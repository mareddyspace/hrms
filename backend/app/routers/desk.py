"""HR service desk (rules in app/services/desk.py).

Everyone raises tickets and sees their own; HR / admin see the queue; the owner a ticket is assigned to sees it.
Nobody works a ticket they raised. Queues: mine (assigned to me), unassigned, overdue, all (HR / admin).
"""

from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import DeskTicket, DeskTicketComment, DeskTicketFile, Employee
from app.schemas.cases_desk import (
    DeskSlaCategoryOut, DeskSlaSummaryOut, DeskTicketAssignIn, DeskTicketCommentIn, DeskTicketCommentOut,
    DeskTicketCreateIn, DeskTicketFileOut, DeskTicketOut, DeskTicketRatingIn, DeskTicketStatusIn,
)
from app.services import desk as rules
from app.services import storage
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, me
from app.services.uploads import UPLOAD_OPENAPI, clean_name, read_upload

router = APIRouter(prefix="/desk", tags=["hr service desk"])


def is_staff(user: CurrentUser) -> bool:
    return user.account.role in rules.DESK_ROLES


def _visible_to(t: DeskTicket, user: CurrentUser) -> bool:
    return is_staff(user) or t.requester_id == user.employee_id or (t.assignee_id is not None and t.assignee_id == user.employee_id)


def _works(t: DeskTicket, user: CurrentUser) -> bool:
    if t.requester_id == user.employee_id:
        return False
    return is_staff(user) or (t.assignee_id is not None and t.assignee_id == user.employee_id)


def _get(db: DbSession, user: CurrentUser, ticket_id: str) -> DeskTicket:
    t = db.get(DeskTicket, ticket_id)
    if t is None or not _visible_to(t, user):
        raise NOT_FOUND
    return t


def _snap(t: DeskTicket) -> dict:
    return {"status": t.status, "priority": t.priority, "assignee_id": t.assignee_id, "category": t.category}


def _outs(db: DbSession, tickets: list[DeskTicket], detail: bool = False) -> list[DeskTicketOut]:
    ids = {t.requester_id for t in tickets} | {t.assignee_id for t in tickets if t.assignee_id}
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_(ids))).all()) if ids else {}
    now = utcnow()
    out = []
    for t in tickets:
        item = DeskTicketOut.model_validate(t)
        item.requester_name, item.assignee_name = names.get(t.requester_id), names.get(t.assignee_id or "")
        item.overdue = rules.is_overdue(t, now)
        if detail:
            comments = list(db.scalars(select(DeskTicketComment).where(DeskTicketComment.ticket_id == t.id).order_by(DeskTicketComment.id)))
            authors = {c.author_id for c in comments if c.author_id}
            cn = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_(authors))).all()) if authors else {}
            item.comments = [DeskTicketCommentOut.model_validate(c).model_copy(update={"author_name": cn.get(c.author_id or "")})
                             for c in comments]
            item.files = [DeskTicketFileOut.model_validate(f) for f in
                          db.scalars(select(DeskTicketFile).where(DeskTicketFile.ticket_id == t.id).order_by(DeskTicketFile.created_at))]
        out.append(item)
    return out


def _comment(db: DbSession, t: DeskTicket, author_id: str | None, text: str, system: bool = False) -> None:
    db.add(DeskTicketComment(ticket_id=t.id, author_id=author_id, text=text, system=system, created_at=utcnow()))


def _notify_status(db: DbSession, t: DeskTicket, actor_id: str | None, actor_name: str) -> None:
    to_requester = t.requester_id != actor_id
    rid = t.requester_id if to_requester else t.assignee_id
    if not rid or rid == actor_id:
        return
    notify(db, recipient_id=rid, title=f"HR request {t.status.lower()} · {t.subject}"[:200],
           body=(f"{actor_name} set your request to {t.status}." + (" HR needs a reply from you." if t.status == "Waiting on you" else ""))
           if to_requester else f"{actor_name} changed the request to {t.status}.",
           href=f"/help?request={t.id}")


@router.get("/categories")
def categories(user: CurrentUserDep) -> list[dict]:
    return [{"category": c, "owner_id": rules.SLA[c][0], "working_days": rules.SLA[c][1]} for c in rules.CATEGORIES]


@router.post("/requests", response_model=DeskTicketOut, status_code=status.HTTP_201_CREATED)
def create_ticket(body: DeskTicketCreateIn, request: Request, db: DbSession, user: CurrentUserDep) -> DeskTicketOut:
    emp = me(user)
    now = utcnow()
    t = DeskTicket(id=f"hr-{secrets.token_hex(6)}", requester_id=emp.id, category=body.category, subject=body.subject.strip(),
                   description=body.description.strip(), priority=body.priority, status="Open",
                   assignee_id=rules.route(body.category, emp.id), submitted_at=now, due_at=rules.due_at(body.category, now),
                   escalation_level=0)
    db.add(t)
    db.flush()
    _comment(db, t, emp.id, t.description)
    record_audit(db, actor_id=user.id, action="desk_ticket_created", entity="desk_ticket", entity_id=t.id, subject_id=emp.id,
                 after=_snap(t) | {"due_at": t.due_at}, ip=client_ip(request))
    if t.assignee_id:
        notify(db, recipient_id=t.assignee_id, title=f"HR request assigned · {t.subject}"[:200],
               body=f"{emp.full_name} raised a {t.category} request. Due {t.due_at:%d %b %H:%M} UTC.", href=f"/help?request={t.id}")
    db.commit()
    return _outs(db, [t], True)[0]


@router.get("/requests", response_model=list[DeskTicketOut])
def list_tickets(
    db: DbSession, user: CurrentUserDep,
    queue: Annotated[str, Query(pattern="^(raised|mine|unassigned|overdue|all)$",
                                description="raised = my own; mine = assigned to me; unassigned / overdue / all = HR queue")] = "raised",
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    category: str | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[DeskTicketOut]:
    emp_id = user.employee_id or ""
    stmt = select(DeskTicket)
    if queue == "raised":
        stmt = stmt.where(DeskTicket.requester_id == emp_id)
    elif queue == "mine":
        stmt = stmt.where(DeskTicket.assignee_id == emp_id)
    else:
        if not is_staff(user):
            raise HTTPException(403, "Only HR can see the service desk queue.")
        if queue == "unassigned":
            stmt = stmt.where(DeskTicket.assignee_id.is_(None), DeskTicket.status.in_(rules.OPEN_STATUSES))
        elif queue == "overdue":
            stmt = stmt.where(DeskTicket.status.in_(rules.CLOCK_RUNNING), DeskTicket.due_at < utcnow())
    if status_filter:
        stmt = stmt.where(DeskTicket.status == status_filter)
    if category:
        stmt = stmt.where(DeskTicket.category == category)
    return _outs(db, list(db.scalars(stmt.order_by(DeskTicket.due_at).limit(limit))))


@router.get("/sla-summary", response_model=DeskSlaSummaryOut)
def sla_summary(db: DbSession, user: CurrentUserDep) -> DeskSlaSummaryOut:
    if not is_staff(user):
        raise HTTPException(403, "Only HR can see the SLA summary.")
    tickets = list(db.scalars(select(DeskTicket)))
    now = utcnow()

    def stats(rows: list[DeskTicket]) -> tuple[int, int, int, int]:
        open_ = [t for t in rows if t.status in rules.OPEN_STATUSES]
        resolved = [t for t in rows if t.resolved_at is not None]
        return (len(open_), sum(rules.is_overdue(t, now) for t in rows), len(resolved),
                sum(1 for t in resolved if t.resolved_at <= t.due_at))

    o, ov, r, ot = stats(tickets)
    firsts = [(t.first_response_at - t.submitted_at).total_seconds() / 3600 for t in tickets if t.first_response_at]
    ratings = [t.satisfaction for t in tickets if t.satisfaction]
    by_cat = []
    for c in rules.CATEGORIES:
        co, cov, cr, cot = stats([t for t in tickets if t.category == c])
        by_cat.append(DeskSlaCategoryOut(category=c, owner_id=rules.SLA[c][0], working_days=rules.SLA[c][1], open=co,
                                         overdue=cov, resolved=cr, resolved_on_time=cot))
    return DeskSlaSummaryOut(
        open=o, unassigned=sum(1 for t in tickets if t.assignee_id is None and t.status in rules.OPEN_STATUSES), overdue=ov,
        escalated=sum(1 for t in tickets if t.escalated_at is not None), resolved=r, resolved_on_time=ot,
        on_time_pct=round(ot * 100 / r, 1) if r else None,
        avg_first_response_hours=round(sum(firsts) / len(firsts), 2) if firsts else None,
        avg_satisfaction=round(sum(ratings) / len(ratings), 2) if ratings else None, ratings=len(ratings), by_category=by_cat,
    )


@router.get("/requests/{ticket_id}", response_model=DeskTicketOut)
def get_ticket(ticket_id: str, db: DbSession, user: CurrentUserDep) -> DeskTicketOut:
    return _outs(db, [_get(db, user, ticket_id)], True)[0]


@router.post("/requests/{ticket_id}/comments", response_model=DeskTicketOut, status_code=status.HTTP_201_CREATED)
def add_comment(ticket_id: str, body: DeskTicketCommentIn, request: Request, db: DbSession, user: CurrentUserDep) -> DeskTicketOut:
    t = _get(db, user, ticket_id)
    if t.status == "Closed":
        raise HTTPException(409, "This request is closed. Reopen it to add a comment.")
    by_hr = _works(t, user)
    before = t.status
    _comment(db, t, user.employee_id, body.text.strip())
    if by_hr and t.first_response_at is None:
        t.first_response_at = utcnow()
    if by_hr and t.status == "Open":
        t.status = "In progress"
    if not by_hr and t.status == "Waiting on you":
        t.status = "In progress"
    if t.status != before:
        _notify_status(db, t, user.employee_id, user.employee.full_name if user.employee else "HR")
    elif by_hr:
        notify(db, recipient_id=t.requester_id, title=f"HR replied · {t.subject}"[:200], body="Open the request to read the reply.",
               href=f"/help?request={t.id}")
    elif t.assignee_id:
        notify(db, recipient_id=t.assignee_id, title=f"New comment · {t.subject}"[:200], body="The requester added a comment.",
               href=f"/help?request={t.id}")
    record_audit(db, actor_id=user.id, action="desk_ticket_commented", entity="desk_ticket", entity_id=t.id,
                 subject_id=t.requester_id, before={"status": before}, after={"status": t.status}, ip=client_ip(request))
    db.commit()
    return _outs(db, [t], True)[0]


@router.post("/requests/{ticket_id}/status", response_model=DeskTicketOut)
def set_status(ticket_id: str, body: DeskTicketStatusIn, request: Request, db: DbSession, user: CurrentUserDep) -> DeskTicketOut:
    t = _get(db, user, ticket_id)
    if body.status == t.status:
        return _outs(db, [t], True)[0]
    by_hr = _works(t, user)
    if by_hr:
        allowed = {"In progress", "Waiting on you", "Resolved", "Closed"}
    elif t.requester_id == user.employee_id:
        allowed = {"Closed", "In progress"} if t.status == "Resolved" else {"In progress"} if t.status == "Closed" else set()
    else:
        allowed = set()
    if body.status not in allowed:
        if is_staff(user) and t.requester_id == user.employee_id:
            raise HTTPException(403, "You raised this request, so another HR team member has to resolve it.")
        raise HTTPException(403 if not by_hr else 409, "That status change is not allowed.")
    before = _snap(t)
    now = utcnow()
    t.status = body.status
    if by_hr and t.first_response_at is None:
        t.first_response_at = now
    if body.status == "Resolved":
        t.resolved_at = now
    elif body.status == "In progress":
        t.resolved_at = None  # reopened
    _comment(db, t, user.employee_id, f"Status changed to {t.status}.", system=True)
    _notify_status(db, t, user.employee_id, user.employee.full_name if user.employee else "HR")
    record_audit(db, actor_id=user.id, action="desk_ticket_status", entity="desk_ticket", entity_id=t.id,
                 subject_id=t.requester_id, before=before, after=_snap(t), ip=client_ip(request))
    db.commit()
    return _outs(db, [t], True)[0]


@router.post("/requests/{ticket_id}/assign", response_model=DeskTicketOut)
def reassign(ticket_id: str, body: DeskTicketAssignIn, request: Request, db: DbSession, user: CurrentUserDep) -> DeskTicketOut:
    t = _get(db, user, ticket_id)
    if not is_staff(user) or t.requester_id == user.employee_id:
        raise HTTPException(403, "Only HR can reassign this request.")
    if body.assignee_id and body.assignee_id == t.requester_id:
        raise HTTPException(422, "The requester can't own their own request.")
    if body.assignee_id and body.assignee_id not in rules.desk_staff(db):
        raise HTTPException(422, "Assign the request to someone on the HR desk.")
    if t.assignee_id == body.assignee_id:
        return _outs(db, [t], True)[0]
    before = _snap(t)
    t.assignee_id = body.assignee_id
    _comment(db, t, user.employee_id, "Reassigned." if body.assignee_id else "Unassigned.", system=True)
    if body.assignee_id and body.assignee_id != user.employee_id:
        notify(db, recipient_id=body.assignee_id, title=f"HR request assigned · {t.subject}"[:200],
               body=f"You were assigned a {t.category} request. Due {t.due_at:%d %b %H:%M} UTC.", href=f"/help?request={t.id}")
    record_audit(db, actor_id=user.id, action="desk_ticket_assigned", entity="desk_ticket", entity_id=t.id,
                 subject_id=t.requester_id, before=before, after=_snap(t), ip=client_ip(request))
    db.commit()
    return _outs(db, [t], True)[0]


@router.post("/requests/{ticket_id}/escalate", response_model=DeskTicketOut)
def escalate(ticket_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> DeskTicketOut:
    """Escalate an overdue request by hand (the requester or HR). The SLA job does the same automatically."""
    t = _get(db, user, ticket_id)
    if not rules.is_overdue(t):
        raise HTTPException(409, "Only overdue requests can be escalated.")
    if t.escalated_at is not None:
        raise HTTPException(409, "This request is already escalated.")
    rules.escalate(db, t, user.id, "escalated by " + ("the requester" if t.requester_id == user.employee_id else "HR"))
    db.commit()
    return _outs(db, [t], True)[0]


@router.post("/requests/{ticket_id}/rating", response_model=DeskTicketOut)
def rate(ticket_id: str, body: DeskTicketRatingIn, request: Request, db: DbSession, user: CurrentUserDep) -> DeskTicketOut:
    t = _get(db, user, ticket_id)
    if t.requester_id != user.employee_id:
        raise HTTPException(403, "Only the requester can rate the service.")
    if t.status not in ("Resolved", "Closed"):
        raise HTTPException(409, "You can rate a request once it is resolved.")
    if t.satisfaction is not None:
        raise HTTPException(409, "You already rated this request.")
    t.satisfaction, t.satisfaction_comment = body.rating, (body.comment or "").strip() or None
    record_audit(db, actor_id=user.id, action="desk_ticket_rated", entity="desk_ticket", entity_id=t.id,
                 subject_id=t.requester_id, after={"rating": body.rating}, ip=client_ip(request))
    db.commit()
    return _outs(db, [t], True)[0]


@router.post("/requests/{ticket_id}/files", response_model=DeskTicketFileOut, status_code=status.HTTP_201_CREATED,
             openapi_extra=UPLOAD_OPENAPI)
async def upload_file(ticket_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                      filename: Annotated[str | None, Query(max_length=255)] = None) -> DeskTicketFile:
    t = _get(db, user, ticket_id)
    if t.status == "Closed":
        raise HTTPException(409, "This request is closed.")
    data, content_type, sha = await read_upload(request)
    fid = f"dtf-{secrets.token_hex(8)}"
    stored = storage.save(f"desk/{t.id}", fid, data, content_type, sha)
    row = DeskTicketFile(id=fid, ticket_id=t.id, uploaded_by=user.employee_id, file_name=clean_name(filename, content_type),
                         content_type=stored.content_type, size_bytes=stored.size_bytes, sha256=stored.sha256,
                         storage_path=stored.relative_path)
    db.add(row)
    db.flush()
    record_audit(db, actor_id=user.id, action="desk_file_added", entity="desk_ticket", entity_id=t.id, subject_id=t.requester_id,
                 after={"file_id": fid, "file_name": row.file_name, "sha256": row.sha256}, ip=client_ip(request))
    try:
        db.commit()
    except Exception:
        storage.delete_quietly(stored.relative_path)
        raise
    return row


@router.get("/requests/{ticket_id}/files/{file_id}", response_class=FileResponse)
def download_file(ticket_id: str, file_id: str, db: DbSession, user: CurrentUserDep) -> FileResponse:
    t = _get(db, user, ticket_id)
    row = db.get(DeskTicketFile, file_id)
    if row is None or row.ticket_id != t.id:
        raise NOT_FOUND
    try:
        path = storage.resolve(row.storage_path)
    except storage.StorageError as exc:
        raise NOT_FOUND from exc
    if not path.is_file():
        raise HTTPException(410, "The file is no longer available.")
    return FileResponse(path, media_type=row.content_type, filename=row.file_name,
                        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})



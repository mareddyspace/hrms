"""Confidential HR cases (rules in app/services/cases.py).

Anyone signed in may raise a case (optionally anonymous) and gets a private code. Only the reporter, HR and
(POSH) the Internal Committee can open it; the person named gets 404 everywhere, including the code lookup.
The reporter's view hides confidential notes and files, assignee details and who the reporter is.
Audit rows never contain the description or note text; notifications carry only the case code.
"""

from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, Response
from sqlalchemy import or_, select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Account, Employee, HrCase, HrCaseFile, HrCaseNote
from app.schemas.cases_desk import (
    HrCaseAssignIn, HrCaseCommentIn, HrCaseCreatedOut, HrCaseCreateIn, HrCaseEntryOut, HrCaseEscalateIn, HrCaseFileOut,
    HrCaseNoteIn, HrCaseOut, HrCasePriorityIn, HrCaseStatusIn,
)
from app.services import cases as rules
from app.services import storage
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, me
from app.services.scope import HR_ROLES
from app.services.uploads import UPLOAD_OPENAPI, clean_name, read_upload

router = APIRouter(prefix="/cases", tags=["hr cases"])


def _role(user: CurrentUser) -> str:
    return user.account.role


def _visible(db: DbSession, user: CurrentUser, case_id: str) -> HrCase:
    case = db.get(HrCase, case_id)
    if case is None or not rules.can_see(db, case, user.employee_id, _role(user), user.scope):
        raise NOT_FOUND
    return case


def _managed(db: DbSession, user: CurrentUser, case_id: str) -> HrCase:
    case = _visible(db, user, case_id)
    if not rules.can_manage(db, case, user.employee_id, _role(user), user.scope):
        raise HTTPException(403, "Only HR (or the Internal Committee for POSH cases) can update this case."
                            if rules.is_posh(case) else "Only HR can update this case.")
    return case


def _not_archived(case: HrCase) -> None:
    if case.status == rules.ARCHIVED:
        raise HTTPException(409, "This case is archived.")


def _name(db: DbSession, emp_id: str | None) -> str | None:
    emp = db.get(Employee, emp_id) if emp_id else None
    return emp.full_name if emp else None


def _out(db: DbSession, user: CurrentUser, case: HrCase) -> HrCaseOut:
    manager = rules.can_manage(db, case, user.employee_id, _role(user), user.scope)
    notes = list(db.scalars(select(HrCaseNote).where(HrCaseNote.case_id == case.id).order_by(HrCaseNote.created_at, HrCaseNote.id)))
    files = list(db.scalars(select(HrCaseFile).where(HrCaseFile.case_id == case.id).order_by(HrCaseFile.created_at)))
    if not manager:
        notes = [n for n in notes if not n.confidential]
        files = [f for f in files if not f.confidential]

    def author(n: HrCaseNote) -> str:
        if n.by_reporter:
            return "Reporter"
        if not n.author_id:
            return "System"
        return (_name(db, n.author_id) or "HR") if manager else "HR"

    out = HrCaseOut(
        id=case.id, code=case.code, category=case.category, description=case.description, anonymous=case.anonymous,
        status=case.status, priority=case.priority, view="manager" if manager else "reporter",
        resolution=case.resolution, closed_on=case.closed_on, archived_on=case.archived_on,
        posh_due_on=rules.posh_due_on(case), posh_overdue=rules.posh_overdue(case),
        escalated_at=case.escalated_at, escalation_count=case.escalation_count or 0, created_at=case.created_at,
        timeline=[HrCaseEntryOut(id=n.id, kind=n.kind, text=n.text, author=author(n), confidential=n.confidential,
                                 status=n.status, created_at=n.created_at) for n in notes],
        files=[HrCaseFileOut.model_validate(f) for f in files],
    )
    if manager:
        if not case.anonymous:
            out.reporter_id, out.reporter_name = case.reporter_id, _name(db, case.reporter_id)
        out.against_id, out.against_name = case.against_id, _name(db, case.against_id)
        out.assignee_id, out.assignee_name = case.assignee_id, _name(db, case.assignee_id)
    return out


def _team(db: DbSession, case: HrCase) -> list[str]:
    """People who work the case (HR, plus the committee on POSH), never the reporter or the person named."""
    ids = list(db.scalars(select(Account.employee_id).where(Account.role.in_(HR_ROLES), Account.active.is_(True),
                                                            Account.employee_id.is_not(None)).order_by(Account.employee_id)))
    if rules.is_posh(case):
        ids += rules.committee(db)
    return [i for i in dict.fromkeys(ids) if i and i not in (case.reporter_id, case.against_id)]


def _audit(db: DbSession, user: CurrentUser, request: Request, action: str, case: HrCase, before: dict | None = None,
           extra: dict | None = None) -> None:
    record_audit(db, actor_id=user.id, action=action, entity="hr_case", entity_id=case.id, before=before,
                 after=rules.snapshot(case) | (extra or {}), ip=client_ip(request))


@router.post("", response_model=HrCaseCreatedOut, status_code=status.HTTP_201_CREATED)
def raise_case(body: HrCaseCreateIn, request: Request, db: DbSession, user: CurrentUserDep) -> HrCaseCreatedOut:
    emp = me(user)
    if body.against_id:
        if body.against_id == emp.id:
            raise HTTPException(422, "You cannot name yourself in a case.")
        if db.get(Employee, body.against_id) is None:
            raise HTTPException(422, "Choose the person from the list.")
    case = HrCase(id=f"hc-{secrets.token_hex(8)}", code=rules.new_code(db), category=body.category,
                  description=body.description.strip(), anonymous=body.anonymous, reporter_id=emp.id,
                  against_id=body.against_id or None, priority="High" if body.category == rules.POSH else "Normal",
                  status="Open", escalation_count=0)
    db.add(case)
    db.flush()
    rules.add_note(db, case, "filed", "Case raised.", emp.id, by_reporter=True, status="Open")
    _audit(db, user, request, "hr_case_raised", case, extra={"anonymous": case.anonymous})
    for rid in _team(db, case):
        notify(db, recipient_id=rid, title=f"New HR case · {case.code}", body=f"A {case.category} case was raised.",
               href=f"/cases/{case.id}")
    db.commit()
    return HrCaseCreatedOut(id=case.id, code=case.code, status=case.status)


@router.get("", response_model=list[HrCaseOut])
def list_cases(
    db: DbSession, user: CurrentUserDep,
    view: Annotated[str, Query(pattern="^(mine|manage)$", description="mine = cases I raised; manage = cases I work")] = "mine",
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    category: str | None = None,
    assigned_to_me: bool = False,
) -> list[HrCaseOut]:
    emp_id = user.employee_id or ""
    stmt = select(HrCase)
    if view == "mine":
        stmt = stmt.where(HrCase.reporter_id == emp_id)
    else:
        if _role(user) not in HR_ROLES:
            if emp_id not in rules.committee(db):
                return []
            stmt = stmt.where(HrCase.category == rules.POSH)
        stmt = stmt.where(HrCase.reporter_id != emp_id, or_(HrCase.against_id.is_(None), HrCase.against_id != emp_id))
    if status_filter:
        stmt = stmt.where(HrCase.status == status_filter)
    if category:
        stmt = stmt.where(HrCase.category == category)
    if assigned_to_me:
        stmt = stmt.where(HrCase.assignee_id == emp_id)
    cases = [c for c in db.scalars(stmt.order_by(HrCase.created_at.desc())) if rules.can_see(db, c, user.employee_id, _role(user), user.scope)]
    return [_out(db, user, c) for c in cases]


@router.get("/by-code/{code}", response_model=HrCaseOut)
def by_code(code: str, db: DbSession, user: CurrentUserDep) -> HrCaseOut:
    case = db.scalar(select(HrCase).where(HrCase.code == code.strip().upper()))
    if case is None or not rules.can_see(db, case, user.employee_id, _role(user), user.scope):
        raise NOT_FOUND
    return _out(db, user, case)


@router.get("/{case_id}", response_model=HrCaseOut)
def get_case(case_id: str, db: DbSession, user: CurrentUserDep) -> HrCaseOut:
    return _out(db, user, _visible(db, user, case_id))


@router.post("/{case_id}/status", response_model=HrCaseOut)
def set_status(case_id: str, body: HrCaseStatusIn, request: Request, db: DbSession, user: CurrentUserDep) -> HrCaseOut:
    case = _managed(db, user, case_id)
    _not_archived(case)
    if body.status not in rules.TRANSITIONS[case.status]:
        raise HTTPException(409, f"A case cannot move from {case.status} to {body.status}.")
    text = body.note.strip()
    if body.status == "Resolved" and len(text) < 10:
        raise HTTPException(422, "Add a resolution note (at least 10 characters).")
    if body.status == "Closed" and case.status != "Resolved" and len(text) < 10:
        raise HTTPException(422, "Add a reason for closing (at least 10 characters).")
    before = rules.snapshot(case)
    case.status = body.status
    if body.status == "Resolved":
        case.resolution = text
    if body.status in ("Resolved", "Closed"):
        case.closed_on = utcnow().date()
    rules.add_note(db, case, "status", text or f"Moved to {body.status}.", user.employee_id, status=body.status)
    _audit(db, user, request, "hr_case_status", case, before)
    if case.reporter_id and case.reporter_id != user.employee_id:
        notify(db, recipient_id=case.reporter_id, title=f"Your HR case was updated · {case.code}",
               body=f"Status: {case.status}.", href=f"/cases/{case.id}")
    db.commit()
    return _out(db, user, case)


@router.post("/{case_id}/assign", response_model=HrCaseOut)
def assign(case_id: str, body: HrCaseAssignIn, request: Request, db: DbSession, user: CurrentUserDep) -> HrCaseOut:
    case = _managed(db, user, case_id)
    _not_archived(case)
    if body.assignee_id and body.assignee_id not in _team(db, case):
        raise HTTPException(422, "Assign the case to someone in HR (or the committee for POSH), "
                                 "never the reporter or the person named.")
    if case.assignee_id == body.assignee_id:
        return _out(db, user, case)
    before = rules.snapshot(case)
    case.assignee_id = body.assignee_id
    rules.add_note(db, case, "note", "Assigned." if body.assignee_id else "Unassigned.", user.employee_id, confidential=True)
    _audit(db, user, request, "hr_case_assigned", case, before)
    if body.assignee_id and body.assignee_id != user.employee_id:
        notify(db, recipient_id=body.assignee_id, title=f"HR case assigned to you · {case.code}",
               body=f"A {case.category} case needs your attention.", href=f"/cases/{case.id}")
    db.commit()
    return _out(db, user, case)


@router.post("/{case_id}/priority", response_model=HrCaseOut)
def set_priority(case_id: str, body: HrCasePriorityIn, request: Request, db: DbSession, user: CurrentUserDep) -> HrCaseOut:
    case = _managed(db, user, case_id)
    _not_archived(case)
    before = rules.snapshot(case)
    case.priority = body.priority
    _audit(db, user, request, "hr_case_priority", case, before)
    db.commit()
    return _out(db, user, case)


@router.post("/{case_id}/notes", response_model=HrCaseOut, status_code=status.HTTP_201_CREATED)
def add_note(case_id: str, body: HrCaseNoteIn, request: Request, db: DbSession, user: CurrentUserDep) -> HrCaseOut:
    """HR / committee note. confidential notes are never shown to the reporter."""
    case = _managed(db, user, case_id)
    _not_archived(case)
    rules.add_note(db, case, "note", body.text.strip(), user.employee_id, confidential=body.confidential)
    _audit(db, user, request, "hr_case_note_added", case, extra={"confidential": body.confidential})
    if not body.confidential and case.reporter_id:
        notify(db, recipient_id=case.reporter_id, title=f"New update on your HR case · {case.code}",
               body="HR added an update.", href=f"/cases/{case.id}")
    db.commit()
    return _out(db, user, case)


@router.post("/{case_id}/comments", response_model=HrCaseOut, status_code=status.HTTP_201_CREATED)
def reporter_comment(case_id: str, body: HrCaseCommentIn, request: Request, db: DbSession, user: CurrentUserDep) -> HrCaseOut:
    """The reporter adds information (shown as "Reporter", even on anonymous cases)."""
    case = _visible(db, user, case_id)
    if not rules.is_reporter(case, user.employee_id):
        raise HTTPException(403, "Only the reporter can comment here; HR adds notes.")
    _not_archived(case)
    if case.status not in rules.OPEN:
        raise HTTPException(409, "This case is closed.")
    rules.add_note(db, case, "comment", body.text.strip(), user.employee_id, by_reporter=True)
    _audit(db, user, request, "hr_case_comment_added", case)
    for rid in [case.assignee_id] if case.assignee_id else _team(db, case):
        notify(db, recipient_id=rid, title=f"Reporter added information · {case.code}", body="Open the case to read it.",
               href=f"/cases/{case.id}")
    db.commit()
    return _out(db, user, case)


@router.post("/{case_id}/escalate", response_model=HrCaseOut)
def escalate(case_id: str, body: HrCaseEscalateIn, request: Request, db: DbSession, user: CurrentUserDep) -> HrCaseOut:
    """HR / committee (or the reporter) escalates an open case: priority Urgent, every HR member told."""
    case = _visible(db, user, case_id)
    _not_archived(case)
    if case.status not in rules.OPEN:
        raise HTTPException(409, "Only open cases can be escalated.")
    by_reporter = rules.is_reporter(case, user.employee_id)
    before = rules.snapshot(case)
    case.priority = "Urgent"
    case.escalated_at, case.escalated_by = utcnow(), user.employee_id
    case.escalation_count = (case.escalation_count or 0) + 1
    rules.add_note(db, case, "escalation", body.reason.strip(), user.employee_id, by_reporter=by_reporter,
                   confidential=not by_reporter)
    _audit(db, user, request, "hr_case_escalated", case, before)
    for rid in _team(db, case):
        if rid != user.employee_id:
            notify(db, recipient_id=rid, title=f"HR case escalated · {case.code}", body=f"A {case.category} case was escalated.",
                   href=f"/cases/{case.id}")
    db.commit()
    return _out(db, user, case)


# ---------- files ----------
@router.post("/{case_id}/files", response_model=HrCaseFileOut, status_code=status.HTTP_201_CREATED, openapi_extra=UPLOAD_OPENAPI)
async def upload_file(
    case_id: str, request: Request, db: DbSession, user: CurrentUserDep,
    filename: Annotated[str | None, Query(max_length=255)] = None, confidential: bool = False,
) -> HrCaseFile:
    case = _visible(db, user, case_id)
    _not_archived(case)
    by_reporter = rules.is_reporter(case, user.employee_id)
    if by_reporter and confidential:
        raise HTTPException(422, "Only HR can add confidential files.")
    data, content_type, sha = await read_upload(request)
    fid = f"hcf-{secrets.token_hex(8)}"
    stored = storage.save(f"cases/{case.id}", fid, data, content_type, sha)
    row = HrCaseFile(id=fid, case_id=case.id, uploaded_by=user.employee_id, by_reporter=by_reporter, confidential=confidential,
                     file_name=clean_name(filename, content_type, "evidence"), content_type=stored.content_type,
                     size_bytes=stored.size_bytes, sha256=stored.sha256, storage_path=stored.relative_path)
    db.add(row)
    db.flush()
    _audit(db, user, request, "hr_case_file_added", case, extra={"file_id": fid, "confidential": confidential})
    try:
        db.commit()
    except Exception:
        storage.delete_quietly(stored.relative_path)
        raise
    return row


@router.get("/{case_id}/files/{file_id}", response_class=FileResponse)
def download_file(case_id: str, file_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    case = _visible(db, user, case_id)
    row = db.get(HrCaseFile, file_id)
    if row is None or row.case_id != case.id:
        raise NOT_FOUND
    if row.confidential and not rules.can_manage(db, case, user.employee_id, _role(user), user.scope):
        raise NOT_FOUND
    try:
        response = storage.download(row.storage_path, media_type=row.content_type, filename=row.file_name)
    except storage.FileMissing as exc:
        raise HTTPException(410, "The file is no longer available.") from exc
    except storage.StorageError as exc:
        raise NOT_FOUND from exc
    record_audit(db, actor_id=user.id, action="hr_case_file_downloaded", entity="hr_case", entity_id=case.id,
                 after={"file_id": row.id}, ip=client_ip(request))
    db.commit()
    return response

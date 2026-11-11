"""Work tickets shared between people (/tickets): list, raise, assign, status, comment, watch, sub-owner, deadline and
tasks. Same rules as src/data/ticketStore.ts. Every change is audited and the people concerned are notified.
Not the HR helpdesk (/desk)."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import Employee, Ticket, TicketCategory, TicketTask, WorkAttachment
from app.services import storage
from app.services import tickets as rules
from app.services import work_attachments as files
from app.services.activity import notify, record_audit
from app.services.scope import HR_ACCESS_ROLES
from app.services.uploads import UPLOAD_OPENAPI

router = APIRouter(prefix="/tickets", tags=["tickets"])


# ---------- schemas ----------

class TicketTaskOut(BaseModel):
    id: str
    title: str
    owner_id: str | None
    due: date | None
    done: bool


class TicketEventOut(BaseModel):
    id: str
    at: datetime
    by_id: str
    kind: str
    text: str
    internal: bool = False


class TicketOut(BaseModel):
    id: str
    title: str
    description: str
    type: str
    priority: str
    status: str
    project_id: str | None
    project_name: str | None
    requester_id: str
    assignee_id: str | None
    sub_owner_id: str | None
    watcher_ids: list[str]
    due: date | None
    tasks: list[TicketTaskOut]
    activity: list[TicketEventOut]
    created_at: datetime
    updated_at: datetime
    names: dict[str, str]  # display names for everyone on the ticket
    can_plan: bool
    next_statuses: list[str]
    can_take: bool = False  # may assign it to themselves ("Take it")
    # Service targets (migration 0033): stored when raised; older tickets get them from their category.
    response_due_at: datetime | None = None
    resolve_due_at: datetime | None = None
    first_response_at: datetime | None = None
    resolved_at: datetime | None = None
    resolution_note: str | None = None
    satisfaction: int | None = None
    satisfaction_note: str | None = None
    escalated_at: datetime | None = None
    reopen_count: int = 0
    sla_state: str = "ok"  # ok | soon | breached | met
    is_agent: bool = False  # works the ticket: sees and writes internal notes
    can_rate: bool = False
    attachments: list[files.AttachmentOut] = []


class TicketIn(BaseModel):
    title: str = Field(max_length=200)
    description: str = Field(default="", max_length=4000)
    type: str
    priority: str = "medium"
    project_id: str | None = Field(default=None, max_length=64)
    project_name: str | None = Field(default=None, max_length=200)
    assignee_id: str | None = Field(default=None, max_length=64)
    due: date | None = None


class AssignIn(BaseModel):
    assignee_id: str = Field(min_length=1, max_length=64)


class StatusIn(BaseModel):
    status: str
    note: str = Field(default="", max_length=2000)


class CommentIn(BaseModel):
    text: str = Field(max_length=2000)
    internal: bool = False


class RatingIn(BaseModel):
    score: int = Field(ge=1, le=5)
    note: str = Field(default="", max_length=1000)


class CategoryOut(BaseModel):
    name: str
    response_hours: int
    resolve_hours: int
    queue_owner_id: str | None = None
    queue_owner_name: str | None = None
    active: bool = True


class CategoryIn(BaseModel):
    response_hours: int = Field(ge=1, le=2000)
    resolve_hours: int = Field(ge=1, le=5000)
    queue_owner_id: str | None = Field(default=None, max_length=64)
    active: bool = True


class PersonIn(BaseModel):
    person_id: str | None = Field(default=None, max_length=64)


class PriorityIn(BaseModel):
    priority: str


class DueIn(BaseModel):
    due: date | None = None


class TaskIn(BaseModel):
    title: str = Field(max_length=200)
    owner_id: str | None = Field(default=None, max_length=64)
    due: date | None = None


# ---------- helpers ----------

def _actor(user) -> tuple[str, str]:  # type: ignore[no-untyped-def]
    if not user.employee_id:
        raise HTTPException(403, "Tickets need an employee profile.")
    return user.employee_id, user.account.role


def _load(db: Session, ticket_id: str, actor_id: str, role: str) -> Ticket:
    t = db.scalar(select(Ticket).where(Ticket.id == ticket_id).options(selectinload(Ticket.tasks), selectinload(Ticket.events)))
    if t is None or not rules.can_view(db, t, actor_id, role):
        raise HTTPException(404, "Ticket not found.")
    return t


def _out(db: Session, t: Ticket, actor_id: str, role: str = "",
         attachments: list[WorkAttachment] | None = None) -> TicketOut:
    agent = rules.is_agent(db, t, actor_id, role)
    events = [e for e in t.events if agent or not e.internal]
    attached = [a for a in (files.list_for(db, "ticket", t.id) if attachments is None else attachments)
                if agent or not a.internal]
    people = {t.requester_id, t.assignee_id, t.sub_owner_id, *(t.watcher_ids or []), *(k.owner_id for k in t.tasks),
              *(e.by_id for e in events), *(a.uploaded_by for a in attached)} - {None}
    respond_by, resolve_by = rules.effective_targets(db, t)
    return TicketOut(
        id=t.id, title=t.title, description=t.description or "", type=t.type, priority=t.priority, status=t.status,
        project_id=t.project_id, project_name=t.project_name, requester_id=t.requester_id, assignee_id=t.assignee_id,
        sub_owner_id=t.sub_owner_id, watcher_ids=list(t.watcher_ids or []), due=t.due,
        tasks=[TicketTaskOut(id=k.id, title=k.title, owner_id=k.owner_id, due=k.due, done=k.done) for k in t.tasks],
        activity=[TicketEventOut(id=str(e.id), at=e.at, by_id=e.by_id, kind=e.kind, text=e.text, internal=bool(e.internal))
                  for e in events],
        created_at=t.created_at, updated_at=t.updated_at,
        names={p: rules.person_name(db, p) for p in people},  # type: ignore[misc]
        can_plan=rules.can_plan(db, t, actor_id), next_statuses=rules.next_statuses(t, actor_id),
        can_take=rules.can_take(db, t, actor_id, role),
        response_due_at=respond_by, resolve_due_at=resolve_by, first_response_at=rules.first_response(t),
        resolved_at=t.resolved_at, resolution_note=t.resolution_note, satisfaction=t.satisfaction,
        satisfaction_note=t.satisfaction_note, escalated_at=t.escalated_at, reopen_count=t.reopen_count or 0,
        sla_state=rules.sla_state(db, t), is_agent=agent,
        can_rate=actor_id == t.requester_id and t.status in ("Resolved", "Closed") and actor_id != t.assignee_id,
        attachments=[files.out(a, rules.person_name(db, a.uploaded_by)) for a in attached],
    )


def _first_response(t: Ticket, actor_id: str) -> None:
    """The first public reply or status move by someone other than the requester meets the response target."""
    if t.first_response_at is None and actor_id != t.requester_id:
        t.first_response_at = datetime.now(timezone.utc)


def _tell(db: Session, recipient: str | None, actor_id: str, title: str, body: str, ticket_id: str) -> None:
    """In-app notification for people with an employee record (portal-only teammates have no inbox)."""
    if recipient and recipient != actor_id and db.get(Employee, recipient) is not None:
        notify(db, recipient_id=recipient, title=title, body=body, href=f"/tickets?id={ticket_id}")


def _save(db: Session, request: Request, user, t: Ticket, action: str, after: dict) -> TicketOut:  # type: ignore[no-untyped-def]
    t.updated_at = datetime.now(timezone.utc)
    record_audit(db, actor_id=user.id, action=action, entity="ticket", entity_id=t.id, subject_id=t.requester_id,
                 after=after, ip=client_ip(request))
    db.commit()
    db.refresh(t)
    return _out(db, t, user.employee_id, user.account.role)


def _check_person(db: Session, person_id: str) -> None:
    if not rules.person_exists(db, person_id):
        raise HTTPException(422, "Pick someone from the list.")


def _plan_guard(db: Session, t: Ticket, actor_id: str) -> None:
    if not rules.can_plan(db, t, actor_id):
        raise HTTPException(403, "Only the owner, sub-owner, requester or their manager can change this.")


# ---------- routes ----------

@router.get("", response_model=list[TicketOut])
def list_tickets(db: DbSession, user: CurrentUserDep) -> list[TicketOut]:
    """Tickets I raised, own, help on, have a task on or watch; my team's; and the IT / HR queue for those roles."""
    actor_id, role = _actor(user)
    if rules.escalate_overdue(db):
        db.commit()
    rows = db.scalars(select(Ticket).options(selectinload(Ticket.tasks), selectinload(Ticket.events))
                      .order_by(Ticket.updated_at.desc())).all()
    visible = [t for t in rows if rules.can_view(db, t, actor_id, role)]
    by_ticket: dict[str, list[WorkAttachment]] = {t.id: [] for t in visible}
    if visible:
        for a in db.scalars(select(WorkAttachment).where(WorkAttachment.entity_type == "ticket",
                                                         WorkAttachment.entity_id.in_(list(by_ticket)))
                            .order_by(WorkAttachment.created_at)):
            by_ticket[a.entity_id].append(a)
    return [_out(db, t, actor_id, role, by_ticket[t.id]) for t in visible]


# ---------- categories and their service targets ----------

def _category_out(db: Session, c: TicketCategory) -> CategoryOut:
    return CategoryOut(name=c.name, response_hours=c.response_hours, resolve_hours=c.resolve_hours,
                       queue_owner_id=c.queue_owner_id,
                       queue_owner_name=rules.person_name(db, c.queue_owner_id) if c.queue_owner_id else None,
                       active=c.active)


@router.get("/categories", response_model=list[CategoryOut])
def list_categories(db: DbSession, user: CurrentUserDep) -> list[CategoryOut]:
    _actor(user)
    if rules.ensure_categories(db):
        db.commit()
    rows = {c.name: c for c in db.scalars(select(TicketCategory))}
    return [_category_out(db, rows[n]) for n in rules.TYPES if n in rows]


@router.put("/categories/{name}", response_model=CategoryOut)
def update_category(name: str, body: CategoryIn, request: Request, db: DbSession, user: CurrentUserDep) -> CategoryOut:
    """HR and admins set a category's response / resolve hours (for medium priority) and its queue owner."""
    if user.account.role not in rules.ADMIN_ROLES | HR_ACCESS_ROLES:
        raise HTTPException(403, "Only HR or an admin can change ticket categories.")
    if name not in rules.TYPES:
        raise HTTPException(404, "Category not found.")
    if body.resolve_hours < body.response_hours:
        raise HTTPException(422, "The resolve target can't be shorter than the response target.")
    if body.queue_owner_id and db.get(Employee, body.queue_owner_id) is None:
        raise HTTPException(422, "Pick someone from the directory for the queue.")
    rules.ensure_categories(db)
    c = db.get(TicketCategory, name)
    before = {"response_hours": c.response_hours, "resolve_hours": c.resolve_hours, "queue_owner_id": c.queue_owner_id,
              "active": c.active}
    c.response_hours, c.resolve_hours = body.response_hours, body.resolve_hours
    c.queue_owner_id, c.active = body.queue_owner_id or None, body.active
    record_audit(db, actor_id=user.id, action="ticket_category_updated", entity="ticket_category", entity_id=name,
                 before=before, after=body.model_dump(), ip=client_ip(request))
    db.commit()
    return _category_out(db, c)


@router.post("", response_model=TicketOut, status_code=status.HTTP_201_CREATED)
def create_ticket(body: TicketIn, request: Request, db: DbSession, user: CurrentUserDep) -> TicketOut:
    actor_id, _ = _actor(user)
    title = body.title.strip()
    if len(title) < 4:
        raise HTTPException(422, "Add a short title.")
    if body.type not in rules.TYPES:
        raise HTTPException(422, "Pick a ticket type.")
    if body.priority not in rules.PRIORITIES:
        raise HTTPException(422, "Pick a priority.")
    if body.due and body.due < date.today():
        raise HTTPException(422, "Due date is in the past.")
    assignee = body.assignee_id or None
    if assignee and assignee != actor_id:
        _check_person(db, assignee)
        if not rules.manages(db, actor_id, assignee):
            raise HTTPException(403, "You can only assign to your team.")
    if not assignee:
        assignee = rules.queue_owner(db, body.type)
    now = datetime.now(timezone.utc)
    respond_by, resolve_by = rules.targets(db, body.type, body.priority, now)
    t = Ticket(id=rules.next_id(db), title=title, description=body.description.strip(), type=body.type,
               priority=body.priority, status="Open", project_id=body.project_id or None,
               project_name=(body.project_name if body.project_id else None), requester_id=actor_id,
               assignee_id=assignee, watcher_ids=[], due=body.due, response_due_at=respond_by,
               resolve_due_at=resolve_by, reopen_count=0)
    rules.add_event(t, actor_id, "created", "Raised the ticket.")
    if assignee:
        rules.add_event(t, actor_id, "assigned", f"Assigned to {rules.person_name(db, assignee)}.")
    db.add(t)
    db.flush()
    _tell(db, assignee, actor_id, f"Ticket assigned: {t.id}",
          f"{title} — from {rules.person_name(db, actor_id)}. Log time from your timesheet.", t.id)
    return _save(db, request, user, t, "ticket_created",
                 {"title": title, "type": t.type, "priority": t.priority, "assignee_id": assignee, "due": t.due})


@router.post("/{ticket_id}/assign", response_model=TicketOut)
def assign_ticket(ticket_id: str, body: AssignIn, request: Request, db: DbSession, user: CurrentUserDep) -> TicketOut:
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    if not rules.is_open(t):
        raise HTTPException(409, "This ticket is already resolved.")
    if t.assignee_id == body.assignee_id:
        raise HTTPException(409, "Already assigned to that person.")
    _check_person(db, body.assignee_id)
    if body.assignee_id == actor_id:
        if not rules.can_take(db, t, actor_id, role):
            raise HTTPException(403, "You can't take this ticket.")
    elif not rules.manages(db, actor_id, body.assignee_id):
        raise HTTPException(403, "You can only assign to your team.")
    before = t.assignee_id
    t.assignee_id = body.assignee_id
    if t.sub_owner_id == body.assignee_id:
        t.sub_owner_id = None
    rules.add_event(t, actor_id, "assigned", f"Assigned to {rules.person_name(db, body.assignee_id)}.")
    _tell(db, body.assignee_id, actor_id, f"Ticket assigned: {t.id}",
          f"{t.title} — from {rules.person_name(db, actor_id)}. Log time from your timesheet.", t.id)
    return _save(db, request, user, t, "ticket_assigned", {"from": before, "to": body.assignee_id})


@router.post("/{ticket_id}/status", response_model=TicketOut)
def move_ticket(ticket_id: str, body: StatusIn, request: Request, db: DbSession, user: CurrentUserDep) -> TicketOut:
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    if body.status not in rules.next_statuses(t, actor_id):
        raise HTTPException(403, "You can't make that change.")
    note = body.note.strip()
    if body.status == "Resolved" and not note:
        raise HTTPException(422, "Add a short resolution note.")
    before = t.status
    reopening = before == "Resolved" and body.status == "In progress"
    if reopening and not note:
        raise HTTPException(422, "Say what is still wrong so the owner can pick it up.")
    t.status = body.status
    _first_response(t, actor_id)
    if body.status == "Resolved":
        t.resolved_at, t.resolution_note = datetime.now(timezone.utc), note
    elif reopening:
        t.resolved_at, t.resolution_note, t.satisfaction, t.satisfaction_note = None, None, None, None
        t.reopen_count = (t.reopen_count or 0) + 1
    elif body.status == "Closed" and t.resolved_at is None:
        t.resolved_at = datetime.now(timezone.utc)  # withdrawn by the requester
    rules.add_event(t, actor_id, "status", f"Reopened: {before} → {body.status}" if reopening else f"{before} → {body.status}")
    if note:
        rules.add_event(t, actor_id, "comment", note)
    # Requester hears about every change; the owner hears when the requester closes or reopens.
    recipient = t.assignee_id if actor_id == t.requester_id else t.requester_id
    _tell(db, recipient, actor_id, f"{t.id} is now {body.status}", f"{t.title}{f' — {note}' if note else ''}", t.id)
    return _save(db, request, user, t, "ticket_status", {"from": before, "to": body.status, "note": note or None})


@router.post("/{ticket_id}/comments", response_model=TicketOut)
def comment_ticket(ticket_id: str, body: CommentIn, request: Request, db: DbSession, user: CurrentUserDep) -> TicketOut:
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    text = body.text.strip()
    if not text:
        raise HTTPException(422, "Write a comment first.")
    if body.internal and not rules.is_agent(db, t, actor_id, role):
        raise HTTPException(403, "Only the people working the ticket can add internal notes.")
    rules.add_event(t, actor_id, "comment", text, internal=body.internal)
    if not body.internal:
        _first_response(t, actor_id)
    name = rules.person_name(db, actor_id)
    audience = {t.assignee_id, t.sub_owner_id} if body.internal else {t.requester_id, t.assignee_id, t.sub_owner_id}
    for person in audience - {None}:
        _tell(db, person, actor_id, f"{'Internal note' if body.internal else 'Comment'} on {t.id}", f"{name}: {text[:140]}", t.id)
    return _save(db, request, user, t, "ticket_comment", {"text": text, "internal": body.internal})


@router.post("/{ticket_id}/rating", response_model=TicketOut)
def rate_ticket(ticket_id: str, body: RatingIn, request: Request, db: DbSession, user: CurrentUserDep) -> TicketOut:
    """The requester rates how the ticket was handled once it is resolved (1-5, can be changed)."""
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    if actor_id != t.requester_id or actor_id == t.assignee_id:
        raise HTTPException(403, "Only the person who raised the ticket can rate it.")
    if t.status not in ("Resolved", "Closed"):
        raise HTTPException(409, "Rate the ticket once it is resolved.")
    t.satisfaction, t.satisfaction_note = body.score, body.note.strip() or None
    rules.add_event(t, actor_id, "comment", f"Rated {body.score}/5" + (f": {t.satisfaction_note}" if t.satisfaction_note else "."))
    _tell(db, t.assignee_id, actor_id, f"{t.id} rated {body.score}/5", t.satisfaction_note or t.title, t.id)
    return _save(db, request, user, t, "ticket_rated", {"score": body.score})


# ---------- attachments ----------

@router.post("/{ticket_id}/attachments", response_model=TicketOut, status_code=status.HTTP_201_CREATED,
             openapi_extra=UPLOAD_OPENAPI)
async def upload_attachment(ticket_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                            filename: Annotated[str | None, Query(max_length=255)] = None,
                            internal: bool = False) -> TicketOut:
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    if internal and not rules.is_agent(db, t, actor_id, role):
        raise HTTPException(403, "Only the people working the ticket can add internal files.")
    row = await files.add(db, request, "ticket", t.id, actor_id, filename, internal)
    rules.add_event(t, actor_id, "comment", f"Attached {row.file_name}.", internal=internal)
    audience = {t.assignee_id, t.sub_owner_id} if internal else {t.requester_id, t.assignee_id, t.sub_owner_id}
    for person in audience - {None}:
        _tell(db, person, actor_id, f"File added to {t.id}", f"{rules.person_name(db, actor_id)}: {row.file_name}", t.id)
    try:
        return _save(db, request, user, t, "ticket_attachment_added", {"file": row.file_name, "internal": internal})
    except Exception:
        storage.delete_quietly(row.storage_path)
        raise


@router.get("/{ticket_id}/attachments/{file_id}/file")
def download_attachment(ticket_id: str, file_id: str, db: DbSession, user: CurrentUserDep) -> Response:
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    row = files.get(db, "ticket", t.id, file_id)
    if row.internal and not rules.is_agent(db, t, actor_id, role):
        raise HTTPException(404, "File not found.")
    return files.download(row)


@router.delete("/{ticket_id}/attachments/{file_id}", response_model=TicketOut)
def delete_attachment(ticket_id: str, file_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> TicketOut:
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    row = files.get(db, "ticket", t.id, file_id)
    if row.internal and not rules.is_agent(db, t, actor_id, role):
        raise HTTPException(404, "File not found.")
    if row.uploaded_by != actor_id and not rules.can_plan(db, t, actor_id):
        raise HTTPException(403, "Only the person who added the file, or the ticket owner, can remove it.")
    path, name, internal = row.storage_path, row.file_name, bool(row.internal)
    db.delete(row)
    rules.add_event(t, actor_id, "comment", f"Removed {name}.", internal=internal)
    out = _save(db, request, user, t, "ticket_attachment_removed", {"file": name})
    storage.delete_quietly(path)
    return out


@router.post("/{ticket_id}/watch", response_model=TicketOut)
def toggle_watch(ticket_id: str, body: PersonIn, request: Request, db: DbSession, user: CurrentUserDep) -> TicketOut:
    """Adds or removes a watcher (yourself by default)."""
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    person = body.person_id or actor_id
    _check_person(db, person)
    watchers = list(t.watcher_ids or [])
    on = person in watchers
    t.watcher_ids = [w for w in watchers if w != person] if on else [*watchers, person]
    rules.add_event(t, actor_id, "watcher", f"{'Removed' if on else 'Added'} watcher {rules.person_name(db, person)}.")
    if not on:
        _tell(db, person, actor_id, f"Watching {t.id}", f"{t.title} — added by {rules.person_name(db, actor_id)}.", t.id)
    return _save(db, request, user, t, "ticket_watch", {"person_id": person, "watching": not on})


@router.put("/{ticket_id}/sub-owner", response_model=TicketOut)
def set_sub_owner(ticket_id: str, body: PersonIn, request: Request, db: DbSession, user: CurrentUserDep) -> TicketOut:
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    person = body.person_id or None
    if person and person == t.assignee_id:
        raise HTTPException(422, "The owner can't also be the sub-owner.")
    _plan_guard(db, t, actor_id)
    if person:
        _check_person(db, person)
    before = t.sub_owner_id
    t.sub_owner_id = person
    rules.add_event(t, actor_id, "task", f"Sub-owner set to {rules.person_name(db, person)}." if person else "Sub-owner removed.")
    _tell(db, person, actor_id, f"Sub-owner on {t.id}", f"{t.title} — from {rules.person_name(db, actor_id)}.", t.id)
    return _save(db, request, user, t, "ticket_sub_owner", {"from": before, "to": person})


@router.put("/{ticket_id}/priority", response_model=TicketOut)
def set_priority(ticket_id: str, body: PriorityIn, request: Request, db: DbSession, user: CurrentUserDep) -> TicketOut:
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    if body.priority not in rules.PRIORITIES:
        raise HTTPException(422, "Pick a priority.")
    _plan_guard(db, t, actor_id)
    if body.priority == t.priority:
        raise HTTPException(409, "The ticket already has that priority.")
    before = t.priority
    t.priority = body.priority
    t.response_due_at, t.resolve_due_at = rules.targets(db, t.type, t.priority,
                                                        rules._aware(t.created_at) or datetime.now(timezone.utc))
    rules.add_event(t, actor_id, "status", f"Priority {before} → {body.priority}.")
    for person in {t.assignee_id, t.sub_owner_id} - {None}:
        _tell(db, person, actor_id, f"{t.id} is now {body.priority} priority", t.title, t.id)
    return _save(db, request, user, t, "ticket_priority", {"from": before, "to": body.priority})


@router.put("/{ticket_id}/due", response_model=TicketOut)
def set_due(ticket_id: str, body: DueIn, request: Request, db: DbSession, user: CurrentUserDep) -> TicketOut:
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    _plan_guard(db, t, actor_id)
    before = t.due
    t.due = body.due
    rules.add_event(t, actor_id, "task", f"Deadline set to {body.due.isoformat()}." if body.due else "Deadline removed.")
    if body.due:
        for person in {t.assignee_id, t.sub_owner_id} - {None}:
            _tell(db, person, actor_id, f"Deadline on {t.id}", f"{t.title} — due {body.due.isoformat()}.", t.id)
    return _save(db, request, user, t, "ticket_due", {"from": before, "to": body.due})


@router.post("/{ticket_id}/tasks", response_model=TicketOut, status_code=status.HTTP_201_CREATED)
def add_task(ticket_id: str, body: TaskIn, request: Request, db: DbSession, user: CurrentUserDep) -> TicketOut:
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    title = body.title.strip()
    if not title:
        raise HTTPException(422, "Enter the task.")
    if t.due and body.due and body.due > t.due:
        raise HTTPException(422, "A task can't be due after the ticket's deadline.")
    _plan_guard(db, t, actor_id)
    owner = body.owner_id or None
    if owner:
        _check_person(db, owner)
    task = TicketTask(id=f"tt-{uuid.uuid4().hex[:12]}", position=max((k.position for k in t.tasks), default=-1) + 1,
                      title=title, owner_id=owner, due=body.due, done=False)
    t.tasks.append(task)
    rules.add_event(t, actor_id, "task", f"Added task: {title}.")
    _tell(db, owner, actor_id, f"Task on {t.id}", f"{title} — from {rules.person_name(db, actor_id)}.", t.id)
    return _save(db, request, user, t, "ticket_task_added", {"task_id": task.id, "title": title, "owner_id": owner, "due": body.due})


def _task(t: Ticket, task_id: str) -> TicketTask:
    task = next((k for k in t.tasks if k.id == task_id), None)
    if task is None:
        raise HTTPException(404, "Task not found.")
    return task


@router.post("/{ticket_id}/tasks/{task_id}/toggle", response_model=TicketOut)
def toggle_task(ticket_id: str, task_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> TicketOut:
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    task = _task(t, task_id)
    if task.owner_id != actor_id and not rules.can_plan(db, t, actor_id):
        raise HTTPException(403, "Only the task owner can tick this off.")
    if not rules.is_open(t):
        raise HTTPException(409, "This ticket is already resolved.")
    task.done = not task.done
    rules.add_event(t, actor_id, "task", f"{'Completed' if task.done else 'Reopened'} task: {task.title}.")
    if task.done:
        _tell(db, t.assignee_id, actor_id, f"Task done on {t.id}", f"{task.title} — {rules.person_name(db, actor_id)}.", t.id)
    return _save(db, request, user, t, "ticket_task_toggled", {"task_id": task.id, "done": task.done})


@router.delete("/{ticket_id}/tasks/{task_id}", response_model=TicketOut)
def remove_task(ticket_id: str, task_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> TicketOut:
    actor_id, role = _actor(user)
    t = _load(db, ticket_id, actor_id, role)
    task = _task(t, task_id)
    _plan_guard(db, t, actor_id)
    t.tasks.remove(task)
    rules.add_event(t, actor_id, "task", f"Removed task: {task.title}.")
    return _save(db, request, user, t, "ticket_task_removed", {"task_id": task.id, "title": task.title})

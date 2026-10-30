"""Work tickets shared between people (/tickets): list, raise, assign, status, comment, watch, sub-owner, deadline and
tasks. Same rules as src/data/ticketStore.ts. Every change is audited and the people concerned are notified.
Not the HR helpdesk (/desk)."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import Employee, Ticket, TicketTask
from app.services import tickets as rules
from app.services.activity import notify, record_audit

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


class PersonIn(BaseModel):
    person_id: str | None = Field(default=None, max_length=64)


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


def _out(db: Session, t: Ticket, actor_id: str) -> TicketOut:
    people = {t.requester_id, t.assignee_id, t.sub_owner_id, *(t.watcher_ids or []), *(k.owner_id for k in t.tasks),
              *(e.by_id for e in t.events)} - {None}
    return TicketOut(
        id=t.id, title=t.title, description=t.description or "", type=t.type, priority=t.priority, status=t.status,
        project_id=t.project_id, project_name=t.project_name, requester_id=t.requester_id, assignee_id=t.assignee_id,
        sub_owner_id=t.sub_owner_id, watcher_ids=list(t.watcher_ids or []), due=t.due,
        tasks=[TicketTaskOut(id=k.id, title=k.title, owner_id=k.owner_id, due=k.due, done=k.done) for k in t.tasks],
        activity=[TicketEventOut(id=str(e.id), at=e.at, by_id=e.by_id, kind=e.kind, text=e.text) for e in t.events],
        created_at=t.created_at, updated_at=t.updated_at,
        names={p: rules.person_name(db, p) for p in people},  # type: ignore[misc]
        can_plan=rules.can_plan(db, t, actor_id), next_statuses=rules.next_statuses(t, actor_id),
    )


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
    return _out(db, t, user.employee_id)


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
    rows = db.scalars(select(Ticket).options(selectinload(Ticket.tasks), selectinload(Ticket.events))
                      .order_by(Ticket.updated_at.desc())).all()
    return [_out(db, t, actor_id) for t in rows if rules.can_view(db, t, actor_id, role)]


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
        assignee = rules.QUEUE_OWNER.get(body.type)
    t = Ticket(id=rules.next_id(db), title=title, description=body.description.strip(), type=body.type,
               priority=body.priority, status="Open", project_id=body.project_id or None,
               project_name=(body.project_name if body.project_id else None), requester_id=actor_id,
               assignee_id=assignee, watcher_ids=[], due=body.due)
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
    if not rules.manages(db, actor_id, body.assignee_id):
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
    t.status = body.status
    rules.add_event(t, actor_id, "status", f"{before} → {body.status}")
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
    rules.add_event(t, actor_id, "comment", text)
    name = rules.person_name(db, actor_id)
    for person in {t.requester_id, t.assignee_id, t.sub_owner_id} - {None}:
        _tell(db, person, actor_id, f"Comment on {t.id}", f"{name}: {text[:140]}", t.id)
    return _save(db, request, user, t, "ticket_comment", {"text": text})


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

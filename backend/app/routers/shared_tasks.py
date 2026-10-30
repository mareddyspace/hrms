"""Tasks shared between a manager and their reports (/tasks).

The portal's task (src/model.ts Task) is stored as a JSON document. The server checks who may see and change it:
the owner, whoever created it, extra people / cc on it, and anyone above the owner in the reporting line. Only the
owner (own task) or a manager above them may create or hand it to someone. Changes are diffed so the other side is
notified (assigned, accepted, declined, status, comments, help, review).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import SharedTask
from app.services.activity import record_audit
from app.services.sharing import managed_ids, person_exists, person_name, tell

router = APIRouter(prefix="/tasks", tags=["tasks"])

STATUSES = {"scheduled", "open", "progress", "done"}
STATUS_LABEL = {"scheduled": "Scheduled", "open": "Open", "progress": "In progress", "done": "Done"}


class TaskOut(BaseModel):
    id: str
    data: dict[str, Any]
    version: int
    created_by: str
    updated_at: datetime


class TaskIn(BaseModel):
    data: dict[str, Any]
    base_version: int | None = None


def _me(user) -> str:  # type: ignore[no-untyped-def]
    if not user.employee_id:
        raise HTTPException(403, "Tasks need an employee profile.")
    return user.employee_id


def _people(data: dict[str, Any]) -> list[str]:
    ids = [*(data.get("peopleIds") or []), *(data.get("ccIds") or [])]
    return [str(p) for p in dict.fromkeys(ids) if isinstance(p, str) and p]


def _can_view(t: SharedTask, me: str, below: set[str]) -> bool:
    return me in {t.assignee_id, t.created_by, *(t.people_ids or [])} or t.assignee_id in below


def _out(t: SharedTask) -> TaskOut:
    return TaskOut(id=t.id, data=t.data, version=t.version, created_by=t.created_by, updated_at=t.updated_at)


@router.get("", response_model=list[TaskOut])
def list_tasks(db: DbSession, user: CurrentUserDep) -> list[TaskOut]:
    me = _me(user)
    below = managed_ids(db, user)
    rows = db.scalars(select(SharedTask).order_by(SharedTask.updated_at.desc())).all()
    return [_out(t) for t in rows if _can_view(t, me, below)]


def _valid(data: dict[str, Any], task_id: str) -> None:
    if str(data.get("id")) != task_id:
        raise HTTPException(422, "Task id does not match.")
    for key in ("code", "employeeId", "subject", "status"):
        if not isinstance(data.get(key), str) or not data[key].strip():
            raise HTTPException(422, f"{key}: required.")
    if data["status"] not in STATUSES:
        raise HTTPException(422, "Unknown status.")
    if len(str(data)) > 200_000:
        raise HTTPException(413, "This task is too large.")


def _due(data: dict[str, Any]) -> date | None:
    try:
        return date.fromisoformat(str(data.get("due"))[:10]) if data.get("due") else None
    except ValueError:
        return None


@router.put("/{task_id}", response_model=TaskOut)
def save_task(task_id: str, payload: TaskIn, request: Request, db: DbSession, user: CurrentUserDep) -> TaskOut:
    me = _me(user)
    data = payload.data
    _valid(data, task_id)
    below = managed_ids(db, user)
    assignee = data["employeeId"]
    if not person_exists(db, assignee):
        raise HTTPException(422, "Pick someone from your team.")
    t = db.get(SharedTask, task_id)
    my_name = person_name(db, me)
    href = f"/tasks?task={task_id}"
    code, subject = data["code"], data["subject"]

    if t is None:
        if assignee != me and assignee not in below:
            raise HTTPException(403, "You can only assign tasks to people who report to you.")
        t = SharedTask(id=task_id, code=code, assignee_id=assignee, created_by=me, people_ids=_people(data),
                       status=data["status"], due=_due(data), data=data, version=1)
        db.add(t)
        record_audit(db, actor_id=user.id, action="task.create", entity="task", entity_id=task_id, subject_id=assignee,
                     after={"code": code, "subject": subject, "assignee": assignee, "due": data.get("due")},
                     ip=client_ip(request))
        tell(db, assignee, me, f"Task assigned: {code}", f"{subject} — from {my_name}", href)
        db.commit()
        db.refresh(t)
        return _out(t)

    if not _can_view(t, me, below):
        raise HTTPException(404, "Task not found.")
    if me not in {t.assignee_id, t.created_by} and t.assignee_id not in below:
        raise HTTPException(403, "People on cc can view this task but not change it.")
    if payload.base_version is not None and payload.base_version != t.version:
        raise HTTPException(409, "Someone else changed this task. Showing the latest.")
    old = t.data or {}
    if assignee != t.assignee_id and assignee != me and assignee not in below:
        raise HTTPException(403, "You can only assign tasks to people who report to you.")

    # Who hears about this change: the owner when someone else acts, otherwise whoever assigned it.
    other = t.created_by if me == t.assignee_id else t.assignee_id
    news: list[str] = []
    if assignee != t.assignee_id:
        record_audit(db, actor_id=user.id, action="task.reassign", entity="task", entity_id=task_id,
                     subject_id=assignee, before={"assignee": t.assignee_id}, after={"assignee": assignee},
                     ip=client_ip(request))
        tell(db, assignee, me, f"Task assigned: {code}", f"{subject} — from {my_name}", href)
    if data["status"] != old.get("status"):
        news.append(f"now {STATUS_LABEL.get(data['status'], data['status'])}")
        record_audit(db, actor_id=user.id, action="task.status", entity="task", entity_id=task_id, subject_id=assignee,
                     before={"status": old.get("status")}, after={"status": data["status"]}, ip=client_ip(request))
    if data.get("due") != old.get("due"):
        news.append(f"due {data.get('due') or 'not set'}")
    seen = {a.get("id") for a in old.get("activity") or [] if isinstance(a, dict)}
    for a in data.get("activity") or []:
        if isinstance(a, dict) and a.get("id") not in seen and a.get("action") not in {"Progress updated", "Moved to progress"}:
            label = str(a.get("action") or "")
            if label and label.lower() not in " ".join(news).lower():
                news.append(label.lower() + (f": {a['detail']}" if a.get("detail") and label != "Assigned" else ""))
    old_comments = {c.get("id") for c in old.get("comments") or [] if isinstance(c, dict)}
    fresh = [c for c in data.get("comments") or [] if isinstance(c, dict) and c.get("id") not in old_comments]
    if fresh:
        news.append(f"comment: {str(fresh[-1].get('text', ''))[:120]}")
    if news and assignee == t.assignee_id:
        tell(db, other, me, f"{code}: {news[0]}", f"{subject} — {my_name}" + (f" · {'; '.join(news[1:])}" if news[1:] else ""), href)

    t.data = data
    t.code = code
    t.assignee_id = assignee
    t.people_ids = _people(data)
    t.status = data["status"]
    t.due = _due(data)
    t.version += 1
    db.commit()
    db.refresh(t)
    return _out(t)

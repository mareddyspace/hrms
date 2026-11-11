"""Tasks shared between a manager and their reports (/tasks).

The portal's task (src/model.ts Task) is stored as a JSON document. The server checks who may see and change it:
the owner, whoever created it, extra people / cc on it, and anyone above the owner in the reporting line. A task can
be given to yourself, someone below you, or a colleague on one of your projects (not someone above you); HR and admins
can give it to anyone. Followers (extra people / cc) may only add comments. Changes are diffed so the other side is
notified (assigned, accepted, declined, status, comments, help, review).
"""

from __future__ import annotations

import secrets
from datetime import date, datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import Project, ProjectMember, SharedTask
from app.services import storage
from app.services import work_attachments as files
from app.services.activity import record_audit
from app.services.uploads import UPLOAD_OPENAPI
from app.services.scope import HR_ACCESS_ROLES, manager_chain_ids
from app.services.sharing import managed_ids, person_exists, person_name, tell

router = APIRouter(prefix="/tasks", tags=["tasks"])

STATUSES = {"scheduled", "open", "progress", "done"}
ASSIGN_RULE = "You can assign tasks to yourself, people who report to you, or colleagues on your projects."
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


def project_colleagues(db, me: str) -> set[str]:  # type: ignore[no-untyped-def]
    """People who share an active project with me (members or the project's manager)."""
    mine = select(ProjectMember.project_id).where(ProjectMember.employee_id == me)
    projects = db.scalars(select(Project).where(Project.active.is_(True), Project.id.in_(mine))).all()
    ids = {p.manager_id for p in projects if p.manager_id}
    ids |= set(db.scalars(select(ProjectMember.employee_id).where(ProjectMember.project_id.in_([p.id for p in projects]))))
    ids.discard(me)
    return ids


def can_assign(db, user, me: str, below: set[str], person: str) -> bool:  # type: ignore[no-untyped-def]
    """Who a task may be given to: yourself, anyone below you, a colleague on one of your projects (but not someone
    above you in your reporting line), and anyone at all for HR and admins."""
    if person == me or person in below:
        return True
    if getattr(getattr(user, "account", None), "role", "") in HR_ACCESS_ROLES:
        return True
    return person in project_colleagues(db, me) and person not in manager_chain_ids(db, me)


# Fields a follower (collaborator or cc) changes when they only add a comment.
_COMMENT_ONLY = {"comments", "lastActivityAt", "activity"}


def _comment_only(old: dict[str, Any], new: dict[str, Any]) -> bool:
    """True when the change only appends comments (and their activity entries) to the task."""
    for key in set(old) | set(new):
        if key not in _COMMENT_ONLY and old.get(key) != new.get(key):
            return False
    for key in ("comments", "activity"):
        before = [x for x in old.get(key) or [] if isinstance(x, dict)]
        after = [x for x in new.get(key) or [] if isinstance(x, dict)]
        if after[: len(before)] != before:
            return False
    return len(new.get("comments") or []) > len(old.get("comments") or [])


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
    start, due = _day(data.get("startDate")), _day(data.get("due"))
    if start and due and due < start:
        raise HTTPException(422, "The due date can't be before the start date.")
    if data.get("priority") not in (None, "low", "medium", "high", "urgent"):
        raise HTTPException(422, "Pick a priority.")


def _day(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def _attachments(db, task_id: str) -> list[dict[str, Any]]:  # type: ignore[no-untyped-def]
    """The task's files as the portal shows them (data.attachments); the database is the source of truth."""
    return [{"id": a.id, "name": a.file_name, "at": a.created_at.isoformat(), "size": a.size_bytes,
             "contentType": a.content_type, "by": a.uploaded_by} for a in files.list_for(db, "task", task_id)]


def _fresh_comments(old: dict[str, Any], new: dict[str, Any]) -> list[dict[str, Any]]:
    seen = {c.get("id") for c in old.get("comments") or [] if isinstance(c, dict)}
    return [c for c in new.get("comments") or [] if isinstance(c, dict) and c.get("id") not in seen]


def _mentions(db, t: SharedTask, data: dict[str, Any], fresh: list[dict[str, Any]], me: str, my_name: str,
              below: set[str]) -> None:  # type: ignore[no-untyped-def]
    """@mentioned people hear about the comment; someone who could not see the task is added to its cc."""
    cc = [str(x) for x in data.get("ccIds") or [] if isinstance(x, str)]
    for c in fresh:
        for pid in dict.fromkeys(str(x) for x in (c.get("mentions") or []) if isinstance(x, str)):
            if pid == me or not person_exists(db, pid):
                continue
            if pid not in {t.assignee_id, t.created_by, *(t.people_ids or []), *cc}:
                cc.append(pid)
            tell(db, pid, me, f"{data['code']}: {my_name} mentioned you",
                 f"{data['subject']} — {str(c.get('text', ''))[:140]}", f"/tasks?task={t.id}")
    if cc != list(data.get("ccIds") or []):
        data["ccIds"] = cc


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
        if not can_assign(db, user, me, below, assignee):
            raise HTTPException(403, ASSIGN_RULE)
        data["attachments"] = []
        t = SharedTask(id=task_id, code=code, assignee_id=assignee, created_by=me, people_ids=_people(data),
                       status=data["status"], due=_due(data), data=data, version=1)
        db.add(t)
        _mentions(db, t, data, _fresh_comments({}, data), me, my_name, below)
        t.people_ids = _people(data)
        record_audit(db, actor_id=user.id, action="task.create", entity="task", entity_id=task_id, subject_id=assignee,
                     after={"code": code, "subject": subject, "assignee": assignee, "due": data.get("due")},
                     ip=client_ip(request))
        tell(db, assignee, me, f"Task assigned: {code}", f"{subject} — from {my_name}", href)
        db.commit()
        db.refresh(t)
        return _out(t)

    if not _can_view(t, me, below):
        raise HTTPException(404, "Task not found.")
    old = t.data or {}
    # Files are added and removed through /tasks/{id}/attachments; a save never changes them.
    data["attachments"] = _attachments(db, task_id)
    old = {**old, "attachments": data["attachments"]}
    editor = me in {t.assignee_id, t.created_by} or t.assignee_id in below
    if not editor and not _comment_only(old, data):
        raise HTTPException(403, "People following this task can comment on it but not change it.")
    if payload.base_version is not None and payload.base_version != t.version:
        raise HTTPException(409, "Someone else changed this task. Showing the latest.")
    if assignee != t.assignee_id and not can_assign(db, user, me, below, assignee):
        raise HTTPException(403, ASSIGN_RULE)
    if not editor:
        # A follower's comment: the owner and whoever assigned it hear about it.
        text = str((data.get("comments") or [{}])[-1].get("text", ""))[:120]
        for person in {t.assignee_id, t.created_by}:
            tell(db, person, me, f"{code}: comment from {my_name}", f"{subject} — {text}", href)
        _mentions(db, t, data, _fresh_comments(old, data), me, my_name, below)
        t.people_ids = _people(data)
        t.data = data
        t.version += 1
        db.commit()
        db.refresh(t)
        return _out(t)

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
    _mentions(db, t, data, fresh, me, my_name, below)
    if data.get("blocked") and not old.get("blocked"):
        record_audit(db, actor_id=user.id, action="task.blocked", entity="task", entity_id=task_id, subject_id=assignee,
                     after={"reason": str(data.get("blocked"))[:300]}, ip=client_ip(request))
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


# ---------- attachments ----------

def _viewable(db, user, task_id: str) -> tuple[SharedTask, str, set[str]]:  # type: ignore[no-untyped-def]
    me = _me(user)
    below = managed_ids(db, user)
    t = db.get(SharedTask, task_id)
    if t is None or not _can_view(t, me, below):
        raise HTTPException(404, "Task not found.")
    return t, me, below


def _touch(db, t: SharedTask, me: str, action: str, detail: str) -> None:  # type: ignore[no-untyped-def]
    data = dict(t.data or {})
    data["attachments"] = _attachments(db, t.id)
    now = datetime.now(timezone.utc).isoformat()
    data["activity"] = [*(data.get("activity") or []),
                        {"id": f"act-{secrets.token_hex(5)}", "at": now, "actor": person_name(db, me), "action": action,
                         "detail": detail}]
    data["lastActivityAt"] = now
    t.data = data
    t.version += 1


@router.post("/{task_id}/attachments", response_model=TaskOut, status_code=201, openapi_extra=UPLOAD_OPENAPI)
async def upload_attachment(task_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                            filename: Annotated[str | None, Query(max_length=255)] = None) -> TaskOut:
    """Anyone who can see the task may attach a file (PDF or image, up to 5 MB)."""
    t, me, _ = _viewable(db, user, task_id)
    row = await files.add(db, request, "task", t.id, me, filename)
    db.flush()
    _touch(db, t, me, "File attached", row.file_name)
    for person in {t.assignee_id, t.created_by}:
        tell(db, person, me, f"{t.code}: file added", f"{person_name(db, me)} attached {row.file_name}",
             f"/tasks?task={t.id}")
    record_audit(db, actor_id=user.id, action="task.attachment_added", entity="task", entity_id=t.id,
                 subject_id=t.assignee_id, after={"file": row.file_name, "size": row.size_bytes}, ip=client_ip(request))
    try:
        db.commit()
    except Exception:
        storage.delete_quietly(row.storage_path)
        raise
    db.refresh(t)
    return _out(t)


@router.get("/{task_id}/attachments/{file_id}/file")
def download_attachment(task_id: str, file_id: str, db: DbSession, user: CurrentUserDep) -> Response:
    t, _, _ = _viewable(db, user, task_id)
    return files.download(files.get(db, "task", t.id, file_id))


@router.delete("/{task_id}/attachments/{file_id}", response_model=TaskOut)
def delete_attachment(task_id: str, file_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> TaskOut:
    """The person who added the file, or anyone who may change the task, removes it."""
    t, me, below = _viewable(db, user, task_id)
    row = files.get(db, "task", t.id, file_id)
    editor = me in {t.assignee_id, t.created_by} or t.assignee_id in below
    if row.uploaded_by != me and not editor:
        raise HTTPException(403, "Only the person who added the file, or the task owner, can remove it.")
    path, name = row.storage_path, row.file_name
    db.delete(row)
    db.flush()
    _touch(db, t, me, "File removed", name)
    record_audit(db, actor_id=user.id, action="task.attachment_removed", entity="task", entity_id=t.id,
                 subject_id=t.assignee_id, after={"file": name}, ip=client_ip(request))
    db.commit()
    storage.delete_quietly(path)
    db.refresh(t)
    return _out(t)

"""Projects people work on (/projects): details, milestones, tasks, updates and comments, documents and activity,
with hours logged and approved from timesheets (migration 0025).

Members of a project see it; its manager (projects.manager_id or a "lead" member) and HR / admin edit it. A task's
assignee may change its status. Any member may comment and add documents."""

from __future__ import annotations

import secrets
from collections import defaultdict
from datetime import date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import (
    Employee, Project, ProjectActivity, ProjectDocument, ProjectMember, ProjectMilestone, ProjectPost, ProjectTask,
    TimesheetDay, TimesheetEntry, TimesheetWeek,
)
from app.services import storage
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, me
from app.services.scope import HR_ROLES
from app.services.uploads import UPLOAD_OPENAPI, clean_name, read_upload

router = APIRouter(prefix="/projects", tags=["projects"])
ROUTE = "/projects"
ADMIN_ROLES = frozenset({"admin", "super_admin"})
TASK_STATUSES = ("todo", "in_progress", "in_review", "done")
TaskStatus = Literal["todo", "in_progress", "in_review", "done"]


# ---------- shapes ----------
class MilestoneOut(BaseModel):
    id: str
    name: str
    description: str | None = None
    due_date: date
    completed_on: date | None = None


class TaskOut(BaseModel):
    id: str
    code: str
    title: str
    description: str | None = None
    assignee_id: str | None = None
    assignee_name: str | None = None
    milestone_id: str | None = None
    due_date: date | None = None
    estimate_hours: float = 0
    status: str
    logged_hours: float = 0


class MemberOut(BaseModel):
    employee_id: str
    name: str
    job_title: str = ""
    role: str
    title: str | None = None
    responsibilities: str | None = None
    budget_hours: float | None = None
    logged_hours: float = 0


class PostOut(BaseModel):
    id: str
    author_id: str
    author_name: str
    kind: str
    body: str
    created_at: datetime


class DocumentOut(BaseModel):
    id: str
    title: str
    url: str | None = None
    file_name: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    added_by: str
    added_by_name: str
    created_at: datetime


class ActivityOut(BaseModel):
    id: str
    actor_name: str
    text: str
    on: date


class ProjectOutFull(BaseModel):
    id: str
    code: str
    name: str
    client: str | None = None
    active: bool
    billable_default: bool
    description: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    budget_hours: float | None = None
    manager_id: str | None = None
    manager_name: str | None = None
    can_edit: bool = False
    my_title: str | None = None
    my_responsibilities: str | None = None
    my_budget_hours: float | None = None
    logged_hours: float = 0
    approved_hours: float = 0
    my_logged_hours: float = 0
    my_approved_hours: float = 0
    members: list[MemberOut] = []
    milestones: list[MilestoneOut] = []
    tasks: list[TaskOut] = []
    posts: list[PostOut] = []
    documents: list[DocumentOut] = []
    activity: list[ActivityOut] = []


class ProjectIn(BaseModel):
    description: str | None = Field(default=None, max_length=4000)
    start_date: date | None = None
    end_date: date | None = None
    budget_hours: float | None = Field(default=None, ge=0, le=1_000_000)
    active: bool | None = None


class MilestoneIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    due_date: date
    completed: bool = False


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    assignee_id: str | None = Field(default=None, max_length=64)
    milestone_id: str | None = Field(default=None, max_length=64)
    due_date: date | None = None
    estimate_hours: float = Field(default=0, ge=0, le=10_000)
    status: TaskStatus = "todo"


class TaskStatusIn(BaseModel):
    status: TaskStatus


class MemberIn(BaseModel):
    title: str | None = Field(default=None, max_length=100)
    responsibilities: str | None = Field(default=None, max_length=4000)
    budget_hours: float | None = Field(default=None, ge=0, le=100_000)


class PostIn(BaseModel):
    kind: Literal["update", "comment"] = "comment"
    body: str = Field(min_length=1, max_length=4000)


class LinkIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    url: str = Field(min_length=8, max_length=500, pattern=r"^https?://")


# ---------- access ----------
def _role(user: CurrentUser) -> str:
    return user.account.role


def _is_hr_admin(user: CurrentUser) -> bool:
    return _role(user) in HR_ROLES or _role(user) in ADMIN_ROLES


def _membership(db: DbSession, project_id: str, employee_id: str | None) -> ProjectMember | None:
    return db.get(ProjectMember, (project_id, employee_id)) if employee_id else None


def _can_edit(db: DbSession, user: CurrentUser, project: Project) -> bool:
    if _is_hr_admin(user) or (project.manager_id and project.manager_id == user.employee_id):
        return True
    m = _membership(db, project.id, user.employee_id)
    return m is not None and m.role == "lead"


def _visible(db: DbSession, user: CurrentUser, project_id: str) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise NOT_FOUND
    if _is_hr_admin(user) or project.manager_id == user.employee_id or _membership(db, project.id, user.employee_id):
        return project
    raise NOT_FOUND


def _editable(db: DbSession, user: CurrentUser, project_id: str) -> Project:
    project = _visible(db, user, project_id)
    if not _can_edit(db, user, project):
        raise HTTPException(403, "Only the project manager can change this.")
    return project


def _name(db: DbSession, employee_id: str | None) -> str:
    emp = db.get(Employee, employee_id) if employee_id else None
    return emp.full_name if emp else (employee_id or "")


def _member_ids(db: DbSession, project_id: str) -> list[str]:
    return list(db.scalars(select(ProjectMember.employee_id).where(ProjectMember.project_id == project_id)))


def _log(db: DbSession, project_id: str, actor_id: str | None, text: str) -> None:
    db.add(ProjectActivity(id=f"pa-{secrets.token_hex(6)}", project_id=project_id, actor_id=actor_id, text=text[:400]))


def _tell_members(db: DbSession, project: Project, actor_id: str | None, title: str, body: str) -> None:
    for emp_id in set(_member_ids(db, project.id)) | ({project.manager_id} if project.manager_id else set()):
        if emp_id and emp_id != actor_id:
            notify(db, recipient_id=emp_id, title=title, body=body, href=f"{ROUTE}?id={project.id}")


def _audit(db: DbSession, user: CurrentUser, request: Request, action: str, project: Project, after: dict | None = None) -> None:
    record_audit(db, actor_id=user.id, action=action, entity="project", entity_id=project.id, after=after or {},
                 ip=client_ip(request))


# ---------- hours ----------
def _hours(db: DbSession, project_ids: list[str]) -> tuple[dict, dict, dict]:
    """Per project: {employee: logged}, {employee: approved}, {task id: logged}. A day counts as approved when its
    daily timesheet is approved (or it was in a week approved before timesheets went daily)."""
    if not project_ids:
        return {}, {}, {}
    rows = db.execute(
        select(TimesheetEntry, TimesheetWeek.status)
        .join(TimesheetWeek, TimesheetWeek.id == TimesheetEntry.week_id)
        .where(TimesheetEntry.project_id.in_(project_ids))
    ).all()
    day_status = {
        (d.employee_id, d.work_date): d.status
        for d in db.scalars(select(TimesheetDay).where(TimesheetDay.employee_id.in_({e.employee_id for e, _ in rows})))
    } if rows else {}
    logged: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    approved: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    by_task: dict[str, float] = defaultdict(float)
    for entry, week_status in rows:
        h = float(entry.hours)
        logged[entry.project_id][entry.employee_id] += h
        if day_status.get((entry.employee_id, entry.work_date)) == "approved" or week_status == "approved":
            approved[entry.project_id][entry.employee_id] += h
        if entry.work_type == "task" and entry.work_id:
            by_task[entry.work_id] += h
    return logged, approved, by_task


def _out(db: DbSession, user: CurrentUser, project: Project, hours: tuple[dict, dict, dict], full: bool) -> ProjectOutFull:
    logged, approved, by_task = hours
    me_id = user.employee_id
    mine = _membership(db, project.id, me_id)
    members = db.scalars(select(ProjectMember).where(ProjectMember.project_id == project.id)).all()
    emps = {e.id: e for e in db.scalars(select(Employee).where(Employee.id.in_([m.employee_id for m in members] +
                                                                                 [project.manager_id or ""])))}
    p_logged, p_approved = logged.get(project.id, {}), approved.get(project.id, {})
    out = ProjectOutFull(
        id=project.id, code=project.code, name=project.name, client=project.client, active=project.active,
        billable_default=project.billable_default, description=project.description, start_date=project.start_date,
        end_date=project.end_date, budget_hours=project.budget_hours, manager_id=project.manager_id,
        manager_name=emps[project.manager_id].full_name if project.manager_id in emps else None,
        can_edit=_can_edit(db, user, project),
        my_title=mine.title if mine else None, my_responsibilities=mine.responsibilities if mine else None,
        my_budget_hours=mine.budget_hours if mine else None,
        logged_hours=round(sum(p_logged.values()), 2), approved_hours=round(sum(p_approved.values()), 2),
        my_logged_hours=round(p_logged.get(me_id or "", 0), 2), my_approved_hours=round(p_approved.get(me_id or "", 0), 2),
    )
    out.members = sorted(
        [MemberOut(employee_id=m.employee_id, name=emps[m.employee_id].full_name if m.employee_id in emps else m.employee_id,
                   job_title=emps[m.employee_id].job_title if m.employee_id in emps else "", role=m.role, title=m.title,
                   responsibilities=m.responsibilities, budget_hours=m.budget_hours,
                   logged_hours=round(p_logged.get(m.employee_id, 0), 2)) for m in members],
        key=lambda m: (m.employee_id != project.manager_id, m.role != "lead", m.name),
    )
    out.milestones = [MilestoneOut.model_validate(m, from_attributes=True) for m in db.scalars(
        select(ProjectMilestone).where(ProjectMilestone.project_id == project.id).order_by(ProjectMilestone.due_date))]
    names = {m.employee_id: m.name for m in out.members}
    out.tasks = [
        TaskOut(id=t.id, code=t.code, title=t.title, description=t.description, assignee_id=t.assignee_id,
                assignee_name=names.get(t.assignee_id or "") or (_name(db, t.assignee_id) if t.assignee_id else None),
                milestone_id=t.milestone_id, due_date=t.due_date, estimate_hours=float(t.estimate_hours or 0),
                status=t.status, logged_hours=round(by_task.get(t.id, 0), 2))
        for t in db.scalars(select(ProjectTask).where(ProjectTask.project_id == project.id)
                            .order_by(ProjectTask.due_date.is_(None), ProjectTask.due_date, ProjectTask.code))
    ]
    if full:
        out.posts = [PostOut(id=p.id, author_id=p.author_id, author_name=_name(db, p.author_id), kind=p.kind, body=p.body,
                             created_at=p.created_at)
                     for p in db.scalars(select(ProjectPost).where(ProjectPost.project_id == project.id)
                                         .order_by(ProjectPost.created_at.desc()).limit(100))]
        out.documents = [DocumentOut(id=d.id, title=d.title, url=d.url, file_name=d.file_name, content_type=d.content_type,
                                     size_bytes=d.size_bytes, added_by=d.added_by, added_by_name=_name(db, d.added_by),
                                     created_at=d.created_at)
                         for d in db.scalars(select(ProjectDocument).where(ProjectDocument.project_id == project.id)
                                             .order_by(ProjectDocument.created_at.desc()))]
        acts = db.scalars(select(ProjectActivity).where(ProjectActivity.project_id == project.id)
                          .order_by(ProjectActivity.created_at.desc()).limit(60)).all()
        out.activity = sorted(
            [ActivityOut(id=a.id, actor_name=_name(db, a.actor_id) if a.actor_id else "TimeZ", text=a.text,
                         on=a.happened_on or a.created_at.date()) for a in acts],
            key=lambda a: a.on, reverse=True)[:30]
    return out


# ---------- reads ----------
@router.get("", response_model=list[ProjectOutFull])
def list_projects(db: DbSession, user: CurrentUserDep, scope: Literal["mine", "all"] = "mine") -> list[ProjectOutFull]:
    emp = me(user)
    if scope == "all" and _is_hr_admin(user):
        projects = list(db.scalars(select(Project).order_by(Project.code)))
    else:
        ids = set(_member_ids_for(db, emp.id)) | set(db.scalars(select(Project.id).where(Project.manager_id == emp.id)))
        projects = list(db.scalars(select(Project).where(Project.id.in_(ids)).order_by(Project.code))) if ids else []
    hours = _hours(db, [p.id for p in projects])
    return [_out(db, user, p, hours, full=False) for p in projects]


def _member_ids_for(db: DbSession, employee_id: str) -> list[str]:
    return list(db.scalars(select(ProjectMember.project_id).where(ProjectMember.employee_id == employee_id)))


@router.get("/{project_id}", response_model=ProjectOutFull)
def get_project(project_id: str, db: DbSession, user: CurrentUserDep) -> ProjectOutFull:
    project = _visible(db, user, project_id)
    return _out(db, user, project, _hours(db, [project.id]), full=True)


def _full(db: DbSession, user: CurrentUser, project: Project) -> ProjectOutFull:
    db.commit()
    return _out(db, user, project, _hours(db, [project.id]), full=True)


# ---------- project ----------
@router.put("/{project_id}", response_model=ProjectOutFull)
def update_project(project_id: str, body: ProjectIn, request: Request, db: DbSession, user: CurrentUserDep) -> ProjectOutFull:
    project = _editable(db, user, project_id)
    if body.start_date and body.end_date and body.end_date < body.start_date:
        raise HTTPException(422, "The end date must be on or after the start date.")
    changes = []
    for field in ("description", "start_date", "end_date", "budget_hours", "active"):
        value = getattr(body, field)
        if field in body.model_fields_set and value != getattr(project, field):
            if field == "active" and value is None:
                continue
            setattr(project, field, value.strip() if isinstance(value, str) else value)
            changes.append(field.replace("_", " "))
    if not changes:
        return _full(db, user, project)
    if "end date" in changes:
        _tell_members(db, project, user.employee_id, f"{project.name}: deadline changed",
                      f"The project now ends on {project.end_date}." if project.end_date else "The project has no end date now.")
    _log(db, project.id, user.employee_id, f"Updated the project ({', '.join(changes)})")
    _audit(db, user, request, "project_updated", project, {"fields": changes})
    return _full(db, user, project)


@router.put("/{project_id}/members/{employee_id}", response_model=ProjectOutFull)
def update_member(project_id: str, employee_id: str, body: MemberIn, request: Request, db: DbSession,
                  user: CurrentUserDep) -> ProjectOutFull:
    project = _editable(db, user, project_id)
    member = _membership(db, project.id, employee_id)
    if member is None:
        raise NOT_FOUND
    member.title = (body.title or "").strip() or None
    member.responsibilities = (body.responsibilities or "").strip() or None
    member.budget_hours = body.budget_hours
    if employee_id != user.employee_id:
        notify(db, recipient_id=employee_id, title=f"{project.name}: your role was updated",
               body=f"Role: {member.title or member.role}.", href=f"{ROUTE}?id={project.id}")
    _log(db, project.id, user.employee_id, f"Updated {_name(db, employee_id)}'s role")
    _audit(db, user, request, "project_member_updated", project, {"employee_id": employee_id})
    return _full(db, user, project)


# ---------- milestones ----------
def _milestone(db: DbSession, project: Project, milestone_id: str) -> ProjectMilestone:
    row = db.get(ProjectMilestone, milestone_id)
    if row is None or row.project_id != project.id:
        raise NOT_FOUND
    return row


@router.post("/{project_id}/milestones", response_model=ProjectOutFull, status_code=status.HTTP_201_CREATED)
def add_milestone(project_id: str, body: MilestoneIn, request: Request, db: DbSession, user: CurrentUserDep) -> ProjectOutFull:
    project = _editable(db, user, project_id)
    row = ProjectMilestone(id=f"pm-{secrets.token_hex(6)}", project_id=project.id, name=body.name.strip(),
                           description=(body.description or "").strip() or None, due_date=body.due_date,
                           completed_on=date.today() if body.completed else None)
    db.add(row)
    _tell_members(db, project, user.employee_id, f"{project.name}: new milestone", f"{row.name}, due {row.due_date}.")
    _log(db, project.id, user.employee_id, f"Added milestone “{row.name}” due {row.due_date:%d %b %Y}")
    _audit(db, user, request, "project_milestone_added", project, {"milestone": row.name})
    return _full(db, user, project)


@router.put("/{project_id}/milestones/{milestone_id}", response_model=ProjectOutFull)
def update_milestone(project_id: str, milestone_id: str, body: MilestoneIn, request: Request, db: DbSession,
                     user: CurrentUserDep) -> ProjectOutFull:
    project = _editable(db, user, project_id)
    row = _milestone(db, project, milestone_id)
    was_done, old_due = row.completed_on is not None, row.due_date
    row.name, row.description, row.due_date = body.name.strip(), (body.description or "").strip() or None, body.due_date
    if body.completed and not was_done:
        row.completed_on = date.today()
        _tell_members(db, project, user.employee_id, f"{project.name}: milestone completed", f"“{row.name}” is done.")
        _log(db, project.id, user.employee_id, f"Completed milestone “{row.name}”")
    elif not body.completed and was_done:
        row.completed_on = None
        _log(db, project.id, user.employee_id, f"Reopened milestone “{row.name}”")
    if old_due != row.due_date:
        _tell_members(db, project, user.employee_id, f"{project.name}: milestone moved",
                      f"“{row.name}” is now due {row.due_date} (was {old_due}).")
        _log(db, project.id, user.employee_id, f"Moved “{row.name}” to {row.due_date:%d %b %Y}")
    _audit(db, user, request, "project_milestone_updated", project, {"milestone": row.name, "done": body.completed})
    return _full(db, user, project)


@router.delete("/{project_id}/milestones/{milestone_id}", response_model=ProjectOutFull)
def delete_milestone(project_id: str, milestone_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> ProjectOutFull:
    project = _editable(db, user, project_id)
    row = _milestone(db, project, milestone_id)
    for task in db.scalars(select(ProjectTask).where(ProjectTask.milestone_id == row.id)):
        task.milestone_id = None
    _log(db, project.id, user.employee_id, f"Removed milestone “{row.name}”")
    _audit(db, user, request, "project_milestone_deleted", project, {"milestone": row.name})
    db.delete(row)
    return _full(db, user, project)


# ---------- tasks ----------
def _task(db: DbSession, project: Project, task_id: str) -> ProjectTask:
    row = db.get(ProjectTask, task_id)
    if row is None or row.project_id != project.id:
        raise NOT_FOUND
    return row


def _check_task(db: DbSession, project: Project, body: TaskIn) -> None:
    if body.assignee_id and _membership(db, project.id, body.assignee_id) is None:
        raise HTTPException(422, "Assign the task to someone on the project.")
    if body.milestone_id:
        row = db.get(ProjectMilestone, body.milestone_id)
        if row is None or row.project_id != project.id:
            raise HTTPException(422, "Pick a milestone of this project.")


@router.post("/{project_id}/tasks", response_model=ProjectOutFull, status_code=status.HTTP_201_CREATED)
def add_task(project_id: str, body: TaskIn, request: Request, db: DbSession, user: CurrentUserDep) -> ProjectOutFull:
    project = _editable(db, user, project_id)
    _check_task(db, project, body)
    count = len(db.scalars(select(ProjectTask.id).where(ProjectTask.project_id == project.id)).all())
    prefix = project.code.split("-")[0][:6].upper() or "PRJ"
    code = f"{prefix}-{100 + count + 1}"
    while db.scalar(select(ProjectTask.id).where(ProjectTask.project_id == project.id, ProjectTask.code == code)):
        count += 1
        code = f"{prefix}-{100 + count + 1}"
    row = ProjectTask(id=f"pt-{secrets.token_hex(6)}", project_id=project.id, code=code, title=body.title.strip(),
                      description=(body.description or "").strip() or None, assignee_id=body.assignee_id,
                      milestone_id=body.milestone_id, due_date=body.due_date, estimate_hours=body.estimate_hours,
                      status=body.status)
    db.add(row)
    if row.assignee_id and row.assignee_id != user.employee_id:
        notify(db, recipient_id=row.assignee_id, title=f"{project.name}: task assigned to you",
               body=f"{code} {row.title}" + (f", due {row.due_date}." if row.due_date else "."), href=f"{ROUTE}?id={project.id}")
    _log(db, project.id, user.employee_id, f"Added task {code} “{row.title}”")
    _audit(db, user, request, "project_task_added", project, {"task": code})
    return _full(db, user, project)


@router.put("/{project_id}/tasks/{task_id}", response_model=ProjectOutFull)
def update_task(project_id: str, task_id: str, body: TaskIn, request: Request, db: DbSession, user: CurrentUserDep) -> ProjectOutFull:
    project = _editable(db, user, project_id)
    row = _task(db, project, task_id)
    _check_task(db, project, body)
    old_assignee = row.assignee_id
    row.title, row.description = body.title.strip(), (body.description or "").strip() or None
    row.assignee_id, row.milestone_id, row.due_date = body.assignee_id, body.milestone_id, body.due_date
    row.estimate_hours, row.status = body.estimate_hours, body.status
    if row.assignee_id and row.assignee_id != old_assignee and row.assignee_id != user.employee_id:
        notify(db, recipient_id=row.assignee_id, title=f"{project.name}: task assigned to you", body=f"{row.code} {row.title}",
               href=f"{ROUTE}?id={project.id}")
    _log(db, project.id, user.employee_id, f"Updated task {row.code}")
    _audit(db, user, request, "project_task_updated", project, {"task": row.code})
    return _full(db, user, project)


@router.post("/{project_id}/tasks/{task_id}/status", response_model=ProjectOutFull)
def set_task_status(project_id: str, task_id: str, body: TaskStatusIn, request: Request, db: DbSession,
                    user: CurrentUserDep) -> ProjectOutFull:
    """The assignee (or the project manager) moves a task along."""
    project = _visible(db, user, project_id)
    row = _task(db, project, task_id)
    if row.assignee_id != user.employee_id and not _can_edit(db, user, project):
        raise HTTPException(403, "Only the person the task is assigned to, or the project manager, can change its status.")
    if row.status == body.status:
        return _full(db, user, project)
    label = body.status.replace("_", " ")
    row.status = body.status
    if project.manager_id and project.manager_id != user.employee_id:
        notify(db, recipient_id=project.manager_id, title=f"{project.name}: {row.code} is {label}",
               body=f"{_name(db, user.employee_id)} moved “{row.title}” to {label}.", href=f"{ROUTE}?id={project.id}")
    _log(db, project.id, user.employee_id, f"Moved {row.code} to {label}")
    _audit(db, user, request, "project_task_status", project, {"task": row.code, "status": body.status})
    return _full(db, user, project)


@router.delete("/{project_id}/tasks/{task_id}", response_model=ProjectOutFull)
def delete_task(project_id: str, task_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> ProjectOutFull:
    project = _editable(db, user, project_id)
    row = _task(db, project, task_id)
    _log(db, project.id, user.employee_id, f"Removed task {row.code}")
    _audit(db, user, request, "project_task_deleted", project, {"task": row.code})
    db.delete(row)
    return _full(db, user, project)


# ---------- updates and comments ----------
@router.post("/{project_id}/posts", response_model=ProjectOutFull, status_code=status.HTTP_201_CREATED)
def add_post(project_id: str, body: PostIn, request: Request, db: DbSession, user: CurrentUserDep) -> ProjectOutFull:
    project = _visible(db, user, project_id)
    if body.kind == "update" and not _can_edit(db, user, project):
        raise HTTPException(403, "Only the project manager posts status updates. Add a comment instead.")
    emp = me(user)
    row = ProjectPost(id=f"pp-{secrets.token_hex(6)}", project_id=project.id, author_id=emp.id, kind=body.kind,
                      body=body.body.strip())
    db.add(row)
    if body.kind == "update":
        _tell_members(db, project, emp.id, f"{project.name}: status update", row.body[:180])
    elif project.manager_id and project.manager_id != emp.id:
        notify(db, recipient_id=project.manager_id, title=f"{project.name}: new comment",
               body=f"{emp.full_name}: {row.body[:160]}", href=f"{ROUTE}?id={project.id}")
    _log(db, project.id, emp.id, "Posted a status update" if body.kind == "update" else "Commented")
    _audit(db, user, request, "project_post_added", project, {"kind": body.kind})
    return _full(db, user, project)


@router.delete("/{project_id}/posts/{post_id}", response_model=ProjectOutFull)
def delete_post(project_id: str, post_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> ProjectOutFull:
    project = _visible(db, user, project_id)
    row = db.get(ProjectPost, post_id)
    if row is None or row.project_id != project.id:
        raise NOT_FOUND
    if row.author_id != user.employee_id and not _can_edit(db, user, project):
        raise HTTPException(403, "You can delete only your own posts.")
    _audit(db, user, request, "project_post_deleted", project, {"post": row.id})
    db.delete(row)
    return _full(db, user, project)


# ---------- documents ----------
def _document(db: DbSession, project: Project, doc_id: str) -> ProjectDocument:
    row = db.get(ProjectDocument, doc_id)
    if row is None or row.project_id != project.id:
        raise NOT_FOUND
    return row


@router.post("/{project_id}/documents/link", response_model=ProjectOutFull, status_code=status.HTTP_201_CREATED)
def add_link(project_id: str, body: LinkIn, request: Request, db: DbSession, user: CurrentUserDep) -> ProjectOutFull:
    project = _visible(db, user, project_id)
    emp = me(user)
    db.add(ProjectDocument(id=f"pd-{secrets.token_hex(6)}", project_id=project.id, title=body.title.strip(),
                           url=body.url.strip(), added_by=emp.id))
    _log(db, project.id, emp.id, f"Added document “{body.title.strip()}”")
    _audit(db, user, request, "project_document_added", project, {"title": body.title})
    return _full(db, user, project)


@router.post("/{project_id}/documents", response_model=ProjectOutFull, status_code=status.HTTP_201_CREATED,
             openapi_extra=UPLOAD_OPENAPI)
async def upload_document(project_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                          filename: Annotated[str | None, Query(max_length=255)] = None,
                          title: Annotated[str | None, Query(max_length=200)] = None) -> ProjectOutFull:
    project = _visible(db, user, project_id)
    emp = me(user)
    data, content_type, sha = await read_upload(request)
    doc_id = f"pd-{secrets.token_hex(6)}"
    stored = storage.save(f"projects/{project.id}", doc_id, data, content_type, sha)
    name = clean_name(filename, content_type, "document")
    db.add(ProjectDocument(id=doc_id, project_id=project.id, title=(title or "").strip() or name, file_name=name,
                           content_type=stored.content_type, size_bytes=stored.size_bytes,
                           storage_path=stored.relative_path, added_by=emp.id))
    _log(db, project.id, emp.id, f"Uploaded “{(title or '').strip() or name}”")
    _audit(db, user, request, "project_document_added", project, {"file": name})
    try:
        return _full(db, user, project)
    except Exception:
        storage.delete_quietly(stored.relative_path)
        raise


@router.get("/{project_id}/documents/{doc_id}/file")
def download_document(project_id: str, doc_id: str, db: DbSession, user: CurrentUserDep) -> Response:
    project = _visible(db, user, project_id)
    row = _document(db, project, doc_id)
    if not row.storage_path:
        raise NOT_FOUND
    try:
        return storage.download(row.storage_path, media_type=row.content_type or "application/octet-stream",
                                filename=row.file_name)
    except storage.FileMissing as exc:
        raise HTTPException(410, "The file is no longer available.") from exc
    except storage.StorageError as exc:
        raise NOT_FOUND from exc


@router.delete("/{project_id}/documents/{doc_id}", response_model=ProjectOutFull)
def delete_document(project_id: str, doc_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> ProjectOutFull:
    project = _visible(db, user, project_id)
    row = _document(db, project, doc_id)
    if row.added_by != user.employee_id and not _can_edit(db, user, project):
        raise HTTPException(403, "Only the person who added it, or the project manager, can remove a document.")
    path = row.storage_path
    _log(db, project.id, user.employee_id, f"Removed document “{row.title}”")
    _audit(db, user, request, "project_document_deleted", project, {"title": row.title})
    db.delete(row)
    out = _full(db, user, project)
    if path:
        storage.delete_quietly(path)
    return out

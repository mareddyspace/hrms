"""What the HR Copilot may know about the person asking: built only from data their role and data scope allow.

- everyone: their own profile basics (no pay, no personal contact details), own leave balances and recent
  requests, this month's attendance summary, timesheet status and how many approvals wait on them
- people with reports: a team overview (counts, who in their line is on leave today)
- HR / admin / executive: organisation-level counts (headcount by country / department), limited to the
  countries their data scope allows

Never: anyone's pay, case notes, reasons people gave, or personal details of others.
Policy sections come from app/services/policy_kb.py.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.deps import CurrentUser
from app.models import AttendanceCorrection, AttendanceSession, Employee, LeaveRequest, TimesheetWeek
from app.services import approvals as approvals_engine
from app.services import policy_kb
from app.services.attendance import local_today, month_summary
from app.services.decisions import decidable_filter
from app.services.headcount import started_clause
from app.services.leave import balances
from app.services.timesheets import week_start_of, week_total

ORG_ROLES = frozenset({"hr_admin", "hr", "hrbp", "admin", "executive"})
_LEFT_STATUSES = ("terminated", "exited", "resigned", "inactive", "separated")


@dataclass
class Source:
    """A policy section ("leave-IN#applying") or a portal page the personal data came from ("/leave")."""

    title: str
    ref: str
    kind: str = "data"  # policy | data
    version: str | None = None
    effective: str | None = None
    section: str | None = None


@dataclass
class CopilotContext:
    blocks: list[str] = field(default_factory=list)
    sources: list[Source] = field(default_factory=list)  # the policy sections used (shown to the user)
    data_refs: list[Source] = field(default_factory=list)  # portal pages the personal data came from

    def text(self) -> str:
        return "\n\n".join(self.blocks)


def _fmt(n: float) -> str:
    return f"{n:g}"


def _profile_block(db: Session, me: Employee, role: str) -> str:
    manager = db.get(Employee, me.manager_id) if me.manager_id else None
    return (
        "ABOUT THE PERSON ASKING\n"
        f"- Name: {me.preferred_name or me.full_name}\n- Role in the portal: {role}\n"
        f"- Job title: {me.job_title}; department: {me.department}; location: {me.location}; country: {me.country_code}\n"
        f"- Employment type: {me.employment_type}; joined: {me.joining_date.isoformat()}\n"
        f"- Manager: {manager.full_name if manager else 'none'}"
    )


def _leave_block(db: Session, me: Employee) -> str:
    today = local_today(me)
    lines = [f"YOUR LEAVE (year {today.year}, as of {today.isoformat()})"]
    for row in balances(db, me):
        lines.append(
            f"- {row.name}: {_fmt(row.quota)} days this year ({_fmt(row.carried_over)} carried over), "
            f"{_fmt(row.used)} used, {_fmt(row.pending)} pending, {_fmt(row.available)} available to apply"
        )
    recent = db.scalars(
        select(LeaveRequest).where(LeaveRequest.employee_id == me.id).order_by(LeaveRequest.from_date.desc()).limit(5)
    ).all()
    if recent:
        lines.append("Recent requests:")
        for r in recent:
            lines.append(f"- {r.leave_code} {r.from_date.isoformat()} to {r.to_date.isoformat()}, {_fmt(r.days)} day(s), {r.status}")
    return "\n".join(lines)


def _attendance_block(db: Session, me: Employee) -> str:
    today = local_today(me)
    s = month_summary(db, me, today.year, today.month)
    return (
        f"YOUR ATTENDANCE ({s.month}, so far)\n"
        f"- Working days in month: {s.working_days}; present: {s.present}; absent: {s.absent}; on leave: {_fmt(s.on_leave)}\n"
        f"- Late check-ins: {s.late}; early leaves: {s.early}; hours worked: {_fmt(s.hours)}; overtime: {_fmt(s.overtime_hours)} h"
    )


def _timesheet_block(db: Session, me: Employee) -> str:
    this_week = week_start_of(local_today(me))
    lines = ["YOUR TIMESHEETS"]
    for label, start in (("This week", this_week), ("Last week", this_week - timedelta(days=7))):
        week = db.scalar(select(TimesheetWeek).where(TimesheetWeek.employee_id == me.id, TimesheetWeek.week_start == start))
        if week is None:
            lines.append(f"- {label} (from {start.isoformat()}): nothing entered yet")
        else:
            lines.append(f"- {label} (from {start.isoformat()}): {week.status}, {_fmt(week_total(db, week))} hours")
    return "\n".join(lines)


def _approvals_block(db: Session, user: CurrentUser) -> str | None:
    if not user.employee_id:
        return None
    who = decidable_filter(user)

    def count(model, status: str) -> int:  # type: ignore[no-untyped-def]
        return db.scalar(
            select(func.count()).select_from(model).join(Employee, Employee.id == model.employee_id)
            .where(model.status == status, who)
        ) or 0

    leave = count(LeaveRequest, "pending")
    corrections = count(AttendanceCorrection, "pending")
    timesheets = count(TimesheetWeek, "submitted")
    other = len(approvals_engine.pending_for(db, user.employee_id))
    total = leave + corrections + timesheets + other
    return (
        "WAITING ON YOUR APPROVAL\n"
        f"- {total} item(s): {leave} leave, {corrections} attendance correction(s), {timesheets} timesheet(s), "
        f"{other} other request(s) (see the Approvals page)"
    )


def _team_block(db: Session, user: CurrentUser, me: Employee) -> str | None:
    line = user.scope.reports
    if not line:
        return None
    today = local_today(me)
    # pre-boarding joiners don't count until they start
    direct = list(db.scalars(select(Employee).where(Employee.manager_id == me.id, started_clause(today)).order_by(Employee.full_name)))
    line = list(db.scalars(select(Employee.id).where(Employee.id.in_(line), started_clause(today))))
    on_leave = db.execute(
        select(Employee.full_name, LeaveRequest.leave_code, LeaveRequest.to_date)
        .join(Employee, Employee.id == LeaveRequest.employee_id)
        .where(LeaveRequest.employee_id.in_(line), LeaveRequest.status == "approved",
               LeaveRequest.from_date <= today, LeaveRequest.to_date >= today)
        .order_by(Employee.full_name)
    ).all()
    upcoming = db.scalar(
        select(func.count()).select_from(LeaveRequest)
        .where(LeaveRequest.employee_id.in_(line), LeaveRequest.status.in_(("approved", "pending")),
               LeaveRequest.from_date > today, LeaveRequest.from_date <= today + timedelta(days=14))
    ) or 0
    checked_in = db.scalar(
        select(func.count(func.distinct(AttendanceSession.employee_id)))
        .where(AttendanceSession.employee_id.in_([e.id for e in direct] or [""]), AttendanceSession.work_date == today)
    ) or 0
    lines = [
        "YOUR TEAM",
        f"- Direct reports: {len(direct)}; whole reporting line: {len(line)}",
        f"- Direct reports checked in today ({today.isoformat()}): {checked_in} of {len(direct)}",
        f"- Leave starting in the next 14 days (approved or pending): {upcoming}",
    ]
    if on_leave:
        names = ", ".join(f"{name} ({code} until {to.isoformat()})" for name, code, to in on_leave[:10])
        lines.append(f"- On leave today: {names}" + (f" and {len(on_leave) - 10} more" if len(on_leave) > 10 else ""))
    else:
        lines.append("- On leave today: nobody")
    return "\n".join(lines)


def _org_block(db: Session, user: CurrentUser) -> str | None:
    if user.account.role not in ORG_ROLES or not user.scope.is_global:
        return None
    today = local_today(user.employee) if user.employee else date.today()
    active = and_(user.scope.employee_filter(), func.lower(Employee.employment_status).not_in(_LEFT_STATUSES),
                  started_clause(today))  # pre-boarding joiners aren't headcount yet
    total = db.scalar(select(func.count()).select_from(Employee).where(active)) or 0
    by_country = db.execute(
        select(Employee.country_code, func.count()).where(active).group_by(Employee.country_code).order_by(func.count().desc())
    ).all()
    by_dept = db.execute(
        select(Employee.department, func.count()).where(active).group_by(Employee.department).order_by(func.count().desc()).limit(12)
    ).all()
    by_type = db.execute(
        select(Employee.employment_type, func.count()).where(active).group_by(Employee.employment_type).order_by(func.count().desc())
    ).all()
    limited = f" (limited to {', '.join(user.scope.countries)})" if user.scope.countries else ""
    return (
        f"ORGANISATION (counts only{limited})\n"
        f"- Active headcount: {total}\n"
        f"- By country: {', '.join(f'{c}: {n}' for c, n in by_country)}\n"
        f"- By department (largest 12): {', '.join(f'{d}: {n}' for d, n in by_dept)}\n"
        f"- By employment type: {', '.join(f'{t}: {n}' for t, n in by_type)}"
    )


def build_context(db: Session, user: CurrentUser, question: str) -> CopilotContext:
    ctx = CopilotContext()
    me = user.employee
    role = user.account.role
    if me is not None:
        ctx.blocks.append(_profile_block(db, me, role))
        ctx.blocks.append(_leave_block(db, me))
        ctx.data_refs.append(Source("Your leave balances", "/leave"))
        ctx.blocks.append(_attendance_block(db, me))
        ctx.data_refs.append(Source("Your attendance", "/attendance"))
        ctx.blocks.append(_timesheet_block(db, me))
        ctx.data_refs.append(Source("Your timesheets", "/timesheet"))
    approvals = _approvals_block(db, user)
    if approvals:
        ctx.blocks.append(approvals)
    if me is not None:
        team = _team_block(db, user, me)
        if team:
            ctx.blocks.append(team)
            ctx.data_refs.append(Source("Your team", "/team"))
    org = _org_block(db, user)
    if org:
        ctx.blocks.append(org)
        ctx.data_refs.append(Source("Organisation analytics", "/analytics"))
    # goals, released ratings, skills, learning, own benefits, career interests (app/services/ai_talent_context.py)
    from app.services.ai_talent_context import copilot_blocks

    for text, title, ref in copilot_blocks(db, user):
        ctx.blocks.append(text)
        if title and ref and not any(s.ref == ref for s in ctx.data_refs):
            ctx.data_refs.append(Source(title, ref))

    hits = policy_kb.search(
        db, question,
        country=me.country_code if me else None, role=role,
        employment_type=me.employment_type if me else None, legal_entity=me.legal_entity if me else None,
    )
    if hits:
        ctx.blocks.append("POLICY SECTIONS\n" + "\n\n".join(h.as_text() for h in hits))
        for h in hits:
            ctx.sources.append(Source(h.title, h.ref, kind="policy", version=h.version, effective=h.effective, section=h.heading))
    else:
        ctx.blocks.append("POLICY SECTIONS\n(no matching policy section found; the full library is on the Policies page)")
    return ctx

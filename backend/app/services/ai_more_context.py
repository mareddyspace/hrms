"""More HR Copilot context: the rest of the signed-in person's own records, plus directory facts and role-limited
numbers, so the AI can answer "almost everything" without ever seeing data the person couldn't open in the portal.

Everyone (own records only):
- upcoming leave, today's attendance and late days this month, timesheet days still open
- payslips: month, pay date, paid days and their OWN net pay (only from locked payroll runs)
- holidays for their country / holiday calendar, tax declarations, expense claims, trips, cash advances
- tasks and tickets assigned to them or raised by them, help-desk requests they raised
- a map of portal pages ("where do I ...")
- people named in the question: directory card only (title, department, location, country, manager, joining date,
  direct reports) - exactly what the Directory shows to anyone signed in. Never pay, contact or personal details.

People with reports: direct reports (name and title), their line by department and country.
HR / admin / executive (org-wide, HR limited to its countries): department heads.
Recruiters, HR and hiring managers: only the requisitions they may open (app/services/recruiting.can_view_requisition),
with candidate counts by stage (no candidate names or contact details).
"""

from __future__ import annotations

import re
from collections import Counter
from datetime import date, timedelta

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.deps import CurrentUser
from app.models import (
    AttendanceSession,
    CashAdvance,
    Candidate,
    DeskTicket,
    Employee,
    ExpenseClaim,
    Holiday,
    LeaveRequest,
    OrgUnit,
    PayrollRun,
    PayrollRunLine,
    Requisition,
    SharedTask,
    TaxDeclaration,
    Ticket,
    TimesheetDay,
    TravelRequest,
)
from app.services.attendance import local_today

Block = tuple[str, str | None, str | None]  # (text, source title, portal page)

_LEFT = ("terminated", "exited", "resigned", "inactive", "separated")
ORG_ROLES = frozenset({"hr_admin", "hr", "hrbp", "admin", "super_admin", "executive"})
_CLOSED_TICKETS = ("Resolved", "Closed")

# "Where do I ..." answers: page -> what it is for. Pages behind a role are only listed for that role.
NAV_PAGES: list[tuple[str, str, frozenset[str] | None]] = [
    ("/leave", "apply for leave, see balances, cancel or track leave requests, request permission for past dates", None),
    ("/holidays", "holiday calendar for your country", None),
    ("/attendance", "check in / check out, monthly attendance, attendance corrections", None),
    ("/timesheet", "log and submit hours (daily or weekly)", None),
    ("/payslips", "your payslips, download a payslip PDF, tax regime", None),
    ("/investment", "tax declarations and proofs", None),
    ("/benefits", "benefit plans, enrolment, dependents and beneficiaries", None),
    ("/expenses", "expense claims and reimbursements", None),
    ("/travel", "travel requests and trip bookings", None),
    ("/cash", "cash advances and their settlement", None),
    ("/overtime", "overtime requests", None),
    ("/encashment", "leave encashment", None),
    ("/documents", "documents and letters (experience, address proof, salary certificate requests)", None),
    ("/info", "your profile: personal details, address, emergency contact, bank details", None),
    ("/approvals", "everything waiting for your approval", None),
    ("/tasks", "tasks assigned to you", None),
    ("/tickets", "IT / HR / project tickets", None),
    ("/help", "helpdesk: raise an HR request, FAQs", None),
    ("/org-chart", "reporting lines", None),
    ("/directory", "find a colleague (name, title, department, location)", None),
    ("/evaluations", "goals, check-ins and performance reviews", None),
    ("/programs", "courses, mandatory training and certifications", None),
    ("/skills", "skills, career interests and next role", None),
    ("/internal-jobs", "internal job openings", None),
    ("/policies", "company policies and acknowledgements", None),
    ("/workforce/shifts", "your shift roster and shift swaps", None),
    ("/workforce/optional-holidays", "pick optional holidays", None),
    ("/calendar", "your calendar: meetings, leave, holidays", None),
    ("/assets", "laptop and other asset requests", None),
    ("/software", "software access requests", None),
    ("/me/grievances", "raise a concern (confidential)", None),
    ("/me/exit", "resignation", None),
    ("/chat", "messages", None),
    ("/team", "your team: who is in, away, team requests", frozenset({"manager", "executive", "hr", "hr_admin", "hrbp", "admin", "super_admin"})),
    ("/leave/team-calendar", "team leave calendar", frozenset({"manager", "executive", "hr", "hr_admin", "hrbp", "admin", "super_admin"})),
    ("/analytics", "headcount, joiners, exits, attrition", frozenset({"manager", "executive", "hr", "hr_admin", "hrbp", "admin", "super_admin"})),
    ("/recruiting", "requisitions, candidates, interviews and offers", frozenset({"recruiter", "hr", "hr_admin", "hrbp", "admin", "super_admin"})),
    ("/onboarding", "joiner checklists", frozenset({"recruiter", "hr", "hr_admin", "hrbp", "admin", "super_admin"})),
    ("/compensation", "pay bands and compensation reviews", frozenset({"hr", "hr_admin", "admin", "super_admin"})),
    ("/people/cases", "HR cases", frozenset({"hr", "hr_admin", "hrbp", "admin", "super_admin"})),
    ("/payroll", "payroll runs", frozenset({"hr", "hr_admin", "admin", "super_admin"})),
    ("/admin", "administration console, roles, AI settings, leave policies", frozenset({"admin", "super_admin", "hr_admin"})),
]

_NAME_WORDS = re.compile(r"[A-Za-z][A-Za-z'-]{2,}")
# Words that are also first names, or too common to treat as a name.
_NOT_NAMES = frozenset(
    "may june april august will mark grace joy hope faith summer bill rich sunny the and what how much who whom "
    "where when which does did can could would should report reports manager team department head heads lead "
    "leave leaves holiday holidays my mine your our their his her him she they them this that with for from "
    "joined join joining hired hire located location work works working title role job about tell show give".split()
)


def _fmt(n: float) -> str:
    return f"{n:g}"


def _d(x: date | None) -> str:
    return x.isoformat() if x else "-"


def _name(db: Session, emp_id: str | None, cache: dict[str, str]) -> str:
    if not emp_id:
        return "nobody"
    if emp_id not in cache:
        e = db.get(Employee, emp_id)
        cache[emp_id] = e.full_name if e else emp_id
    return cache[emp_id]


# ---------- own records ----------
def upcoming_leave_block(db: Session, me: Employee, today: date) -> str | None:
    rows = db.scalars(
        select(LeaveRequest).where(LeaveRequest.employee_id == me.id, LeaveRequest.to_date >= today,
                                   LeaveRequest.status.in_(("approved", "pending")))
        .order_by(LeaveRequest.from_date).limit(8)
    ).all()
    if not rows:
        return "YOUR UPCOMING LEAVE\n- None booked (approved or pending) from today"
    return "YOUR UPCOMING LEAVE\n" + "\n".join(
        f"- {r.leave_code} {r.from_date.isoformat()} to {r.to_date.isoformat()}, {_fmt(r.days)} day(s), {r.status}" for r in rows
    )


def attendance_today_block(db: Session, me: Employee, today: date) -> str:
    s = db.scalar(select(AttendanceSession).where(AttendanceSession.employee_id == me.id, AttendanceSession.work_date == today)
                  .order_by(AttendanceSession.check_in))
    if s is None:
        line = f"- Today ({today.isoformat()}): not checked in"
    else:
        out = "still checked in" if s.check_out is None else f"checked out (worked {_fmt(round((s.worked_minutes or 0) / 60, 2))} h)"
        late = f", late by {s.late_minutes} min" if s.is_late else ", on time"
        line = f"- Today ({today.isoformat()}): checked in ({s.work_mode}){late}; {out}; shift {s.shift_start}-{s.shift_end}"
    first = today.replace(day=1)
    late_days = db.scalars(
        select(AttendanceSession.work_date).where(AttendanceSession.employee_id == me.id, AttendanceSession.is_late.is_(True),
                                                  AttendanceSession.work_date >= first, AttendanceSession.work_date <= today)
        .order_by(AttendanceSession.work_date)
    ).all()
    late_line = f"- Late days this month: {len(late_days)}" + (f" ({', '.join(d.isoformat() for d in late_days[:15])})" if late_days else "")
    return "YOUR ATTENDANCE TODAY\n" + line + "\n" + late_line


def timesheet_days_block(db: Session, me: Employee, today: date) -> str | None:
    since = today - timedelta(days=31)
    rows = db.execute(
        select(TimesheetDay.status, TimesheetDay.work_date).where(TimesheetDay.employee_id == me.id, TimesheetDay.work_date >= since)
        .order_by(TimesheetDay.work_date)
    ).all()
    if not rows:
        return None
    by = Counter(s for s, _ in rows)
    open_days = [d.isoformat() for s, d in rows if s in ("draft", "rejected")]
    return (
        "YOUR TIMESHEET DAYS (last 31 days)\n"
        f"- Approved: {by.get('approved', 0)}; submitted, waiting for approval: {by.get('submitted', 0)}; "
        f"draft: {by.get('draft', 0)}; sent back: {by.get('rejected', 0)}\n"
        f"- Days still to submit or fix: {', '.join(open_days[:12]) or 'none'}"
    )


def payslips_block(db: Session, me: Employee) -> str:
    rows = db.execute(
        select(PayrollRun.month, PayrollRun.payday, PayrollRun.currency, PayrollRunLine.net, PayrollRunLine.paid_days,
               PayrollRunLine.lwp_days, PayrollRunLine.bank_ok)
        .join(PayrollRun, PayrollRun.id == PayrollRunLine.run_id)
        .where(PayrollRunLine.employee_id == me.id, PayrollRun.status == "locked")
        .order_by(PayrollRun.month.desc()).limit(3)
    ).all()
    from app.services.payroll_runs import payday

    today = local_today(me)
    next_pay = payday(today.strftime("%Y-%m"), me.country_code)
    if next_pay < today:
        nm = date(today.year + (today.month == 12), today.month % 12 + 1, 1)
        next_pay = payday(nm.strftime("%Y-%m"), me.country_code)
    lines = ["YOUR PAYSLIPS (your own pay only)", f"- Next pay date: {next_pay.isoformat()} (last working day of the month)"]
    if not rows:
        lines.append("- No payslip released from payroll yet (see the Payslips page)")
    for month, pd, cur, net, paid, lwp, bank_ok in rows:
        held = "" if bank_ok else "; pay held: bank details missing"
        lines.append(f"- {month}: paid on {_d(pd)}, net pay {cur} {net:,.2f}, paid days {_fmt(paid)}, loss of pay days {_fmt(lwp)}{held}")
    return "\n".join(lines)


def holidays_block(db: Session, me: Employee, today: date) -> str:
    cal = Holiday.calendar.is_(None) if not me.holiday_calendar else or_(Holiday.calendar.is_(None), Holiday.calendar == me.holiday_calendar)
    rows = db.execute(
        select(Holiday.date, Holiday.name).where(Holiday.country_code == me.country_code, Holiday.active.is_(True), cal,
                                                 Holiday.date >= today, Holiday.date <= today + timedelta(days=370))
        .order_by(Holiday.date).limit(8)
    ).all()
    year_count = db.scalar(select(func.count()).select_from(Holiday).where(
        Holiday.country_code == me.country_code, Holiday.active.is_(True), cal,
        Holiday.date >= date(today.year, 1, 1), Holiday.date <= date(today.year, 12, 31))) or 0
    head = f"YOUR HOLIDAYS ({me.country_code}{', ' + me.holiday_calendar if me.holiday_calendar else ''}; {year_count} in {today.year})"
    if not rows:
        return head + "\n- No upcoming holidays on the calendar"
    return head + "\n" + "\n".join(f"- {d.isoformat()} ({d.strftime('%A')}): {n}" for d, n in rows)


def tax_block(db: Session, me: Employee) -> str | None:
    rows = db.scalars(select(TaxDeclaration).where(TaxDeclaration.employee_id == me.id).order_by(TaxDeclaration.financial_year.desc())).all()
    if not rows:
        return "YOUR TAX DECLARATIONS\n- Nothing declared yet (Tax declarations page)"
    fy = rows[0].financial_year
    cur = [r for r in rows if r.financial_year == fy]
    by = Counter(r.status for r in cur)
    lines = [f"YOUR TAX DECLARATIONS ({fy}{', regime ' + me.tax_regime if me.tax_regime else ''})",
             f"- {len(cur)} item(s): " + ", ".join(f"{n} {s}" for s, n in by.items())]
    for r in cur[:8]:
        lines.append(f"- {r.section} {r.title}: {r.currency} {r.amount:,.2f}, {r.status}")
    return "\n".join(lines)


def claims_block(db: Session, me: Employee, today: date) -> str:
    lines = ["YOUR CLAIMS, TRIPS AND ADVANCES"]
    claims = db.scalars(select(ExpenseClaim).where(ExpenseClaim.employee_id == me.id).order_by(ExpenseClaim.expense_date.desc()).limit(6)).all()
    if claims:
        waiting = sum(1 for c in claims if c.status == "submitted")
        lines.append(f"- Expense claims (latest {len(claims)}, {waiting} waiting for approval):")
        for c in claims:
            paid = f", paid {c.paid_on.isoformat()}" if c.paid_on else ""
            lines.append(f"  - {c.expense_date.isoformat()} {c.category} {c.currency} {c.amount:,.2f}: {c.status}{paid}")
    else:
        lines.append("- Expense claims: none")
    trips = db.scalars(select(TravelRequest).where(TravelRequest.employee_id == me.id).order_by(TravelRequest.start_date.desc()).limit(5)).all()
    if trips:
        lines.append("- Travel requests:")
        for t in trips:
            when = "upcoming" if t.start_date >= today else "past"
            lines.append(f"  - {t.from_location} to {t.to_location}, {t.start_date.isoformat()} to {t.end_date.isoformat()} ({when}, {t.mode}): {t.status}")
    else:
        lines.append("- Travel requests: none")
    adv = db.scalars(select(CashAdvance).where(CashAdvance.employee_id == me.id).order_by(CashAdvance.created_at.desc()).limit(3)).all()
    if adv:
        lines.append("- Cash advances: " + "; ".join(f"{a.category} {a.currency} {a.amount:,.2f}: {a.status}" for a in adv))
    return "\n".join(lines)


def work_items_block(db: Session, me: Employee) -> str:
    cache: dict[str, str] = {}
    lines = ["YOUR TASKS AND TICKETS"]
    open_q = (SharedTask.assignee_id == me.id, SharedTask.status != "done")
    tasks = db.scalars(select(SharedTask).where(*open_q)
                       .order_by(SharedTask.due.is_(None), SharedTask.due).limit(8)).all()
    # exact counts (the list below shows at most 8)
    counts = dict(db.execute(select(SharedTask.status, func.count()).where(*open_q).group_by(SharedTask.status)).all())
    total = sum(counts.values())
    today = date.today()
    overdue = db.scalar(select(func.count()).select_from(SharedTask).where(*open_q, SharedTask.due < today)) or 0
    lines.append(f"- Open tasks assigned to you: {total} (not started {counts.get('open', 0)}, in progress "
                 f"{counts.get('progress', 0)}, scheduled {counts.get('scheduled', 0)}; overdue {overdue})"
                 + ("; the 8 due soonest:" if total > 8 else ""))
    done = db.scalar(select(func.count()).select_from(SharedTask).where(SharedTask.assignee_id == me.id,
                                                                       SharedTask.status == "done")) or 0
    lines.append(f"- Tasks you have completed: {done}")
    for t in tasks:
        subject = str((t.data or {}).get("subject") or t.code)[:120]
        lines.append(f"  - {t.code} {subject} ({t.status}, due {_d(t.due)}, from {_name(db, t.created_by, cache)})")
    mine = or_(Ticket.assignee_id == me.id, Ticket.sub_owner_id == me.id)
    tickets = db.scalars(select(Ticket).where(mine, Ticket.status.not_in(_CLOSED_TICKETS))
                         .order_by(Ticket.due.is_(None), Ticket.due).limit(8)).all()
    ticket_total = db.scalar(select(func.count()).select_from(Ticket).where(mine, Ticket.status.not_in(_CLOSED_TICKETS))) or 0
    lines.append(f"- Open tickets you own: {ticket_total}" + ("; the 8 due soonest:" if ticket_total > 8 else ""))
    for t in tickets:
        lines.append(f"  - {t.id} {t.title[:100]} ({t.type}, {t.priority}, {t.status}, due {_d(t.due)})")
    raised = db.scalar(select(func.count()).select_from(Ticket).where(Ticket.requester_id == me.id, Ticket.status.not_in(_CLOSED_TICKETS))) or 0
    desk = db.scalars(select(DeskTicket).where(DeskTicket.requester_id == me.id, DeskTicket.status.not_in(_CLOSED_TICKETS))
                      .order_by(DeskTicket.submitted_at.desc()).limit(5)).all()
    lines.append(f"- Open tickets you raised: {raised}")
    lines.append(f"- Open helpdesk requests you raised: {len(desk)}" + (" (" + "; ".join(f"{d.subject[:60]}: {d.status}" for d in desk) + ")" if desk else ""))
    return "\n".join(lines)


def navigation_block(role: str) -> str:
    pages = [f"- {ref}: {what}" for ref, what, roles in NAV_PAGES if roles is None or role in roles]
    return "PORTAL PAGES (for \"where do I ...\" questions; mention the page path)\n" + "\n".join(pages)


# ---------- people and organisation ----------
def _active(today: date):  # type: ignore[no-untyped-def]
    return and_(func.lower(Employee.employment_status).not_in(_LEFT), Employee.joining_date <= today)


def people_mentioned_block(db: Session, user: CurrentUser, question: str, today: date) -> str | None:
    """Directory cards for people named in the question (what the Directory shows anyone signed in)."""
    words = {w.lower().removesuffix("'s") for w in _NAME_WORDS.findall(question)} - _NOT_NAMES
    if not words:
        return None
    hits = db.scalars(
        select(Employee).where(or_(func.lower(Employee.first_name).in_(words), func.lower(Employee.last_name).in_(words),
                                   func.lower(Employee.preferred_name).in_(words)),
                               func.lower(Employee.employment_status).not_in(_LEFT))
        .order_by(Employee.full_name).limit(40)
    ).all()
    if not hits:
        return None
    me = user.employee

    def rank(e: Employee) -> int:  # full-name match first, then people close to the asker
        score = 4 if (e.first_name or "").lower() in words and (e.last_name or "").lower() in words else 0
        if me is not None:
            score += 2 if e.id in user.scope.reports or e.id == me.manager_id or e.manager_id == me.manager_id else 0
            score += (e.department == me.department) + (e.country_code == me.country_code)
        return score

    hits = sorted(hits, key=lambda e: (-rank(e), e.full_name))[:4]
    cache: dict[str, str] = {}
    lines = ["PEOPLE NAMED IN THE QUESTION (directory card only: no pay, contact or personal details)"]
    for e in hits:
        reports = db.scalars(select(Employee.full_name).where(Employee.manager_id == e.id, _active(today)).order_by(Employee.full_name)).all()
        rep = f"{len(reports)} direct report(s)" + (f": {', '.join(reports[:8])}" + (" ..." if len(reports) > 8 else "") if reports else "")
        lines.append(
            f"- {e.full_name}{' (you)' if e.id == user.employee_id else ''}: {e.job_title}, {e.department}, {e.location} ({e.country_code}); "
            f"reports to {_name(db, e.manager_id, cache)}; joined {e.joining_date.isoformat()}; {rep}"
        )
    return "\n".join(lines)


def my_reports_block(db: Session, user: CurrentUser, me: Employee, today: date) -> str | None:
    if not user.scope.reports:
        return None
    direct = db.execute(select(Employee.full_name, Employee.job_title).where(Employee.manager_id == me.id, _active(today))
                        .order_by(Employee.full_name)).all()
    line_ids = list(user.scope.reports)
    by_dept = db.execute(select(Employee.department, func.count()).where(Employee.id.in_(line_ids), _active(today))
                         .group_by(Employee.department).order_by(func.count().desc())).all()
    by_country = db.execute(select(Employee.country_code, func.count()).where(Employee.id.in_(line_ids), _active(today))
                            .group_by(Employee.country_code).order_by(func.count().desc())).all()
    return (
        "YOUR REPORTING LINE\n"
        f"- Direct reports: {', '.join(f'{n} ({t})' for n, t in direct[:20]) or 'none'}\n"
        f"- Whole line by department: {', '.join(f'{d}: {n}' for d, n in by_dept)}\n"
        f"- Whole line by country: {', '.join(f'{c}: {n}' for c, n in by_country)}"
    )


def department_heads_block(db: Session, user: CurrentUser) -> str | None:
    if user.account.role not in ORG_ROLES or not user.scope.org_wide:
        return None
    units = db.execute(select(OrgUnit.name, OrgUnit.manager_id, OrgUnit.country_code)
                       .where(OrgUnit.type == "department", OrgUnit.active.is_(True), OrgUnit.manager_id.is_not(None))
                       .order_by(OrgUnit.name)).all()
    allowed = user.scope.countries
    cache: dict[str, str] = {}
    rows = [f"{n}: {_name(db, m, cache)}" for n, m, c in units if not allowed or c is None or c in allowed]
    if not rows:
        return None
    return "DEPARTMENT HEADS\n- " + "; ".join(rows[:30])


def recruiting_block(db: Session, user: CurrentUser) -> str | None:
    from app.services.recruiting import can_view_requisition

    role = user.account.role
    if role != "recruiter" and not user.scope.is_hr:
        if not user.employee_id or not db.scalar(select(Requisition.id).where(Requisition.hiring_manager_id == user.employee_id).limit(1)):
            return None
    reqs = [r for r in db.scalars(select(Requisition).order_by(Requisition.raised_on.desc())) if can_view_requisition(db, user, r)]
    if not reqs:
        return "RECRUITING (requisitions you can open)\n- None"
    ids = [r.id for r in reqs]
    stages = db.execute(select(Candidate.requisition_id, Candidate.stage, func.count()).where(Candidate.requisition_id.in_(ids))
                        .group_by(Candidate.requisition_id, Candidate.stage)).all()
    per: dict[str, Counter[str]] = {}
    for rid, stage, n in stages:
        per.setdefault(rid, Counter())[stage] = n
    total = Counter()
    for c in per.values():
        total.update(c)
    status = Counter(r.status for r in reqs)
    lines = [
        "RECRUITING (requisitions you can open; candidate counts only)",
        f"- Requisitions: {len(reqs)} ({', '.join(f'{n} {s}' for s, n in status.items())}); "
        f"open positions on approved roles: {sum(r.openings for r in reqs if r.status == 'approved')}",
        f"- Candidates by stage: {', '.join(f'{s}: {n}' for s, n in total.most_common()) or 'none'}",
    ]
    if user.employee_id:
        assigned = [r for r in reqs if r.recruiter_id == user.employee_id and r.status == "approved"]
        if assigned:
            lines.append(f"- Assigned to you as recruiter: {len(assigned)}")
    for r in reqs[:10]:
        c = per.get(r.id, Counter())
        lines.append(f"  - {r.id} {r.title} ({r.department}, {r.location} {r.country_code}): {r.status}, {r.openings} opening(s), "
                     f"{sum(c.values())} candidate(s)")
    return "\n".join(lines)


def more_blocks(db: Session, user: CurrentUser, question: str) -> list[Block]:
    me = user.employee
    role = user.account.role
    out: list[Block] = []
    today = local_today(me) if me is not None else date.today()
    if me is not None:
        out.append((upcoming_leave_block(db, me, today) or "", None, None))
        out.append((attendance_today_block(db, me, today), "Your attendance", "/attendance"))
        ts = timesheet_days_block(db, me, today)
        if ts:
            out.append((ts, "Your timesheets", "/timesheet"))
        out.append((payslips_block(db, me), "Your payslips", "/payslips"))
        out.append((holidays_block(db, me, today), "Holiday calendar", "/holidays"))
        tax = tax_block(db, me)
        if tax:
            out.append((tax, "Your tax declarations", "/investment"))
        out.append((claims_block(db, me, today), "Your claims and trips", "/expenses"))
        out.append((work_items_block(db, me), "Your tasks and tickets", "/tasks"))
        mine = my_reports_block(db, user, me, today)
        if mine:
            out.append((mine, "Org chart", "/org-chart"))
    people = people_mentioned_block(db, user, question, today)
    if people:
        out.append((people, "Directory", "/directory"))
    heads = department_heads_block(db, user)
    if heads:
        out.append((heads, "Organization", "/organization"))
    rec = recruiting_block(db, user)
    if rec:
        out.append((rec, "Recruiting", "/recruiting"))
    out.append((navigation_block(role), None, None))
    return [b for b in out if b[0]]

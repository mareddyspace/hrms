"""Background jobs: approval reminders, SLA escalation, HR case retention.

Run at API startup (never blocking it) and on demand with POST /api/v1/admin/jobs/run (admin).

- send_due_reminders(): items waiting on someone for more than 2 days (leave, attendance corrections, timesheet
  weeks, generic approvals) and HR desk tickets due within 4 hours or overdue (to the owner). Each item is
  reminded at most once per day per recipient (reminder_log), as in src/data/approvalReminders.ts.
- run_sla_escalation(): escalates overdue desk tickets once; alerts HR / committee once a day about POSH cases
  past their 90-day deadline; escalates approval steps waiting longer than their sla_hours once
  (approvals.escalate_overdue_steps).
  Leave, corrections and timesheet weeks in an approval chain are reminded through their approval instance.
- archive_expired_cases(): retention rule for closed HR cases.
- leave carry-forward into this year (app/services/leave_rules.py run_carry_forward; once per year).
- complete_due_exits(): approved exits whose last working day has passed -> person "Exited", sign-in deactivated
  (app/services/exits.py; only people with an approved exit are touched).
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SessionLocal, utcnow
from app.models import (
    Account, ApprovalInstance, AttendanceCorrection, DeskTicket, Employee, HrCase, LeaveRequest, ReminderLog, TimesheetWeek,
)
from app.services import approvals as engine
from app.services import cases as case_rules
from app.services import desk as desk_rules
from app.services.activity import notify
from app.services.scope import HR_ROLES

log = logging.getLogger("timez.jobs")

WAITING = timedelta(days=2)
NEAR_SLA = timedelta(hours=4)


def _already_sent(db: Session, key: str, recipient_id: str, day: date) -> bool:
    return db.scalar(select(ReminderLog.id).where(ReminderLog.item_key == key, ReminderLog.recipient_id == recipient_id,
                                                  ReminderLog.sent_on == day)) is not None


def _send(db: Session, key: str, recipient_id: str | None, day: date, kind: str, title: str, body: str, href: str) -> bool:
    if not recipient_id or _already_sent(db, key, recipient_id, day):
        return False
    db.add(ReminderLog(item_key=key, recipient_id=recipient_id, sent_on=day, kind=kind))
    notify(db, recipient_id=recipient_id, title=title[:200], body=body, href=href)
    db.flush()
    return True


def _days(delta: timedelta) -> int:
    return max(1, delta.days)


def send_due_reminders(db: Session | None = None, now: datetime | None = None) -> int:
    """Remind approvers about items waiting more than 2 days. Returns how many reminders went out."""
    if db is None:
        with SessionLocal() as own:
            sent = send_due_reminders(own, now)
            own.commit()
            return sent
    now = now or utcnow()
    today = now.date()
    cutoff = now - WAITING
    sent = 0
    names = lambda ids: dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_(ids))).all())  # noqa: E731

    chained = {t: set(engine.pending_instances(db, t)) for t in ("leave", "attendance_correction", "timesheet")}
    leaves = [r for r in db.scalars(select(LeaveRequest).where(LeaveRequest.status == "pending", LeaveRequest.created_at < cutoff))
              if r.id not in chained["leave"]]
    who = names({r.employee_id for r in leaves})
    for r in leaves:
        emp = db.get(Employee, r.employee_id)
        sent += _send(db, f"leave:{r.id}", emp.manager_id if emp else None, today, "approval_reminder",
                      f"Approve leave · {who.get(r.employee_id, 'A team member')}",
                      f"{r.leave_code} leave from {r.from_date} has waited {_days(now - r.created_at)} days for your decision.",
                      "/approvals")
    corrections = [c for c in db.scalars(select(AttendanceCorrection).where(AttendanceCorrection.status == "pending",
                                                                            AttendanceCorrection.created_at < cutoff))
                   if c.id not in chained["attendance_correction"]]
    who = names({c.employee_id for c in corrections})
    for c in corrections:
        emp = db.get(Employee, c.employee_id)
        sent += _send(db, f"correction:{c.id}", emp.manager_id if emp else None, today, "approval_reminder",
                      f"Approve attendance correction · {who.get(c.employee_id, 'A team member')}",
                      f"Correction for {c.work_date} has waited {_days(now - c.created_at)} days for your decision.",
                      "/attendance")
    weeks = [w for w in db.scalars(select(TimesheetWeek).where(TimesheetWeek.status == "submitted",
                                                               TimesheetWeek.submitted_at < cutoff))
             if w.id not in chained["timesheet"]]
    who = names({w.employee_id for w in weeks})
    for w in weeks:
        emp = db.get(Employee, w.employee_id)
        sent += _send(db, f"timesheet:{w.id}", emp.manager_id if emp else None, today, "approval_reminder",
                      f"Approve timesheet · {who.get(w.employee_id, 'A team member')}",
                      f"Week of {w.week_start} has waited {_days(now - (w.submitted_at or now))} days for your decision.",
                      "/approvals")
    for inst in db.scalars(select(ApprovalInstance).where(ApprovalInstance.status == "pending",
                                                          ApprovalInstance.created_at < cutoff)):
        requester = db.get(Employee, inst.requester_id)
        for ids in engine.open_groups(db, inst).values():
            for approver in ids:
                sent += _send(db, f"approval:{inst.id}:{inst.current_step}", approver, today, "approval_reminder",
                              f"Approve {inst.type.replace('_', ' ')} · {requester.full_name if requester else 'request'}",
                              f"Request {inst.entity_id} has waited {_days(now - inst.created_at)} days for your decision.",
                              f"/approvals/{inst.id}")
    for t in db.scalars(select(DeskTicket).where(DeskTicket.status.in_(desk_rules.CLOCK_RUNNING),
                                                 DeskTicket.assignee_id.is_not(None), DeskTicket.due_at <= now + NEAR_SLA)):
        overdue = desk_rules.is_overdue(t, now)
        sent += _send(db, f"desk:{t.id}", t.assignee_id, today, "approval_reminder",
                      f"{'HR request overdue' if overdue else 'HR request due soon'} · {t.subject}",
                      f"{t.category} request {t.id} " + ("is past its due time." if overdue else "is due within 4 hours."),
                      f"/help?request={t.id}")
    return sent


def run_sla_escalation(db: Session | None = None, now: datetime | None = None) -> dict[str, int]:
    if db is None:
        with SessionLocal() as own:
            out = run_sla_escalation(own, now)
            own.commit()
            return out
    now = now or utcnow()
    escalated = desk_rules.escalate_overdue(db, now)
    alerts = 0
    hr_ids = list(db.scalars(select(Account.employee_id).where(Account.role.in_(HR_ROLES), Account.active.is_(True),
                                                               Account.employee_id.is_not(None))))
    for case in db.scalars(select(HrCase).where(HrCase.category == case_rules.POSH, HrCase.status.in_(case_rules.OPEN))):
        if not case_rules.posh_overdue(case, now.date()):
            continue
        for rid in dict.fromkeys([case.assignee_id, *hr_ids, *case_rules.committee(db)]):
            if rid and rid not in (case.reporter_id, case.against_id):
                alerts += _send(db, f"posh:{case.id}", rid, now.date(), "posh_deadline", f"POSH case past 90 days · {case.code}",
                                "This POSH case is past its 90-day deadline. Please complete the inquiry.",
                                f"/cases/{case.id}")
    return {"desk_escalated": escalated, "posh_alerts": alerts, "approvals_escalated": engine.escalate_overdue_steps(db, now)}


def archive_expired_cases(db: Session | None = None, today: date | None = None) -> int:
    if db is None:
        with SessionLocal() as own:
            n = archive_expired_cases(own, today)
            own.commit()
            return n
    return case_rules.archive_expired(db, today)


def run_all(db: Session, now: datetime | None = None) -> dict[str, Any]:
    now = now or utcnow()
    out: dict[str, Any] = {"reminders_sent": send_due_reminders(db, now)}
    out.update(run_sla_escalation(db, now))
    out["cases_archived"] = archive_expired_cases(db, now.date())
    from app.services.leave_rules import run_carry_forward_safely  # year-end leave carry-forward (idempotent per year)

    out["leave_carry_forward"] = run_carry_forward_safely(db, now.date())
    from app.services.exits import complete_due_exits  # leavers past their last working day

    out["exits_completed"] = len(complete_due_exits(db))
    return out


def run_at_startup() -> dict[str, Any]:
    """Never stops the API from starting (e.g. before migrations have run)."""
    try:
        with SessionLocal() as db:
            out = run_all(db)
            db.commit()
            log.info("Startup jobs: %s", out)
            return out
    except Exception as exc:  # noqa: BLE001
        log.warning("Startup jobs skipped (%s). Run python -m app.db_init?", exc.__class__.__name__)
        return {}

"""Weekly timesheets submitted before timesheets went daily (POST /timesheets/weeks/{week_start}/submit now refuses).

Tests that check decisions on those old weeks put a submitted week straight into the database, the way the retired
endpoint did (status submitted, approval chain "timesheet" started, audit "timesheet_submitted").
"""

from __future__ import annotations

from datetime import date

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal, utcnow
from app.models import Account, Employee, TimesheetWeek
from app.services import time_approvals as chain
from app.services.activity import record_audit


def legacy_submit_week(client: TestClient, headers: dict, employee_id: str, week_start: str) -> dict:
    """Mark the person's week (entries already logged) submitted and start its approval; returns the week as listed."""
    with SessionLocal() as db:
        week = db.scalar(select(TimesheetWeek).where(TimesheetWeek.employee_id == employee_id,
                                                     TimesheetWeek.week_start == date.fromisoformat(week_start)))
        assert week is not None, "log an entry in that week first"
        emp = db.get(Employee, employee_id)
        account_id = db.scalar(select(Account.id).where(Account.employee_id == employee_id))
        week.status, week.submitted_at = "submitted", utcnow()
        week.decided_by = week.decided_at = week.decision_note = None
        db.flush()
        chain.start(db, chain.TIMESHEET, week.id, emp, account_id)
        record_audit(db, actor_id=account_id, action="timesheet_submitted", entity="timesheet_week", entity_id=week.id,
                     subject_id=employee_id, after={"status": "submitted"})
        db.commit()
        week_id = week.id
    return next(w for w in client.get("/api/v1/timesheets/weeks", headers=headers).json() if w["id"] == week_id)

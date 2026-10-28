"""Integration connectors: simulated sync runs with validation and a quarantine (src/data/platformLocal.ts).

A run processes one batch; about one record in ten fails a field check and goes to quarantine (the first run
always has one). Quarantined records can be retried as they are (passes ~40% of the time, deterministic),
fixed (passes when the new value is valid) or dismissed with a reason. Failures alert admins (and HR for
payroll / benefits / attendance) through notifications, which also queue "integrations" emails.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import Account, IntegrationConnector, IntegrationQuarantine, IntegrationRun
from app.services.activity import notify, record_audit

SCHEDULE_MINUTES = {"15m": 15, "hourly": 60, "daily": 1440, "manual": 0}
COST_CENTRES = ("CC-100", "CC-200", "CC-300", "CC-400", "CC-500")
CONNECTOR_FIELDS: dict[str, list[str]] = {
    "payroll": ["bankAccount", "taxId", "costCentre"],
    "benefits": ["taxId", "costCentre"],
    "attendance": ["costCentre"],
    "learning": ["workEmail", "costCentre"],
    "sso": ["workEmail"],
    "email": ["workEmail"],
    "teams": ["workEmail"],
    "slack": ["workEmail"],
}
BATCH_SIZE = {"payroll": 24, "benefits": 16, "attendance": 40, "learning": 20}
HR_CONNECTORS = {"payroll", "benefits", "attendance"}
FIRST = ["Priya", "Arjun", "Meera", "Kabir", "Ananya", "Rohan", "Sara", "Vikram", "Diya", "Farah"]
LAST = ["Nair", "Sharma", "Iyer", "Mehta", "Rao", "Khan", "Patel", "Singh", "Das", "Ali"]


class IntegrationError(ValueError):
    """Safe to show."""


def _hash(*parts: object) -> int:
    return int.from_bytes(hashlib.sha256("|".join(map(str, parts)).encode()).digest()[:4], "big")


def validate_value(field: str, value: str) -> str | None:
    v = value.strip()
    if field == "bankAccount":
        return None if re.fullmatch(r"\d{9,18}", v) else ("Invalid bank account number" if v else "Missing bank account")
    if field == "taxId":
        return None if re.fullmatch(r"[A-Z]{5}\d{4}[A-Z]", v.upper()) else "Invalid tax ID"
    if field == "costCentre":
        return None if v.upper() in COST_CENTRES else f"Unknown cost centre {v or '(blank)'}"
    return None if re.fullmatch(r"[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}", v) else "Missing work email"


def _bad_value(field: str, seed: int) -> str:
    if field == "taxId":
        return ["ABCD1234", "PAN-PENDING", "AB12C3456D"][seed % 3]
    if field == "costCentre":
        return ["CC-999", "CC-710", "SALES-EU"][seed % 3]
    return ""


def open_count(db: Session, connector_id: str) -> int:
    return db.scalar(select(func.count()).select_from(IntegrationQuarantine).where(
        IntegrationQuarantine.connector_id == connector_id, IntegrationQuarantine.status == "open")) or 0


def _refresh_status(db: Session, c: IntegrationConnector) -> None:
    db.flush()
    n = open_count(db, c.id)
    if n == 0 and c.status == "Degraded":
        c.status = "Connected"
    elif n > 0 and c.status == "Connected":
        c.status = "Degraded"


def next_run_at(c: IntegrationConnector) -> datetime | None:
    minutes = SCHEDULE_MINUTES.get(c.schedule, 0)
    if not minutes or c.status in ("Not configured", "Disconnected"):
        return None
    return (c.last_sync_at or utcnow()) + timedelta(minutes=minutes)


def run_sync(db: Session, c: IntegrationConnector, actor_id: str | None, trigger: str = "manual") -> IntegrationRun:
    if c.status in ("Not configured", "Disconnected"):
        raise IntegrationError(f"{c.name} is {c.status.lower()}.")
    c.run_count = (c.run_count or 0) + 1
    run_no = c.run_count
    fields = CONNECTOR_FIELDS.get(c.id, ["costCentre"])
    size = BATCH_SIZE.get(c.id, 12)
    failed = []
    for i in range(size):
        roll = _hash(c.id, run_no, i)
        if roll % 100 >= 10 and not (run_no == 1 and i == 3):
            continue
        field = fields[(roll >> 8) % len(fields)]
        value = _bad_value(field, roll >> 12)
        code = 1000 + (run_no * 37 + i * 13) % 900
        name = f"{FIRST[(run_no + i) % len(FIRST)]} {LAST[(run_no * 3 + i * 7) % len(LAST)]}"
        failed.append((i, field, value, f"EMP-{code} · {name}"))
    run = IntegrationRun(connector_id=c.id, started_at=utcnow(), trigger=trigger, processed=size,
                         succeeded=size - len(failed), failed=len(failed), run_by=actor_id)
    db.add(run)
    db.flush()
    for i, field, value, record in failed:
        db.add(IntegrationQuarantine(id=f"q-{c.id}-{run_no}-{i}", connector_id=c.id, run_id=run.id, record=record, field=field,
                                     value=value, reason=validate_value(field, value) or "Rejected by provider", attempts=0,
                                     status="open"))
    c.last_sync_at = run.started_at
    c.records_processed = (c.records_processed or 0) + run.succeeded
    c.success_count = (c.success_count or 0) + run.succeeded
    c.failed_count = (c.failed_count or 0) + run.failed
    _refresh_status(db, c)
    record_audit(db, actor_id=actor_id, action="integration_sync_run", entity="integration", entity_id=c.id,
                 after={"processed": size, "passed": run.succeeded, "quarantined": run.failed, "trigger": trigger})
    if failed:
        recipients = list(db.scalars(select(Account.employee_id).where(Account.role == "admin", Account.employee_id.is_not(None))))
        if c.id in HR_CONNECTORS:
            recipients += list(db.scalars(select(Account.employee_id).where(Account.role == "hr_admin", Account.employee_id.is_not(None))))
        reasons = ", ".join(dict.fromkeys(validate_value(f, v) or "Rejected by provider" for _, f, v, _ in failed))
        for rid in dict.fromkeys(recipients):
            notify(db, recipient_id=rid, title=f"{c.name}: sync failures",
                   body=f"{len(failed)} of {size} records failed and are in quarantine: {reasons}.",
                   href=f"/integrations?connector={c.id}")
    return run


def _settle(db: Session, rec: IntegrationQuarantine, ok: bool, actor_id: str | None, action: str, note: str | None = None) -> None:
    rec.attempts = (rec.attempts or 0) + 1
    if ok:
        rec.status, rec.resolved_by, rec.resolved_at, rec.resolution_note = "resolved", actor_id, utcnow(), note
        c = db.get(IntegrationConnector, rec.connector_id)
        if c is not None:
            c.records_processed = (c.records_processed or 0) + 1
            _refresh_status(db, c)
    record_audit(db, actor_id=actor_id, action=action, entity="integration_quarantine", entity_id=rec.id,
                 after={"connector_id": rec.connector_id, "ok": ok, "attempts": rec.attempts})


def retry(db: Session, rec: IntegrationQuarantine, actor_id: str | None) -> bool:
    ok = _hash(rec.id, (rec.attempts or 0) + 1) % 100 < 40
    _settle(db, rec, ok, actor_id, "quarantine_retried")
    return ok


def fix(db: Session, rec: IntegrationQuarantine, value: str, actor_id: str | None) -> None:
    error = validate_value(rec.field, value)
    if error:
        raise IntegrationError(error)
    v = value.strip()
    # The corrected value goes to the provider; only a masked copy of bank / tax values is kept here.
    rec.value = ("•" * max(0, len(v) - 4) + v[-4:]) if rec.field in ("bankAccount", "taxId") else v
    _settle(db, rec, True, actor_id, "quarantine_fixed", "Fixed and retried")


def dismiss(db: Session, rec: IntegrationQuarantine, reason: str, actor_id: str | None) -> None:
    rec.status, rec.resolved_by, rec.resolved_at, rec.resolution_note = "dismissed", actor_id, utcnow(), reason.strip()
    c = db.get(IntegrationConnector, rec.connector_id)
    if c is not None:
        _refresh_status(db, c)
    record_audit(db, actor_id=actor_id, action="quarantine_dismissed", entity="integration_quarantine", entity_id=rec.id,
                 after={"connector_id": rec.connector_id, "reason": reason.strip()})


def run_due_syncs(db: Session, now: datetime | None = None) -> int:
    now = now or utcnow()
    ran = 0
    for c in db.scalars(select(IntegrationConnector)):
        due = next_run_at(c)
        if c.last_sync_at is not None and due is not None and due <= now:
            run_sync(db, c, None, "schedule")
            ran += 1
    return ran

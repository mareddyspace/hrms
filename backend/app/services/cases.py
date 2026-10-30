"""Confidential HR case rules (same as the portal, src/features/compliance/grievanceStore.ts).

- Who sees a case: the reporter, HR, and for POSH cases the Internal Committee. The person named never does,
  not even when they are HR. HR / committee can't work a case they raised or are named in.
- The reporter never sees confidential notes / files, nor who works the case beyond "HR".
- POSH cases must be closed within 90 days of filing.
- Retention: Resolved / Closed cases whose closing date is older than N years (setting case_retention_years,
  default 5) are cut down to a stub: description, notes and files removed, person named cleared.
- Audit rows carry no description or note text.
"""

from __future__ import annotations

import secrets
from datetime import date, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import Employee, HrCase, HrCaseFile, HrCaseNote
from app.services import storage
from app.services.activity import record_audit
from app.services.platform_settings import get_setting
from app.services.scope import HR_ROLES, Scope

CATEGORIES = ("Grievance", "Harassment/POSH", "Discrimination", "Ethics/whistleblowing", "Safety")
POSH = "Harassment/POSH"
POSH_SLA_DAYS = 90
ARCHIVED = "Archived"
PRIORITIES = ("Low", "Normal", "High", "Urgent")
TRANSITIONS: dict[str, tuple[str, ...]] = {
    "Open": ("Investigating", "Closed"),
    "Investigating": ("Resolved", "Closed"),
    "Resolved": ("Closed",),
    "Closed": (),
    ARCHIVED: (),
}
OPEN = ("Open", "Investigating")
ARCHIVED_TEXT = "Case file removed under the retention rule."
_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def new_code(db: Session) -> str:
    while True:
        part = lambda: "".join(secrets.choice(_CODE_CHARS) for _ in range(4))  # noqa: E731
        code = f"CASE-{part()}-{part()}"
        if db.scalar(select(HrCase.id).where(HrCase.code == code)) is None:
            return code


def is_posh(case: HrCase) -> bool:
    return case.category == POSH


def committee(db: Session) -> list[str]:
    value = get_setting(db, "posh_committee") or []
    return [str(v) for v in value if v]


def is_named(case: HrCase, employee_id: str | None) -> bool:
    return bool(employee_id) and case.against_id == employee_id


def is_reporter(case: HrCase, employee_id: str | None) -> bool:
    return bool(employee_id) and case.reporter_id == employee_id and not is_named(case, employee_id)


def in_hr_scope(db: Session, case: HrCase, scope: Scope | None) -> bool:
    """HR works a case only when its data scope (e.g. its countries) covers the reporter, or the person named
    when there is no reporter. No scope given = role check only (internal callers such as jobs)."""
    if scope is None or (scope.is_global and not scope.countries):
        return True
    for person_id in (case.reporter_id, case.against_id):
        emp = db.get(Employee, person_id) if person_id else None
        if emp is not None:
            return scope.can_see(emp)
    return False  # nobody to place the case: only HR without a country limit


def can_manage(db: Session, case: HrCase, employee_id: str | None, role: str, scope: Scope | None = None) -> bool:
    """HR within its data scope; committee members additionally for POSH. Never the reporter or the person named."""
    if not employee_id or is_named(case, employee_id) or case.reporter_id == employee_id:
        return False
    if role in HR_ROLES and in_hr_scope(db, case, scope):
        return True
    return is_posh(case) and employee_id in committee(db)


def can_see(db: Session, case: HrCase, employee_id: str | None, role: str, scope: Scope | None = None) -> bool:
    return is_reporter(case, employee_id) or can_manage(db, case, employee_id, role, scope)


def posh_due_on(case: HrCase) -> date | None:
    if not is_posh(case) or case.created_at is None:
        return None
    return case.created_at.date() + timedelta(days=POSH_SLA_DAYS)


def posh_overdue(case: HrCase, today: date | None = None) -> bool:
    due = posh_due_on(case)
    return due is not None and case.status in OPEN and (today or date.today()) > due


def add_note(db: Session, case: HrCase, kind: str, text: str, author_id: str | None, *, by_reporter: bool = False,
             confidential: bool = False, status: str | None = None) -> HrCaseNote:
    note = HrCaseNote(id=f"hcn-{secrets.token_hex(8)}", case_id=case.id, kind=kind, text=text, author_id=author_id,
                      by_reporter=by_reporter, confidential=confidential, status=status, created_at=utcnow())
    db.add(note)
    return note


def snapshot(case: HrCase) -> dict:
    """Audit-safe view: never the description, notes or names."""
    return {"status": case.status, "category": case.category, "priority": case.priority, "assignee_id": case.assignee_id,
            "escalation_count": case.escalation_count}


def retention_cutoff(db: Session, today: date | None = None) -> date:
    years = int(get_setting(db, "case_retention_years") or 5)
    today = today or date.today()
    try:
        return today.replace(year=today.year - years)
    except ValueError:  # 29 February
        return today.replace(year=today.year - years, day=28)


def archive_expired(db: Session, today: date | None = None) -> int:
    """Retention job: cut closed cases past the retention period down to a stub."""
    today = today or date.today()
    cutoff = retention_cutoff(db, today)
    count = 0
    for case in db.scalars(select(HrCase).where(HrCase.status.in_(("Resolved", "Closed")), HrCase.closed_on.is_not(None),
                                                HrCase.closed_on < cutoff)):
        before = snapshot(case)
        for f in db.scalars(select(HrCaseFile).where(HrCaseFile.case_id == case.id)):
            storage.delete_quietly(f.storage_path)
        db.execute(delete(HrCaseFile).where(HrCaseFile.case_id == case.id))
        db.execute(delete(HrCaseNote).where(HrCaseNote.case_id == case.id))
        case.status, case.archived_on = ARCHIVED, today
        case.description, case.resolution, case.against_id = ARCHIVED_TEXT, None, None
        add_note(db, case, "archived", "Archived under the retention rule.", None, status=ARCHIVED)
        record_audit(db, actor_id=None, action="hr_case_archived", entity="hr_case", entity_id=case.id,
                     before=before, after=snapshot(case))
        count += 1
    return count

"""HR common sense about who a rule applies to (one place, used by several modules).

- The top of the organisation: the CEO / founders (account role in EXECUTIVE_ROLES). HR and admin may not terminate,
  demote, re-parent or raise the pay of an executive or of anyone above them in their own reporting line
  (`senior_block_reason`): that needs the board, not a subordinate.
- Serving notice: employment_status "Notice period" (set when an exit is approved). No raises, bonuses, promotions,
  internal applications or new reviews for leavers (`is_serving_notice`).
- Probation: joining date + the country's probation months still ahead (`in_probation`).
- Grades: the demo accounts use L3-L6 / M1-M3 / E1, the 500-person workbook G1 (junior) - G9 (senior).
  `grade_band` says "E" (executive), "M" (manager) or "IC"; `is_senior_grade` covers M, E and G8-G9.
- Paid overtime (`overtime_block_reason`): not for executives, managers / HR heads, M or E grades, or senior G grades
  (G8-G9); those people are exempt from paid overtime.
- Attendance-exempt roles (`attendance_exempt`): executives aren't asked to check in.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Account, Employee

EXECUTIVE_ROLES = frozenset({"executive", "founder", "cofounder"})
# Roles that never claim paid overtime (they run the time of others or are exempt staff).
OVERTIME_EXEMPT_ROLES = EXECUTIVE_ROLES | frozenset({"manager", "hr_admin"})
# Roles not asked to check in / out (kept in step with src/data/roleRules.ts ATTENDANCE_EXEMPT_ROLES).
ATTENDANCE_EXEMPT_ROLES = EXECUTIVE_ROLES
NOTICE_STATUSES = frozenset({"notice period", "serving notice"})
SENIOR_G_GRADES = frozenset({"G8", "G9"})


def account_role(db: Session, employee_id: str | None) -> str | None:
    if not employee_id:
        return None
    return db.scalar(select(Account.role).where(Account.employee_id == employee_id, Account.active.is_(True)))


def is_executive(db: Session, emp: Employee) -> bool:
    return account_role(db, emp.id) in EXECUTIVE_ROLES or (emp.grade or "").upper().startswith("E")


def senior_block_reason(db: Session, actor_employee_id: str | None, subject: Employee) -> str | None:
    """Why the actor (HR / admin acting on someone else) may not change this person's job, line, pay or employment:
    the subject is above the actor in the reporting line, or an executive the actor doesn't manage."""
    from app.services.scope import manager_chain_ids

    if not actor_employee_id or subject.id == actor_employee_id:
        return None
    if subject.id in manager_chain_ids(db, actor_employee_id):
        return f"{subject.full_name} is above you in the reporting line. Changes for them go to the board or their own manager."
    if is_executive(db, subject) and actor_employee_id not in manager_chain_ids(db, subject.id):
        return f"{subject.full_name} is an executive. Changes for executives are decided by the board, not HR or admin."
    return None


def is_serving_notice(emp: Employee) -> bool:
    return (emp.employment_status or "").strip().lower() in NOTICE_STATUSES


def in_probation(db: Session, emp: Employee, on: date) -> bool:
    from app.services.leave_rules import probation_end

    return bool(emp.joining_date) and on < probation_end(db, emp)


def grade_band(grade: str | None) -> str:
    g = (grade or "").strip().upper()
    if g.startswith("E"):
        return "E"
    if g.startswith("M"):
        return "M"
    return "IC"


def is_senior_grade(grade: str | None) -> bool:
    return grade_band(grade) in ("E", "M") or (grade or "").strip().upper() in SENIOR_G_GRADES


def overtime_block_reason(db: Session, emp: Employee) -> str | None:
    role = account_role(db, emp.id)
    if role in OVERTIME_EXEMPT_ROLES:
        return "Paid overtime isn't available for executives, managers or the HR head (exempt roles)."
    if is_senior_grade(emp.grade):
        return f"Paid overtime isn't available at grade {emp.grade} (managers, executives and senior grades are exempt)."
    return None


def attendance_exempt(db: Session, emp: Employee) -> bool:
    return account_role(db, emp.id) in ATTENDANCE_EXEMPT_ROLES

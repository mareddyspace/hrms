"""Who may decide a request raised by someone else (attendance corrections, timesheet weeks, approvals list).

Product-owner rule: only the person's direct (line) manager, someone covering for that manager through an active
delegation, or HR whose data scope covers the person. Never a skip-level manager, never your own request.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import ColumnElement, and_, false, or_
from sqlalchemy.orm import Session

from app.deps import CurrentUser
from app.models import Employee
from app.services.scope import manager_chain_ids

NOT_FOUND = HTTPException(404, "Not found.")


def me(user: CurrentUser) -> Employee:
    if user.employee is None:
        raise HTTPException(400, "This account is not linked to an employee record.")
    return user.employee


def target(db: Session, user: CurrentUser, employee_id: str | None) -> Employee:
    """The caller, or someone in the caller's data scope (404 otherwise)."""
    if not employee_id or employee_id == user.employee_id:
        return me(user)
    emp = db.get(Employee, employee_id)
    if emp is None or not user.scope.can_see(emp):
        raise NOT_FOUND
    return emp


def can_view(db: Session, user: CurrentUser, emp: Employee) -> bool:
    return user.scope.can_see(emp) or (user.employee_id is not None and user.employee_id in manager_chain_ids(db, emp.id))


def is_line_manager(user: CurrentUser, emp: Employee) -> bool:
    return bool(user.employee_id) and emp.manager_id == user.employee_id and emp.id != user.employee_id


def can_decide(db: Session, user: CurrentUser, emp: Employee, type_: str = "other") -> bool:
    """Direct manager, the direct manager's delegate (for this request type) or HR in scope. Not skip-level."""
    if not user.employee_id or emp.id == user.employee_id:
        return False
    if user.scope.is_hr and user.scope.can_see(emp):
        return True
    if is_line_manager(user, emp):
        return True
    if emp.manager_id:
        from app.services.approvals import delegators_for

        return emp.manager_id in delegators_for(db, user.employee_id, type_)
    return False


def decidable_filter(user: CurrentUser) -> ColumnElement[bool]:
    """SQL condition on Employee: people whose requests this user may decide (never themselves)."""
    if not user.employee_id:
        return false()
    parts: list[ColumnElement[bool]] = []
    if user.scope.reports:  # direct reports only (no skip-level)
        parts.append(Employee.manager_id == user.employee_id)
    if user.scope.is_hr:
        parts.append(user.scope.employee_filter())
    if not parts:
        return false()
    return and_(Employee.id != user.employee_id, or_(*parts))

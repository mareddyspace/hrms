"""Who may decide a request raised by someone else (attendance corrections, timesheet weeks, approvals list).

Same rule as leave (app/routers/leave.py): anyone above the person in the reporting line, or HR whose data scope
covers the person. Never your own request.
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


def can_decide(db: Session, user: CurrentUser, emp: Employee) -> bool:
    if not user.employee_id or emp.id == user.employee_id:
        return False
    if user.scope.is_hr and user.scope.can_see(emp):
        return True
    return user.employee_id in manager_chain_ids(db, emp.id)


def decidable_filter(user: CurrentUser) -> ColumnElement[bool]:
    """SQL condition on Employee: people whose requests this user may decide (never themselves)."""
    if not user.employee_id:
        return false()
    parts: list[ColumnElement[bool]] = []
    if user.scope.reports:
        parts.append(Employee.id.in_(user.scope.reports))
    if user.scope.is_hr:
        parts.append(user.scope.employee_filter())
    if not parts:
        return false()
    return and_(Employee.id != user.employee_id, or_(*parts))

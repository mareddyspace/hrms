"""Who counts as working here: pre-boarding joiners are in the directory and onboarding, but not in headcount,
review lists or shift rosters until they start."""

from __future__ import annotations

from datetime import date

from sqlalchemy import ColumnElement, and_, func

from app.models import Employee

PRE_START_STATUSES = ("onboarding", "pre-boarding", "pre_boarding", "preboarding")


def started_clause(on: date) -> ColumnElement[bool]:
    """SQL: the person has started by this day (not pre-boarding, joining date reached)."""
    return and_(func.lower(Employee.employment_status).not_in(PRE_START_STATUSES), Employee.joining_date <= on)


def has_started(emp: Employee, on: date) -> bool:
    return (emp.employment_status or "").strip().lower() not in PRE_START_STATUSES and emp.joining_date <= on


def joined_by(emp: Employee, on: date) -> bool:
    """For a given day (rosters): the joining date is reached."""
    return emp.joining_date <= on

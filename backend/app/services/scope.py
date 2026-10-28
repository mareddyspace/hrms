"""Who can see whom.

- everyone: themselves
- anyone with reports: their whole reporting line (recursive via manager_id)
- HR / admin / executive: global (HR can be limited to a list of countries in access_scopes)
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import ColumnElement, false, or_, select, true
from sqlalchemy.orm import Session

from app.models import AccessScope, Account, Employee

HR_ROLES = frozenset({"hr_admin", "hr", "hrbp"})
GLOBAL_ROLES = HR_ROLES | {"admin", "executive"}
# Saved data scopes that mean "people sharing my <column>" (app/services/data_scope.py).
SCOPE_MATCH_COLUMNS = {
    "department": "department", "country": "country_code", "entity": "legal_entity",
    "business_unit": "business_unit", "location": "location",
}


def report_ids(db: Session, manager_id: str) -> set[str]:
    """Everyone below this person, at any depth."""
    reports = select(Employee.id).where(Employee.manager_id == manager_id).cte("reports", recursive=True)
    reports = reports.union(select(Employee.id).where(Employee.manager_id == reports.c.id))
    return set(db.scalars(select(reports.c.id)))


def manager_chain_ids(db: Session, employee_id: str) -> list[str]:
    """Managers above this person, nearest first."""
    chain: list[str] = []
    seen = {employee_id}
    current = db.get(Employee, employee_id)
    while current is not None and current.manager_id and current.manager_id not in seen:
        chain.append(current.manager_id)
        seen.add(current.manager_id)
        current = db.get(Employee, current.manager_id)
    return chain


@dataclass
class Scope:
    self_id: str | None
    role: str
    is_global: bool
    countries: list[str] | None = None
    reports: set[str] = field(default_factory=set)

    @property
    def is_hr(self) -> bool:
        return self.role in HR_ROLES

    def employee_filter(self) -> ColumnElement[bool]:
        """SQL condition on Employee for rows this user may see."""
        own = {self.self_id, *self.reports} - {None}
        if self.is_global and not self.countries:
            return true()
        parts: list[ColumnElement[bool]] = []
        if self.is_global and self.countries:
            parts.append(Employee.country_code.in_(self.countries))
        if own:
            parts.append(Employee.id.in_(own))
        return or_(*parts) if parts else false()

    def can_see(self, employee: Employee) -> bool:
        if employee.id == self.self_id or employee.id in self.reports:
            return True
        if self.is_global:
            return not self.countries or employee.country_code in self.countries
        return False


def build_scope(db: Session, account: Account) -> Scope:
    reports = report_ids(db, account.employee_id) if account.employee_id else set()
    countries: list[str] | None = None
    row = db.get(AccessScope, account.id)
    if row and row.country_codes:
        countries = [c.strip().upper() for c in row.country_codes.split(",") if c.strip()]
    return Scope(
        self_id=account.employee_id,
        role=account.role,
        is_global=account.role in GLOBAL_ROLES,
        countries=countries,
        reports=reports,
    )

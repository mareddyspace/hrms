"""Data scope saved per account (admin, table account_data_scopes) applied on top of the role default scope.

No saved row = the role default from app/services/scope.py (unchanged behaviour). A saved scope
(same options as the portal, src/data/accessControl.ts):
- own: only themselves            - direct: themselves and direct reports    - line: their whole reporting line
- department / country / entity / business_unit / location: people sharing their department / country / legal entity /
  business unit / location (plus their line)
- global: everyone; HR may be limited to a list of countries
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.orm import Session

from app.models import Account, AccountDataScope, Employee
from app.services.scope import HR_ROLES, ORG_WIDE_ROLES, SCOPE_MATCH_COLUMNS, Scope, build_scope

DATA_SCOPES = ("own", "direct", "line", "department", "country", "entity", "business_unit", "location", "global")
_MATCH_COLUMN = SCOPE_MATCH_COLUMNS


def default_scope_name(role: str) -> str:
    if role in HR_ROLES:  # admin / executive: their line for HR data; org-wide only for aggregates (Scope.org_wide)
        return "global"
    return "line"


@dataclass
class SavedScope(Scope):
    """Scope with an extra "same department / country / legal entity" rule."""

    kind: str = "default"
    match_column: str | None = None
    match_value: str | None = None

    def employee_filter(self) -> ColumnElement[bool]:
        base = super().employee_filter()
        if self.match_column and self.match_value:
            rule = getattr(Employee, self.match_column) == self.match_value
            if self.countries:
                rule = rule & Employee.country_code.in_(self.countries)
            return or_(base, rule)
        return base

    def can_see(self, employee: Employee) -> bool:
        if super().can_see(employee):
            return True
        if self.match_column and self.match_value and getattr(employee, self.match_column) == self.match_value:
            return not self.countries or employee.country_code in self.countries
        return False


def saved_row(db: Session, account_id: str) -> AccountDataScope | None:
    return db.get(AccountDataScope, account_id)


def scope_for(db: Session, account: Account) -> Scope:
    """The scope request handlers use (app/deps.py)."""
    base = build_scope(db, account)
    row = saved_row(db, account.id)
    if row is None:
        return base
    countries = [c.strip().upper() for c in (row.country_codes or []) if c and c.strip()] or None
    if account.role not in HR_ROLES:
        countries = None
    reports = set(base.reports)
    if row.scope == "own":
        reports = set()
    elif row.scope == "direct" and account.employee_id:
        reports = set(db.scalars(select(Employee.id).where(Employee.manager_id == account.employee_id)))
    me = db.get(Employee, account.employee_id) if account.employee_id else None
    column = _MATCH_COLUMN.get(row.scope)
    value = getattr(me, column) if (column and me is not None) else None
    return SavedScope(
        self_id=account.employee_id,
        role=account.role,
        is_global=row.scope == "global",
        countries=countries if row.scope == "global" or row.scope in _MATCH_COLUMN else None,
        reports=reports,
        org_wide=base.org_wide,
        kind=row.scope,
        match_column=column if value else None,
        match_value=value,
    )

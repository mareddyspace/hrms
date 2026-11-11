"""Contract end dates for contractors that have none (fill-blank only, idempotent, safe on the live database).

The compliance calendar seed gives a few contractors a near end date; everyone else on a fixed-term contract gets the
next anniversary of their joining date after 31 Jan 2027, so contract alerts and the director dashboard show real
dates instead of "no end date".
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Employee

AFTER = date(2027, 1, 31)


def _next_anniversary(joined: date, after: date) -> date:
    year = after.year
    while True:
        try:
            d = joined.replace(year=year)
        except ValueError:  # 29 Feb
            d = date(year, 2, 28)
        if d > after:
            return d
        year += 1


def seed(db: Session) -> dict[str, int]:
    added = 0
    for emp in db.scalars(select(Employee).where(Employee.employment_type == "Contract", Employee.contract_end_date.is_(None),
                                                 Employee.employment_status != "Terminated")):
        if emp.joining_date:
            emp.contract_end_date = _next_anniversary(emp.joining_date, AFTER)
            added += 1
    return {"contract_end_dates_filled": added}

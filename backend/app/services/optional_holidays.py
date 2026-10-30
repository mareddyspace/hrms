"""Optional (restricted) holidays: a per-country list people pick from, booked as leave type "optional".

The yearly number of picks is the "optional" leave policy quota for the country (e.g. 2 in India), so picks go
through the normal leave flow: balance, manager approval, calendar.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Country, Employee, OptionalHoliday

CODE = "optional"

# id, country, date, name (same list as the portal's local mode, src/features/workforce/optionalHolidaysStore.ts)
DEFAULTS: list[tuple[str, str, date, str]] = [
    ("oh-in-mahavir", "IN", date(2026, 3, 31), "Mahavir Jayanti"),
    ("oh-in-onam", "IN", date(2026, 8, 26), "Onam"),
    ("oh-in-rakhi", "IN", date(2026, 8, 27), "Raksha Bandhan"),
    ("oh-in-karva", "IN", date(2026, 10, 29), "Karva Chauth"),
    ("oh-in-chhath", "IN", date(2026, 11, 16), "Chhath Puja"),
    ("oh-in-xmas-eve", "IN", date(2026, 12, 24), "Christmas Eve"),
    ("oh-in-nye", "IN", date(2026, 12, 31), "New Year's Eve"),
    ("oh-us-thanks", "US", date(2026, 11, 27), "Day after Thanksgiving"),
    ("oh-us-xmas-eve", "US", date(2026, 12, 24), "Christmas Eve"),
]


def seed_defaults(db: Session) -> int:
    """Adds the sample optional holidays that are missing (never overwrites HR's changes)."""
    countries = set(db.scalars(select(Country.code)))
    added = 0
    for hid, cc, day, name in DEFAULTS:
        if cc in countries and db.get(OptionalHoliday, hid) is None:
            db.add(OptionalHoliday(id=hid, country_code=cc, date=day, name=name, active=True))
            added += 1
    db.flush()
    return added


def list_for(db: Session, country_code: str, year: int) -> list[OptionalHoliday]:
    return list(
        db.scalars(
            select(OptionalHoliday)
            .where(OptionalHoliday.country_code == country_code, OptionalHoliday.active.is_(True),
                   OptionalHoliday.date >= date(year, 1, 1), OptionalHoliday.date <= date(year, 12, 31))
            .order_by(OptionalHoliday.date)
        )
    )


def request_problem(db: Session, employee: Employee, start: date, end: date, half: str) -> str | None:
    """Why an "optional" leave request isn't allowed, or None."""
    if start != end:
        return "An optional holiday is a single day."
    if half != "none":
        return "An optional holiday can't be taken as a half day."
    found = db.scalar(
        select(OptionalHoliday).where(OptionalHoliday.country_code == employee.country_code, OptionalHoliday.date == start,
                                      OptionalHoliday.active.is_(True))
    )
    if found is None:
        return "That date isn't an optional holiday for your country."
    return None

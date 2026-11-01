"""Optional (restricted) holidays: a per-country list people pick from, booked as leave type "optional".

The yearly number of picks is the "optional" leave policy quota for the country (e.g. 2 in India), so picks go
through the normal leave flow: balance, manager approval, calendar.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import or_, select
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


DESCRIPTIONS: dict[str, str] = {
    "oh-in-mahavir": "Jain festival marking the birth of Lord Mahavir.",
    "oh-in-onam": "Harvest festival of Kerala.",
    "oh-in-rakhi": "Festival celebrating the bond between brothers and sisters.",
    "oh-in-karva": "Festival observed mainly in North India.",
    "oh-in-chhath": "Festival of the Sun god, observed mainly in Bihar and Uttar Pradesh.",
    "oh-in-xmas-eve": "The evening before Christmas Day.",
    "oh-in-nye": "The last day of the year.",
    "oh-us-thanks": "The Friday after Thanksgiving.",
    "oh-us-xmas-eve": "The day before Christmas Day.",
}
PICK_NOTICE_DAYS = 7  # the sample holidays must be picked a week ahead


def deadline(row: OptionalHoliday) -> date:
    """Last day the holiday can be picked: HR's date, else the day before the holiday."""
    return row.select_by or (row.date - timedelta(days=1))


def seed_defaults(db: Session) -> int:
    """Adds the sample optional holidays that are missing (never overwrites HR's changes; fills empty details)."""
    countries = set(db.scalars(select(Country.code)))
    added = 0
    for hid, cc, day, name in DEFAULTS:
        if cc not in countries:
            continue
        row = db.get(OptionalHoliday, hid)
        if row is None:
            row = OptionalHoliday(id=hid, country_code=cc, date=day, name=name, active=True)
            db.add(row)
            added += 1
        if row.description is None:
            row.description = DESCRIPTIONS.get(hid)
        if row.select_by is None and row.date == day:
            row.select_by = day - timedelta(days=PICK_NOTICE_DAYS)
    db.flush()
    return added


def list_for(db: Session, country_code: str, year: int, employee: Employee | None = None) -> list[OptionalHoliday]:
    """The country's optional holidays in a year; for a person, only those for their region and legal entity."""
    stmt = (
        select(OptionalHoliday)
        .where(OptionalHoliday.country_code == country_code, OptionalHoliday.active.is_(True),
               OptionalHoliday.date >= date(year, 1, 1), OptionalHoliday.date <= date(year, 12, 31))
        .order_by(OptionalHoliday.date)
    )
    if employee is not None:
        stmt = stmt.where(
            or_(OptionalHoliday.region.is_(None), OptionalHoliday.region == (employee.holiday_calendar or "")),
            or_(OptionalHoliday.legal_entity.is_(None), OptionalHoliday.legal_entity == (employee.legal_entity or "")),
        )
    return list(db.scalars(stmt))


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
    if found is None or found not in list_for(db, employee.country_code, start.year, employee):
        return "That date isn't an optional holiday for your country."
    from app.services.leave import today_for

    if today_for(employee) > deadline(found):
        return f"Picks for {found.name} closed on {deadline(found).isoformat()}."
    return None

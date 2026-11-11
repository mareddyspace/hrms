"""Who gets which holiday (migration 0032).

A holiday has a type and an applicability:
- holiday_type: national | regional | company | optional  (NULL on old rows = national, a day off for the whole country)
- regions: list of states / cities (NULL or empty = the whole country). A person matches when their work location,
  or the state that location is in, is listed.
- legal_entity: only people employed by that entity (NULL = every entity).
- calendar (older column): only people on that holiday calendar (NULL = every calendar).

Optional holidays are not days off: they are picked by the person (leave type "optional", see optional_holidays.py),
so rows typed "optional" are mirrored into the optional_holidays list and left out of working-day counts.

classify_seeded() fills holiday_type / regions on the sample rows (fill-blank only, idempotent): India keeps three
national days, six company days and up to three state holidays by office, so each office has 12 days off in 2026;
the other festivals become optional picks.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any, Iterable

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

TYPES = ("national", "regional", "company", "optional")
DAY_OFF_TYPES = ("national", "regional", "company")

# Work location (city) -> state / province / region. Cities not listed match only by their own name.
CITY_REGION: dict[str, str] = {
    "bengaluru": "Karnataka", "bangalore": "Karnataka", "mysuru": "Karnataka",
    "hyderabad": "Telangana", "mumbai": "Maharashtra", "pune": "Maharashtra",
    "chennai": "Tamil Nadu", "coimbatore": "Tamil Nadu", "kochi": "Kerala", "thiruvananthapuram": "Kerala",
    "new delhi": "Delhi", "delhi": "Delhi", "gurugram": "Haryana", "noida": "Uttar Pradesh", "kolkata": "West Bengal",
    "ahmedabad": "Gujarat",
    "new york": "New York", "san francisco": "California", "austin": "Texas",
    "london": "England", "manchester": "England", "edinburgh": "Scotland",
    "sydney": "New South Wales", "melbourne": "Victoria",
    "toronto": "Ontario", "vancouver": "British Columbia", "montreal": "Quebec",
    "dubai": "Dubai", "abu dhabi": "Abu Dhabi", "riyadh": "Riyadh", "jeddah": "Makkah",
    "berlin": "Berlin", "munich": "Bavaria", "frankfurt": "Hesse",
}


def region_of(location: str | None) -> str | None:
    return CITY_REGION.get((location or "").strip().lower())


def _norm(value: str | None) -> str:
    return (value or "").strip().lower()


def kind(row: Any) -> str:
    return (getattr(row, "holiday_type", None) or "national").lower()


def applies(row: Any, *, calendar: str | None = None, location: str | None = None,
            legal_entity: str | None = None, include_optional: bool = False) -> bool:
    """Whether a holiday row is a day off for someone with this calendar / location / legal entity.

    location None means "no particular office": only holidays without a region match."""
    if not getattr(row, "active", True):
        return False
    if kind(row) == "optional" and not include_optional:
        return False
    if row.calendar and _norm(row.calendar) != _norm(calendar):
        return False
    entity = getattr(row, "legal_entity", None)
    if entity and _norm(entity) != _norm(legal_entity):
        return False
    regions = [r for r in (getattr(row, "regions", None) or []) if r]
    if regions:
        mine = {_norm(location), _norm(region_of(location))} - {""}
        if not mine or not mine & {_norm(r) for r in regions}:
            return False
    return True


def applies_to(row: Any, employee: Any, include_optional: bool = False) -> bool:
    return applies(row, calendar=employee.holiday_calendar, location=employee.location,
                   legal_entity=employee.legal_entity, include_optional=include_optional)


def rows_for(db: Session, country_code: str, start: date, end: date, *, calendar: str | None = None,
             location: str | None = None, legal_entity: str | None = None, include_optional: bool = False) -> list[Any]:
    from app.models import Holiday

    stmt = select(Holiday).where(Holiday.country_code == country_code, Holiday.date >= start, Holiday.date <= end,
                                 Holiday.active.is_(True))
    stmt = stmt.where(Holiday.calendar.is_(None) if not calendar else or_(Holiday.calendar.is_(None), Holiday.calendar == calendar))
    return [h for h in db.scalars(stmt.order_by(Holiday.date))
            if applies(h, calendar=calendar, location=location, legal_entity=legal_entity, include_optional=include_optional)]


def rows_for_employee(db: Session, employee: Any, start: date, end: date, include_optional: bool = False) -> list[Any]:
    return rows_for(db, employee.country_code, start, end, calendar=employee.holiday_calendar,
                    location=employee.location, legal_entity=employee.legal_entity, include_optional=include_optional)


def clean_regions(regions: Iterable[str] | None) -> list[str] | None:
    if regions is None:
        return None
    out = list(dict.fromkeys(r.strip() for r in regions if r and r.strip()))
    return out or None


# ---------- classification of the sample holidays (fill-blank only) ----------
IN_STATES = {
    "sankranti": ["Karnataka", "Telangana", "Tamil Nadu"],
    "pongal": ["Karnataka", "Telangana", "Tamil Nadu"],
    "ugadi": ["Karnataka", "Telangana", "Maharashtra"],
    "may day": ["Karnataka", "Maharashtra"],
    "ganesh": ["Maharashtra", "Telangana"],
    "onam": ["Kerala"],
}
# (country, lower-case name fragment) -> type, first match wins
NAME_RULES: dict[str, list[tuple[str, str]]] = {
    "IN": [("republic day", "national"), ("independence day", "national"), ("gandhi jayanti", "national"),
           ("new year", "company"), ("dussehra", "company"), ("diwali", "company"), ("christmas", "company"),
           ("founders", "company"),
           ("sankranti", "regional"), ("ugadi", "regional"), ("may day", "regional"), ("ganesh", "regional"),
           ("onam", "regional"), ("", "optional")],
    "US": [("day after thanksgiving", "company"), ("", "national")],
    "CA": [("family day", "regional"), ("civic holiday", "regional"), ("", "national")],
    "AU": [("labour day", "regional"), ("melbourne cup", "regional"), ("", "national")],
    "DE": [("fronleichnam", "regional"), ("heilige drei", "regional"), ("", "national")],
    "GB": [("", "national")], "AE": [("", "national")], "SA": [("", "national")],
}
OTHER_REGIONS: dict[str, dict[str, list[str]]] = {
    "CA": {"family day": ["Ontario", "British Columbia"], "civic holiday": ["Ontario", "British Columbia"]},
    "AU": {"labour day (victoria)": ["Victoria"], "labour day": ["New South Wales"], "melbourne cup": ["Victoria"]},
    "DE": {"fronleichnam": ["Bavaria", "Hesse"], "heilige drei": ["Bavaria"]},
}
ADMIN_ID = re.compile(r"^h-[a-z]{2}-[0-9a-f]{10}$")  # rows HR added in the admin screen (typed by HR, not here)

# State holidays the sample data was missing (insert once, never overwritten).
EXTRA_REGIONAL: list[tuple[str, str, date, str, list[str], str]] = [
    ("h-au-r-labour-vic", "AU", date(2026, 3, 9), "Labour Day (Victoria)", ["Victoria"], "Public holiday in Victoria."),
    ("h-au-r-melb-cup", "AU", date(2026, 11, 3), "Melbourne Cup Day", ["Victoria"], "Public holiday in Melbourne."),
    ("h-de-r-drei-koenige", "DE", date(2026, 1, 6), "Heilige Drei Könige", ["Bavaria"], "Epiphany; a public holiday in Bavaria."),
    ("h-de-r-fronleichnam", "DE", date(2026, 6, 4), "Fronleichnam", ["Bavaria", "Hesse"],
     "Corpus Christi; a public holiday in Bavaria and Hesse."),
    ("h-in-r-onam", "IN", date(2026, 8, 26), "Thiruvonam (Onam)", ["Kerala"], "Harvest festival of Kerala; a holiday for Kerala offices."),
    ("h-in-r-pongal-tn", "IN", date(2026, 1, 15), "Thai Pongal", ["Tamil Nadu"], "Harvest festival of Tamil Nadu."),
]


def classify(country_code: str, name: str) -> tuple[str, list[str] | None] | None:
    low = name.lower()
    for fragment, holiday_type in NAME_RULES.get(country_code, []):
        if fragment in low:
            regions = None
            if holiday_type == "regional":
                pool = IN_STATES if country_code == "IN" else OTHER_REGIONS.get(country_code, {})
                regions = next((v for k, v in pool.items() if k in low), None)
                if regions is None:
                    return None
            return holiday_type, regions
    return None


def is_seed_id(holiday_id: str) -> bool:
    return holiday_id.startswith("h-") and not ADMIN_ID.match(holiday_id)


def offer_as_optional(db: Session, holiday: Any) -> int:
    """List an optional-typed holiday as an optional-holiday pick (insert once; 0 when that date is already listed)."""
    from app.models import OptionalHoliday

    oid = f"oh-{holiday.id}"[:64]
    if db.get(OptionalHoliday, oid) is not None or db.scalar(select(OptionalHoliday.id).where(
            OptionalHoliday.country_code == holiday.country_code, OptionalHoliday.date == holiday.date)):
        return 0
    regions = holiday.regions or []
    db.add(OptionalHoliday(id=oid, country_code=holiday.country_code, date=holiday.date, name=holiday.name, active=True,
                           description=holiday.description, region=regions[0] if len(regions) == 1 else None,
                           legal_entity=holiday.legal_entity, select_by=holiday.date - timedelta(days=1)))
    db.flush()
    return 1


def classify_seeded(db: Session) -> dict[str, int]:
    """Fill holiday_type / regions on sample rows still blank, add the missing state holidays and offer the
    optional ones as optional-holiday picks. Never changes a row HR has typed, never deletes."""
    from app.models import Country, Holiday

    countries = set(db.scalars(select(Country.code)))
    added = 0
    have_dates = {(h.country_code, h.date, tuple(h.regions or ())) for h in db.scalars(select(Holiday))}
    for hid, cc, day, name, regions, desc in EXTRA_REGIONAL:
        if cc not in countries or db.get(Holiday, hid) is not None or (cc, day, tuple(regions)) in have_dates:
            continue
        db.add(Holiday(id=hid, country_code=cc, date=day, name=name, calendar=None, active=True, description=desc,
                       holiday_type="regional", regions=regions))
        added += 1
    db.flush()
    typed = 0
    for h in db.scalars(select(Holiday).where(Holiday.holiday_type.is_(None))):
        if not is_seed_id(h.id):
            continue
        found = classify(h.country_code, h.name)
        if found is None:
            continue
        h.holiday_type, regions = found
        if h.regions is None and regions:
            h.regions = regions
        typed += 1
    db.flush()
    offered = sum(offer_as_optional(db, h) for h in list(db.scalars(
        select(Holiday).where(Holiday.holiday_type == "optional", Holiday.active.is_(True)))))
    db.flush()
    return {"holidays_typed": typed, "regional_holidays_added": added, "optional_picks_added": offered}

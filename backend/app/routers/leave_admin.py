"""Leave admin for HR and admins: leave types, leave policies per country (with eligibility rules), holidays per
country / holiday calendar, and the year-end carry-forward job. Every change is audited. Also the country
config (GET for everyone signed in, PUT for admins). Nothing is hard-deleted: DELETE deactivates."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import func, select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Country, Employee, Holiday, LeavePolicy, LeaveType
from app.schemas.leave_rules import (
    CarryForwardRunOut,
    CountryConfigIn,
    CountryConfigOut,
    HolidayAdminIn,
    HolidayAdminOut,
    HolidayAdminUpdate,
    HolidayCalendarOut,
    HolidayLocationOut,
    LeavePolicyAdminIn,
    LeavePolicyAdminOut,
    LeavePolicyAdminUpdate,
    LeaveTypeAdminIn,
    LeaveTypeAdminOut,
    LeaveTypeAdminUpdate,
)
from app.services import holiday_rules, leave_rules
from app.services.activity import record_audit
from app.services.scope import HR_ACCESS_ROLES

router = APIRouter(prefix="/admin/leave", tags=["leave admin"])
countries_router = APIRouter(prefix="/countries", tags=["countries"])

ADMIN_ROLES = frozenset({"admin", "super_admin"})
NOT_FOUND = HTTPException(404, "Not found.")
CountryQ = Annotated[str | None, Query(pattern=r"^[A-Z]{2}$")]


def _hr_or_admin(user: CurrentUser) -> None:
    if user.account.role not in HR_ACCESS_ROLES and user.account.role not in ADMIN_ROLES:
        raise HTTPException(403, "Only HR or an administrator can do this.")


def _covers(user: CurrentUser, code: str | None) -> None:
    """HR limited to some countries changes only those countries' policies and holidays."""
    countries = user.scope.countries
    if countries and code not in countries:
        raise HTTPException(403, "That country is outside your HR scope.")


def _country(db: DbSession, code: str) -> Country:
    country = db.get(Country, code)
    if country is None:
        raise HTTPException(422, "Unknown country.")
    return country


def _snap(row: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    return {f: getattr(row, f) for f in fields}


TYPE_FIELDS = ("name", "half_day_allowed", "active")
POLICY_FIELDS = ("leave_code", "country_code", "name", "quota", "carry_forward_max", "accrual", "effective_from",
                 "effective_to", "gender", "min_service_months", "employment_types", "not_in_probation",
                 "max_per_request", "min_notice_days", "active", "encashable")
HOLIDAY_FIELDS = ("country_code", "date", "name", "calendar", "active", "holiday_type", "regions", "legal_entity")
COUNTRY_FIELDS = leave_rules.COUNTRY_CONFIG_FIELDS


def _audit(db: DbSession, user: CurrentUser, request: Request, action: str, entity: str, entity_id: str,
           before: dict | None, after: dict | None) -> None:
    record_audit(db, actor_id=user.id, action=action, entity=entity, entity_id=entity_id, before=before, after=after,
                 ip=client_ip(request))


# ---------- leave types ----------
@router.get("/types", response_model=list[LeaveTypeAdminOut])
def list_types(db: DbSession, user: CurrentUserDep) -> list[LeaveType]:
    _hr_or_admin(user)
    return list(db.scalars(select(LeaveType).order_by(LeaveType.name)))


@router.post("/types", response_model=LeaveTypeAdminOut, status_code=status.HTTP_201_CREATED)
def create_type(body: LeaveTypeAdminIn, request: Request, db: DbSession, user: CurrentUserDep) -> LeaveType:
    _hr_or_admin(user)
    if db.get(LeaveType, body.code) is not None:
        raise HTTPException(409, "A leave type with this code already exists.")
    row = LeaveType(code=body.code, name=body.name.strip(), half_day_allowed=body.half_day_allowed, active=True)
    db.add(row)
    db.flush()
    _audit(db, user, request, "leave_type_created", "leave_type", row.code, None, _snap(row, TYPE_FIELDS))
    db.commit()
    return row


def _update_type(db: DbSession, user: CurrentUser, request: Request, code: str, changes: dict[str, Any]) -> LeaveType:
    _hr_or_admin(user)
    row = db.get(LeaveType, code)
    if row is None:
        raise NOT_FOUND
    before = _snap(row, TYPE_FIELDS)
    for k, v in changes.items():
        setattr(row, k, v.strip() if isinstance(v, str) else v)
    after = _snap(row, TYPE_FIELDS)
    if after != before:
        action = "leave_type_deactivated" if before["active"] and not row.active else "leave_type_updated"
        _audit(db, user, request, action, "leave_type", code, before, after)
    db.commit()
    return row


@router.put("/types/{code}", response_model=LeaveTypeAdminOut)
def update_type(code: str, body: LeaveTypeAdminUpdate, request: Request, db: DbSession, user: CurrentUserDep) -> LeaveType:
    return _update_type(db, user, request, code, body.model_dump(exclude_unset=True, exclude_none=True))


@router.delete("/types/{code}", response_model=LeaveTypeAdminOut)
def deactivate_type(code: str, request: Request, db: DbSession, user: CurrentUserDep) -> LeaveType:
    return _update_type(db, user, request, code, {"active": False})


# ---------- leave policies ----------
@router.get("/policies", response_model=list[LeavePolicyAdminOut])
def list_policies(db: DbSession, user: CurrentUserDep, country: CountryQ = None,
                  include_inactive: bool = True) -> list[LeavePolicy]:
    _hr_or_admin(user)
    stmt = select(LeavePolicy)
    if country:
        stmt = stmt.where(LeavePolicy.country_code == country)
    if not include_inactive:
        stmt = stmt.where(LeavePolicy.active.is_(True))
    return list(db.scalars(stmt.order_by(LeavePolicy.country_code, LeavePolicy.leave_code, LeavePolicy.effective_from)))


def _check_policy(row: LeavePolicy) -> None:
    if row.effective_to and row.effective_to < row.effective_from:
        raise HTTPException(422, "The end date is before the start date.")
    if row.carry_forward_max and row.carry_forward_max > row.quota:
        raise HTTPException(422, "Carry-forward can't be more than the yearly quota.")
    if row.accrual not in ("annual", "monthly"):
        raise HTTPException(422, "Choose yearly or monthly accrual.")


def _clean_types(types: list[str] | None) -> list[str] | None:
    if types is None:
        return None
    clean = list(dict.fromkeys(t.strip() for t in types if t and t.strip()))
    return clean or None


@router.post("/policies", response_model=LeavePolicyAdminOut, status_code=status.HTTP_201_CREATED)
def create_policy(body: LeavePolicyAdminIn, request: Request, db: DbSession, user: CurrentUserDep) -> LeavePolicy:
    _hr_or_admin(user)
    _covers(user, body.country_code)
    _country(db, body.country_code)
    if db.get(LeaveType, body.leave_code) is None:
        raise HTTPException(422, "Unknown leave type.")
    clash = db.scalar(select(LeavePolicy.id).where(LeavePolicy.leave_code == body.leave_code,
                                                   LeavePolicy.country_code == body.country_code,
                                                   LeavePolicy.effective_from == body.effective_from))
    if clash:
        raise HTTPException(409, "A policy for this type, country and start date already exists. Edit it instead.")
    data = body.model_dump()
    data["employment_types"] = _clean_types(data["employment_types"])
    data["name"] = data["name"].strip()
    row = LeavePolicy(id=f"{body.leave_code}-{body.country_code}-{uuid.uuid4().hex[:8]}", active=True, **data)
    _check_policy(row)
    db.add(row)
    db.flush()
    _audit(db, user, request, "leave_policy_created", "leave_policy", row.id, None, _snap(row, POLICY_FIELDS))
    db.commit()
    return row


def _update_policy(db: DbSession, user: CurrentUser, request: Request, policy_id: str, changes: dict[str, Any]) -> LeavePolicy:
    _hr_or_admin(user)
    row = db.get(LeavePolicy, policy_id)
    if row is None:
        raise NOT_FOUND
    _covers(user, row.country_code)
    if "country_code" in changes:
        _covers(user, changes["country_code"])
    before = _snap(row, POLICY_FIELDS)
    if "employment_types" in changes:
        changes["employment_types"] = _clean_types(changes["employment_types"])
    for k, v in changes.items():
        setattr(row, k, v.strip() if isinstance(v, str) else v)
    _check_policy(row)
    after = _snap(row, POLICY_FIELDS)
    if after != before:
        action = "leave_policy_deactivated" if before["active"] and not row.active else "leave_policy_updated"
        _audit(db, user, request, action, "leave_policy", policy_id, before, after)
    db.commit()
    return row


@router.put("/policies/{policy_id}", response_model=LeavePolicyAdminOut)
def update_policy(policy_id: str, body: LeavePolicyAdminUpdate, request: Request, db: DbSession,
                  user: CurrentUserDep) -> LeavePolicy:
    # Explicit nulls clear the optional limits (min service, max per request, notice, end date).
    changes = body.model_dump(exclude_unset=True)
    for required in ("name", "quota", "carry_forward_max", "accrual", "effective_from", "gender", "not_in_probation", "active"):
        if required in changes and changes[required] is None:
            changes.pop(required)
    return _update_policy(db, user, request, policy_id, changes)


@router.delete("/policies/{policy_id}", response_model=LeavePolicyAdminOut)
def deactivate_policy(policy_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> LeavePolicy:
    return _update_policy(db, user, request, policy_id, {"active": False})


# ---------- holidays ----------
@router.get("/holidays", response_model=list[HolidayAdminOut])
def list_holidays(db: DbSession, user: CurrentUserDep, country: CountryQ = None,
                  year: Annotated[int | None, Query(ge=2000, le=2100)] = None, calendar: str | None = None,
                  holiday_type: Annotated[str | None, Query(pattern="^(national|regional|company|optional)$")] = None,
                  location: Annotated[str | None, Query(max_length=200)] = None) -> list[Holiday]:
    """location: only the holidays that apply to that office (whole-country ones plus its state's)."""
    _hr_or_admin(user)
    stmt = select(Holiday)
    if country:
        stmt = stmt.where(Holiday.country_code == country)
    if year:
        stmt = stmt.where(Holiday.date >= date(year, 1, 1), Holiday.date <= date(year, 12, 31))
    if calendar:
        stmt = stmt.where(Holiday.calendar == calendar)
    rows = list(db.scalars(stmt.order_by(Holiday.country_code, Holiday.date)))
    if holiday_type:
        rows = [h for h in rows if holiday_rules.kind(h) == holiday_type]
    if location:
        rows = [h for h in rows if not h.regions or holiday_rules.applies(
            h, calendar=h.calendar, location=location, legal_entity=h.legal_entity, include_optional=True)]
    return rows


@router.get("/holiday-locations", response_model=list[HolidayLocationOut])
def holiday_locations(db: DbSession, user: CurrentUserDep, country: CountryQ = None,
                      year: Annotated[int | None, Query(ge=2000, le=2100)] = None) -> list[HolidayLocationOut]:
    """Each office (work location) with its state, head count and how many days off it gets in the year."""
    _hr_or_admin(user)
    year = year or date.today().year
    stmt = (select(Employee.country_code, Employee.location, Employee.legal_entity, func.count())
            .where(Employee.employment_status != "Terminated")
            .group_by(Employee.country_code, Employee.location, Employee.legal_entity)
            .order_by(Employee.country_code, Employee.location))
    if country:
        stmt = stmt.where(Employee.country_code == country)
    out = []
    for cc, location, entity, n in db.execute(stmt):
        rows = holiday_rules.rows_for(db, cc, date(year, 1, 1), date(year, 12, 31), location=location,
                                      legal_entity=entity, include_optional=True)
        out.append(HolidayLocationOut(
            country_code=cc, location=location or "", region=holiday_rules.region_of(location), legal_entity=entity,
            employees=n, days_off=sum(1 for h in rows if holiday_rules.kind(h) != "optional"),
            by_type={t: sum(1 for h in rows if holiday_rules.kind(h) == t) for t in holiday_rules.TYPES}))
    return out


@router.get("/calendars", response_model=list[HolidayCalendarOut])
def list_calendars(db: DbSession, user: CurrentUserDep, country: CountryQ = None) -> list[HolidayCalendarOut]:
    """Holiday calendars in use (employees.holiday_calendar), per country."""
    _hr_or_admin(user)
    stmt = (select(Employee.country_code, Employee.holiday_calendar, func.count())
            .where(Employee.holiday_calendar.is_not(None))
            .group_by(Employee.country_code, Employee.holiday_calendar)
            .order_by(Employee.country_code, Employee.holiday_calendar))
    if country:
        stmt = stmt.where(Employee.country_code == country)
    return [HolidayCalendarOut(country_code=c, calendar=cal, employees=n) for c, cal, n in db.execute(stmt)]


def _check_holiday(row: Holiday) -> None:
    kind = holiday_rules.kind(row)
    if kind not in holiday_rules.TYPES:
        raise HTTPException(422, "Choose national, regional, company or optional.")
    row.regions = holiday_rules.clean_regions(row.regions)
    row.legal_entity = (row.legal_entity or "").strip() or None
    if kind == "regional" and not row.regions:
        raise HTTPException(422, "A regional holiday needs at least one state or location.")
    if kind == "national" and (row.regions or row.legal_entity):
        raise HTTPException(422, "A national holiday applies to the whole country; choose regional or company instead.")


def _holiday_clash(db: DbSession, row: Holiday) -> None:
    """The same date twice for the same people. Holidays for different states on one day are fine."""
    stmt = select(Holiday).where(Holiday.country_code == row.country_code, Holiday.date == row.date,
                                 Holiday.id != row.id, Holiday.active.is_(True))
    stmt = stmt.where(Holiday.calendar.is_(None) if row.calendar is None else Holiday.calendar == row.calendar)
    mine = {r.lower() for r in (row.regions or [])}
    for other in db.scalars(stmt):
        if (other.legal_entity or None) != (row.legal_entity or None):
            continue
        if (holiday_rules.kind(other) == "optional") != (holiday_rules.kind(row) == "optional"):
            continue  # an optional pick and a day off on the same date don't clash
        theirs = {r.lower() for r in (other.regions or [])}
        if not mine or not theirs or mine & theirs:
            raise HTTPException(409, "There is already a holiday on that date for these people.")


@router.post("/holidays", response_model=HolidayAdminOut, status_code=status.HTTP_201_CREATED)
def create_holiday(body: HolidayAdminIn, request: Request, db: DbSession, user: CurrentUserDep) -> Holiday:
    _hr_or_admin(user)
    _covers(user, body.country_code)
    _country(db, body.country_code)
    row = Holiday(id=f"h-{body.country_code.lower()}-{uuid.uuid4().hex[:10]}", country_code=body.country_code,
                  date=body.date, name=body.name.strip(), calendar=(body.calendar or "").strip() or None, active=True,
                  description=(body.description or "").strip() or None, holiday_type=body.holiday_type,
                  regions=body.regions, legal_entity=body.legal_entity)
    _check_holiday(row)
    _holiday_clash(db, row)
    db.add(row)
    db.flush()
    _audit(db, user, request, "holiday_created", "holiday", row.id, None, _snap(row, HOLIDAY_FIELDS))
    if row.holiday_type == "optional":
        holiday_rules.offer_as_optional(db, row)
    db.commit()
    return row


def _update_holiday(db: DbSession, user: CurrentUser, request: Request, holiday_id: str, changes: dict[str, Any]) -> Holiday:
    _hr_or_admin(user)
    row = db.get(Holiday, holiday_id)
    if row is None:
        raise NOT_FOUND
    _covers(user, row.country_code)
    if "country_code" in changes:
        _covers(user, changes["country_code"])
    before = _snap(row, HOLIDAY_FIELDS)
    if "calendar" in changes:
        changes["calendar"] = (changes["calendar"] or "").strip() or None
    for k, v in changes.items():
        setattr(row, k, v.strip() if isinstance(v, str) else v)
    if row.holiday_type is None and (row.regions or row.legal_entity):
        row.holiday_type = "regional" if row.regions else "company"
    _check_holiday(row)
    if row.active:
        _holiday_clash(db, row)
    after = _snap(row, HOLIDAY_FIELDS)
    if after != before:
        action = "holiday_deactivated" if before["active"] and not row.active else "holiday_updated"
        _audit(db, user, request, action, "holiday", holiday_id, before, after)
        if row.active and row.holiday_type == "optional":
            holiday_rules.offer_as_optional(db, row)
    db.commit()
    return row


@router.put("/holidays/{holiday_id}", response_model=HolidayAdminOut)
def update_holiday(holiday_id: str, body: HolidayAdminUpdate, request: Request, db: DbSession, user: CurrentUserDep) -> Holiday:
    changes = body.model_dump(exclude_unset=True)
    for required in ("date", "name", "active", "holiday_type"):
        if required in changes and changes[required] is None:
            changes.pop(required)
    return _update_holiday(db, user, request, holiday_id, changes)


@router.delete("/holidays/{holiday_id}", response_model=HolidayAdminOut)
def deactivate_holiday(holiday_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Holiday:
    return _update_holiday(db, user, request, holiday_id, {"active": False})


# ---------- carry-forward ----------
@router.post("/carry-forward/run", response_model=CarryForwardRunOut)
def run_carry_forward(request: Request, db: DbSession, user: CurrentUserDep,
                      year: Annotated[int | None, Query(ge=2000, le=2100)] = None) -> CarryForwardRunOut:
    """Carry unused days into `year` (default: this year). Running it again adds nothing."""
    _hr_or_admin(user)
    if user.scope.countries:
        raise HTTPException(403, "Carry-forward runs for every country; ask HR without a country limit or an admin.")
    out = leave_rules.run_carry_forward(db, year)
    record_audit(db, actor_id=user.id, action="leave_carry_forward_run", entity="jobs", entity_id=None, after=out,
                 ip=client_ip(request))
    db.commit()
    return CarryForwardRunOut(**out)


# ---------- country config ----------
@countries_router.get("", response_model=list[CountryConfigOut])
def list_countries(db: DbSession, user: CurrentUserDep) -> list[Country]:
    return list(db.scalars(select(Country).order_by(Country.name)))


@countries_router.put("/{code}", response_model=CountryConfigOut)
def put_country(code: str, body: CountryConfigIn, request: Request, db: DbSession, user: CurrentUserDep) -> Country:
    if user.account.role not in ADMIN_ROLES:
        raise HTTPException(403, "Only an administrator can do this.")
    row = db.get(Country, code.upper())
    if row is None:
        raise NOT_FOUND
    before = _snap(row, COUNTRY_FIELDS)
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    if "required_documents" in changes:
        changes["required_documents"] = list(dict.fromkeys(d.strip() for d in changes["required_documents"] if d.strip()))
    if "work_week_days" in changes:
        changes["work_week_days"] = [d for d in leave_rules.WEEK_DAYS if d in set(changes["work_week_days"])]
    if "languages" in changes:
        changes["languages"] = list(dict.fromkeys(changes["languages"])) or ["en"]
    if "workflow_notes" in changes:
        changes["workflow_notes"] = changes["workflow_notes"].strip()
    for k, v in changes.items():
        setattr(row, k, v)
    after = _snap(row, COUNTRY_FIELDS)
    if after != before:
        record_audit(db, actor_id=user.id, action="country_config_updated", entity="country", entity_id=row.code,
                     before=before, after=after, ip=client_ip(request))
    db.commit()
    return row

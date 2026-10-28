"""Company directory.

Everyone signed in sees the directory with basic fields (name, title, department, location, country, email,
manager, photo). The full record comes back only for people in the caller's data scope: themselves, their
reporting line, or (HR/admin/executive) everyone within their country scope. Pay fields are never returned.
Mobile, personal email and date of birth are always masked; GET /people/{id}/reveal returns one full value to the
person themselves or HR / admin in scope (HR / admin reveals are audited, without the value).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import aliased

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Employee
from app.schemas import Page, PersonBasicOut, PersonFullOut, PersonOut
from app.services.pii import EMPLOYEE_FIELDS, audit_reveal, can_reveal_employee

router = APIRouter(prefix="/people", tags=["people"])

NOT_FOUND = HTTPException(404, "Person not found.")


def present(user: CurrentUser, emp: Employee, manager_name: str | None) -> PersonBasicOut | PersonFullOut:
    model = PersonFullOut if user.scope.can_see(emp) else PersonBasicOut
    item = model.model_validate(emp)
    item.manager_name = manager_name
    if isinstance(item, PersonFullOut):
        item.can_reveal = can_reveal_employee(user, emp)
    return item


def _directory_filter(user: CurrentUser):  # type: ignore[no-untyped-def]
    """People who have left stay visible only to those whose scope covers them."""
    return or_(Employee.employment_status != "Terminated", user.scope.employee_filter())


@router.get("", response_model=Page[PersonOut])
def list_people(
    db: DbSession,
    user: CurrentUserDep,
    q: Annotated[str | None, Query(max_length=100, description="Name, email, code or job title")] = None,
    department: str | None = None,
    country: Annotated[str | None, Query(description="Country code, e.g. IN")] = None,
    location: str | None = None,
    status: Annotated[str | None, Query(description="Employment status, e.g. Active")] = None,
    scope: Annotated[str, Query(pattern="^(directory|mine)$", description="mine = only people whose full record you may see")] = "directory",
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 50,
) -> Page[PersonBasicOut | PersonFullOut]:
    manager = aliased(Employee)
    conditions = [_directory_filter(user)]
    if scope == "mine":
        conditions.append(user.scope.employee_filter())
    if q:
        like = f"%{q.strip().lower()}%"
        conditions.append(
            or_(
                func.lower(Employee.full_name).like(like),
                func.lower(Employee.email).like(like),
                func.lower(Employee.employee_code).like(like),
                func.lower(Employee.job_title).like(like),
            )
        )
    if department:
        conditions.append(Employee.department == department)
    if country:
        conditions.append(Employee.country_code == country.upper())
    if location:
        conditions.append(Employee.location == location)
    if status:
        conditions.append(Employee.employment_status == status)

    total = db.scalar(select(func.count()).select_from(Employee).where(*conditions)) or 0
    rows = db.execute(
        select(Employee, manager.full_name)
        .outerjoin(manager, manager.id == Employee.manager_id)
        .where(*conditions)
        .order_by(Employee.full_name, Employee.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return Page(items=[present(user, e, m) for e, m in rows], total=total, page=page, page_size=page_size)


def _get_visible(db: DbSession, user: CurrentUser, person_id: str) -> Employee:
    emp = db.get(Employee, person_id)
    if emp is None or (emp.employment_status == "Terminated" and not user.scope.can_see(emp)):
        raise NOT_FOUND
    return emp


@router.get("/{person_id}", response_model=PersonOut)
def get_person(person_id: str, db: DbSession, user: CurrentUserDep) -> PersonBasicOut | PersonFullOut:
    emp = _get_visible(db, user, person_id)
    mgr = db.get(Employee, emp.manager_id) if emp.manager_id else None
    item = present(user, emp, mgr.full_name if mgr else None)
    if isinstance(item, PersonFullOut):
        item.direct_report_count = db.scalar(select(func.count()).where(Employee.manager_id == emp.id)) or 0
    return item


@router.get("/{person_id}/reports", response_model=list[PersonOut])
def direct_reports(person_id: str, db: DbSession, user: CurrentUserDep) -> list[PersonBasicOut | PersonFullOut]:
    emp = _get_visible(db, user, person_id)
    rows = db.scalars(
        select(Employee).where(Employee.manager_id == emp.id, _directory_filter(user)).order_by(Employee.full_name)
    ).all()
    return [present(user, r, emp.full_name) for r in rows]


@router.get("/{person_id}/reveal")
def reveal_detail(
    person_id: str,
    request: Request,
    db: DbSession,
    user: CurrentUserDep,
    field: Annotated[str, Query(pattern="^(mobile|personal_email|date_of_birth|address_line|address_postcode|emergency_phone)$")],
) -> dict[str, str | None]:
    """One full personal detail, for the person themselves or HR / admin in scope. HR / admin views are audited."""
    emp = _get_visible(db, user, person_id)
    if field not in EMPLOYEE_FIELDS or not can_reveal_employee(user, emp):
        raise HTTPException(403, "You can't view this detail.")
    raw = getattr(emp, field)
    value = raw.isoformat() if hasattr(raw, "isoformat") else raw
    if emp.id != user.employee_id:
        audit_reveal(db, user, entity="employee", entity_id=emp.id, field=field, subject_id=emp.id, ip=client_ip(request))
        db.commit()
    return {"field": field, "value": value}

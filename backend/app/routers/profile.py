"""Profile edits, profile correction requests and the Copilot action audit.

- PATCH /people/me: the signed-in person edits their own details (preferred name, contact, address, emergency
  contact, languages, education, experience, career goals).
- PATCH /people/{id}: HR / admin within their data scope edit anyone else's record, HR-owned fields included.
- Corrections: an employee asks for an HR-owned field to change; HR / admin in scope approve (the value is applied)
  or reject. The employee may withdraw an open request.
- POST /ai/actions/audit: Copilot actions shown, confirmed or cancelled, with no personal values.

Every change writes audit_log with before/after; sensitive values are masked there (app/services/pii.py).
"""

from __future__ import annotations

import re
import uuid
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request
from sqlalchemy import select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Account, Employee, ProfileCorrection
from app.routers.people import _get_visible, present
from app.schemas import PersonFullOut
from app.schemas.profile import (
    AiActionAuditIn, AiActionAuditOut, HrProfileUpdateIn, ProfileCorrectionDecisionIn, ProfileCorrectionIn,
    ProfileCorrectionOut, ProfileOtpIn, ProfileOtpOut, SelfProfileUpdateIn,
)
from app.config import get_settings
from app.services import profile_otp
from app.services.activity import notify, record_audit
from app.services.pii import REVEAL_ROLES, can_reveal_employee, mask_dob, mask_email, mask_for_audit
from app.services.scope import HR_ROLES, report_ids

router = APIRouter(tags=["profile"])

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
PHONE_RE = re.compile(r"^\+?[\d ()\-]+$")
WORK_ARRANGEMENTS = {"Office", "Hybrid", "Remote"}
CORRECTION_LABEL = {
    "full_name": "Legal name",
    "middle_name": "Middle name",
    "date_of_birth": "Date of birth",
    "nationality": "Nationality",
    "job_title": "Job title",
    "department": "Department",
    "manager_id": "Manager",
    "work_arrangement": "Work arrangement",
}


def _clean(value: Any) -> Any:
    if isinstance(value, str):
        return value.strip() or None
    return value


def _valid_phone(value: str) -> bool:
    digits = len(re.sub(r"\D", "", value))
    return bool(PHONE_RE.match(value)) and 8 <= digits <= 15


def _validate(values: dict[str, Any]) -> None:
    if values.get("mobile") is not None and not _valid_phone(values["mobile"]):
        raise HTTPException(422, "Enter a valid mobile number: 8-15 digits.")
    if values.get("emergency_phone") is not None and not _valid_phone(values["emergency_phone"]):
        raise HTTPException(422, "Enter a valid emergency contact phone: 8-15 digits.")
    if values.get("personal_email") is not None and not EMAIL_RE.match(values["personal_email"]):
        raise HTTPException(422, "Enter a valid personal email address.")
    if values.get("date_of_birth") is not None:
        years = date.today().year - values["date_of_birth"].year
        if years < 15 or years > 90:
            raise HTTPException(422, "Enter a valid date of birth.")
    for i, x in enumerate(values.get("experience") or [], start=1):
        if x["to"] < x["from"]:
            raise HTTPException(422, f"Experience {i}: the end date is before the start date.")
        if x["to"][:7] > date.today().isoformat()[:7]:
            raise HTTPException(422, f"Experience {i}: the end date is in the future.")


def _normalise(body: SelfProfileUpdateIn) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for name in body.model_fields_set:
        if name == "otp_code":
            continue
        raw = getattr(body, name)
        if name == "languages":
            raw = list(dict.fromkeys(s.strip() for s in (raw or []) if s and s.strip()))
        elif name == "education":
            raw = sorted(
                ({"degree": e.degree.strip(), "institution": e.institution.strip(), "year": e.year} for e in raw or []),
                key=lambda e: -e["year"],
            )
        elif name == "experience":
            raw = sorted(
                ({"employer": x.employer.strip(), "title": x.title.strip(), "from": x.from_, "to": x.to} for x in raw or []),
                key=lambda x: x["from"],
                reverse=True,
            )
        elif name == "personal_email" and isinstance(raw, str):
            raw = raw.strip().lower() or None
        values[name] = _clean(raw)
    _validate(values)
    pref = values.get("preferred_language")
    if pref and "languages" in values and pref not in values["languages"]:
        values["languages"] = [pref, *values["languages"]]
    return values


def _apply(db: DbSession, user: CurrentUser, emp: Employee, values: dict[str, Any], request: Request, action: str) -> None:
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    names_changed = False
    for name, value in values.items():
        old = getattr(emp, name)
        if old == value:
            continue
        before[name] = mask_for_audit(name, old)
        after[name] = mask_for_audit(name, value)
        setattr(emp, name, value)
        names_changed = names_changed or name in ("first_name", "middle_name", "last_name")
    if names_changed:
        old_full = emp.full_name
        emp.full_name = " ".join(x for x in (emp.first_name, emp.middle_name, emp.last_name) if x) or old_full
        if emp.full_name != old_full:
            before["full_name"], after["full_name"] = old_full, emp.full_name
    if not after:
        return
    record_audit(db, actor_id=user.id, action=action, entity="employee", entity_id=emp.id, subject_id=emp.id,
                 before=before, after=after, ip=client_ip(request))
    db.commit()
    db.refresh(emp)


def _full(db: DbSession, user: CurrentUser, emp: Employee) -> PersonFullOut:
    mgr = db.get(Employee, emp.manager_id) if emp.manager_id else None
    item = present(user, emp, mgr.full_name if mgr else None)
    assert isinstance(item, PersonFullOut)
    return item


def _can_manage(user: CurrentUser, emp: Employee) -> bool:
    """HR / admin whose data scope covers this person."""
    return user.account.role in REVEAL_ROLES and user.scope.can_see(emp)


@router.patch("/people/me", response_model=PersonFullOut)
def update_own_profile(body: SelfProfileUpdateIn, request: Request, db: DbSession, user: CurrentUserDep) -> PersonFullOut:
    if user.employee is None:
        raise HTTPException(404, "This account has no employee record.")
    emp = user.employee
    values = _normalise(body)
    # A new mobile or personal email needs the code sent by POST /people/me/otp (clearing one does not).
    changing = [f for f in profile_otp.OTP_FIELDS if values.get(f) is not None and values[f] != getattr(emp, f)]
    if len(changing) > 1:
        raise HTTPException(422, "Change your mobile and personal email one at a time.")
    if changing:
        profile_otp.check(db, emp, changing[0], values[changing[0]], body.otp_code)
    _apply(db, user, emp, values, request, "updated own profile")
    db.commit()
    return _full(db, user, emp)


@router.post("/people/me/otp", response_model=ProfileOtpOut, status_code=201)
def request_profile_otp(body: ProfileOtpIn, request: Request, db: DbSession, user: CurrentUserDep) -> ProfileOtpOut:
    """Sends a 6-digit code (10 minutes, 5 tries) for changing your own mobile or personal email."""
    if user.employee is None:
        raise HTTPException(404, "This account has no employee record.")
    emp = user.employee
    value = body.new_value.strip()
    if body.field == "personal_email":
        value = value.lower()
    _validate({body.field: value})
    if value == getattr(emp, body.field):
        raise HTTPException(422, f"That is already your {profile_otp.FIELD_LABEL[body.field]}.")
    code, expires, to = profile_otp.issue(db, emp, body.field, value, user.id)
    record_audit(db, actor_id=user.id, action="requested verification code", entity="employee", entity_id=emp.id,
                 subject_id=emp.id, before=None, after={"field": body.field}, ip=client_ip(request))
    db.commit()
    return ProfileOtpOut(field=body.field, sent_to=mask_email(to) or "", expires_at=expires,
                         dev_code=code if get_settings().otp_dev_echo else None)


@router.patch("/people/{person_id}", response_model=PersonFullOut)
def update_profile(person_id: str, body: HrProfileUpdateIn, request: Request, db: DbSession, user: CurrentUserDep) -> PersonFullOut:
    emp = _get_visible(db, user, person_id)
    if emp.id == user.employee_id:
        raise HTTPException(403, "Edit your own details under My profile, or raise a correction.")
    if not _can_manage(user, emp):
        raise HTTPException(403, "Only HR can edit this record.")
    values = _normalise(body)
    if values.get("first_name", "") is None or values.get("last_name", "") is None:
        raise HTTPException(422, "First and last name can't be blank.")
    if "company" in values and not values["company"]:
        values["company"] = "TimeZ"
    _apply(db, user, emp, values, request, "updated profile")
    return _full(db, user, emp)


# ---------- correction requests ----------

def _current_value(db: DbSession, emp: Employee, field: str) -> str | None:
    if field == "manager_id":
        mgr = db.get(Employee, emp.manager_id) if emp.manager_id else None
        return mgr.full_name if mgr else None
    value = getattr(emp, field)
    return value.isoformat() if isinstance(value, date) else value


def _validate_requested(db: DbSession, emp: Employee, field: str, value: str | None) -> None:
    if field != "middle_name" and not value:
        raise HTTPException(422, "Enter the correct value.")
    if field == "full_name" and len((value or "").split()) < 2:
        raise HTTPException(422, "Enter the full legal name (first and last name).")
    if field == "date_of_birth":
        try:
            dob = date.fromisoformat(value or "")
        except ValueError:
            raise HTTPException(422, "Enter a valid date of birth.") from None
        if not 15 <= date.today().year - dob.year <= 90:
            raise HTTPException(422, "Enter a valid date of birth.")
    if field == "work_arrangement" and value not in WORK_ARRANGEMENTS:
        raise HTTPException(422, "Choose Office, Hybrid or Remote.")
    if field == "manager_id":
        mgr = db.get(Employee, value) if value else None
        if mgr is None or mgr.employment_status == "Terminated":
            raise HTTPException(422, "Choose an active manager.")
        if mgr.id == emp.id or mgr.id in report_ids(db, emp.id):
            raise HTTPException(422, "That manager reports to this person.")


def _correction_out(db: DbSession, user: CurrentUser, row: ProfileCorrection, emp: Employee | None) -> ProfileCorrectionOut:
    requested, current = row.requested_value, row.current_value
    label = None
    if row.field == "date_of_birth":
        current = mask_dob(current)
        if not (emp and can_reveal_employee(user, emp)):
            requested = mask_dob(requested)
    if row.field == "manager_id" and row.requested_value:
        mgr = db.get(Employee, row.requested_value)
        label = mgr.full_name if mgr else None
    return ProfileCorrectionOut(
        id=row.id, employee_id=row.employee_id, employee_name=emp.full_name if emp else None, field=row.field,
        current_value=current, requested_value=requested, requested_label=label, reason=row.reason, status=row.status,
        requested_by=row.requested_by, decided_by=row.decided_by, decided_at=row.decided_at,
        decision_note=row.decision_note, created_at=row.created_at,
        can_decide=row.status == "pending" and emp is not None and emp.id != user.employee_id and _can_manage(user, emp),
    )


def _audit_correction(db: DbSession, user: CurrentUser, row: ProfileCorrection, before: dict[str, Any], after: dict[str, Any],
                      request: Request, action: str) -> None:
    record_audit(db, actor_id=user.id, action=action, entity="profile_correction", entity_id=row.id,
                 subject_id=row.employee_id, before=before, after=after, ip=client_ip(request))


def _masked(field: str, value: str | None) -> str | None:
    return mask_dob(value) if field == "date_of_birth" else value


@router.post("/people/{person_id}/corrections", response_model=ProfileCorrectionOut, status_code=201)
def request_correction(person_id: str, body: ProfileCorrectionIn, request: Request, db: DbSession,
                       user: CurrentUserDep) -> ProfileCorrectionOut:
    emp = _get_visible(db, user, person_id)
    if emp.id != user.employee_id:
        raise HTTPException(403, "You can only ask for corrections to your own record.")
    value = body.requested_value.strip() or None
    current = _current_value(db, emp, body.field)
    if (emp.manager_id if body.field == "manager_id" else current) == value:
        raise HTTPException(422, "That is already the value on your record.")
    _validate_requested(db, emp, body.field, value)
    open_row = db.scalar(select(ProfileCorrection.id).where(
        ProfileCorrection.employee_id == emp.id, ProfileCorrection.field == body.field, ProfileCorrection.status == "pending"))
    if open_row:
        raise HTTPException(409, f"You already have an open {CORRECTION_LABEL[body.field].lower()} correction.")
    row = ProfileCorrection(id=f"pcr-{uuid.uuid4().hex[:12]}", employee_id=emp.id, field=body.field, current_value=current,
                            requested_value=value, reason=body.reason.strip(), status="pending", requested_by=user.id)
    db.add(row)
    db.flush()
    _audit_correction(db, user, row, {}, {"field": body.field, "status": "pending", "requested_value": _masked(body.field, value)},
                      request, "requested profile correction")
    hr = db.scalars(select(Account.employee_id).where(Account.role.in_(HR_ROLES), Account.active.is_(True),
                                                      Account.employee_id.is_not(None), Account.employee_id != emp.id))
    for recipient in hr:
        notify(db, recipient_id=recipient, title="Profile correction to review",
               body=f"{emp.full_name}: {CORRECTION_LABEL[body.field].lower()}.", href=f"/people/{emp.id}")
    db.commit()
    return _correction_out(db, user, row, emp)


@router.get("/people/{person_id}/corrections", response_model=list[ProfileCorrectionOut])
def person_corrections(person_id: str, db: DbSession, user: CurrentUserDep) -> list[ProfileCorrectionOut]:
    emp = _get_visible(db, user, person_id)
    if emp.id != user.employee_id and not _can_manage(user, emp):
        raise HTTPException(403, "You can't view these requests.")
    rows = db.scalars(select(ProfileCorrection).where(ProfileCorrection.employee_id == emp.id)
                      .order_by(ProfileCorrection.created_at.desc())).all()
    return [_correction_out(db, user, r, emp) for r in rows]


@router.get("/profile-corrections", response_model=list[ProfileCorrectionOut])
def list_corrections(
    db: DbSession,
    user: CurrentUserDep,
    status: Annotated[str | None, Query(pattern="^(pending|approved|rejected|withdrawn)$")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[ProfileCorrectionOut]:
    """Your own requests, plus (HR / admin) everyone's within your data scope."""
    query = select(ProfileCorrection, Employee).join(Employee, Employee.id == ProfileCorrection.employee_id)
    if user.account.role in REVEAL_ROLES:
        query = query.where(user.scope.employee_filter())
    else:
        query = query.where(ProfileCorrection.employee_id == (user.employee_id or ""))
    if status:
        query = query.where(ProfileCorrection.status == status)
    rows = db.execute(query.order_by(ProfileCorrection.created_at.desc()).limit(limit)).all()
    return [_correction_out(db, user, r, e) for r, e in rows]


def _get_correction(db: DbSession, correction_id: str) -> tuple[ProfileCorrection, Employee]:
    row = db.get(ProfileCorrection, correction_id)
    emp = db.get(Employee, row.employee_id) if row else None
    if row is None or emp is None:
        raise HTTPException(404, "Request not found.")
    return row, emp


def _apply_correction(db: DbSession, emp: Employee, row: ProfileCorrection) -> tuple[dict[str, Any], dict[str, Any]]:
    value = row.requested_value
    _validate_requested(db, emp, row.field, value)  # still valid now (e.g. the manager may have left)
    tracked = ("full_name", "first_name", "middle_name", "last_name", row.field)
    before = {k: getattr(emp, k) for k in dict.fromkeys(tracked)}
    if row.field == "full_name":
        parts = (value or "").split()
        emp.full_name = " ".join(parts)
        emp.first_name, emp.last_name = parts[0], parts[-1]
        emp.middle_name = " ".join(parts[1:-1]) or None
    elif row.field == "middle_name":
        emp.middle_name = value
        emp.full_name = " ".join(x for x in (emp.first_name, value, emp.last_name) if x) or emp.full_name
    elif row.field == "date_of_birth":
        emp.date_of_birth = date.fromisoformat(value or "")
    else:
        setattr(emp, row.field, value)
    after = {k: getattr(emp, k) for k in before}
    changed = [k for k in before if before[k] != after[k]]
    return ({k: mask_for_audit(k, before[k]) for k in changed}, {k: mask_for_audit(k, after[k]) for k in changed})


@router.post("/profile-corrections/{correction_id}/decide", response_model=ProfileCorrectionOut)
def decide_correction(correction_id: str, body: ProfileCorrectionDecisionIn, request: Request, db: DbSession,
                      user: CurrentUserDep) -> ProfileCorrectionOut:
    row, emp = _get_correction(db, correction_id)
    if emp.id == user.employee_id:
        raise HTTPException(403, "You cannot decide your own request.")
    if not _can_manage(user, emp):
        raise HTTPException(403, "Only HR can decide this request.")
    if row.status != "pending":
        raise HTTPException(409, "This request is no longer open.")
    note = (body.note or "").strip() or None
    if body.decision == "reject" and not note:
        raise HTTPException(422, "Add a note explaining the rejection.")
    if body.decision == "approve":
        before, after = _apply_correction(db, emp, row)
        if after:
            record_audit(db, actor_id=user.id, action="updated profile", entity="employee", entity_id=emp.id,
                         subject_id=emp.id, before=before, after=after, ip=client_ip(request))
    row.status = "approved" if body.decision == "approve" else "rejected"
    row.decided_by, row.decided_at, row.decision_note = user.id, utcnow(), note
    _audit_correction(db, user, row, {"status": "pending"}, {"status": row.status, "note": note}, request,
                      "decided profile correction")
    requester = db.get(Account, row.requested_by)
    if requester and requester.employee_id:
        label = CORRECTION_LABEL.get(row.field, row.field).lower()
        notify(db, recipient_id=requester.employee_id, title=f"Profile correction {row.status}",
               body=f"Your {label} correction was {row.status}.", href="/info")
    db.commit()
    db.refresh(emp)
    return _correction_out(db, user, row, emp)


@router.post("/profile-corrections/{correction_id}/withdraw", response_model=ProfileCorrectionOut)
def withdraw_correction(correction_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> ProfileCorrectionOut:
    row, emp = _get_correction(db, correction_id)
    if row.requested_by != user.id:
        raise HTTPException(403, "Only the person who asked can withdraw it.")
    if row.status != "pending":
        raise HTTPException(409, "Only open requests can be withdrawn.")
    row.status = "withdrawn"
    row.decided_at = utcnow()
    _audit_correction(db, user, row, {"status": "pending"}, {"status": "withdrawn"}, request, "withdrew profile correction")
    db.commit()
    return _correction_out(db, user, row, emp)


# ---------- Copilot action audit ----------

_EMAIL_IN_TEXT = re.compile(r"[^\s@]+@[^\s@]+")
_NUMBER_IN_TEXT = re.compile(r"\+?\d[\d \-()]{3,}\d")


def _scrub(text: str) -> str:
    """Drop anything that looks like an email or phone / postcode, so no personal values reach the audit."""
    return _NUMBER_IN_TEXT.sub("•••", _EMAIL_IN_TEXT.sub("•••", text)).strip()


@router.post("/ai/actions/audit", response_model=AiActionAuditOut, status_code=201)
def audit_ai_action(body: AiActionAuditIn, request: Request, db: DbSession, user: CurrentUserDep) -> AiActionAuditOut:
    entry = record_audit(db, actor_id=user.id, action=f"copilot action {body.status}", entity="ai_action",
                         entity_id=body.action, subject_id=user.employee_id,
                         after={"action": body.action, "status": body.status, "summary": _scrub(body.summary)},
                         ip=client_ip(request))
    db.commit()
    return AiActionAuditOut(id=entry.id, action=body.action, status=body.status)

"""Cash advances, leave encashment and software licences (migration 0016). Same rules as the portal
(src/features/payrequests/rules.ts), so both modes agree.

Cash advance (approval type "cash_advance"): manager, then finance / HR; HR (or finance) then marks it paid. Limit: one
month's basic pay, never above the country's cash-advance cap; one open advance at a time (open = waiting, approved,
or paid and not yet recovered). Recovered from pay in 1-6 equal monthly instalments starting the month after it is paid.

Leave encashment (approval type "encashment"): manager, then HR. Privilege leave only; at most 10 days a year and at
least 5 days must stay in the balance. Paid at basic pay / 22 a day with the month's salary (this month when approved by
the 20th, else next month); taxed as salary. Pending and approved days count as used leave (app/services/leave.py).

Software (approval type "software"): titles that need approval go to the manager, then IT (admin); the rest are granted
straight away while seats last. IT can assign a licence directly, revoke one and change seat counts; the holder can
return it. A licence for N months expires on its own.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    Account, ApprovalDecision, ApprovalInstance, CashAdvance, Employee, EncashmentRequest, SoftwareRequest, SoftwareTitle,
)
from app.services import approvals as engine
from app.services.activity import notify, record_audit
from app.services.leave import today_for

CASH, ENCASH, SOFTWARE = "cash_advance", "encashment", "software"
PENDING = ("Submitted", "Manager approved")
MAX_INSTALMENTS = 6
CASH_CATEGORIES = ("Medical", "Family event", "Education", "Relocation", "Home repair", "Travel", "Other")
ENCASHABLE = ("pto",)
ENCASH_MAX_DAYS_A_YEAR = 10.0
ENCASH_KEEP_DAYS = 5.0
ENCASH_CUTOFF_DAY = 20
WORKING_DAYS_A_MONTH = 22
IT_ROLES = ("admin", "super_admin", "it_admin")

# First (basic) pay line a month by country, and the seniority scale (src/countryPay.ts, payScaleFor).
BASIC_MONTHLY = {"IN": 38000, "US": 7000, "GB": 4500, "AU": 8500, "CA": 7500, "AE": 18000, "SA": 15000, "DE": 5200}
ROLE_SCALE = {"employee": 1.0, "manager": 1.35, "hr_admin": 1.4, "hr": 1.4, "executive": 2.1, "admin": 1.25,
              "super_admin": 1.25}

CATALOGUE = (
    # id, name, category, vendor, monthly cost (USD), needs approval, seats
    ("sw-slack", "Slack", "Communication", "Salesforce", 8.75, False, 0),
    ("sw-zoom", "Zoom Pro", "Communication", "Zoom", 13.33, False, 200),
    ("sw-m365", "Microsoft 365", "Office", "Microsoft", 12.5, False, 0),
    ("sw-notion", "Notion", "Productivity", "Notion Labs", 10.0, False, 150),
    ("sw-figma", "Figma Professional", "Design", "Figma", 15.0, True, 40),
    ("sw-adobe", "Adobe Creative Cloud", "Design", "Adobe", 59.99, True, 15),
    ("sw-jetbrains", "JetBrains All Products", "Development", "JetBrains", 28.9, True, 60),
    ("sw-copilot", "GitHub Copilot", "Development", "GitHub", 19.0, True, 80),
    ("sw-postman", "Postman Team", "Development", "Postman", 14.0, False, 100),
    ("sw-tableau", "Tableau Creator", "Analytics", "Salesforce", 75.0, True, 10),
    ("sw-jira", "Jira Software", "Project management", "Atlassian", 8.15, False, 0),
    ("sw-1password", "1Password", "Security", "1Password", 7.99, False, 0),
)


class RequestError(ValueError):
    """A rule was broken (422, or 409 when the message says "already"); safe to show the user."""


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def role_of(db: Session, emp: Employee) -> str:
    return db.scalar(select(Account.role).where(Account.employee_id == emp.id)) or "employee"


def basic_monthly(db: Session, emp: Employee) -> float:
    base = BASIC_MONTHLY.get(emp.country_code, BASIC_MONTHLY["IN"])
    return round(base * ROLE_SCALE.get(role_of(db, emp), 1.15))


def has_manager(db: Session, emp: Employee) -> bool:
    return bool(emp.manager_id and db.get(Employee, emp.manager_id) is not None)


def instance_of(db: Session, row: Any) -> ApprovalInstance | None:
    return db.get(ApprovalInstance, row.approval_instance_id) if row.approval_instance_id else None


def stage_status(db: Session, row: Any, final: str) -> str:
    """Submitted / Manager approved while waiting (an earlier step approved); the row's own status otherwise."""
    if row.status not in PENDING:
        return row.status
    instance = instance_of(db, row)
    if instance is None or instance.status != "pending":
        return row.status
    earlier = db.scalar(select(ApprovalDecision.id).where(
        ApprovalDecision.instance_id == instance.id, ApprovalDecision.decision == "approve",
        ApprovalDecision.step < instance.current_step))
    return "Manager approved" if earlier else "Submitted"


def _start(db: Session, type_: str, row: Any, emp: Employee, amount: float | None, actor_id: str) -> ApprovalInstance:
    from app.services.workflow_defaults import ensure_default

    ensure_default(db, type_)
    try:
        instance = engine.start(db, type_, row.id, emp, amount, actor_id=actor_id,
                                context={"via_manager": has_manager(db, emp)}, fallback=False)
    except engine.ApprovalError as exc:
        raise RequestError(str(exc)) from exc
    row.approval_instance_id = instance.id
    return instance


def _withdraw(db: Session, row: Any, actor: Employee, actor_id: str, what: str, href: str, ip: str | None) -> None:
    from app.services.workflow_defaults import notify_withdrawn

    if row.status not in PENDING:
        raise RequestError(f"This request is already {row.status.lower()}; it can only be withdrawn while waiting.")
    instance = instance_of(db, row)
    notify_withdrawn(db, instance, actor.full_name, what, href)
    if instance is not None and instance.status == "pending":
        engine.cancel(db, instance, actor_id=actor_id, ip=ip)
    row.status = "Withdrawn"
    record_audit(db, actor_id=actor_id, action=f"{what.replace(' ', '_')}_withdrawn", entity=row.__tablename__,
                 entity_id=row.id, subject_id=row.employee_id, after={"status": "Withdrawn"}, ip=ip)


def _last_decider(db: Session, instance: ApprovalInstance) -> str:
    return db.scalar(select(ApprovalDecision.approver_id).where(ApprovalDecision.instance_id == instance.id)
                     .order_by(ApprovalDecision.id.desc())) or instance.requester_id


def add_months(day: date, months: int) -> date:
    y, m = divmod(day.month - 1 + months, 12)
    year, month = day.year + y, m + 1
    last = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(day.day, last))


def month_key(day: date) -> str:
    return f"{day.year:04d}-{day.month:02d}"


# ---------- cash advances ----------
def cash_limit(db: Session, emp: Employee) -> dict[str, Any]:
    from app.services.expenses import limits_for

    basic = basic_monthly(db, emp)
    cap = float(limits_for(emp.country_code)["max_cash_advance"])
    return {"limit": float(min(basic, cap)), "basic_monthly": float(basic), "country_cap": cap, "currency": emp.currency,
            "max_instalments": MAX_INSTALMENTS}


def schedule(row: CashAdvance, today: date) -> list[dict[str, Any]]:
    """Equal monthly instalments from the month after it was paid (the last one takes the rounding)."""
    if row.paid_on is None:
        return []
    n = max(1, row.instalments)
    each = round(row.amount / n, 2)
    start = add_months(date(row.paid_on.year, row.paid_on.month, 1), 1)
    out = []
    for i in range(n):
        month = add_months(start, i)
        amount = round(row.amount - each * (n - 1), 2) if i == n - 1 else each
        out.append({"month": month_key(month), "amount": amount, "recovered": month_key(month) < month_key(today)})
    return out


def outstanding(row: CashAdvance, today: date) -> float:
    if row.status != "Paid":
        return 0.0
    return round(sum(i["amount"] for i in schedule(row, today) if not i["recovered"]), 2)


def is_open(row: CashAdvance, today: date) -> bool:
    return row.status in (*PENDING, "Approved") or (row.status == "Paid" and outstanding(row, today) > 0)


def create_cash(db: Session, emp: Employee, data: dict[str, Any], actor_id: str, ip: str | None) -> CashAdvance:
    today = today_for(emp)
    amount = float(data["amount"])
    limits = cash_limit(db, emp)
    if amount <= 0:
        raise RequestError("Enter an amount greater than zero.")
    if amount > limits["limit"]:
        raise RequestError(f"You can ask for up to {limits['limit']:,.0f} {emp.currency} (one month's basic pay).")
    n = int(data.get("instalments") or 1)
    if not 1 <= n <= MAX_INSTALMENTS:
        raise RequestError(f"Repay in 1 to {MAX_INSTALMENTS} monthly instalments.")
    if data["needed_by"] < today:
        raise RequestError("The needed-by date can't be in the past.")
    if data["needed_by"] > today + timedelta(days=90):
        raise RequestError("The needed-by date must be within 90 days.")
    category = (data.get("category") or "").strip()
    if category not in CASH_CATEGORIES:
        raise RequestError("Choose a purpose.")
    for row in db.scalars(select(CashAdvance).where(CashAdvance.employee_id == emp.id)):
        if is_open(row, today):
            raise RequestError("You already have an open cash advance. Finish repaying it first.")
    row = CashAdvance(id=_id("cash"), employee_id=emp.id, amount=round(amount, 2), currency=emp.currency,
                      category=category, purpose=(data.get("purpose") or "").strip()[:1000], needed_by=data["needed_by"],
                      instalments=n, status="Submitted")
    db.add(row)
    db.flush()
    record_audit(db, actor_id=actor_id, action="cash_advance_submitted", entity="cash_advances", entity_id=row.id,
                 subject_id=emp.id, after={"amount": row.amount, "instalments": n}, ip=ip)
    _start(db, CASH, row, emp, row.amount, actor_id)
    return row


def withdraw_cash(db: Session, row: CashAdvance, actor: Employee, actor_id: str, ip: str | None) -> None:
    _withdraw(db, row, actor, actor_id, "cash advance", "/cash", ip)


def can_pay(role: str, is_hr: bool) -> bool:
    return is_hr or role in ("finance", "admin", "super_admin")


def mark_paid(db: Session, row: CashAdvance, actor: Employee, actor_id: str, reference: str | None, ip: str | None) -> None:
    if row.status == "Paid":
        raise RequestError("This advance is already paid.")
    if row.status != "Approved":
        raise RequestError("Only an approved advance can be paid.")
    if actor.id == row.employee_id:
        raise RequestError("You can't pay out your own advance.")
    row.status = "Paid"
    row.paid_on = today_for(actor)
    row.paid_by = actor.full_name
    row.reference = (reference or "").strip()[:64] or f"CA-{row.id[-6:].upper()}"
    record_audit(db, actor_id=actor_id, action="cash_advance_paid", entity="cash_advances", entity_id=row.id,
                 subject_id=row.employee_id, after={"paid_on": row.paid_on, "reference": row.reference}, ip=ip)
    first = schedule(row, row.paid_on)[0]["month"] if row.instalments else ""
    notify(db, recipient_id=row.employee_id, title="Cash advance paid",
           body=f"Recovery starts with {first} pay.", href="/cash")


@engine.on_finish(CASH)
def _cash_finished(db: Session, instance: ApprovalInstance) -> None:
    row = db.get(CashAdvance, instance.entity_id)
    if row is None or row.status not in PENDING:
        return
    row.status = "Approved" if instance.status == "approved" else "Rejected"
    record_audit(db, actor_id=_last_decider(db, instance), action=f"cash_advance_{row.status.lower()}",
                 entity="cash_advances", entity_id=row.id, subject_id=row.employee_id, after={"status": row.status})
    notify(db, recipient_id=row.employee_id, title=f"Cash advance {row.status.lower()}",
           body="It will be paid to your bank account soon." if row.status == "Approved" else "Open it to see the note.",
           href="/cash")


# ---------- leave encashment ----------
def per_day(db: Session, emp: Employee) -> float:
    return round(basic_monthly(db, emp) / WORKING_DAYS_A_MONTH, 2)


def encashed_days(db: Session, employee_id: str, code: str, year: int) -> tuple[float, float]:
    """(approved, pending) encashed days of this leave type in the year (counted as used / pending leave)."""
    rows = db.execute(select(EncashmentRequest.status, EncashmentRequest.days).where(
        EncashmentRequest.employee_id == employee_id, EncashmentRequest.leave_code == code,
        EncashmentRequest.year == year, EncashmentRequest.status.in_(("Approved", *PENDING)))).all()
    return (sum(float(d) for s, d in rows if s == "Approved"), sum(float(d) for s, d in rows if s in PENDING))


def encash_policy(db: Session, emp: Employee) -> dict[str, Any]:
    from app.services.leave import balances

    today = today_for(emp)
    try:
        rows = balances(db, emp)
    except Exception:  # noqa: BLE001  (no leave policies for the country)
        rows = []
    out = []
    for b in rows:
        if b.code not in ENCASHABLE:
            out.append({"code": b.code, "name": b.name, "available": float(b.available), "encashable": 0.0,
                        "used_this_year": 0.0, "eligible": False, "why_not": "Not encashable"})
            continue
        approved, pending = encashed_days(db, emp.id, b.code, today.year)
        room_year = max(0.0, ENCASH_MAX_DAYS_A_YEAR - approved - pending)
        room_balance = max(0.0, float(b.available) - ENCASH_KEEP_DAYS)
        encashable = float(int(min(room_year, room_balance) * 2) / 2)
        why = None if encashable > 0 else (
            f"Yearly limit of {ENCASH_MAX_DAYS_A_YEAR:g} days reached" if room_year <= 0
            else f"Keep at least {ENCASH_KEEP_DAYS:g} days in your balance")
        out.append({"code": b.code, "name": b.name, "available": float(b.available), "encashable": encashable,
                    "used_this_year": approved + pending, "eligible": encashable > 0, "why_not": why})
    return {"per_day": per_day(db, emp), "currency": emp.currency, "max_days_a_year": ENCASH_MAX_DAYS_A_YEAR,
            "keep_days": ENCASH_KEEP_DAYS, "cutoff_day": ENCASH_CUTOFF_DAY, "types": out}


def payout_month(day: date) -> str:
    return month_key(day if day.day <= ENCASH_CUTOFF_DAY else add_months(date(day.year, day.month, 1), 1))


def create_encashment(db: Session, emp: Employee, code: str, days: float, actor_id: str, ip: str | None) -> EncashmentRequest:
    if days <= 0 or days * 2 != int(days * 2):
        raise RequestError("Choose whole or half days.")
    policy = encash_policy(db, emp)
    row = next((t for t in policy["types"] if t["code"] == code), None)
    if row is None or code not in ENCASHABLE:
        raise RequestError("Only privilege leave can be encashed.")
    if db.scalar(select(EncashmentRequest.id).where(EncashmentRequest.employee_id == emp.id,
                                                    EncashmentRequest.status.in_(PENDING))):
        raise RequestError("You already have an encashment waiting for approval.")
    if days > row["encashable"]:
        raise RequestError(f"You can encash up to {row['encashable']:g} days now." if row["encashable"] > 0
                           else f"Nothing to encash: {row['why_not'].lower()}.")
    today = today_for(emp)
    rate = policy["per_day"]
    item = EncashmentRequest(id=_id("enc"), employee_id=emp.id, leave_code=code, year=today.year, days=days, per_day=rate,
                             amount=round(rate * days, 2), currency=emp.currency, status="Submitted")
    db.add(item)
    db.flush()
    record_audit(db, actor_id=actor_id, action="encashment_submitted", entity="encashment_requests", entity_id=item.id,
                 subject_id=emp.id, after={"days": days, "amount": item.amount}, ip=ip)
    _start(db, ENCASH, item, emp, item.amount, actor_id)
    return item


def withdraw_encashment(db: Session, row: EncashmentRequest, actor: Employee, actor_id: str, ip: str | None) -> None:
    _withdraw(db, row, actor, actor_id, "leave encashment", "/encashment", ip)


@engine.on_finish(ENCASH)
def _encash_finished(db: Session, instance: ApprovalInstance) -> None:
    row = db.get(EncashmentRequest, instance.entity_id)
    if row is None or row.status not in PENDING:
        return
    emp = db.get(Employee, row.employee_id)
    if instance.status == "approved":
        row.status = "Approved"
        row.payout_month = payout_month(today_for(emp) if emp else date.today())
    else:
        row.status = "Rejected"
    record_audit(db, actor_id=_last_decider(db, instance), action=f"encashment_{row.status.lower()}",
                 entity="encashment_requests", entity_id=row.id, subject_id=row.employee_id,
                 after={"status": row.status, "payout_month": row.payout_month})
    notify(db, recipient_id=row.employee_id, title=f"Leave encashment {row.status.lower()}",
           body=f"Paid with {date.fromisoformat(row.payout_month + '-01'):%B %Y} pay." if row.payout_month
           else "Open it to see the note.", href="/encashment")


# ---------- software ----------
def ensure_catalogue(db: Session) -> None:
    if db.scalar(select(func.count()).select_from(SoftwareTitle)):
        return
    for sid, name, cat, vendor, cost, approval, seats in CATALOGUE:
        db.add(SoftwareTitle(id=sid, name=name, category=cat, vendor=vendor, monthly_cost=cost, currency="USD",
                             needs_approval=approval, seats=seats, active=True))
    db.flush()


def software_status(row: SoftwareRequest, today: date) -> str:
    if row.status == "Active" and row.expires_on and row.expires_on < today:
        return "Expired"
    return row.status


def seats_used(db: Session, title_id: str, today: date) -> int:
    rows = db.scalars(select(SoftwareRequest).where(SoftwareRequest.title_id == title_id, SoftwareRequest.status == "Active"))
    return sum(1 for r in rows if software_status(r, today) == "Active")


def _grant(db: Session, row: SoftwareRequest, today: date) -> None:
    row.status = "Active"
    row.assigned_on = today
    row.expires_on = add_months(today, row.duration_months) if row.duration_months else None
    row.licence_key = f"LIC-{secrets.token_hex(3).upper()}-{secrets.token_hex(2).upper()}"


def create_software(db: Session, emp: Employee, title: SoftwareTitle, reason: str, duration: int | None, raiser: Employee,
                    actor_id: str, ip: str | None) -> SoftwareRequest:
    today = today_for(emp)
    if not title.active:
        raise RequestError("This software is no longer offered.")
    for r in db.scalars(select(SoftwareRequest).where(SoftwareRequest.employee_id == emp.id,
                                                      SoftwareRequest.title_id == title.id)):
        status = software_status(r, today)
        if status == "Active":
            raise RequestError(f"{'You' if raiser.id == emp.id else emp.full_name} already {'have' if raiser.id == emp.id else 'has'} {title.name}.")
        if status in PENDING:
            raise RequestError(f"A request for {title.name} is already waiting.")
    if duration is not None and not 1 <= duration <= 24:
        raise RequestError("Choose 1 to 24 months, or ongoing.")
    direct = raiser.id != emp.id  # IT assigning
    if not (reason or "").strip() and not direct:
        raise RequestError("Say why you need it.")
    if title.seats and seats_used(db, title.id, today) >= title.seats and (direct or not title.needs_approval):
        raise RequestError(f"No {title.name} seats left. Ask IT to add seats.")
    row = SoftwareRequest(id=_id("swr"), employee_id=emp.id, title_id=title.id, reason=(reason or "").strip()[:1000],
                          duration_months=duration, status="Submitted", raised_by=raiser.id)
    db.add(row)
    db.flush()
    if direct or not title.needs_approval:
        _grant(db, row, today)
        if direct:
            notify(db, recipient_id=emp.id, title=f"{title.name} assigned to you", body=f"Licence {row.licence_key}.",
                   href="/software")
    else:
        _start(db, SOFTWARE, row, emp, None, actor_id)
    record_audit(db, actor_id=actor_id, action="software_requested" if not direct else "software_assigned",
                 entity="software_requests", entity_id=row.id, subject_id=emp.id,
                 after={"title": title.id, "status": row.status}, ip=ip)
    return row


def withdraw_software(db: Session, row: SoftwareRequest, actor: Employee, actor_id: str, ip: str | None) -> None:
    _withdraw(db, row, actor, actor_id, "software request", "/software", ip)


def end_licence(db: Session, row: SoftwareRequest, actor: Employee, actor_id: str, how: str, ip: str | None) -> None:
    today = today_for(actor)
    if software_status(row, today) != "Active":
        raise RequestError("This licence is not active.")
    row.status = how  # Returned | Revoked
    row.ended_on = today
    row.ended_by = actor.full_name
    record_audit(db, actor_id=actor_id, action=f"software_{how.lower()}", entity="software_requests", entity_id=row.id,
                 subject_id=row.employee_id, after={"status": how}, ip=ip)
    if how == "Revoked":
        title = db.get(SoftwareTitle, row.title_id)
        notify(db, recipient_id=row.employee_id, title=f"{title.name if title else 'Software'} licence removed",
               body="IT removed this licence.", href="/software")


@engine.on_finish(SOFTWARE)
def _software_finished(db: Session, instance: ApprovalInstance) -> None:
    row = db.get(SoftwareRequest, instance.entity_id)
    if row is None or row.status not in PENDING:
        return
    emp = db.get(Employee, row.employee_id)
    title = db.get(SoftwareTitle, row.title_id)
    if instance.status == "approved":
        _grant(db, row, today_for(emp) if emp else date.today())
    else:
        row.status = "Rejected"
    record_audit(db, actor_id=_last_decider(db, instance), action=f"software_{'granted' if row.status == 'Active' else 'rejected'}",
                 entity="software_requests", entity_id=row.id, subject_id=row.employee_id, after={"status": row.status})
    name = title.name if title else "Software"
    notify(db, recipient_id=row.employee_id, title=f"{name} {'approved' if row.status == 'Active' else 'not approved'}",
           body=f"Licence {row.licence_key}." if row.licence_key else "Open it to see the note.", href="/software")


def summary_for(db: Session, inst: ApprovalInstance) -> str | None:
    """Inbox text for these approval types (GET /approvals/pending)."""
    if inst.type == CASH and (row := db.get(CashAdvance, inst.entity_id)):
        plan = "one payment" if row.instalments == 1 else f"{row.instalments} monthly instalments"
        return f"Cash advance of {row.amount:,.0f} {row.currency}, {row.category.lower()}, repaid in {plan}"
    if inst.type == ENCASH and (row := db.get(EncashmentRequest, inst.entity_id)):
        return f"Leave encashment: {row.days:g} {'day' if row.days == 1 else 'days'} of privilege leave"
    if inst.type == SOFTWARE and (row := db.get(SoftwareRequest, inst.entity_id)):
        title = db.get(SoftwareTitle, row.title_id)
        span = f"{row.duration_months} months" if row.duration_months else "ongoing"
        return f"Software: {title.name if title else row.title_id} ({span})"
    return None


engine.NOTICE_LABELS.update({CASH: "Cash advance", ENCASH: "Leave encashment", SOFTWARE: "Software request"})
engine.OWN_FINISH_NOTICE.update({CASH, ENCASH, SOFTWARE})
engine.ENTITY_HREFS.update({CASH: "/cash", ENCASH: "/encashment", SOFTWARE: "/software"})

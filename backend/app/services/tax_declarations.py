"""Tax-saving declarations (same sections and tax years as the portal: src/countryPay.ts, src/data/taxRules.ts).

- An employee declares for the current or next tax year of their own country, per section, with proof files.
- draft -> submitted -> verified | rejected. Drafts and rejected items can be edited, deleted or (re)submitted until
  the year's deadline; a submitted item can be pulled back to draft until then. Verified items are final.
- India: sections apply under the old regime only (the new regime has no such deductions); the regime itself can
  be changed until the year's deadline.
- Finance / HR (payroll) verify items of people in their scope, never their own; rejecting needs a reason.
- Amounts never go into the audit log or notifications.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.deps import CurrentUser
from app.models import AccessScope, Employee, Notification, TaxDeclaration, TaxDeclarationWindow
from app.services.scope import HR_ROLES

VERIFY_ROLES = HR_ROLES | {"finance", "payroll", "compensation"}
EDITABLE = ("draft", "rejected")
STATUSES = ("draft", "submitted", "verified", "rejected")
REMIND_DAYS = 30  # deadline reminders start this many days before


@dataclass(frozen=True)
class Section:
    code: str
    label: str
    cap: float | None = None
    proof: str = ""


# Mirrors COUNTRY_PAY[...].declarations in src/countryPay.ts.
SECTIONS: dict[str, list[Section]] = {
    "IN": [
        Section("80C", "80C — PPF, ELSS, life insurance, tuition fees", 150000, "Investment statement or premium receipt"),
        Section("80CCD(1B)", "80CCD(1B) — NPS (additional)", 50000, "NPS contribution statement"),
        Section("80D", "80D — health insurance (self, spouse, children)", 25000, "Premium receipt"),
        Section("80D-parents", "80D — health insurance for senior-citizen parents", 50000, "Premium receipt"),
        Section("HRA", "HRA — rent paid", None, "Rent receipts or rental agreement (landlord PAN above ₹1 lakh a year)"),
        Section("24(b)", "24(b) — home loan interest", 200000, "Lender's interest certificate"),
        Section("LTA", "LTA — leave travel allowance", None, "Travel tickets and boarding passes"),
        Section("80E", "80E — education loan interest", None, "Lender's interest certificate"),
        Section("80G", "80G — donations", None, "Donation receipt with the trust's 80G number"),
        Section("80TTA", "80TTA — savings account interest", 10000, "Bank interest certificate"),
    ],
    "US": [
        Section("401(k)", "401(k) — extra pre-tax contribution", 24500, "Election form"),
        Section("HSA", "HSA — health savings account", 4400, "HSA election"),
        Section("DCFSA", "Dependent care FSA", 7500, "Election form"),
        Section("W-4", "W-4 — extra withholding or credits", None, "Signed W-4"),
    ],
    "GB": [
        Section("Pension", "Extra pension contribution", 60000, "Pension provider letter"),
        Section("Gift Aid", "Gift Aid donations", None, "Charity receipt"),
        Section("Cycle to Work", "Cycle to Work scheme", None, "Scheme agreement"),
    ],
    "AU": [
        Section("Super", "Salary-sacrifice super", 30000, "Salary-sacrifice agreement"),
        Section("Work expenses", "Work-related expenses", None, "Receipts"),
        Section("Donations", "Donations to registered charities", None, "DGR receipt"),
    ],
    "CA": [
        Section("RRSP", "RRSP contributions", 32490, "RRSP contribution receipt"),
        Section("FHSA", "First Home Savings Account", 8000, "FHSA statement"),
        Section("TD1", "TD1 — personal tax credits", None, "Signed TD1"),
    ],
    "DE": [
        Section("Werbungskosten", "Werbungskosten — work expenses", None, "Receipts"),
        Section("Riester", "Riester pension", 2100, "Provider certificate"),
        Section("Freibetrag", "Lohnsteuer-Freibetrag", None, "Finanzamt notice"),
    ],
}
CURRENCY = {"IN": "INR", "US": "USD", "GB": "GBP", "AU": "AUD", "CA": "CAD", "DE": "EUR", "AE": "AED", "SA": "SAR"}
# (month, day) the tax year starts.
YEAR_START = {"IN": (4, 1), "GB": (4, 6), "AU": (7, 1)}


class DeclarationError(ValueError):
    pass


def year_start(country: str, on: date) -> int:
    m, d = YEAR_START.get(country, (1, 1))
    return on.year if (on.month, on.day) >= (m, d) else on.year - 1


def year_label(country: str, start: int) -> str:
    nxt = f"{(start + 1) % 100:02d}"
    return {
        "IN": f"{start}-{nxt}", "AU": f"{start}-{nxt}", "GB": f"Tax year {start}/{nxt}",
        "US": f"Tax year {start}", "CA": f"Tax year {start}", "DE": f"Steuerjahr {start}",
    }.get(country, str(start))


def year_bounds(country: str, start: int) -> tuple[date, date]:
    m, d = YEAR_START.get(country, (1, 1))
    first = date(start, m, d)
    return first, date(start + 1, m, d) - timedelta(days=1)


def declarable_years(country: str, today: date) -> list[tuple[str, int]]:
    start = year_start(country, today)
    return [(year_label(country, start), start), (year_label(country, start + 1), start + 1)]


def sections_for(country: str) -> list[Section]:
    return SECTIONS.get(country, [])


@dataclass
class Window:
    financial_year: str
    opens_on: date
    deadline: date
    proof_deadline: date | None
    locked: bool
    configured: bool

    def open(self, today: date) -> bool:
        return not self.locked and self.opens_on <= today <= self.deadline


def window_for(db: Session, country: str, label: str, start: int) -> Window:
    """The year's window; without a configured one: from the year start to 60 days before it ends."""
    row = db.scalar(select(TaxDeclarationWindow).where(TaxDeclarationWindow.country_code == country,
                                                       TaxDeclarationWindow.financial_year == label))
    if row is not None:
        return Window(label, row.opens_on, row.deadline, row.proof_deadline, bool(row.locked), True)
    first, last = year_bounds(country, start)
    return Window(label, first - timedelta(days=60), last - timedelta(days=60), last - timedelta(days=30), False, False)


def start_for_label(country: str, label: str, today: date) -> int | None:
    for lab, start in declarable_years(country, today):
        if lab == label:
            return start
    # Earlier years (read only).
    for start in range(year_start(country, today) - 5, year_start(country, today)):
        if year_label(country, start) == label:
            return start
    return None


def can_verify(db: Session, user: CurrentUser, emp: Employee) -> bool:
    """Finance / HR verify people in their scope, never themselves."""
    if emp.id == user.employee_id or user.account.role not in VERIFY_ROLES:
        return False
    if user.account.role in HR_ROLES:
        return user.scope.can_see(emp)
    row = db.get(AccessScope, user.id)
    countries = [c.strip().upper() for c in (row.country_codes or "").split(",") if c.strip()] if row else []
    return not countries or emp.country_code in countries


def is_verifier(user: CurrentUser) -> bool:
    return user.account.role in VERIFY_ROLES


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def log(item: TaxDeclaration, actor_id: str | None, action: str, note: str | None = None) -> None:
    entry: dict[str, Any] = {"at": utcnow().isoformat(), "by": actor_id, "action": action}
    if note:
        entry["note"] = note
    item.history = [*(item.history or []), entry]


def check_amount(country: str, section: Section, amount: float, others: float) -> None:
    if amount <= 0:
        raise DeclarationError("Enter an amount above zero.")
    if section.cap is not None and others + amount > section.cap:
        cur = CURRENCY.get(country, "")
        raise DeclarationError(f"{section.code} allows up to {cur} {section.cap:,.0f} a year; "
                               f"{cur} {others:,.0f} is already declared.")


def declared_elsewhere(db: Session, item_employee: str, fy: str, section: str, exclude_id: str | None) -> float:
    rows = db.scalars(select(TaxDeclaration).where(TaxDeclaration.employee_id == item_employee,
                                                   TaxDeclaration.financial_year == fy,
                                                   TaxDeclaration.section == section,
                                                   TaxDeclaration.status.in_(("draft", "submitted", "verified"))))
    return sum((r.verified_amount if r.status == "verified" and r.verified_amount is not None else r.amount)
               for r in rows if r.id != exclude_id)


def remind_deadline(db: Session, emp: Employee, today: date) -> None:
    """One reminder per year when the deadline is near and something is still a draft (or nothing is declared)."""
    sections = sections_for(emp.country_code)
    if not sections:
        return
    if emp.country_code == "IN" and (emp.tax_regime or "new") != "old":
        return
    label, start = declarable_years(emp.country_code, today)[0]
    win = window_for(db, emp.country_code, label, start)
    if not win.open(today) or (win.deadline - today).days > REMIND_DAYS:
        return
    items = db.scalars(select(TaxDeclaration).where(TaxDeclaration.employee_id == emp.id,
                                                    TaxDeclaration.financial_year == label)).all()
    drafts = [i for i in items if i.status in EDITABLE]
    if items and not drafts:
        return
    title = f"Tax declarations for {label} close on {win.deadline.isoformat()}"
    if db.scalar(select(Notification.id).where(Notification.recipient_id == emp.id, Notification.title.like(f"Tax declarations for {label} close%"))):
        return
    from app.services.activity import notify

    body = f"{len(drafts)} item(s) are still drafts — submit them with proofs." if drafts else "Declare your tax-saving investments with proofs."
    notify(db, recipient_id=emp.id, title=title, body=body, href="/investment")
    db.commit()

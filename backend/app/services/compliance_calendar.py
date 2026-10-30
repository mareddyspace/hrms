"""HR compliance calendar: statutory due dates per country (sample dates, configurable in compliance_due_dates) plus
automatic items from people data: visa / permit and other document expiries, probation end, contract end.

Kept in line with the portal's local mode (src/features/compliancecal/rules.ts): same sample list, same windows.
HR is notified 7 days before each item (run_alerts, called from app/services/jobs.py run_all).
"""

from __future__ import annotations

import calendar
import re
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from typing import Any

from sqlalchemy import ColumnElement, select, true
from sqlalchemy.orm import Session

from app.models import Account, ComplianceDueDate, Country, Employee, EmployeeDocument, LifecycleAction
from app.services.scope import HR_ROLES

KINDS = ("statutory", "visa", "document", "probation", "contract")
WINDOWS = (30, 60, 90)
ALERT_DAYS = 7
LEFT = ("Terminated", "Exited")
VISA_WORDS = re.compile(r"visa|permit|iqama|emirates id|brp|right to work|right-to-work|aufenthalt", re.I)

# Sample statutory dates (not legal advice): id, country, name, frequency, day, months, href.
SAMPLE_DUE_DATES: tuple[tuple[str, str, str, str, int, list[int] | None, str | None], ...] = (
    ("cd-in-pf", "IN", "PF contribution (EPF ECR)", "monthly", 15, None, "/payroll"),
    ("cd-in-esi", "IN", "ESI contribution", "monthly", 15, None, "/payroll"),
    ("cd-in-tds", "IN", "TDS deposit (salary)", "monthly", 7, None, "/payroll"),
    ("cd-in-pt", "IN", "Professional tax (Karnataka)", "monthly", 20, None, "/payroll"),
    ("cd-in-24q", "IN", "TDS return (Form 24Q)", "quarterly", 31, [1, 5, 7, 10], "/payroll"),
    ("cd-gb-paye", "GB", "PAYE and NI payment to HMRC", "monthly", 22, None, "/payroll"),
    ("cd-gb-p60", "GB", "P60 to employees", "annual", 31, [5], "/payroll"),
    ("cd-us-941", "US", "Form 941 (quarterly federal return)", "quarterly", 31, [1, 4, 7, 10], "/payroll"),
    ("cd-us-w2", "US", "W-2 to employees and SSA", "annual", 31, [1], "/payroll"),
    ("cd-au-stp", "AU", "PAYG withholding (BAS)", "quarterly", 28, [1, 4, 7, 10], "/payroll"),
    ("cd-ae-wps", "AE", "WPS salary transfer", "monthly", 10, None, "/payroll"),
    ("cd-sa-gosi", "SA", "GOSI contribution", "monthly", 15, None, "/payroll"),
    ("cd-de-lst", "DE", "Lohnsteuer-Anmeldung", "monthly", 10, None, "/payroll"),
    ("cd-ca-rem", "CA", "Source deductions remittance", "monthly", 15, None, "/payroll"),
)


class ComplianceError(ValueError):
    """Bad input; the message is safe to show."""


@dataclass
class Item:
    id: str
    kind: str
    title: str
    date: date
    country_code: str
    days_left: int
    href: str
    employee_id: str | None = None
    employee_name: str | None = None
    sample: bool = False

    def out(self) -> dict[str, Any]:
        return asdict(self)


def seed_defaults(db: Session) -> int:
    """Insert the sample list once (rows HR changed or removed are left alone)."""
    added = 0
    for cid, cc, name, freq, day, months, href in SAMPLE_DUE_DATES:
        if db.get(ComplianceDueDate, cid) is None:
            db.add(ComplianceDueDate(id=cid, country_code=cc, name=name, frequency=freq, day=day, months=months, href=href,
                                     note="Sample date", active=True))
            added += 1
    db.flush()
    return added


def _on(year: int, month: int, day: int) -> date:
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def occurrences(row: ComplianceDueDate, start: date, end: date) -> list[date]:
    out: list[date] = []
    y, m = start.year, start.month
    while date(y, m, 1) <= end:
        if row.frequency == "monthly" or (row.months and m in row.months):
            d = _on(y, m, row.day)
            if start <= d <= end:
                out.append(d)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def validate(data: dict[str, Any], countries: set[str]) -> dict[str, Any]:
    name = " ".join(str(data.get("name") or "").split())
    if not name:
        raise ComplianceError("Enter a name.")
    cc = str(data.get("country_code") or "").upper()
    if cc not in countries:
        raise ComplianceError("Choose a country.")
    freq = data.get("frequency")
    if freq not in ("monthly", "quarterly", "annual"):
        raise ComplianceError("Choose monthly, quarterly or annual.")
    day = int(data.get("day") or 0)
    if not 1 <= day <= 31:
        raise ComplianceError("Day must be 1 to 31.")
    months = sorted({int(x) for x in (data.get("months") or [])})
    if any(not 1 <= x <= 12 for x in months):
        raise ComplianceError("Months must be 1 to 12.")
    if freq == "quarterly" and len(months) != 4:
        raise ComplianceError("Pick the four months it is due in.")
    if freq == "annual" and len(months) != 1:
        raise ComplianceError("Pick the month it is due in.")
    href = (data.get("href") or "").strip() or None
    if href and not href.startswith("/"):
        raise ComplianceError("Link must be a page in the portal, e.g. /payroll.")
    return {"name": name[:200], "country_code": cc, "frequency": freq, "day": day,
            "months": months if freq != "monthly" else None, "href": href[:200] if href else None,
            "active": bool(data.get("active", True))}


def probation_end(emp: Employee, months: int | None) -> date | None:
    if not months:
        return None
    y, m = emp.joining_date.year, emp.joining_date.month + months
    y, m = y + (m - 1) // 12, (m - 1) % 12 + 1
    return _on(y, m, emp.joining_date.day)


def items(db: Session, today: date, days: int = 90, people: ColumnElement[bool] | None = None,
          country: str | None = None, kind: str | None = None) -> list[Item]:
    """Everything due from today to today + days, soonest first. `people` limits person items (data scope)."""
    end = today + timedelta(days=days)
    allowed = people if people is not None else true()
    out: list[Item] = []
    want = (lambda k: kind in (None, "", k))

    if want("statutory"):
        stmt = select(ComplianceDueDate).where(ComplianceDueDate.active.is_(True))
        if country:
            stmt = stmt.where(ComplianceDueDate.country_code == country)
        for row in db.scalars(stmt):
            for d in occurrences(row, today, end):
                out.append(Item(id=f"{row.id}:{d.isoformat()}", kind="statutory", title=row.name, date=d,
                                country_code=row.country_code, days_left=(d - today).days, href=row.href or "/payroll",
                                sample=(row.note or "").lower().startswith("sample")))

    emp_stmt = select(Employee).where(allowed, Employee.employment_status.not_in(LEFT))
    if country:
        emp_stmt = emp_stmt.where(Employee.country_code == country)

    if want("visa") or want("document"):
        stmt = (select(EmployeeDocument, Employee).join(Employee, Employee.id == EmployeeDocument.employee_id)
                .where(allowed, Employee.employment_status.not_in(LEFT), EmployeeDocument.expiry_date.is_not(None),
                       EmployeeDocument.expiry_date >= today, EmployeeDocument.expiry_date <= end))
        if country:
            stmt = stmt.where(Employee.country_code == country)
        for doc, emp in db.execute(stmt):
            k = "visa" if doc.category.lower() == "immigration" or VISA_WORDS.search(doc.title) else "document"
            if want(k):
                out.append(Item(id=f"doc:{doc.id}", kind=k, title=f"{doc.title} expires", date=doc.expiry_date,
                                country_code=emp.country_code, days_left=(doc.expiry_date - today).days,
                                href=f"/people/{emp.id}", employee_id=emp.id, employee_name=emp.full_name))

    if want("probation"):
        months = {c.code: c.probation_months for c in db.scalars(select(Country))}
        done = set(db.scalars(select(LifecycleAction.employee_id).where(
            LifecycleAction.action_type == "probation_completion", LifecycleAction.status == "applied")))
        extended: dict[str, date] = {}
        for la in db.scalars(select(LifecycleAction).where(LifecycleAction.status.in_(("applied", "scheduled")))):
            raw = (la.after or {}).get("probation_end_date")
            if raw and la.action_type != "probation_completion":
                try:
                    extended[la.employee_id] = date.fromisoformat(str(raw))
                except ValueError:
                    pass
        earliest = today - timedelta(days=31 * 13)
        for emp in db.scalars(emp_stmt.where(Employee.joining_date >= earliest, Employee.joining_date <= today)):
            if emp.id in done:
                continue
            d = extended.get(emp.id) or probation_end(emp, months.get(emp.country_code))
            if d and today <= d <= end:
                out.append(Item(id=f"probation:{emp.id}", kind="probation", title="Probation ends", date=d,
                                country_code=emp.country_code, days_left=(d - today).days, href=f"/people/{emp.id}",
                                employee_id=emp.id, employee_name=emp.full_name))

    if want("contract"):
        for emp in db.scalars(emp_stmt.where(Employee.contract_end_date.is_not(None), Employee.contract_end_date >= today,
                                             Employee.contract_end_date <= end)):
            d = emp.contract_end_date
            assert d is not None
            out.append(Item(id=f"contract:{emp.id}", kind="contract", title="Contract ends", date=d,
                            country_code=emp.country_code, days_left=(d - today).days, href=f"/people/{emp.id}",
                            employee_id=emp.id, employee_name=emp.full_name))

    out.sort(key=lambda i: (i.date, i.kind, i.title, i.employee_name or ""))
    return out


def run_alerts(db: Session, today: date, send: Any) -> int:
    """Notify HR about items due in exactly 7 days (or fewer, once per item per recipient per day)."""
    hr_ids = list(db.scalars(select(Account.employee_id).where(Account.role.in_(HR_ROLES), Account.active.is_(True),
                                                               Account.employee_id.is_not(None))))
    if not hr_ids:
        return 0
    sent = 0
    for item in items(db, today, ALERT_DAYS):
        if item.days_left != ALERT_DAYS:
            continue
        who = f" · {item.employee_name}" if item.employee_name else ""
        for rid in hr_ids:
            sent += send(db, f"compliance:{item.id}", rid, today, "compliance_due", f"Due in 7 days: {item.title}{who}",
                         f"{item.title} on {item.date.isoformat()} ({item.country_code}).", item.href)
    return sent


# ---------- seed: a few immigration documents and contract end dates so the calendar has people items ----------
def seed_people_items(db: Session, today: date) -> dict[str, int]:
    from app.seed_hr_content import _pdf
    from app.models import DocumentVersion
    from app.services import documents as docs

    stats = {"immigration_docs": 0, "contract_ends": 0}
    abroad = list(db.scalars(select(Employee).where(Employee.country_code.in_(("AE", "GB", "SA", "DE")),
                                                    Employee.employment_status == "Active").order_by(Employee.id).limit(4)))
    for i, (emp, offset, title) in enumerate(zip(abroad, (12, 26, 47, 83), ("Work permit", "Visa", "Residence permit", "Visa"))):
        doc_id = f"doc-seed-imm-{i}"
        if db.get(EmployeeDocument, doc_id) is not None:
            continue
        data = _pdf(title, [emp.full_name, f"{title} (sample)", f"Valid until {(today + timedelta(days=offset)):%d %b %Y}"])
        vid = f"dv-seed-imm-{i}"
        saved = docs.save_bytes(f"documents/{emp.id}", vid, data, "application/pdf")
        db.add(EmployeeDocument(id=doc_id, employee_id=emp.id, category="Immigration", title=title, current_version=1,
                                expiry_date=today + timedelta(days=offset), uploaded_by=None))
        db.flush()
        db.add(DocumentVersion(id=vid, document_id=doc_id, version=1, file_name=f"{title.replace(' ', '-')}.pdf",
                               content_type="application/pdf", size_bytes=saved.size_bytes, sha256=saved.sha256,
                               storage_path=saved.relative_path, uploaded_by=None))
        stats["immigration_docs"] += 1
    contractors = list(db.scalars(select(Employee).where(Employee.employment_type == "Contract",
                                                         Employee.employment_status == "Active").order_by(Employee.id).limit(4)))
    for emp, offset in zip(contractors, (9, 34, 58, 88)):
        if emp.contract_end_date is None:
            emp.contract_end_date = today + timedelta(days=offset)
            stats["contract_ends"] += 1
    db.flush()
    return stats

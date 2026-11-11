"""Starting data for Ram's two other engineers, Priya (India) and Oliver (UK), so their pages match Babu's
(called from app.seed.run()).

Insert-once by fixed id; nothing is updated or deleted. Pay history, benefits, leave history, project membership and
skills live in the shared seed lists (app/seed.py, app/seed_rewards.py, app/services/career.py); this module adds what
those lists can't: roster shifts in weeks Ram already published, project tasks on projects that already have tasks,
documents (Indian ones for Priya, UK ones for Oliver), a tax declaration each, and one open request each waiting for Ram.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    DocumentVersion, Employee, EmployeeDocument, ExpenseClaim, LeaveRequest, ProjectMember, ProjectTask, RosterShift,
    TaxDeclaration,
)
from app.seed_hr_content import _documents, _pdf
from app.services import documents as docs
from app.services import tax_declarations as decl
from app.services import time_approvals as chain
from app.services.leave import holiday_dates, today_for, working_days
from app.db import utcnow

PRIYA, OLIVER, RAM, HR = "emp-priya", "emp-oliver", "emp-ram", "demo-hr-admin"
TEAM = (PRIYA, OLIVER)

# code, title, due, status, estimate hours, assignee, description
TASKS: dict[str, list[tuple[str, str, str, str, float, str, str]]] = {
    "p-north": [("NW-420", "Payment gateway retry design", "2026-11-13", "in_progress", 10, PRIYA,
                 "Retry and back-off rules for failed card payments."),
                ("NW-421", "Regression suite for invoice exports", "2026-11-11", "in_progress", 12, OLIVER,
                 "Automated checks for CSV and PDF exports.")],
    "p-maple": [("MC-214", "Lab report API review", "2026-11-12", "in_review", 6, PRIYA,
                 "Review the data contract with the clinic's feed.")],
    "prj-hrms": [("HR-310", "Release plan for year-end build", "2026-11-20", "todo", 8, PRIYA,
                  "Branch cut, test windows and rollback steps."),
                 ("HR-311", "Timesheet approval test cases", "2026-11-09", "in_progress", 8, OLIVER,
                  "Cover approve, reopen and the 9-hour rule.")],
    "prj-acme": [("AC-145", "Returns flow end-to-end tests", "2026-11-16", "todo", 10, OLIVER,
                  "Customer return from request to refund.")],
    "prj-internal": [("INT-14", "Complete security awareness course", "2026-11-30", "todo", 2, PRIYA,
                      "Annual course, about 2 hours."),
                     ("INT-15", "Complete security awareness course", "2026-11-30", "todo", 2, OLIVER,
                      "Annual course, about 2 hours.")],
}


def _roster(db: Session, today: date) -> int:
    """General shift on weekdays this week and next, on days they have no shift yet (Ram's published weeks too)."""
    added = 0
    monday = today - timedelta(days=today.weekday())
    for emp_id in TEAM:
        emp = db.get(Employee, emp_id)
        if emp is None or emp.manager_id != RAM:
            continue
        holidays = holiday_dates(db, emp.country_code, monday, monday + timedelta(days=13))
        for offset in [*range(5), *range(7, 12)]:
            day = monday + timedelta(days=offset)
            if day in holidays:
                continue
            if db.scalar(select(RosterShift.id).where(RosterShift.employee_id == emp_id, RosterShift.work_date == day)):
                continue
            from app.seed_shift_roster import _target  # weekly rotation

            week = day - timedelta(days=day.weekday())
            db.add(RosterShift(id=f"rs-seed-{emp_id}-{day.isoformat()}", employee_id=emp_id, work_date=day,
                               shift_id=_target(emp_id, week), manager_id=RAM))
            added += 1
    return added


def _tasks(db: Session) -> int:
    added = 0
    for pid, rows in TASKS.items():
        for code, title, due, status, est, who, desc in rows:
            tid = f"pt-seed-{code.lower()}"
            if db.get(ProjectTask, tid) is not None or db.get(ProjectMember, (pid, who)) is None:
                continue
            db.add(ProjectTask(id=tid, project_id=pid, code=code, title=title, description=desc, assignee_id=who,
                               due_date=date.fromisoformat(due), estimate_hours=est, status=status))
            added += 1
    return added


def _uk_documents(emp: Employee, today: date) -> list[tuple[str, str, str, list[str], date | None]]:
    """(id suffix, category, title, lines, expiry) — the UK counterparts of Babu's documents."""
    code, name = emp.employee_code, emp.full_name
    joined = emp.joining_date.strftime("%d %B %Y").lstrip("0") if emp.joining_date else "12 September 2022"
    last_month = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
    months = [last_month, (last_month - timedelta(days=1)).replace(day=1)]
    tax_year_end = today.year if (today.month, today.day) >= (4, 6) else today.year - 1
    payslip = lambda m: [  # noqa: E731
        f"Payslip for {m.strftime('%B %Y')}", "",
        f"Employee   {name} ({code})", f"Role       {emp.job_title}, {emp.department}",
        "NI number  QQ ** ** 86 C      Tax code  1257L", "Bank       Barclays ****4186", "",
        "EARNINGS                         GBP", "Basic salary                 5,041.67", "Gross                        5,041.67", "",
        "DEDUCTIONS", "Income tax (PAYE)              798.40", "National Insurance             251.67",
        "Workplace pension (5%)         252.08", "Total deductions             1,302.15", "",
        "NET PAY                      3,739.52",
    ]
    return [
        ("passport", "Identity", "Passport", [
            "United Kingdom of Great Britain and Northern Ireland", "", f"Name            {name.upper()}",
            "Passport number ******186", f"Date of birth   {emp.date_of_birth:%d/%m/%Y}" if emp.date_of_birth else "",
            "", "Masked copy. Verified by HR."], today + timedelta(days=5 * 365)),
        ("right-to-work", "Identity", "Right to work check", [
            emp.legal_entity, "", f"Employee        {name} ({code})", "Check type      British passport (manual check)",
            f"Checked on      {joined}", "Result          Right to work confirmed, no time limit", "",
            "Recorded by HR."], None),
        ("offer", "Employment", "Offer letter", [
            emp.legal_entity, "", f"Dear {emp.first_name or name},", "",
            f"We are pleased to offer you the position of {emp.job_title} in {emp.department},",
            f"starting {joined}. Your annual base salary will be GBP 52,000.", "",
            "This offer is subject to right to work and reference checks.", "",
            "Authorised Signatory, Human Resources", "", f"Accepted by {name}."], None),
        (f"payslip-{months[0]:%Y-%m}", "Payroll", f"Payslip — {months[0]:%B %Y}", payslip(months[0]), None),
        (f"payslip-{months[1]:%Y-%m}", "Payroll", f"Payslip — {months[1]:%B %Y}", payslip(months[1]), None),
        ("p60", "Payroll", f"P60 — tax year {tax_year_end - 1}-{str(tax_year_end)[2:]}", [
            f"End of year certificate, tax year to 5 April {tax_year_end}", "",
            f"Employer   {emp.legal_entity}   PAYE ref 123/T****", f"Employee   {name}   NI QQ ** ** 86 C", "",
            "Pay in this employment      58,000.00", "Tax deducted                 9,086.00",
            "Employee NI                  2,722.00", "Final tax code               1257L"], None),
    ]


def _documents_for(db: Session, today: date) -> int:
    added = 0
    for emp_id in TEAM:
        emp = db.get(Employee, emp_id)
        if emp is None:
            continue
        items = _uk_documents(emp, today) if emp.country_code == "GB" else _documents(emp, today)
        for suffix, category, title, lines, expiry in items:
            doc_id = f"doc-seed-{emp_id.removeprefix('emp-')}-{suffix}"[:64]
            if db.get(EmployeeDocument, doc_id) is not None:
                continue
            data = _pdf(title, [line for line in lines])
            vid = f"dv-seed-{uuid.uuid4().hex[:10]}"
            saved = docs.save_bytes(f"documents/{emp.id}", vid, data, "application/pdf")
            db.add(EmployeeDocument(id=doc_id, employee_id=emp.id, category=category, title=title, current_version=1,
                                    expiry_date=expiry, uploaded_by=HR))
            db.flush()
            db.add(DocumentVersion(id=vid, document_id=doc_id, version=1,
                                   file_name=f"{title.replace(' — ', '-').replace(' ', '-')}.pdf",
                                   content_type="application/pdf", size_bytes=saved.size_bytes, sha256=saved.sha256,
                                   storage_path=saved.relative_path, uploaded_by=HR))
            added += 1
    return added


def _tax_declarations(db: Session, today: date) -> int:
    samples = {  # employee: (id, section, title, amount, status)
        PRIYA: ("td-seed-priya-1", "80C", "PPF contribution", 120000, "submitted"),
        OLIVER: ("td-seed-oliver-1", "Pension", "Extra pension contribution", 2400, "draft"),
    }
    added = 0
    for emp_id, (tid, section, title, amount, status) in samples.items():
        emp = db.get(Employee, emp_id)
        if emp is None or db.get(TaxDeclaration, tid) is not None or emp.country_code not in decl.SECTIONS:
            continue
        fy, _ = decl.declarable_years(emp.country_code, today)[0]
        now = utcnow()
        history = [{"at": now.isoformat(), "by": emp.id, "action": "Saved as draft"}]
        if status != "draft":
            history.append({"at": now.isoformat(), "by": emp.id, "action": "Submitted for verification"})
        db.add(TaxDeclaration(id=tid, employee_id=emp.id, country_code=emp.country_code, financial_year=fy,
                              regime="old" if emp.country_code == "IN" else None, section=section, title=title,
                              amount=amount, currency=emp.currency, status=status,
                              submitted_at=now if status != "draft" else None, history=history))
        added += 1
    return added


def _next_workday(db: Session, emp: Employee, day: date) -> date:
    holidays = holiday_dates(db, emp.country_code, day, day + timedelta(days=30))
    while day.weekday() >= 5 or day in holidays:
        day += timedelta(days=1)
    return day


def _open_requests(db: Session, today: date) -> int:
    """Priya: two days' leave in a fortnight; Oliver: a travel expense. Both waiting for Ram."""
    added = 0
    priya = db.get(Employee, PRIYA)
    if priya is not None and priya.manager_id == RAM and db.get(LeaveRequest, "lv-seed-priya-pending") is None:
        start = _next_workday(db, priya, today_for(priya) + timedelta(days=14))
        end = _next_workday(db, priya, start + timedelta(days=1))
        days = working_days(start, end, holiday_dates(db, priya.country_code, start, end))
        item = LeaveRequest(id="lv-seed-priya-pending", employee_id=PRIYA, leave_code="pto", from_date=start, to_date=end,
                            half="none", days=days, reason="Cousin's wedding in Kochi", status="pending")
        db.add(item)
        db.flush()
        chain.start(db, chain.LEAVE, item.id, priya, PRIYA, {"needs_hr": chain.leave_needs_hr(db, "pto", days),
                                                              "leave_type": "pto"})
        added += 1
    oliver = db.get(Employee, OLIVER)
    if oliver is not None and oliver.manager_id == RAM and db.get(ExpenseClaim, "exp-seed-oliver-1") is None:
        from app.seed_demo import _start

        claim = ExpenseClaim(id="exp-seed-oliver-1", employee_id=OLIVER, category="Travel", amount=86.40, currency=oliver.currency,
                             expense_date=today - timedelta(days=4), description="Train to the Acme office in Reading",
                             status="submitted")
        db.add(claim)
        db.flush()
        claim.approval_instance_id = _start(db, "expense", claim.id, oliver, claim.amount)
        added += 1
    return added


def seed(db: Session) -> dict[str, int]:
    db.flush()
    if db.get(Employee, RAM) is None:
        return {}
    today = date.today()
    stats = {
        "teammate_shifts_added": _roster(db, today),
        "teammate_tasks_added": _tasks(db),
        "teammate_documents_added": _documents_for(db, today),
        "teammate_tax_declarations_added": _tax_declarations(db, today),
    }
    db.flush()
    stats["teammate_requests_added"] = _open_requests(db, today)
    db.flush()
    return stats

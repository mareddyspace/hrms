"""Babu's starting documents and one policy change waiting for his acknowledgement (called from app.seed.run()).

Insert-once by fixed id; nothing is changed or deleted afterwards.

- Documents (PDF files in storage): Aadhaar and PAN (masked), offer letter, the last two payslips, Form 16.
- Policy: "Provident Fund contribution change" for India (PF from 12% to 13% of basic pay from 1 December),
  published and waiting for acknowledgement; Babu gets the notification.
"""

from __future__ import annotations

import io
import uuid
from datetime import UTC, date, datetime, timedelta
from xml.sax.saxutils import escape

from sqlalchemy.orm import Session

from app.models import DocumentVersion, Employee, EmployeeDocument
from app.models.policies import HrPolicy, HrPolicyVersion
from app.services import documents as docs
from app.services.activity import notify

BABU, HR = "emp-mahesh", "demo-hr-admin"
PF_POLICY = "pf-contribution-change"


def _pdf(title: str, lines: list[str]) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import HRFlowable, Paragraph, SimpleDocTemplate, Spacer

    navy = colors.HexColor("#1d3d6e")
    head = ParagraphStyle("h", fontName="Helvetica-Bold", fontSize=15, leading=19, textColor=navy)
    sub = ParagraphStyle("s", fontName="Helvetica-Bold", fontSize=12, leading=16, spaceBefore=4, spaceAfter=8)
    body = ParagraphStyle("b", fontName="Courier", fontSize=9.5, leading=13)
    story = [Paragraph("TimeZ", head), HRFlowable(width="100%", thickness=1.2, color=navy, spaceBefore=3, spaceAfter=8),
             Paragraph(escape(title), sub), Spacer(1, 4)]
    story += [Paragraph(escape(line).replace(" ", "&nbsp;") if line else "&nbsp;", body) for line in lines]
    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                      title=title, author="TimeZ").build(story)
    return buf.getvalue()


def _documents(emp: Employee, today: date) -> list[tuple[str, str, str, list[str], date | None]]:
    """(id suffix, category, title, lines, expiry)."""
    code, name = emp.employee_code, emp.full_name
    joined = emp.joining_date.strftime("%d %B %Y").lstrip("0") if emp.joining_date else "4 November 2024"
    last_month = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
    months = [last_month, (last_month - timedelta(days=1)).replace(day=1)]
    fy_end = today.year if today.month >= 4 else today.year - 1
    payslip = lambda m: [  # noqa: E731
        f"Payslip for {m.strftime('%B %Y')}", "",
        f"Employee   {name} ({code})", f"Role       {emp.job_title}, {emp.department}",
        "PAN        ABCPM****K      UAN  1009****4412", "Bank       HDFC Bank ****6620", "",
        "EARNINGS                         INR", "Basic                         52,000", "HRA                           26,000",
        "Special allowance             26,000", "Gross                       1,04,000", "",
        "DEDUCTIONS", "Provident Fund (12%)           6,240", "Professional tax                 200",
        "Income tax (TDS)               8,450", "Total deductions              14,890", "",
        "NET PAY                       89,110",
    ]
    return [
        ("aadhaar", "Identity", "Aadhaar card", [
            "Unique Identification Authority of India", "", f"Name            {name}", "Aadhaar number  XXXX XXXX 4821",
            "Date of birth   14/03/1994", "Address         12 Lake View Road, Indiranagar, Bengaluru 560038",
            "", "Masked copy. Verified by HR."], None),
        ("pan", "Identity", "PAN card", [
            "Income Tax Department, Government of India", "", f"Name            {name.upper()}", "PAN             ABCPM****K",
            "Date of birth   14/03/1994", "", "Masked copy. Verified by HR."], None),
        ("offer", "Employment", "Offer letter", [
            emp.legal_entity, "", f"Dear {emp.first_name or name},", "",
            f"We are pleased to offer you the position of {emp.job_title} in {emp.department},",
            f"starting {joined}. Your annual base salary will be INR 12,48,000.", "",
            "This offer is subject to background verification and joining documents.", "",
            "Authorised Signatory, Human Resources", "", f"Accepted by {name}."], None),
        (f"payslip-{months[0]:%Y-%m}", "Payroll", f"Payslip — {months[0]:%B %Y}", payslip(months[0]), None),
        (f"payslip-{months[1]:%Y-%m}", "Payroll", f"Payslip — {months[1]:%B %Y}", payslip(months[1]), None),
        ("form16", "Payroll", f"Form 16 — FY {fy_end - 1}-{str(fy_end)[2:]}", [
            "Certificate under section 203 of the Income-tax Act, 1961", f"Financial year {fy_end - 1}-{str(fy_end)[2:]}", "",
            f"Employer   {emp.legal_entity}   TAN BLRT****2E", f"Employee   {name}   PAN ABCPM****K", "",
            "Part A - tax deducted and deposited", "Q1 25,350   Q2 25,350   Q3 25,350   Q4 25,350", "Total TDS          1,01,400", "",
            "Part B - salary and deductions", "Gross salary      12,48,000", "Standard deduction   75,000",
            "Taxable income    11,73,000"], None),
    ]


def _seed_documents(db: Session, today: date) -> int:
    emp = db.get(Employee, BABU)
    if emp is None:
        return 0
    added = 0
    for suffix, category, title, lines, expiry in _documents(emp, today):
        doc_id = f"doc-seed-babu-{suffix}"[:64]
        if db.get(EmployeeDocument, doc_id) is not None:
            continue
        data = _pdf(title, lines)
        vid = f"dv-seed-{uuid.uuid4().hex[:10]}"
        saved = docs.save_bytes(f"documents/{emp.id}", vid, data, "application/pdf")
        db.add(EmployeeDocument(id=doc_id, employee_id=emp.id, category=category, title=title, current_version=1,
                                expiry_date=expiry, uploaded_by=HR))
        db.flush()
        db.add(DocumentVersion(id=vid, document_id=doc_id, version=1, file_name=f"{title.replace(' — ', '-').replace(' ', '-')}.pdf",
                               content_type="application/pdf", size_bytes=saved.size_bytes, sha256=saved.sha256,
                               storage_path=saved.relative_path, uploaded_by=HR))
        added += 1
    return added


def _seed_pf_policy(db: Session, today: date) -> int:
    if db.get(HrPolicy, PF_POLICY) is not None:
        return 0
    effective = date(today.year, 12, 1) if today < date(today.year, 12, 1) else date(today.year + 1, 12, 1)
    when = effective.strftime("%d %B %Y").lstrip("0")
    publisher = HR if db.get(Employee, HR) is not None else None
    db.add(HrPolicy(id=PF_POLICY, title="Provident Fund contribution change", category="Pay & tax", status="published",
                    audience_type="country", audience_values=["IN"], requires_ack=True, current_version=1,
                    created_by=publisher, updated_by=publisher))
    db.flush()
    change = f"Employee PF contribution goes up from 12% to 13% of basic pay from {when}."
    db.add(HrPolicyVersion(
        policy_id=PF_POLICY, version=1, status="published", change_summary=change, effective_date=effective,
        summary="Applies to everyone on the India payroll.",
        sections=[
            {"heading": "What changes", "rules": [
                f"From {when}, your Provident Fund contribution is 13% of basic pay (it was 12%).",
                "The company contribution also goes up to 13%.",
                "Your take-home pay goes down by 1% of basic pay. Your PF balance grows by the same amount, plus the company's share."]},
            {"heading": "What you need to do", "rules": [
                "Nothing, apart from acknowledging this change. Payroll applies it automatically.",
                "Questions: add a comment when you acknowledge, or ask HR through the Helpdesk."]},
        ],
        published_at=datetime.now(UTC), published_by=publisher))
    if db.get(Employee, BABU) is not None:
        notify(db, recipient_id=BABU, title="Needs your acknowledgement: Provident Fund contribution change",
               body=f"{change} Effective {when}.", href=f"/policies?policy={PF_POLICY}")
    return 1


def seed(db: Session) -> dict[str, int]:
    today = date.today()
    return {"seed_documents": _seed_documents(db, today), "seed_policies": _seed_pf_policy(db, today)}

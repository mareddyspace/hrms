"""Letters (same as the portal: src/data/letterTemplates.ts, src/data/letterService.ts).

request -> type -> fields from the employee record (and pay history for pay letters) -> missing-field check ->
approval (type "letter": HR whose scope covers the employee; never the employee, never the person who raised it, so
warning / termination letters raised by HR always get a second approver) -> issue: a PDF is generated, stored as a
new version of the employee's "Letters" document and becomes downloadable by the employee.
Sensitive letters (salary revision, promotion, warning, termination) stay hidden from the employee until issued.

Template wording lives in letter_templates (per type, optionally per country); DEFAULT_WORDING below is the seed,
ported from letterTemplates.ts. Placeholders: see PLACEHOLDERS.
"""

from __future__ import annotations

import io
import uuid
from datetime import date
from typing import Any
from xml.sax.saxutils import escape

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import (
    ApprovalDecision,
    ApprovalInstance,
    CompensationRecord,
    Country,
    DocumentVersion,
    Employee,
    EmployeeDocument,
    LetterIssue,
    LetterRequest,
    LetterTemplate,
)
from app.services import approvals as engine
from app.services import documents as docs
from app.services.activity import notify, record_audit

LETTER_WORKFLOW: list[dict[str, Any]] = [{"roles": ["hr"], "mode": "any", "min_amount": None}]

# type: label, employee may request it, pay letter, details label, HR enters an effective date, needs a second approver
LETTER_TYPES: dict[str, dict[str, Any]] = {
    "Offer": {"label": "Offer letter", "employee": False, "pay": True},
    "Appointment": {"label": "Appointment letter", "employee": False, "pay": True},
    "Employment": {"label": "Employment certificate", "employee": True, "pay": False},
    "Promotion": {"label": "Promotion letter", "employee": False, "pay": True, "effective": True},
    "Transfer": {"label": "Transfer letter", "employee": False, "pay": False, "details": "New location / department",
                 "effective": True},
    "Salary revision": {"label": "Salary revision letter", "employee": False, "pay": True, "effective": True},
    "Experience": {"label": "Experience letter", "employee": True, "pay": False, "effective": True},
    "Relieving": {"label": "Relieving letter", "employee": False, "pay": False, "effective": True},
    "Confirmation": {"label": "Confirmation letter", "employee": False, "pay": False, "effective": True},
    "NOC": {"label": "No objection certificate", "employee": True, "pay": False, "details": "Purpose"},
    "Visa/Travel": {"label": "Visa / travel letter", "employee": True, "pay": False, "details": "Destination and travel dates"},
    "Address proof": {"label": "Address proof letter", "employee": True, "pay": False},
    "Internship": {"label": "Internship certificate", "employee": True, "pay": False, "effective": True},
    "Warning": {"label": "Warning letter", "employee": False, "pay": False, "details": "Issue and expected improvement",
                "second": True},
    "Termination": {"label": "Termination letter", "employee": False, "pay": False, "details": "Reason for termination",
                    "effective": True, "second": True},
}
SENSITIVE_TYPES = frozenset({"Salary revision", "Promotion", "Warning", "Termination"})
EXITED_STATUSES = frozenset({"Terminated", "Exited", "Resigned", "Separated", "Inactive"})

TYPE_CODE = {"Internship": "INT", "Warning": "WRN", "Termination": "TRM", "Employment": "EMP", "Experience": "EXP",
             "Relieving": "REL", "Offer": "OFR", "Appointment": "APT", "Confirmation": "CNF", "Promotion": "PRM",
             "Salary revision": "SAL", "Transfer": "TRF", "NOC": "NOC", "Visa/Travel": "VIS", "Address proof": "ADR"}

ENTITY_ADDRESS = {
    "IN": "Prestige Tech Park, Outer Ring Road, Bengaluru 560103, India",
    "US": "350 Fifth Avenue, Suite 4200, New York, NY 10118, United States",
    "GB": "20 Finsbury Circus, London EC2M 7EA, United Kingdom",
    "AU": "1 Martin Place, Sydney NSW 2000, Australia",
    "CA": "100 King Street West, Toronto, ON M5X 1A9, Canada",
    "AE": "Dubai Internet City, Building 3, Dubai, United Arab Emirates",
    "SA": "King Fahd Road, Olaya, Riyadh 12214, Saudi Arabia",
    "DE": "Friedrichstraße 68, 10117 Berlin, Germany",
}

FIELD_LABELS = {
    "employee_name": "Employee name", "employee_code": "Employee code", "title": "Job title", "department": "Department",
    "grade": "Grade", "joining_date": "Joining date", "last_working_day": "Last working day", "manager": "Line manager",
    "country_code": "Country", "country_name": "Country", "legal_entity": "Legal entity", "address": "Address",
    "salary": "Salary (compensation record)", "previous_salary": "Previous salary", "effective_date": "Effective date",
    "details": "Details", "nationality": "Nationality", "end_date": "End date",
}
BASE_REQUIRED = ("employee_name", "employee_code", "title", "department", "country_name", "legal_entity", "joining_date")
EXTRA_REQUIRED: dict[str, tuple[str, ...]] = {
    "Internship": ("end_date",), "Warning": ("details", "manager"), "Termination": ("details", "effective_date"),
    "Employment": (), "Experience": ("last_working_day",), "Relieving": ("last_working_day",), "Offer": ("grade", "salary"),
    "Appointment": ("grade", "manager", "salary"), "Confirmation": ("effective_date",),
    "Promotion": ("grade", "salary", "effective_date"), "Salary revision": ("salary", "effective_date"),
    "Transfer": ("details", "effective_date"), "NOC": ("details",), "Visa/Travel": ("details",), "Address proof": ("address",),
}

PLACEHOLDERS = (
    "employee", "employee_name", "employee_code", "role", "title", "department", "grade", "entity", "joining_date",
    "last_working_day", "effective_date", "end_date", "salary", "previous_salary", "salary_change", "details", "manager",
    "address", "nationality_clause", "supervision",
)


class LetterError(ValueError):
    """A rule was broken (422); the message is safe to show the user."""


# ---------- default wording (ported from letterTemplates.ts body()) ----------
def default_wording(letter_type: str, c: str) -> tuple[str, bool, list[str]]:
    """(title, "To whom it may concern" salutation, paragraphs) for a country code ("" = the default)."""
    no_liability = ("This certificate is issued at the employee's request without any liability on the company."
                    if c in ("AE", "SA") else "This letter is issued at the employee's request.")
    if letter_type == "Employment":
        return ("Employment Verification" if c == "US" else "Employment Certificate", True, [
            "This is to certify that {employee} has been employed with {entity} since {joining_date} and currently works as {role}.",
            "Employment with the company is at-will." if c == "US" else "The employee is in active service as of the date of this letter.",
            no_liability])
    if letter_type == "Experience":
        return ("Experience Letter", True, [
            "This is to certify that {employee} was employed with {entity} from {joining_date} to {last_working_day}. "
            "Their last position was {role}.",
            "During this period their conduct and performance were satisfactory. We wish them well.",
            *(["A qualified reference (Arbeitszeugnis) is available on request."] if c == "DE" else [])])
    if letter_type == "Relieving":
        if c == "US":
            return ("Separation Letter", False, [
                "This confirms that your employment with {entity} as {role} ended on {last_working_day}.",
                "Final pay and benefit details are sent separately."])
        if c == "GB":
            return ("Confirmation of Leaving", False, [
                "This confirms that your employment with {entity} as {role} ended on {last_working_day}.",
                "Your P45 is issued with your final payslip."])
        return ("Relieving Letter", False, [
            "Further to your resignation, you are relieved from your duties as {role} with {entity} at the close of business "
            "on {last_working_day}.",
            "Your full and final settlement will be processed as per company policy. We thank you for your service."])
    if letter_type == "Offer":
        return ("Offer of Employment", False, [
            "We are pleased to offer you the position of {title} (grade {grade}) in {department} with {entity}, starting {joining_date}.",
            "Your annual base salary will be <b>{salary}</b>, subject to applicable deductions.",
            "Employment with the company is at-will. This offer is subject to background verification and work authorization."
            if c == "US" else
            "This offer is subject to right-to-work checks. A written statement of particulars follows on joining."
            if c == "GB" else "This offer is subject to background verification and submission of joining documents."])
    if letter_type == "Appointment":
        return ("Letter of Appointment", False, [
            "You are appointed as {title} (grade {grade}) in {department} with {entity}, effective {joining_date}. "
            "You will report to {manager}.",
            "Your annual base salary is <b>{salary}</b>.",
            "Your employment is governed by the company's standing orders and policies, as amended from time to time."
            if c == "IN" else "Your employment is governed by your contract and the company's policies."])
    if letter_type == "Confirmation":
        return ("Confirmation of Employment", False, [
            "We are pleased to confirm your employment as {role} with {entity}, effective {effective_date}, on successful "
            "completion of your probation.",
            "All other terms of your employment remain unchanged."])
    if letter_type == "Promotion":
        return ("Promotion Letter", False, [
            "We are pleased to inform you that you have been promoted to grade <b>{grade}</b> as {role}, effective {effective_date}.",
            "Your revised annual base salary is <b>{salary}</b>.",
            "All other terms of your employment remain unchanged."])
    if letter_type == "Salary revision":
        return ("Salary Revision Letter", False, [
            "Your annual base salary is revised {salary_change}, effective {effective_date}.",
            "This information is confidential. All other terms remain unchanged."])
    if letter_type == "Transfer":
        return ("Transfer Letter", False, [
            "You are transferred from {role} to <b>{details}</b>, effective {effective_date}.",
            "Your grade, pay and continuity of service are unchanged unless stated otherwise in writing."])
    if letter_type == "NOC":
        return ("No Objection Certificate", True, [
            "{employee}, {role}, has been employed with {entity} since {joining_date}.",
            "The company has no objection to the employee's request for: <b>{details}</b>.",
            no_liability])
    if letter_type == "Visa/Travel":
        return ("Visa Support Letter" if c in ("DE", "GB") else "Visa / Travel Letter", True, [
            "{employee}{nationality_clause} is employed with {entity} as {role} since {joining_date}.",
            "The employee intends to travel as follows: <b>{details}</b>. The employee will resume duties on return.",
            no_liability])
    if letter_type == "Address proof":
        return ("Address Confirmation", True, [
            "This is to certify that {employee}, {role}, is employed with {entity}.",
            "As per company records, the employee's residential address is: <b>{address}</b>.",
            no_liability])
    if letter_type == "Internship":
        return ("Internship Certificate", True, [
            "This is to certify that {employee} completed an internship with {entity} from {joining_date} to {end_date}, "
            "working as {role}.",
            "{supervision}",
            "We wish them every success."])
    if letter_type == "Warning":
        return ("Warning Letter (Abmahnung)" if c == "DE" else "Warning Letter", False, [
            "This letter is a formal warning about the following: <b>{details}</b>.",
            "This was discussed with you by your line manager, {manager}. You are expected to show immediate and lasting "
            "improvement. Further issues of this kind may lead to further disciplinary action, up to and including "
            "termination of employment.",
            "You have the right to appeal this warning in writing to Human Resources within 5 working days." if c == "GB" else
            "A copy of this warning is placed on your personnel file. You may submit a written response, which will be "
            "filed with it." if c == "DE" else
            "A copy of this letter is placed on your personnel file. You may reply in writing to Human Resources within 7 days.",
            "Please sign a copy of this letter to confirm you have received it."])
    if letter_type == "Termination":
        return ("Termination of Employment", False, [
            "This letter confirms that your employment with {entity} as {role} ends with effect from <b>{effective_date}</b>.",
            "Reason: {details}.",
            "Employment with the company is at-will. Information on final pay, benefits continuation and any severance is sent "
            "separately." if c == "US" else
            "You will receive pay for your statutory or contractual notice, whichever is longer, and any accrued holiday. You "
            "have the right to appeal this decision in writing within 5 working days." if c == "GB" else
            "The statutory or contractual notice period applies. Your final settlement and employment reference "
            "(Arbeitszeugnis) will follow." if c == "DE" else
            "Your end-of-service gratuity, notice pay and accrued leave will be settled as per labour law and your contract."
            if c in ("AE", "SA") else
            "Your full and final settlement, including notice pay and accrued leave, will be processed as per your appointment "
            "terms and company policy.",
            "Please return all company property and complete the exit handover by your last working day."])
    raise LetterError(f"Unknown letter type: {letter_type}")


def seed_templates(db: Session, countries: list[str]) -> int:
    """Insert-once: a default row per type, plus a country row wherever the wording differs. Returns rows added."""
    added = 0
    for letter_type in LETTER_TYPES:
        rows = {None: default_wording(letter_type, "")}
        for c in countries:
            wording = default_wording(letter_type, c)
            if wording != rows[None]:
                rows[c] = wording
        for country, (title, to_whom, paragraphs) in rows.items():
            tid = f"lt-{TYPE_CODE[letter_type].lower()}-{(country or 'all').lower()}"
            if db.get(LetterTemplate, tid) is None:
                db.add(LetterTemplate(id=tid, letter_type=letter_type, country_code=country, title=title, to_whom=to_whom,
                                      paragraphs=paragraphs, version=1, active=True))
                added += 1
    return added


def ensure_workflow(db: Session) -> None:
    if engine.latest_definition(db, "letter") is None:
        engine.save_definition(db, "letter", LETTER_WORKFLOW, None)


def template_for(db: Session, letter_type: str, country_code: str) -> LetterTemplate | None:
    rows = list(db.scalars(select(LetterTemplate).where(LetterTemplate.letter_type == letter_type,
                                                        LetterTemplate.active.is_(True))))
    return next((t for t in rows if t.country_code == country_code), None) or next((t for t in rows if t.country_code is None), None)


def check_template_text(paragraphs: list[str]) -> None:
    values = {k: "x" for k in PLACEHOLDERS}
    for p in paragraphs:
        try:
            p.format_map(values)
        except (KeyError, ValueError, IndexError) as exc:
            raise LetterError(f"Unknown or broken placeholder in: {p[:60]}... Allowed: {', '.join(PLACEHOLDERS)}.") from exc


# ---------- fields ----------
def format_money(amount: float, currency: str) -> str:
    whole = int(round(amount))
    if currency == "INR":
        s = str(abs(whole))
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        grouped = ",".join(groups + [tail]) if groups else tail
    else:
        grouped = f"{abs(whole):,}"
    return f"{currency} {'-' if whole < 0 else ''}{grouped}"


MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
          "December")


def letter_date(iso: str, country_code: str) -> str:
    try:
        d = date.fromisoformat(iso)
    except ValueError:
        return iso
    return f"{MONTHS[d.month - 1]} {d.day}, {d.year}" if country_code == "US" else f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def collect_fields(db: Session, req: LetterRequest, emp: Employee) -> dict[str, str]:
    info = LETTER_TYPES[req.letter_type]
    country = db.get(Country, emp.country_code)
    manager = db.get(Employee, emp.manager_id) if emp.manager_id else None
    salary = previous_salary = comp_effective = comp_grade = ""
    if info["pay"]:
        rows = list(db.scalars(select(CompensationRecord).where(CompensationRecord.employee_id == emp.id)
                               .order_by(CompensationRecord.effective_date.desc())))
        # Offer / appointment use the starting salary; promotion / revision use the latest one.
        pick = rows[-1] if req.letter_type in ("Offer", "Appointment") and rows else rows[0] if rows else None
        if pick is not None:
            salary = format_money(pick.base_salary, pick.currency)
            comp_effective, comp_grade = pick.effective_date.isoformat(), pick.grade
            if req.letter_type == "Salary revision" and len(rows) > 1:
                previous_salary = format_money(rows[1].base_salary, rows[1].currency)
    effective = req.effective_date.isoformat() if req.effective_date else ""
    if not effective and req.letter_type in ("Promotion", "Salary revision"):
        effective = comp_effective
    return {
        "employee_name": emp.full_name or "",
        "employee_code": emp.employee_code or "",
        "title": emp.job_title or "",
        "department": emp.department or "",
        "grade": (req.letter_type == "Promotion" and comp_grade) or emp.grade or comp_grade or "",
        "joining_date": emp.joining_date.isoformat() if emp.joining_date else "",
        "last_working_day": effective if req.letter_type in ("Experience", "Relieving") else "",
        "manager": manager.full_name if manager else "",
        "country_code": emp.country_code or "",
        "country_name": country.name if country else "",
        "legal_entity": emp.legal_entity or "",
        "address": "",  # no address on the employee record yet
        "salary": salary,
        "previous_salary": previous_salary,
        "effective_date": effective if req.letter_type not in ("Experience", "Relieving", "Internship") else "",
        "details": req.details or "",
        "nationality": "",
        "end_date": effective if req.letter_type == "Internship" else "",
    }


def missing_fields(letter_type: str, fields: dict[str, str]) -> list[str]:
    out = []
    for key in (*BASE_REQUIRED, *EXTRA_REQUIRED.get(letter_type, ())):
        if (fields.get(key) or "").strip():
            continue
        if key == "details":
            out.append(LETTER_TYPES[letter_type].get("details") or FIELD_LABELS["details"])
        elif key == "effective_date" and letter_type == "Termination":
            out.append("Termination date")
        elif key == "end_date" and letter_type == "Internship":
            out.append("Internship end date (effective date)")
        else:
            out.append(FIELD_LABELS[key])
    return out


def missing_message(missing: list[str]) -> str:
    return f"Cannot generate — missing: {', '.join(missing)}."


def render(db: Session, letter_type: str, fields: dict[str, str]) -> tuple[str, bool, list[str]]:
    """(title, to_whom, paragraphs as reportlab markup). Values are escaped; template markup (<b>) is kept."""
    c = fields["country_code"]
    tpl = template_for(db, letter_type, c)
    title, to_whom, paragraphs = (tpl.title, tpl.to_whom, list(tpl.paragraphs)) if tpl else default_wording(letter_type, c)
    e = {k: escape(v) for k, v in fields.items()}
    d = {k: escape(letter_date(fields[k], c)) if fields[k] else "" for k in ("joining_date", "last_working_day",
                                                                             "effective_date", "end_date")}
    values = {
        "employee": f"<b>{e['employee_name']}</b> ({e['employee_code']})",
        "employee_name": e["employee_name"], "employee_code": e["employee_code"],
        "role": f"{e['title']}, {e['department']}", "title": e["title"], "department": e["department"], "grade": e["grade"],
        "entity": e["legal_entity"], **d, "salary": e["salary"], "previous_salary": e["previous_salary"],
        "salary_change": (f"from {e['previous_salary']} to <b>{e['salary']}</b>" if fields["previous_salary"]
                          else f"to <b>{e['salary']}</b>"),
        "details": e["details"], "manager": e["manager"], "address": e["address"],
        "nationality_clause": f", {e['nationality']} national," if fields["nationality"] else "",
        "supervision": (f"The internship was supervised by {e['manager']}. During this period their conduct and work were "
                        "satisfactory." if fields["manager"] else "During this period their conduct and work were satisfactory."),
    }
    try:
        rendered = [p.format_map(values) for p in paragraphs]
    except (KeyError, ValueError, IndexError) as exc:
        raise LetterError("The letter template has a broken placeholder. Ask HR to fix the template.") from exc
    return title, to_whom, [p for p in rendered if p.strip()]


def reference_number(letter_type: str, country_code: str, serial: int, on: date) -> str:
    return f"INF-{country_code or 'IN'}/HR/{TYPE_CODE[letter_type]}/{on.year}/{serial:04d}"


def build_pdf(*, fields: dict[str, str], title: str, to_whom: bool, paragraphs: list[str], reference_no: str, on: date,
              approved_by: str, doc_id: str, version: int) -> bytes:
    """A4 letter on the entity letterhead (reportlab)."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import HRFlowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    c = fields["country_code"]
    navy = colors.HexColor("#1d3d6e")
    body = ParagraphStyle("body", fontName="Times-Roman", fontSize=11, leading=16, spaceAfter=8)
    small = ParagraphStyle("small", fontName="Helvetica", fontSize=9, leading=12, textColor=colors.HexColor("#555555"))
    head = ParagraphStyle("head", fontName="Helvetica-Bold", fontSize=16, leading=20, textColor=navy)
    h1 = ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=13, leading=18, alignment=TA_CENTER, spaceBefore=6, spaceAfter=14)
    approval = ParagraphStyle("approval", parent=small, textColor=navy)
    foot = ParagraphStyle("foot", parent=small, fontSize=8, alignment=TA_CENTER, textColor=colors.HexColor("#777777"))

    entity = escape(fields["legal_entity"])
    story: list[Any] = [
        Paragraph(entity, head),
        Paragraph(escape(ENTITY_ADDRESS.get(c, ENTITY_ADDRESS["IN"])), small),
        HRFlowable(width="100%", thickness=1.5, color=navy, spaceBefore=4, spaceAfter=10),
    ]
    meta = Table([[Paragraph(f"Ref: {escape(reference_no)}", small), Paragraph(escape(letter_date(on.isoformat(), c)), small)]],
                 colWidths=["70%", "30%"])
    meta.setStyle(TableStyle([("ALIGN", (1, 0), (1, 0), "RIGHT"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                              ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    story += [meta, Spacer(1, 10), Paragraph(escape(title.upper()), h1)]
    story.append(Paragraph("To whom it may concern," if to_whom else f"Dear {escape(fields['employee_name'])},", body))
    story += [Paragraph(p, body) for p in paragraphs]
    story += [
        Spacer(1, 18), Paragraph(f"For {entity}", body), Spacer(1, 28),
        HRFlowable(width=55 * mm, thickness=0.8, color=colors.black, hAlign="LEFT", spaceAfter=4),
        Paragraph("<b>Authorised Signatory</b><br/>Human Resources", body),
        Paragraph(f"Approved by {escape(approved_by)} on {escape(letter_date(on.isoformat(), c))}", approval),
        Spacer(1, 30),
        HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#cccccc"), spaceAfter=4),
        Paragraph(f"Document {escape(doc_id)} · version {version}", foot),
    ]
    buf = io.BytesIO()
    pdf = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=18 * mm, bottomMargin=20 * mm,
                            title=title, author=fields["legal_entity"], subject=reference_no)
    pdf.build(story)
    return buf.getvalue()


def issue(db: Session, req: LetterRequest, approver_id: str | None, generated_by: str | None) -> LetterIssue:
    """Generate the PDF, store it as the next version of the employee's letter document. Raises LetterError."""
    emp = db.get(Employee, req.employee_id)
    if emp is None:
        raise LetterError("Employee not found.")
    fields = collect_fields(db, req, emp)
    missing = missing_fields(req.letter_type, fields)
    if missing:
        raise LetterError(missing_message(missing))
    title, to_whom, paragraphs = render(db, req.letter_type, fields)
    approver = db.get(Employee, approver_id) if approver_id else None
    today = date.today()
    serial = (db.scalar(select(func.count()).select_from(LetterIssue)) or 0) + 1
    reference_no = reference_number(req.letter_type, fields["country_code"], serial, today)
    while db.scalar(select(LetterIssue.id).where(LetterIssue.reference_no == reference_no)):
        serial += 1
        reference_no = reference_number(req.letter_type, fields["country_code"], serial, today)
    version = (db.scalar(select(func.max(LetterIssue.version)).where(LetterIssue.request_id == req.id)) or 0) + 1
    doc_id = f"DOC-{today.strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}"
    pdf = build_pdf(fields=fields, title=title, to_whom=to_whom, paragraphs=paragraphs, reference_no=reference_no, on=today,
                    approved_by=approver.full_name if approver else "Human Resources", doc_id=doc_id, version=version)
    label = LETTER_TYPES[req.letter_type]["label"]
    document = db.get(EmployeeDocument, req.document_id) if req.document_id else None
    if document is None:
        document = EmployeeDocument(id=f"doc-{uuid.uuid4().hex[:12]}", employee_id=emp.id, category=docs.LETTERS_CATEGORY,
                                    title=label, current_version=0, letter_request_id=req.id, uploaded_by=generated_by)
        db.add(document)
        db.flush()
        req.document_id = document.id
    doc_version = document.current_version + 1
    version_id = f"dv-{uuid.uuid4().hex[:12]}"
    saved = docs.save_bytes(f"letters/{emp.id}", f"{doc_id}-v{version}", pdf, "application/pdf")
    db.add(DocumentVersion(id=version_id, document_id=document.id, version=doc_version,
                           file_name=f"{label.replace(' ', '-').replace('/', '-')}-{emp.employee_code}-v{version}.pdf",
                           content_type="application/pdf", size_bytes=saved.size_bytes, sha256=saved.sha256,
                           storage_path=saved.relative_path, uploaded_by=generated_by))
    document.current_version = doc_version
    row = LetterIssue(id=doc_id, request_id=req.id, version=version, reference_no=reference_no, document_version_id=version_id,
                      approved_by=approver_id, generated_by=generated_by, fields=fields)
    db.add(row)
    req.status, req.issued_at, req.issue_error = "issued", utcnow(), None
    record_audit(db, actor_id=generated_by, action="letter_issued", entity="letter_request", entity_id=req.id, subject_id=emp.id,
                 after={"doc_id": doc_id, "version": version, "reference_no": reference_no, "sha256": saved.sha256})
    notify(db, recipient_id=emp.id, title=f"{label} issued", body=f"Your {label.lower()} is ready ({reference_no}).",
           href=f"/documents/{document.id}")
    db.flush()
    return row


@engine.on_finish("letter")
def _letter_finished(db: Session, instance: ApprovalInstance) -> None:
    req = db.get(LetterRequest, instance.entity_id)
    if req is None or req.status != "pending" or instance.status not in ("approved", "rejected"):
        return
    decider = db.scalar(select(ApprovalDecision.approver_id).where(ApprovalDecision.instance_id == instance.id)
                        .order_by(ApprovalDecision.id.desc()))
    if instance.status == "rejected":
        req.status = "rejected"
        record_audit(db, actor_id=decider, action="letter_rejected", entity="letter_request", entity_id=req.id,
                     subject_id=req.employee_id, before={"status": "pending"}, after={"status": "rejected"})
        return
    try:
        issue(db, req, decider, decider)
    except LetterError as exc:
        req.status, req.issue_error = "approved", str(exc)
        record_audit(db, actor_id=decider, action="letter_approved", entity="letter_request", entity_id=req.id,
                     subject_id=req.employee_id, before={"status": "pending"}, after={"status": "approved", "error": str(exc)})

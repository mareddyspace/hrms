"""Official PDFs: a payslip from a locked payroll run, and a benefit plan summary (reportlab, as letters are)."""

from __future__ import annotations

import io
from datetime import date
from typing import Any
from xml.sax.saxutils import escape

from app.services.letters import ENTITY_ADDRESS


def _money(amount: float, currency: str) -> str:
    return f"{currency} {amount:,.2f}"


def _styles() -> dict[str, Any]:
    from reportlab.lib import colors
    from reportlab.lib.styles import ParagraphStyle

    navy = colors.HexColor("#1d3d6e")
    return {
        "navy": navy,
        "head": ParagraphStyle("head", fontName="Helvetica-Bold", fontSize=16, leading=20, textColor=navy),
        "small": ParagraphStyle("small", fontName="Helvetica", fontSize=8.5, leading=11, textColor=colors.HexColor("#555555")),
        "h1": ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=13, leading=17, spaceBefore=6, spaceAfter=8),
        "h2": ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=10.5, leading=14, spaceBefore=8, spaceAfter=4, textColor=navy),
        "body": ParagraphStyle("body", fontName="Helvetica", fontSize=9.5, leading=13),
    }


def _table(rows: list[list[str]], widths: list[Any], bold_last: bool = False, header: bool = False) -> Any:
    from reportlab.lib import colors
    from reportlab.platypus import Table, TableStyle

    t = Table(rows, colWidths=widths)
    style = [("FONT", (0, 0), (-1, -1), "Helvetica", 9), ("ALIGN", (-1, 0), (-1, -1), "RIGHT"),
             ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#dddddd")),
             ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
    if bold_last:
        style.append(("FONT", (0, -1), (-1, -1), "Helvetica-Bold", 9))
    if header:
        style += [("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef2f8"))]
    t.setStyle(TableStyle(style))
    return t


def _letterhead(entity: str, country: str, s: dict[str, Any]) -> list[Any]:
    from reportlab.platypus import HRFlowable, Paragraph

    return [Paragraph("TimeZ", s["head"]),
            Paragraph(f"{escape(entity)} · {escape(ENTITY_ADDRESS.get(country, ENTITY_ADDRESS['IN']))}", s["small"]),
            HRFlowable(width="100%", thickness=1.5, color=s["navy"], spaceBefore=4, spaceAfter=8)]


def payslip_pdf(*, emp: Any, month: str, currency: str, legal_entity: str, payday: date | None, run_id: str,
                approved_on: date | None, line: Any) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    s = _styles()
    slip: dict[str, Any] = line.slip or {}
    y, m = int(month[:4]), int(month[5:7])
    title = f"Payslip {date(y, m, 1):%B %Y}"
    story: list[Any] = _letterhead(legal_entity, emp.country_code, s)
    story.append(Paragraph(f"{escape(title)} · FINAL (locked payroll run)", s["h1"]))
    facts = [
        ["Employee", f"{emp.full_name} ({emp.employee_code})", "Pay period", f"{date(y, m, 1):%d %b %Y} – {date(y, m, line.days_in_month):%d %b %Y}"],
        ["Department", emp.department or "—", "Payment date", f"{payday:%d %b %Y}" if payday else "—"],
        ["Designation", emp.job_title or "—", "Days paid", f"{line.paid_days:g} of {line.days_in_month}"],
        ["Country", emp.country_code, "Currency", currency],
    ]
    t = _table(facts, [28 * mm, 60 * mm, 28 * mm, 58 * mm])
    from reportlab.platypus import TableStyle

    t.setStyle(TableStyle([("ALIGN", (-1, 0), (-1, -1), "LEFT"), ("FONT", (0, 0), (0, -1), "Helvetica-Bold", 9),
                           ("FONT", (2, 0), (2, -1), "Helvetica-Bold", 9)]))
    story.append(t)

    def section(name: str, items: list[dict[str, Any]], total_name: str) -> None:
        rows = [[str(i.get("name", "")), _money(float(i.get("amount") or 0), currency)] for i in items if float(i.get("amount") or 0)]
        if not rows:
            rows = [["None", _money(0, currency)]]
        rows.append([total_name, _money(sum(float(i.get("amount") or 0) for i in items), currency)])
        story.append(Paragraph(name, s["h2"]))
        story.append(_table(rows, [120 * mm, 54 * mm], bold_last=True))

    section("Earnings", line.earnings, "Gross pay")
    section("Deductions", line.deductions, "Total deductions")
    story.append(Spacer(1, 6))
    story.append(_table([["NET PAY", _money(line.net, currency)]], [120 * mm, 54 * mm], bold_last=True))
    if line.employer:
        section("Employer contributions (not deducted from your pay)", line.employer, "Total employer contributions")
    tax = slip.get("tax") if isinstance(slip.get("tax"), dict) else None
    if tax:
        story.append(Paragraph(f"Tax computation · {escape(str(tax.get('taxYear', '')))}", s["h2"]))
        rows = [["Basis", str(tax.get("basis", ""))],
                ["Annual gross (annualised)", _money(float(tax.get("annualGross") or 0), currency)]]
        rows += [[f"Less {r.get('name')}", _money(float(r.get("amount") or 0), currency)] for r in tax.get("reliefs") or []]
        rows += [["Annual taxable income", _money(float(tax.get("annualTaxable") or 0), currency)],
                 ["Annual tax", _money(float(tax.get("annualTax") or 0), currency)],
                 ["Tax this month", _money(float(tax.get("monthTax") or 0), currency)]]
        story.append(_table(rows, [120 * mm, 54 * mm]))
    ytd = slip.get("ytd") if isinstance(slip.get("ytd"), dict) else None
    if ytd:
        story.append(Paragraph(f"Year to date · {escape(str(ytd.get('taxYear', '')))}", s["h2"]))
        story.append(_table([["Gross", "Tax", "Net"],
                             [_money(float(ytd.get("gross") or 0), currency), _money(float(ytd.get("tax") or 0), currency),
                              _money(float(ytd.get("net") or 0), currency)]], [58 * mm, 58 * mm, 58 * mm], header=True))
    story += [Spacer(1, 14), Paragraph(
        f"Final figures from payroll run {escape(run_id)}" + (f", approved and locked on {approved_on:%d %b %Y}" if approved_on else "")
        + ". This is a computer-generated payslip and needs no signature. Confidential.", s["small"])]
    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                      title=title, author=legal_entity, subject="Payslip").build(story)
    return buf.getvalue()


def plan_pdf(*, plan: Any, eligibility: list[str], country_name: str) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    s = _styles()
    entity = plan.legal_entity or f"All TimeZ entities in {country_name}"
    story: list[Any] = _letterhead(entity, plan.country_code, s)
    story.append(Paragraph(f"{escape(plan.name)} · plan summary", s["h1"]))
    facts = [["Plan type", plan.plan_type], ["Provider", plan.provider], ["Country", country_name],
             ["Employee contribution", plan.employee_cost or "—"],
             ["Employer contribution", f"{plan.currency} {float(plan.employer_annual_cost or 0):,.0f} a year per member"
              if plan.employer_annual_cost else "—"],
             ["Dependents", "Can be covered" if plan.covers_dependents else "Employee only"],
             ["Enrollment", "Statutory (automatic)" if plan.mandatory else "Automatic" if plan.auto_enrolled else "On request"]]
    t = _table(facts, [50 * mm, 124 * mm])
    from reportlab.platypus import TableStyle

    t.setStyle(TableStyle([("ALIGN", (-1, 0), (-1, -1), "LEFT"), ("FONT", (0, 0), (0, -1), "Helvetica-Bold", 9)]))
    story.append(t)
    for heading, text in (("Summary", plan.summary), ("Coverage", plan.coverage), ("Terms", plan.terms)):
        if text:
            story.append(Paragraph(heading, s["h2"]))
            story += [Paragraph(escape(p), s["body"]) for p in str(text).split("\n") if p.strip()]
    story.append(Paragraph("Who can join", s["h2"]))
    story += [Paragraph(f"• {escape(r)}", s["body"]) for r in eligibility] or [Paragraph("Everyone in the country.", s["body"])]
    story += [Spacer(1, 14), Paragraph("Summary for information. The provider's policy wording prevails.", s["small"])]
    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                      title=f"{plan.name} plan summary", author="TimeZ", subject="Benefit plan").build(story)
    return buf.getvalue()

"""Benefit plan details (coverage, terms), tax declaration deadlines and a few sample declarations (migration 0026).

Insert-once / fill-if-empty: safe to run on an existing database.
"""

from __future__ import annotations

import hashlib
import io
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import BenefitPlan, Employee, TaxDeclaration, TaxDeclarationDocument, TaxDeclarationWindow
from app.services import tax_declarations as decl

PLAN_DETAILS: dict[str, tuple[str, str]] = {
    "bp-in-med": ("Hospitalisation up to ₹5,00,000 a year per family (floater) for you, your spouse and up to two children. "
                  "Cashless at network hospitals; pre- and post-hospitalisation 30/60 days; maternity ₹50,000.",
                  "Cover runs from the enrollment date to 31 March. Dependents must be verified by HR. Pre-existing conditions "
                  "covered from day one. Claims within 30 days of discharge."),
    "bp-in-pf": ("Employee 12% of basic + employer 12% of basic (3.67% to EPF, 8.33% to EPS). Interest as declared by EPFO.",
                 "Statutory under the EPF Act. Withdrawals and transfers through the EPFO member portal (UAN)."),
    "bp-in-life": ("Life cover of 3 × annual base salary; accidental death benefit of an equal amount.",
                   "Cover ends on your last working day. Nominee as recorded under Dependents › Nominees."),
    "bp-in-nps": ("Employer contribution of 10% of basic to your NPS Tier I account (tax-free under 80CCD(2)).",
                  "Senior grades after 12 months of service. You need a PRAN; Tier II top-ups are voluntary."),
    "bp-us-med": ("PPO network: $500 individual / $1,500 family deductible, 80% coinsurance, $4,000 out-of-pocket max.",
                  "Elections hold for the plan year (Jan–Dec) unless you have a qualifying life event."),
    "bp-us-401": ("Employer matches 100% of the first 4% you defer; immediate vesting of your deferrals, match vests over 3 years.",
                  "Change your deferral rate any payroll; IRS limits apply."),
    "bp-uk-med": ("Inpatient and outpatient treatment, cancer cover, mental health; optional partner and children.",
                  "Benefit-in-kind is reported on your P11D. 12-month moratorium on pre-existing conditions."),
    "bp-uk-pen": ("Employer 3% and employee 5% of qualifying earnings (salary sacrifice available).",
                  "Automatic enrolment; you may opt out within one month of being enrolled."),
    "bp-ae-med": ("DHA essential benefits plus outpatient, dental emergency and maternity; dependents covered.",
                  "Mandatory for all employees in Dubai; card issued within 10 working days."),
    "bp-ae-life": ("Life cover of 24 months of base salary, worldwide, 24 hours.", "Cover ends on your last working day."),
    "bp-au-super": ("Superannuation guarantee at 12% of ordinary time earnings, paid quarterly to your chosen fund.",
                    "Choose your fund on joining; salary sacrifice counts toward the concessional cap."),
    "bp-au-med": ("Hospital (gold tier) and extras: dental, optical, physio.", "Waiting periods waived for employees who join within 60 days."),
    "bp-ca-health": ("Prescription drugs 80%, dental basic 80% / major 50%, vision $300 every two years.",
                     "Coverage starts after 3 months of service; dependents to age 21 (25 if a student)."),
    "bp-ca-rrsp": ("Employer matches up to 4% of salary into a group RRSP.", "Contributions reduce taxable income within your RRSP room."),
    "bp-sa-med": ("CCHI essential benefits plus outpatient and maternity; dependents covered.", "Mandatory for all employees in Saudi Arabia."),
    "bp-sa-gosi": ("Saudi nationals: annuities and occupational hazards; others: occupational hazards.", "Statutory under the GOSI law."),
    "bp-de-health": ("Statutory health insurance (GKV) with the employer paying half of the contribution.", "Statutory; family members insured free."),
    "bp-de-bav": ("Deferred compensation into a Pensionskasse with a 15% employer top-up.", "Tax- and social-security-free up to the legal limits."),
}

SAMPLE_PROOF_NAME = "elss-statement-2026.pdf"


def _sample_pdf(text: str) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 12)
    c.drawString(72, 760, text)
    c.drawString(72, 740, "Sample proof generated for the TimeZ demo.")
    c.save()
    return buf.getvalue()


def seed(db: Session) -> dict[str, int]:
    stats = {"benefit_plan_details": 0, "tax_decl_windows": 0, "tax_declarations": 0}
    for plan in db.scalars(select(BenefitPlan)):
        details = PLAN_DETAILS.get(plan.id)
        if details and not plan.coverage and not plan.terms:
            plan.coverage, plan.terms = details
            stats["benefit_plan_details"] += 1
        if plan.id == "bp-in-med" and not plan.legal_entity:
            plan.legal_entity = "TimeZ India Pvt Ltd"

    today = date.today()
    for country in decl.SECTIONS:
        for label, start in decl.declarable_years(country, today)[:1]:
            exists = db.scalar(select(TaxDeclarationWindow.id).where(TaxDeclarationWindow.country_code == country,
                                                                     TaxDeclarationWindow.financial_year == label))
            if exists:
                continue
            first, last = decl.year_bounds(country, start)
            # Declarations close two months before the year ends (India: by mid-January for the March payroll).
            deadline = max(today + timedelta(days=20), last - timedelta(days=75))
            db.add(TaxDeclarationWindow(id=f"tdw-{country.lower()}-{start}", country_code=country, financial_year=label,
                                        opens_on=first, deadline=deadline, proof_deadline=max(deadline, last - timedelta(days=45)),
                                        locked=False))
            stats["tax_decl_windows"] += 1

    babu = db.get(Employee, "emp-mahesh")
    if babu is not None and babu.country_code == "IN":
        fy, _ = decl.declarable_years("IN", today)[0]
        samples: list[dict[str, Any]] = [
            {"id": "td-seed-1", "section": "80C", "title": "ELSS mutual fund", "amount": 50000, "status": "verified",
             "verified_amount": 50000, "decision_note": "Statement matches the folio.", "doc": True},
            {"id": "td-seed-2", "section": "80D", "title": "Health insurance premium (family)", "amount": 18000, "status": "submitted",
             "doc": True},
            {"id": "td-seed-3", "section": "HRA", "title": "Rent — Kochi flat (Apr–Mar)", "amount": 180000, "status": "draft"},
        ]
        from app.seed_repairs import align_tax_regime

        align_tax_regime(babu)  # 80C / 80D / HRA are old-regime deductions: the profile shows the same regime
        for s in samples:
            if db.get(TaxDeclaration, s["id"]) is not None:
                continue
            now = utcnow()
            item = TaxDeclaration(id=s["id"], employee_id=babu.id, country_code="IN", financial_year=fy, regime="old",
                                  section=s["section"], title=s["title"], amount=s["amount"], currency="INR", status=s["status"],
                                  verified_amount=s.get("verified_amount"),
                                  submitted_at=now if s["status"] != "draft" else None,
                                  decided_by="demo-hr-admin" if s["status"] == "verified" else None,
                                  decided_at=now if s["status"] == "verified" else None,
                                  decision_note=s.get("decision_note"),
                                  history=[{"at": now.isoformat(), "by": babu.id, "action": "Saved as draft"}]
                                  + ([{"at": now.isoformat(), "by": babu.id, "action": "Submitted for verification"}]
                                     if s["status"] != "draft" else [])
                                  + ([{"at": now.isoformat(), "by": "demo-hr-admin", "action": "Verified", "note": s.get("decision_note")}]
                                     if s["status"] == "verified" else []))
            db.add(item)
            db.flush()
            if s.get("doc"):
                try:
                    from app.services import storage

                    data = _sample_pdf(f"{s['title']} · {fy}")
                    stored = storage.save(f"tax-declarations/{babu.id}", f"{s['id']}-proof", data, "application/pdf",
                                          hashlib.sha256(data).hexdigest())
                    db.add(TaxDeclarationDocument(id=f"{s['id']}-proof", declaration_id=item.id, file_name=SAMPLE_PROOF_NAME
                                                  if s["section"] == "80C" else "premium-receipt.pdf", content_type="application/pdf",
                                                  size_bytes=stored.size_bytes, sha256=stored.sha256,
                                                  storage_path=stored.relative_path, uploaded_by=babu.id, uploaded_at=now))
                except Exception:  # noqa: BLE001 - storage not configured: the item is still useful without its file
                    pass
            stats["tax_declarations"] += 1
    db.flush()
    return stats

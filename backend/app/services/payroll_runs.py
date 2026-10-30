"""Monthly payroll runs per month + country + legal entity (migration 0023).

Draft -> Review -> Locked. HR / payroll prepares and sends for review; a second person (finance, the executive or
another HR in scope; never the one who prepared or sent it) approves, which locks the run. A locked run never
changes.

Pay visibility: the admin is a system administrator and has no access to payroll runs at all. Per-person lines and
the register CSV are for HR / payroll in scope (and an approver whose account holds the compensation grant,
access_scopes.comp_access, as in app/services/compensation.py). Other approvers (the CEO / executive, finance) see
run totals only: headcount, gross, deductions, net, exception counts and per-department totals. The bank file
(account numbers) is for HR / payroll in scope only. Employees' payslips for a locked month come from the run (GET /payroll/my-slips); other months still use
the portal's payslip generator.

Who is paid: people in the country and legal entity who have started by the month end and had not left before it
started. The server works out each person's inputs (inputs()); the payslip itself (gross, tax, PF / NI / ...) is
worked out in the browser by the same code as the payslips (src/data/payslipGenerator.ts) and sent with prepare().
prepare() checks those lines against the server's own inputs (overtime, reimbursements, cash advance recovery,
leave encashment, unpaid leave) and works out totals, flags and exceptions itself.
"""

from __future__ import annotations

import csv
import hashlib
import io
import uuid
from calendar import monthrange
from datetime import date, timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import (
    Account, CashAdvance, Country, Employee, EmployeeBankDetail, EncashmentRequest, ExpenseClaim, LeaveRequest,
    OvertimeRequest, PayrollRun, PayrollRunLine,
)
from app.services import overtime as overtime_rules
from app.services import self_service
from app.services.activity import notify, record_audit
from app.services.headcount import PRE_START_STATUSES
from app.services.leave import holiday_dates_for, weekly_off_for_employee, working_days
from app.services.scope import HR_ROLES, Scope

PAYROLL_ROLES = HR_ROLES | {"payroll"}  # do payroll: prepare, see each person's pay, export the register and bank file
PREPARE_ROLES = PAYROLL_ROLES
APPROVE_ROLES = PAYROLL_ROLES | {"finance", "executive"}
VIEW_ROLES = PREPARE_ROLES | APPROVE_ROLES
BANK_ROLES = PAYROLL_ROLES
TOLERANCE = 1.0  # rounding between the browser and the server, in currency units

OVERTIME_LINE = "Overtime pay"
REIMBURSEMENT_LINE = "Reimbursements"
ENCASHMENT_LINE = "Leave encashment payout"
CASH_LINE = "Cash advance recovery"

FLAG_TEXT = {
    "missing_bank": "No bank details: pay is held",
    "negative_net": "Net pay below zero",
    "new_joiner": "New joiner",
    "leaver": "Leaver",
}


class RunError(ValueError):
    """A rule was broken (422, or 409 when the message says "already" / "locked"); safe to show the user."""


def month_bounds(month: str) -> tuple[date, date]:
    try:
        y, m = (int(x) for x in month.split("-"))
        return date(y, m, 1), date(y, m, monthrange(y, m)[1])
    except (ValueError, TypeError) as exc:
        raise RunError("Use a month like 2026-10.") from exc


def payday(month: str, country: str) -> date:
    """The last working day of the month (as paydayFor in src/data/payslipGenerator.ts)."""
    _, end = month_bounds(month)
    weekend = {4, 5} if country == "SA" else {5, 6}
    while end.weekday() in weekend:
        end -= timedelta(days=1)
    return end


def country_ok(scope: Scope, role: str, country: str) -> bool:
    if role not in VIEW_ROLES:
        return False  # admin and everyone else: no payroll runs
    if role == "finance":
        return True
    # org_wide: the executive approves whole-country runs (totals only), though his HR data scope is his line only.
    return (scope.is_global or scope.org_wide) and (not scope.countries or country in scope.countries)


def can_see_lines(db: Session, user: Any) -> bool:
    """Each person's pay in a run (lines, register CSV): HR / payroll, or an approver holding the compensation grant."""
    from app.services.compensation import has_comp_flag

    role = user.account.role
    return role in PAYROLL_ROLES or (role in APPROVE_ROLES and has_comp_flag(db, user))


def can_export_bank(user: Any) -> bool:
    """The bank transfer file (account numbers): HR / payroll only."""
    return user.account.role in BANK_ROLES


def department_totals(db: Session, run: PayrollRun) -> list[dict[str, Any]]:
    """Run totals per department (aggregates the totals-only approvers may see)."""
    lines = lines_of(db, run)
    depts = dict(db.execute(select(Employee.id, Employee.department)
                            .where(Employee.id.in_([l.employee_id for l in lines] or [""]))).all())
    groups: dict[str, dict[str, Any]] = {}
    for l in lines:
        name = depts.get(l.employee_id) or "Not set"
        g = groups.setdefault(name, {"department": name, "headcount": 0, "gross": 0.0, "deductions": 0.0, "net": 0.0})
        g["headcount"] += 1
        g["gross"] += l.gross
        g["deductions"] += l.deductions_total
        g["net"] += l.net
    return [{**g, "gross": round(g["gross"], 2), "deductions": round(g["deductions"], 2), "net": round(g["net"], 2)}
            for g in sorted(groups.values(), key=lambda g: g["department"])]


def population(db: Session, country: str, entity: str, month: str) -> list[Employee]:
    start, end = month_bounds(month)
    rows = db.scalars(select(Employee).where(
        Employee.country_code == country, Employee.legal_entity == entity, Employee.joining_date <= end,
        or_(Employee.last_working_day.is_(None), Employee.last_working_day >= start),
    ).order_by(Employee.employee_code))
    out = []
    for emp in rows:
        status = (emp.employment_status or "").strip().lower()
        if status in PRE_START_STATUSES:
            continue
        if status in ("terminated", "exited") and (emp.last_working_day is None or emp.last_working_day < start):
            continue
        out.append(emp)
    return out


def _mask(number: str) -> str:
    return f"•••• {number[-4:]}" if number else ""


def _lwp_days(db: Session, emp: Employee, start: date, end: date) -> float:
    total = 0.0
    for r in db.scalars(select(LeaveRequest).where(
            LeaveRequest.employee_id == emp.id, LeaveRequest.leave_code == "unpaid", LeaveRequest.status == "approved",
            LeaveRequest.from_date <= end, LeaveRequest.to_date >= start)):
        a, b = max(r.from_date, start), min(r.to_date, end)
        half = r.half if r.from_date == r.to_date else "none"
        total += working_days(a, b, holiday_dates_for(db, emp, a, b), half, weekly_off=weekly_off_for_employee(db, emp))
    return total


def inputs(db: Session, country: str, entity: str, month: str) -> list[dict[str, Any]]:
    """Each person's input pack, before the payslip is worked out."""
    start, end = month_bounds(month)
    people = population(db, country, entity, month)
    ids = [e.id for e in people]
    roles = dict(db.execute(select(Account.employee_id, Account.role).where(Account.employee_id.in_(ids or [""]))).all())
    banks = {b.employee_id: b for b in db.scalars(select(EmployeeBankDetail).where(EmployeeBankDetail.employee_id.in_(ids or [""])))}
    overtime = overtime_rules.payable(db, ids, month)
    claims: dict[str, list[ExpenseClaim]] = {}
    for c in db.scalars(select(ExpenseClaim).where(ExpenseClaim.employee_id.in_(ids or [""]), ExpenseClaim.status == "approved",
                                                   ExpenseClaim.expense_date <= end)):
        claims.setdefault(c.employee_id, []).append(c)
    encash: dict[str, list[EncashmentRequest]] = {}
    for r in db.scalars(select(EncashmentRequest).where(EncashmentRequest.employee_id.in_(ids or [""]),
                                                        EncashmentRequest.status == "Approved",
                                                        EncashmentRequest.payout_month == month)):
        encash.setdefault(r.employee_id, []).append(r)
    cash: dict[str, list[dict[str, Any]]] = {}
    for adv in db.scalars(select(CashAdvance).where(CashAdvance.employee_id.in_(ids or [""]), CashAdvance.status == "Paid")):
        plan = self_service.schedule(adv, end)
        for i, inst in enumerate(plan):
            if inst["month"] == month:
                name = f"{CASH_LINE} ({i + 1} of {len(plan)})" if len(plan) > 1 else CASH_LINE
                cash.setdefault(adv.employee_id, []).append({"name": name, "amount": inst["amount"]})
    from app.models import CompensationRecord

    out = []
    for emp in people:
        comp = db.scalar(select(CompensationRecord).where(CompensationRecord.employee_id == emp.id,
                                                          CompensationRecord.effective_date <= end)
                         .order_by(CompensationRecord.effective_date.desc()).limit(1))
        ot = overtime.get(emp.id, [])
        mine = [c for c in claims.get(emp.id, []) if c.currency == emp.currency]
        enc = encash.get(emp.id, [])
        bank = banks.get(emp.id)
        lwd = emp.last_working_day if emp.last_working_day and emp.last_working_day <= end else None
        out.append({
            "employee_id": emp.id, "employee_code": emp.employee_code, "name": emp.full_name,
            "role": roles.get(emp.id, "employee"), "country_code": emp.country_code, "legal_entity": emp.legal_entity,
            "location": emp.location, "nationality": emp.nationality, "employment_status": emp.employment_status,
            "employment_type": emp.employment_type, "joining_date": emp.joining_date, "last_working_day": lwd,
            "tax_regime": emp.tax_regime or "new", "currency": emp.currency,
            "annual_base": float(comp.base_salary) if comp and comp.currency == emp.currency else None,
            "days_in_month": (end - start).days + 1,
            "lwp_days": _lwp_days(db, emp, max(start, emp.joining_date), min(end, lwd or end)),
            "reimbursements": round(sum(float(c.amount) for c in mine), 2), "reimbursement_count": len(mine),
            "cash_recovery": cash.get(emp.id, []),
            "encashment": round(sum(r.amount for r in enc), 2), "encashment_days": sum(r.days for r in enc),
            "overtime_hours": sum(r.hours for r in ot), "overtime_pay": round(sum(r.amount for r in ot), 2),
            "bank_ok": bank is not None, "bank_masked": _mask(bank.account_number) if bank else None,
            "new_joiner": start <= emp.joining_date <= end, "leaver": lwd is not None,
        })
    return out


def _sum(lines: list[dict[str, Any]], prefix: str | None = None) -> float:
    return round(sum(float(l.get("amount") or 0) for l in lines if prefix is None or str(l.get("name", "")).startswith(prefix)), 2)


def _clean(lines: Any) -> list[dict[str, Any]]:
    if not isinstance(lines, list):
        raise RunError("Each line needs earnings and deductions.")
    out = []
    for l in lines[:60]:
        if not isinstance(l, dict) or not str(l.get("name", "")).strip():
            raise RunError("Each pay line needs a name and an amount.")
        amount = float(l.get("amount") or 0)
        if amount != amount or abs(amount) > 1e10:  # NaN or absurd
            raise RunError("A pay line amount is not a number.")
        out.append({"name": str(l["name"]).strip()[:120], "amount": round(amount, 2)})
    return out


def _check(name: str, label: str, got: float, want: float) -> None:
    if abs(got - want) > TOLERANCE:
        raise RunError(f"{name}: {label} is {got:,.0f} but should be {want:,.0f}. Prepare again.")


def get_run(db: Session, country: str, entity: str, month: str) -> PayrollRun | None:
    return db.scalar(select(PayrollRun).where(PayrollRun.month == month, PayrollRun.country_code == country,
                                              PayrollRun.legal_entity == entity))


def lines_of(db: Session, run: PayrollRun) -> list[PayrollRunLine]:
    return list(db.scalars(select(PayrollRunLine).where(PayrollRunLine.run_id == run.id).order_by(PayrollRunLine.employee_code)))


def prepare(db: Session, country: str, entity: str, month: str, lines: list[dict[str, Any]], actor_id: str,
            ip: str | None) -> PayrollRun:
    start, end = month_bounds(month)
    c = db.get(Country, country)
    if c is None:
        raise RunError("Unknown country.")
    run = get_run(db, country, entity, month)
    if run is not None and run.status != "draft":
        raise RunError(f"This run is already {'locked' if run.status == 'locked' else 'in review'}; it can't change.")
    pack = {p["employee_id"]: p for p in inputs(db, country, entity, month)}
    if not pack:
        raise RunError("Nobody is on the payroll for this country and entity in that month.")
    sent = {str(l.get("employee_id")): l for l in lines}
    unknown = set(sent) - set(pack)
    if unknown:
        raise RunError(f"{len(unknown)} line(s) are for people not on this payroll. Prepare again.")
    missing = set(pack) - set(sent)
    if missing:
        raise RunError(f"{len(missing)} people are missing from the run. Prepare again.")
    if run is None:
        run = PayrollRun(id=f"pr-{uuid.uuid4().hex[:12]}", month=month, country_code=country, legal_entity=entity,
                         currency=c.currency, status="draft", headcount=0, totals={}, exceptions=[])
        db.add(run)
        db.flush()
    else:
        for old in lines_of(db, run):
            db.delete(old)
        db.flush()
    totals = {k: 0.0 for k in ("gross", "deductions", "net", "employer", "reimbursements", "overtime", "cash_recovery",
                               "encashment", "bank_total")}
    totals["held"] = 0
    exceptions: list[dict[str, Any]] = []
    for emp_id, p in pack.items():
        raw = sent[emp_id]
        earnings, deductions = _clean(raw.get("earnings")), _clean(raw.get("deductions"))
        employer = _clean(raw.get("employer") or [])
        name = p["name"]
        _check(name, "overtime pay", _sum(earnings, OVERTIME_LINE), p["overtime_pay"])
        _check(name, "reimbursements", _sum(earnings, REIMBURSEMENT_LINE), p["reimbursements"])
        _check(name, "leave encashment", _sum(earnings, ENCASHMENT_LINE), p["encashment"])
        _check(name, "cash advance recovery", _sum(deductions, CASH_LINE), _sum(p["cash_recovery"]))
        lwp = float(raw.get("lwp_days") or 0)
        if abs(lwp - p["lwp_days"]) > 0.01:
            raise RunError(f"{name}: unpaid leave is {lwp:g} days but should be {p['lwp_days']:g}. Prepare again.")
        paid_days = float(raw.get("paid_days") or 0)
        if not 0 <= paid_days <= p["days_in_month"]:
            raise RunError(f"{name}: paid days must be 0 to {p['days_in_month']}.")
        gross, ded = _sum(earnings), _sum(deductions)
        net = round(gross - ded, 2)
        flags = [f for f, on in (("missing_bank", not p["bank_ok"]), ("negative_net", net < 0),
                                 ("new_joiner", p["new_joiner"]), ("leaver", p["leaver"])) if on]
        slip = raw.get("slip") if isinstance(raw.get("slip"), dict) else None
        db.add(PayrollRunLine(
            run_id=run.id, employee_id=emp_id, employee_name=name, employee_code=p["employee_code"],
            days_in_month=p["days_in_month"], paid_days=paid_days, lwp_days=p["lwp_days"], gross=gross,
            deductions_total=ded, net=net, earnings=earnings, deductions=deductions, employer=employer,
            reimbursements=p["reimbursements"], cash_recovery=_sum(p["cash_recovery"]), encashment=p["encashment"],
            overtime_hours=p["overtime_hours"], overtime_pay=p["overtime_pay"], bank_ok=p["bank_ok"], flags=flags,
            slip=slip,
        ))
        totals["gross"] += gross
        totals["deductions"] += ded
        totals["net"] += net
        totals["employer"] += _sum(employer)
        totals["reimbursements"] += p["reimbursements"]
        totals["overtime"] += p["overtime_pay"]
        totals["cash_recovery"] += _sum(p["cash_recovery"])
        totals["encashment"] += p["encashment"]
        if p["bank_ok"] and net > 0:
            totals["bank_total"] += net
        elif not p["bank_ok"]:
            totals["held"] += 1
        for f in flags:
            exceptions.append({"employee_id": emp_id, "name": name, "kind": f, "text": FLAG_TEXT[f]})
    run.headcount = len(pack)
    run.totals = {k: round(v, 2) if isinstance(v, float) else v for k, v in totals.items()}
    run.exceptions = exceptions
    run.prepared_by = actor_id
    run.prepared_at = utcnow()
    run.returned_note = None
    run.payday = payday(month, country)
    db.flush()
    record_audit(db, actor_id=actor_id, action="payroll_prepared", entity="payroll_runs", entity_id=run.id,
                 after={"month": month, "country": country, "entity": entity, "headcount": run.headcount,
                        "net": run.totals["net"], "exceptions": len(exceptions)}, ip=ip)
    return run


def drift(db: Session, run: PayrollRun) -> list[str]:
    """People whose inputs changed since the run was prepared (new overtime, claims, leave, joiners...)."""
    pack = {p["employee_id"]: p for p in inputs(db, run.country_code, run.legal_entity, run.month)}
    lines = {l.employee_id: l for l in lines_of(db, run)}
    names = [p["name"] for i, p in pack.items() if i not in lines]
    names += [l.employee_name for i, l in lines.items() if i not in pack]
    for i, l in lines.items():
        p = pack.get(i)
        if p is None:
            continue
        if any(abs(a - b) > TOLERANCE for a, b in (
                (l.overtime_pay, p["overtime_pay"]), (l.reimbursements, p["reimbursements"]),
                (l.encashment, p["encashment"]), (l.cash_recovery, _sum(p["cash_recovery"]))))                 or abs(l.lwp_days - p["lwp_days"]) > 0.01 or l.bank_ok != p["bank_ok"]:
            names.append(l.employee_name)
    return names


def _drift_error(names: list[str], action: str) -> RunError:
    who = ", ".join(names[:3]) + (f" and {len(names) - 3} more" if len(names) > 3 else "")
    return RunError(f"Inputs changed since the run was prepared ({who}). {action}")


def _approver_ids(db: Session, exclude: set[str]) -> list[str]:
    return [e for e in db.scalars(select(Account.employee_id).where(Account.role.in_(APPROVE_ROLES), Account.active.is_(True),
                                                                   Account.employee_id.is_not(None))) if e not in exclude]


def label(run: PayrollRun) -> str:
    start, _ = month_bounds(run.month)
    return f"{start:%B %Y} · {run.legal_entity}"


def submit(db: Session, run: PayrollRun, actor_id: str, actor_employee_id: str | None, ip: str | None) -> None:
    if run.status != "draft":
        raise RunError(f"This run is already {'locked' if run.status == 'locked' else 'in review'}.")
    if not run.headcount:
        raise RunError("Prepare the run first.")
    if changed := drift(db, run):
        raise _drift_error(changed, "Prepare again.")
    run.status = "review"
    run.submitted_by = actor_id
    run.submitted_at = utcnow()
    record_audit(db, actor_id=actor_id, action="payroll_submitted", entity="payroll_runs", entity_id=run.id,
                 after={"status": "review"}, ip=ip)
    preparer = db.scalar(select(Account.employee_id).where(Account.id == run.prepared_by))
    for rid in _approver_ids(db, {actor_employee_id or "", preparer or ""}):
        notify(db, recipient_id=rid, title=f"Approve payroll · {label(run)}",
               body=f"{run.headcount} people, net {run.totals.get('net', 0):,.0f} {run.currency}.", href="/payroll")


def send_back(db: Session, run: PayrollRun, actor_id: str, note: str, ip: str | None) -> None:
    if run.status != "review":
        raise RunError("Only a run in review can be sent back." if run.status == "draft" else "This run is already locked.")
    if not note.strip():
        raise RunError("Add a note saying what to fix.")
    if actor_id in (run.prepared_by, run.submitted_by):
        raise RunError("A second person reviews the run; you prepared or sent it.")
    run.status = "draft"
    run.returned_note = note.strip()[:1000]
    record_audit(db, actor_id=actor_id, action="payroll_sent_back", entity="payroll_runs", entity_id=run.id,
                 after={"status": "draft", "note": run.returned_note}, ip=ip)
    for acc in {run.prepared_by, run.submitted_by} - {None}:
        emp_id = db.scalar(select(Account.employee_id).where(Account.id == acc))
        if emp_id:
            notify(db, recipient_id=emp_id, title=f"Payroll sent back · {label(run)}", body=run.returned_note, href="/payroll")


def approve(db: Session, run: PayrollRun, actor_id: str, ip: str | None) -> None:
    """The second person approves: the run locks, paid overtime and reimbursements are marked paid, payslips go out."""
    if run.status == "locked":
        raise RunError("This run is already locked.")
    if run.status != "review":
        raise RunError("Send the run for review first.")
    if actor_id in (run.prepared_by, run.submitted_by):
        raise RunError("A second person approves the run; you prepared or sent it.")
    if changed := drift(db, run):
        raise _drift_error(changed, "Send it back to be prepared again.")
    lines = lines_of(db, run)
    ids = [l.employee_id for l in lines]
    _, end = month_bounds(run.month)
    paid_on = run.payday or payday(run.month, run.country_code)
    for row in overtime_rules.payable(db, ids, run.month).values():
        for ot in row:
            ot.paid_run_id = run.id
    with_claims = {l.employee_id for l in lines if l.reimbursements}
    for c in db.scalars(select(ExpenseClaim).where(ExpenseClaim.employee_id.in_(with_claims or {""}),
                                                   ExpenseClaim.status == "approved", ExpenseClaim.expense_date <= end)):
        emp = db.get(Employee, c.employee_id)
        if emp is not None and c.currency == emp.currency:
            c.status = "paid"
            c.paid_on = paid_on
            c.payment_reference = f"Payroll {run.month}"
            c.paid_by = actor_id
    run.status = "locked"
    run.approved_by = actor_id
    run.approved_at = utcnow()
    record_audit(db, actor_id=actor_id, action="payroll_approved_locked", entity="payroll_runs", entity_id=run.id,
                 after={"status": "locked", "headcount": run.headcount, "net": run.totals.get("net")}, ip=ip)
    start, _ = month_bounds(run.month)
    for l in lines:
        notify(db, recipient_id=l.employee_id, title=f"Payslip for {start:%B %Y}",
               body=f"Paid on {paid_on:%d %b %Y}." if l.bank_ok else "Your pay is held: add your bank details with HR.",
               href="/payslips")


def register_csv(run: PayrollRun, lines: list[PayrollRunLine]) -> str:
    earn_names = list(dict.fromkeys(e["name"] for l in lines for e in l.earnings))
    ded_names = list(dict.fromkeys(d["name"] for l in lines for d in l.deductions))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Employee code", "Name", "Days in month", "Paid days", "Unpaid leave days", *earn_names, "Gross",
                *ded_names, "Total deductions", "Net pay", "Overtime hours", "Currency", "Flags"])
    for l in lines:
        e = {x["name"]: x["amount"] for x in l.earnings}
        d = {x["name"]: x["amount"] for x in l.deductions}
        w.writerow([l.employee_code, l.employee_name, l.days_in_month, f"{l.paid_days:g}", f"{l.lwp_days:g}",
                    *[e.get(n, 0) for n in earn_names], l.gross, *[d.get(n, 0) for n in ded_names], l.deductions_total,
                    l.net, f"{l.overtime_hours:g}", run.currency, "; ".join(FLAG_TEXT.get(f, f) for f in l.flags)])
    w.writerow(["Total", "", "", "", "", *[round(sum(x["amount"] for l in lines for x in l.earnings if x["name"] == n), 2)
                                          for n in earn_names], round(sum(l.gross for l in lines), 2),
                *[round(sum(x["amount"] for l in lines for x in l.deductions if x["name"] == n), 2) for n in ded_names],
                round(sum(l.deductions_total for l in lines), 2), round(sum(l.net for l in lines), 2), "", run.currency, ""])
    return buf.getvalue()


def bank_csv(db: Session, run: PayrollRun, lines: list[PayrollRunLine]) -> str:
    banks = {b.employee_id: b for b in db.scalars(select(EmployeeBankDetail).where(
        EmployeeBankDetail.employee_id.in_([l.employee_id for l in lines] or [""])))}
    start, _ = month_bounds(run.month)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Employee code", "Name", "Account name", "Account number", "Bank code", "Bank name", "Amount", "Currency",
                "Payment date", "Reference"])
    for l in lines:
        b = banks.get(l.employee_id)
        if b is None or l.net <= 0:
            continue
        w.writerow([l.employee_code, l.employee_name, b.account_name, b.account_number, b.bank_code, b.bank_name,
                    f"{l.net:.2f}", run.currency, (run.payday or payday(run.month, run.country_code)).isoformat(),
                    f"SAL {start:%b %Y} {l.employee_code}".upper()])
    return buf.getvalue()


# ---------- bank details (seed + HR fix) ----------
BANKS = {
    "IN": ("HDFC Bank", lambda h: f"HDFC0{h[:6].upper()}", 14), "US": ("Chase", lambda h: "021000021", 12),
    "GB": ("Barclays", lambda h: "20-00-00", 8), "AU": ("Commonwealth Bank", lambda h: "062-000", 9),
    "CA": ("RBC Royal Bank", lambda h: "00003-003", 11), "AE": ("Emirates NBD", lambda h: "EBILAEAD", 13),
    "SA": ("Al Rajhi Bank", lambda h: "RJHISARI", 15), "DE": ("Deutsche Bank", lambda h: "DEUTDEFF", 10),
}
# Sample people with no bank details yet (they show as exceptions in a payroll run).
NO_BANK_EVERY = 37


def _digits(seed: str, n: int) -> str:
    h = hashlib.sha256(seed.encode()).hexdigest()
    return "".join(str(int(ch, 16) % 10) for ch in h)[:n]


def seed_bank_details(db: Session) -> int:
    """Insert-once: sample bank details for everyone except about one in 37 (never a sign-in person)."""
    have = set(db.scalars(select(EmployeeBankDetail.employee_id)))
    signed_in = set(db.scalars(select(Account.employee_id).where(Account.employee_id.is_not(None))))
    added = 0
    for emp in db.scalars(select(Employee)):
        if emp.id in have:
            continue
        h = hashlib.sha256(emp.id.encode()).hexdigest()
        if emp.id not in signed_in and int(h[:6], 16) % NO_BANK_EVERY == 0:
            continue
        name, code, n = BANKS.get(emp.country_code, BANKS["IN"])
        db.add(EmployeeBankDetail(employee_id=emp.id, account_name=emp.full_name, account_number=_digits(emp.id, n),
                                  bank_code=code(h), bank_name=name, updated_by="seed"))
        added += 1
    db.flush()
    return added

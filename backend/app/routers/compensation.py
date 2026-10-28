"""Compensation: grade bands, pay history, bonuses, review cycles, proposals and the total rewards statement.

Rules and visibility: app/services/compensation.py. Reading someone else's pay is always audited ("pay_viewed").
"""

from __future__ import annotations

import re
from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import (
    ApprovalInstance,
    BenefitEnrollment,
    BenefitPlan,
    CompBonus,
    CompensationRecord,
    CompProposal,
    CompReviewCycle,
    Country,
    Employee,
    GradeBand,
)
from app.schemas.compensation import (
    CompBonusIn,
    CompBonusOut,
    CompBonusStatusIn,
    CompCycleIn,
    CompCycleOut,
    CompCycleStatusIn,
    CompHistoryOut,
    CompProposalIn,
    CompProposalOut,
    CompRecordIn,
    CompRecordOut,
    CompStatementOut,
    GradeBandIn,
    GradeBandOut,
    GradeBandUpdateIn,
    StatementBenefitLine,
)
from app.schemas import DecisionIn
from app.services import approvals as engine
from app.services import compensation as comp
from app.services.activity import notify, record_audit
from app.services.approval_targets import start_about
from app.services.decisions import NOT_FOUND, can_view, me
from app.services.leave import today_for
from app.services.scope import manager_chain_ids
from app.services.workflow_defaults import decide_http, waiting_entity_ids

router = APIRouter(prefix="/compensation", tags=["compensation"])


def _today(user: CurrentUser) -> date:
    return today_for(user.employee) if user.employee else date.today()


def _require_pay_role(user: CurrentUser, what: str) -> None:
    if not comp.is_pay_role(user):
        raise HTTPException(403, f"Only HR or compensation can {what}.")


def _employee(db: DbSession, employee_id: str) -> Employee:
    emp = db.get(Employee, employee_id)
    if emp is None:
        raise NOT_FOUND
    return emp


# ---------- grade bands ----------
@router.get("/grade-bands", response_model=list[GradeBandOut])
def list_grade_bands(
    db: DbSession, user: CurrentUserDep, country: Annotated[str | None, Query(pattern=r"^[A-Z]{2}$")] = None,
    grade: Annotated[str | None, Query(max_length=16)] = None,
) -> list[GradeBand]:
    """Pay roles and comp_access holders see every band; everyone else only their own country's."""
    stmt = select(GradeBand)
    if not (comp.is_pay_role(user) or comp.has_comp_flag(db, user)):
        stmt = stmt.where(GradeBand.country_code == me(user).country_code)
    if country:
        stmt = stmt.where(GradeBand.country_code == country)
    if grade:
        stmt = stmt.where(GradeBand.grade == grade)
    return list(db.scalars(stmt.order_by(GradeBand.country_code, GradeBand.grade)))


def _check_band(lo: float, mid: float, hi: float) -> None:
    if not (lo <= mid <= hi):
        raise HTTPException(422, "Min must be at most mid, and mid at most max.")


@router.post("/grade-bands", response_model=GradeBandOut, status_code=status.HTTP_201_CREATED)
def create_grade_band(body: GradeBandIn, request: Request, db: DbSession, user: CurrentUserDep) -> GradeBand:
    _require_pay_role(user, "change salary ranges")
    country = db.get(Country, body.country_code)
    if country is None:
        raise HTTPException(422, "Unknown country.")
    if body.currency and body.currency != country.currency:
        raise HTTPException(422, f"Ranges in {country.name} are in {country.currency}.")
    _check_band(body.min_amount, body.mid_amount, body.max_amount)
    if db.scalar(select(GradeBand.id).where(GradeBand.grade == body.grade, GradeBand.country_code == body.country_code)):
        raise HTTPException(409, f"A range for grade {body.grade} in {country.name} already exists.")
    band = GradeBand(id=f"gb-{body.country_code.lower()}-{body.grade.lower()}", grade=body.grade, country_code=body.country_code,
                     currency=country.currency, min_amount=body.min_amount, mid_amount=body.mid_amount,
                     max_amount=body.max_amount, updated_by=user.id)
    if db.get(GradeBand, band.id) is not None:
        band.id = comp.new_id("gb")
    db.add(band)
    record_audit(db, actor_id=user.id, action="grade_band_created", entity="grade_band", entity_id=band.id,
                 after={"grade": band.grade, "country": band.country_code, "min": band.min_amount, "mid": band.mid_amount,
                        "max": band.max_amount}, ip=client_ip(request))
    db.commit()
    return band


@router.put("/grade-bands/{band_id}", response_model=GradeBandOut)
def update_grade_band(band_id: str, body: GradeBandUpdateIn, request: Request, db: DbSession, user: CurrentUserDep) -> GradeBand:
    _require_pay_role(user, "change salary ranges")
    band = db.get(GradeBand, band_id)
    if band is None:
        raise NOT_FOUND
    _check_band(body.min_amount, body.mid_amount, body.max_amount)
    before = {"min": band.min_amount, "mid": band.mid_amount, "max": band.max_amount}
    after = {"min": body.min_amount, "mid": body.mid_amount, "max": body.max_amount}
    if before == after:
        raise HTTPException(422, "Nothing changed.")
    band.min_amount, band.mid_amount, band.max_amount, band.updated_by = body.min_amount, body.mid_amount, body.max_amount, user.id
    record_audit(db, actor_id=user.id, action="grade_band_updated", entity="grade_band", entity_id=band.id, before=before,
                 after=after, ip=client_ip(request))
    db.commit()
    return band


# ---------- pay history ----------
def _history_out(db: DbSession, emp: Employee, today: date) -> CompHistoryOut:
    rows = comp.history(db, emp.id)
    current = comp.current_record(db, emp.id, today)
    records = []
    for r in rows:
        item = CompRecordOut.model_validate(r)
        item.is_current = current is not None and r.id == current.id
        records.append(item)
    return CompHistoryOut(employee_id=emp.id, employee_name=emp.full_name,
                          current=next((r for r in records if r.is_current), None), records=records)


@router.get("/records", response_model=CompHistoryOut)
def get_history(request: Request, db: DbSession, user: CurrentUserDep, employee_id: str | None = None) -> CompHistoryOut:
    """Effective-dated pay history of one person (yourself by default)."""
    emp = comp.require_pay_view(db, user, employee_id)
    out = _history_out(db, emp, _today(user))
    comp.log_pay_view(db, user, emp.id, "pay history", client_ip(request))
    db.commit()
    return out


@router.get("/records/current", response_model=list[CompRecordOut])
def list_current_pay(
    request: Request, db: DbSession, user: CurrentUserDep,
    country: Annotated[str | None, Query(pattern=r"^[A-Z]{2}$")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> list[CompRecordOut]:
    """Current pay of the people whose pay you may see (HR / compensation in scope, or comp_access holders)."""
    if not (comp.is_pay_role(user) or comp.has_comp_flag(db, user)):
        raise HTTPException(403, comp.NO_PAY_ACCESS)
    stmt = select(Employee).join(CompensationRecord, CompensationRecord.employee_id == Employee.id).where(user.scope.employee_filter())
    if country:
        stmt = stmt.where(Employee.country_code == country)
    today = _today(user)
    out: list[CompRecordOut] = []
    for emp in db.scalars(stmt.distinct().order_by(Employee.full_name)):
        if len(out) >= limit:
            break
        if not comp.can_view_pay(db, user, emp):
            continue
        record = comp.current_record(db, emp.id, today)
        if record is None:
            continue
        item = CompRecordOut.model_validate(record)
        item.is_current = True
        out.append(item)
        comp.log_pay_view(db, user, emp.id, "current pay (list)", client_ip(request))
    db.commit()
    return out


@router.post("/records", response_model=CompRecordOut, status_code=status.HTTP_201_CREATED)
def add_record(body: CompRecordIn, request: Request, db: DbSession, user: CurrentUserDep) -> CompRecordOut:
    emp = _employee(db, body.employee_id)
    if not comp.can_manage_pay(user, emp):
        if emp.id == user.employee_id and comp.is_pay_role(user):
            raise HTTPException(403, "Someone else must record your own pay.")
        raise HTTPException(403, "Only HR or compensation can record pay for people in their scope.")
    if body.currency and body.currency != emp.currency:
        raise HTTPException(422, f"{emp.full_name}'s pay is recorded in {emp.currency}.")
    if db.scalar(select(CompensationRecord.id).where(CompensationRecord.employee_id == emp.id,
                                                     CompensationRecord.effective_date == body.effective_date)):
        raise HTTPException(409, f"{emp.full_name} already has a pay record effective {body.effective_date}.")
    record = CompensationRecord(id=comp.new_id("comp"), employee_id=emp.id, effective_date=body.effective_date,
                                base_salary=round(body.base_salary, 2), currency=emp.currency,
                                grade=(body.grade or emp.grade).strip(), reason=body.reason.strip(), created_by=user.id)
    db.add(record)
    record_audit(db, actor_id=user.id, action="comp_record_created", entity="compensation_record", entity_id=record.id,
                 subject_id=emp.id, after={"effective_date": record.effective_date, "base_salary": record.base_salary,
                                           "currency": record.currency, "grade": record.grade, "reason": record.reason},
                 ip=client_ip(request))
    db.commit()
    out = CompRecordOut.model_validate(record)
    current = comp.current_record(db, emp.id, _today(user))
    out.is_current = current is not None and current.id == record.id
    return out


# ---------- bonuses ----------
@router.get("/bonuses", response_model=list[CompBonusOut])
def list_bonuses(request: Request, db: DbSession, user: CurrentUserDep, employee_id: str | None = None) -> list[CompBonus]:
    emp = comp.require_pay_view(db, user, employee_id)
    rows = list(db.scalars(select(CompBonus).where(CompBonus.employee_id == emp.id).order_by(CompBonus.created_at.desc())))
    comp.log_pay_view(db, user, emp.id, "bonuses", client_ip(request))
    db.commit()
    return rows


@router.post("/bonuses", response_model=CompBonusOut, status_code=status.HTTP_201_CREATED)
def add_bonus(body: CompBonusIn, request: Request, db: DbSession, user: CurrentUserDep) -> CompBonus:
    emp = _employee(db, body.employee_id)
    if not comp.can_manage_pay(user, emp):
        if emp.id == user.employee_id:
            raise HTTPException(403, "Someone else must record your own bonus.")
        raise HTTPException(403, "Only HR or compensation can record bonuses.")
    bonus = CompBonus(id=comp.new_id("bonus"), employee_id=emp.id, bonus_type=body.bonus_type.strip(), period=body.period.strip(),
                      amount=round(body.amount, 2), currency=emp.currency, status="accrued", created_by=user.id)
    db.add(bonus)
    record_audit(db, actor_id=user.id, action="bonus_created", entity="comp_bonus", entity_id=bonus.id, subject_id=emp.id,
                 after={"type": bonus.bonus_type, "period": bonus.period, "amount": bonus.amount, "status": "accrued"},
                 ip=client_ip(request))
    db.commit()
    return bonus


@router.post("/bonuses/{bonus_id}/status", response_model=CompBonusOut)
def set_bonus_status(bonus_id: str, body: CompBonusStatusIn, request: Request, db: DbSession, user: CurrentUserDep) -> CompBonus:
    bonus = db.get(CompBonus, bonus_id)
    emp = db.get(Employee, bonus.employee_id) if bonus else None
    if bonus is None or emp is None or not comp.can_view_pay(db, user, emp):
        raise NOT_FOUND
    if not comp.can_manage_pay(user, emp):
        raise HTTPException(403, "Someone else must update your own bonus." if emp.id == user.employee_id
                            else "Only HR or compensation can change bonus status.")
    if bonus.status != "accrued":
        raise HTTPException(409, "Only accrued bonuses can be changed.")
    bonus.status, bonus.decided_by = body.status, user.id
    record_audit(db, actor_id=user.id, action=f"bonus_{body.status}", entity="comp_bonus", entity_id=bonus.id, subject_id=emp.id,
                 before={"status": "accrued"}, after={"status": body.status}, ip=client_ip(request))
    db.commit()
    return bonus


# ---------- review cycles ----------
def _cycle_out(db: DbSession, user: CurrentUser, cycle: CompReviewCycle) -> CompCycleOut:
    out = CompCycleOut.model_validate(cycle)
    out.accepting_proposals = comp.cycle_open_on(cycle, _today(user))
    if comp.is_pay_role(user):
        rows = list(db.scalars(select(CompProposal).where(CompProposal.cycle_id == cycle.id,
                                                          CompProposal.status.in_(("pending", "approved")))))
        base = sum(r.current_base for r in rows)
        out.proposals = len(rows)
        out.budget_used_pct = round(sum(r.proposed_base - r.current_base for r in rows) / base * 100, 2) if base else 0.0
    return out


@router.get("/cycles", response_model=list[CompCycleOut])
def list_cycles(db: DbSession, user: CurrentUserDep) -> list[CompCycleOut]:
    return [_cycle_out(db, user, c) for c in db.scalars(select(CompReviewCycle).order_by(CompReviewCycle.opens_on.desc()))]


@router.post("/cycles", response_model=CompCycleOut, status_code=status.HTTP_201_CREATED)
def create_cycle(body: CompCycleIn, request: Request, db: DbSession, user: CurrentUserDep) -> CompCycleOut:
    if user.account.role not in comp.HR_ROLES:
        raise HTTPException(403, "Only HR can create review cycles.")
    if body.closes_on < body.opens_on:
        raise HTTPException(422, "The close date must be after the open date.")
    if body.effective_date < body.opens_on:
        raise HTTPException(422, "The effective date can't be before the cycle opens.")
    countries = sorted({c.strip().upper() for c in body.countries}) if body.countries else None
    if countries and any(db.get(Country, c) is None for c in countries):
        raise HTTPException(422, "Unknown country in the list.")
    name = body.name.strip()
    if db.scalar(select(CompReviewCycle.id).where(CompReviewCycle.name == name)):
        raise HTTPException(409, "A cycle with this name already exists.")
    cycle = CompReviewCycle(id=comp.new_id("cyc"), name=name, effective_date=body.effective_date, budget_pct=body.budget_pct,
                            opens_on=body.opens_on, closes_on=body.closes_on, status=body.status, countries=countries,
                            created_by=user.id)
    db.add(cycle)
    record_audit(db, actor_id=user.id, action="comp_cycle_created", entity="comp_review_cycle", entity_id=cycle.id,
                 after={"name": name, "effective_date": body.effective_date, "budget_pct": body.budget_pct,
                        "opens_on": body.opens_on, "closes_on": body.closes_on, "status": body.status}, ip=client_ip(request))
    db.commit()
    return _cycle_out(db, user, cycle)


@router.post("/cycles/{cycle_id}/status", response_model=CompCycleOut)
def set_cycle_status(cycle_id: str, body: CompCycleStatusIn, request: Request, db: DbSession, user: CurrentUserDep) -> CompCycleOut:
    if user.account.role not in comp.HR_ROLES:
        raise HTTPException(403, "Only HR can open or close review cycles.")
    cycle = db.get(CompReviewCycle, cycle_id)
    if cycle is None:
        raise NOT_FOUND
    if cycle.status == body.status:
        raise HTTPException(409, f"The cycle is already {body.status}.")
    before = cycle.status
    cycle.status = body.status
    record_audit(db, actor_id=user.id, action="comp_cycle_status", entity="comp_review_cycle", entity_id=cycle.id,
                 before={"status": before}, after={"status": body.status}, ip=client_ip(request))
    db.commit()
    return _cycle_out(db, user, cycle)


# ---------- proposals ----------
def _instance(db: DbSession, p: CompProposal) -> ApprovalInstance | None:
    return db.get(ApprovalInstance, p.approval_instance_id) if p.approval_instance_id else None


def _pay_visible(db: DbSession, user: CurrentUser, p: CompProposal, emp: Employee) -> bool:
    return comp.can_view_pay(db, user, emp) or comp.is_approver(_instance(db, p), user.employee_id)


def _proposal_outs(db: DbSession, user: CurrentUser, rows: list[CompProposal], ip: str | None) -> list[CompProposalOut]:
    out = []
    for p in rows:
        emp = db.get(Employee, p.employee_id)
        assert emp is not None
        item = CompProposalOut.model_validate(p)
        item.employee_name = emp.full_name
        inst = _instance(db, p)
        if inst is not None:
            item.approval_status, item.current_step = inst.status, inst.current_step
            item.executive_step = any("executive" in s["roles"] and not s["skipped"] for s in inst.steps)
        if _pay_visible(db, user, p, emp):
            comp.log_pay_view(db, user, emp.id, "pay proposal", ip, entity_id=p.id)
        else:
            item.current_base = item.proposed_base = item.bonus_amount = None
            item.pay_visible = False
        out.append(item)
    return out


def _visible_proposal(db: DbSession, user: CurrentUser, proposal_id: str) -> tuple[CompProposal, Employee]:
    p = db.get(CompProposal, proposal_id)
    emp = db.get(Employee, p.employee_id) if p else None
    if p is None or emp is None or emp.id == user.employee_id:
        raise NOT_FOUND  # people never see proposals about their own pay
    visible = (p.proposed_by == user.employee_id or comp.is_approver(_instance(db, p), user.employee_id)
               or (comp.is_pay_role(user) and user.scope.can_see(emp)))
    if not visible:
        raise NOT_FOUND
    return p, emp


@router.get("/proposals", response_model=list[CompProposalOut])
def list_proposals(
    request: Request, db: DbSession, user: CurrentUserDep,
    view: Annotated[str, Query(pattern="^(mine|to_decide|all)$", description="mine = proposed by me; all = HR scope")] = "mine",
    cycle_id: str | None = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
) -> list[CompProposalOut]:
    stmt = select(CompProposal).join(Employee, Employee.id == CompProposal.employee_id)
    if view == "mine":
        stmt = stmt.where(CompProposal.proposed_by == (user.employee_id or ""))
    elif view == "to_decide":
        stmt = stmt.where(CompProposal.id.in_(waiting_entity_ids(db, "compensation", user.employee_id) or [""]))
    else:
        _require_pay_role(user, "list every proposal")
        stmt = stmt.where(user.scope.employee_filter(), CompProposal.employee_id != (user.employee_id or ""))
    if cycle_id:
        stmt = stmt.where(CompProposal.cycle_id == cycle_id)
    if status_filter:
        stmt = stmt.where(CompProposal.status == status_filter)
    out = _proposal_outs(db, user, list(db.scalars(stmt.order_by(CompProposal.created_at.desc()))), client_ip(request))
    db.commit()
    return out


@router.post("/proposals", response_model=CompProposalOut, status_code=status.HTTP_201_CREATED)
def create_proposal(body: CompProposalIn, request: Request, db: DbSession, user: CurrentUserDep) -> CompProposalOut:
    proposer = me(user)
    emp = _employee(db, body.employee_id)
    if emp.id == proposer.id:
        raise HTTPException(403, "You can't propose a change to your own pay.")
    hr_ok = comp.is_pay_role(user) and user.scope.can_see(emp)
    if not (hr_ok or proposer.id in manager_chain_ids(db, emp.id)):
        if can_view(db, user, emp):
            raise HTTPException(403, "You can only propose for people below you in the reporting line.")
        raise NOT_FOUND
    cycle = db.get(CompReviewCycle, body.cycle_id)
    if cycle is None:
        raise HTTPException(422, "Cycle not found.")
    if not comp.cycle_open_on(cycle, _today(user)):
        raise HTTPException(409, f"{cycle.name} is not open for proposals.")
    if cycle.countries and emp.country_code not in cycle.countries:
        raise HTTPException(422, f"{cycle.name} doesn't cover {emp.country_code}.")
    if db.scalar(select(CompProposal.id).where(CompProposal.cycle_id == cycle.id, CompProposal.employee_id == emp.id,
                                               CompProposal.status.in_(("pending", "approved")))):
        raise HTTPException(409, f"{emp.full_name} already has a proposal in this cycle.")
    current = comp.current_record(db, emp.id, _today(user))
    if current is None:
        raise HTTPException(422, f"{emp.full_name} has no current pay on record. HR must add a compensation record first.")
    proposal = CompProposal(
        id=comp.new_id("prop"), cycle_id=cycle.id, employee_id=emp.id, proposed_by=proposer.id, currency=current.currency,
        current_base=current.base_salary, current_grade=current.grade, increase_pct=round(body.increase_pct, 2),
        proposed_base=round(current.base_salary * (1 + body.increase_pct / 100), 2),
        proposed_grade=(body.proposed_grade or current.grade).strip(), bonus_amount=body.bonus_amount or None,
        justification=(body.justification or "").strip() or None, status="pending",
    )
    db.add(proposal)
    db.flush()
    record_audit(db, actor_id=user.id, action="comp_proposal_submitted", entity="comp_proposal", entity_id=proposal.id,
                 subject_id=emp.id, after={"cycle_id": cycle.id, "increase_pct": proposal.increase_pct,
                                           "proposed_grade": proposal.proposed_grade}, ip=client_ip(request))
    comp.ensure_workflow(db)
    try:
        instance = start_about(db, "compensation", proposal.id, proposer, emp, amount=proposal.increase_pct, actor_id=user.id,
                               title=f"Pay proposal to approve: {emp.full_name}",
                               body=f"{proposal.increase_pct:g}% increase proposed by {proposer.full_name} ({cycle.name}).",
                               href=f"/compensation/proposals/{proposal.id}")
    except engine.ApprovalError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    proposal.approval_instance_id = instance.id
    out = _proposal_outs(db, user, [proposal], client_ip(request))[0]
    db.commit()
    return out


@router.get("/proposals/{proposal_id}", response_model=CompProposalOut)
def get_proposal(proposal_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> CompProposalOut:
    p, _ = _visible_proposal(db, user, proposal_id)
    out = _proposal_outs(db, user, [p], client_ip(request))[0]
    db.commit()
    return out


@router.post("/proposals/{proposal_id}/decision", response_model=CompProposalOut)
def decide_proposal(proposal_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> CompProposalOut:
    """Same as POST /approvals/{approval_instance_id}/decision."""
    p, _ = _visible_proposal(db, user, proposal_id)
    if p.proposed_by == user.employee_id:
        raise HTTPException(403, "You can't approve your own proposal.")
    decide_http(db, _instance(db, p), user.employee_id, body.decision, body.note, user.id, client_ip(request))
    db.commit()
    out = _proposal_outs(db, user, [p], client_ip(request))[0]
    db.commit()
    return out


@router.post("/proposals/{proposal_id}/withdraw", response_model=CompProposalOut)
def withdraw_proposal(proposal_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> CompProposalOut:
    p = db.get(CompProposal, proposal_id)
    if p is None or p.proposed_by != user.employee_id:
        raise NOT_FOUND
    if p.status != "pending":
        raise HTTPException(409, f"Only pending proposals can be withdrawn; this one is {p.status}.")
    instance = _instance(db, p)
    if instance is not None and instance.status == "pending":
        for ids in engine.open_groups(db, instance).values():
            for approver in ids:
                notify(db, recipient_id=approver, title="Pay proposal withdrawn", body="No action is needed any more.",
                       href=f"/compensation/proposals/{p.id}")
        engine.cancel(db, instance, actor_id=user.id, ip=client_ip(request))
    p.status = "withdrawn"
    record_audit(db, actor_id=user.id, action="comp_proposal_withdrawn", entity="comp_proposal", entity_id=p.id,
                 subject_id=p.employee_id, before={"status": "pending"}, after={"status": "withdrawn"}, ip=client_ip(request))
    db.commit()
    return _proposal_outs(db, user, [p], client_ip(request))[0]


# ---------- total rewards statement ----------
def _bonus_year(bonus: CompBonus) -> int:
    """The year in the period ("FY2026", "Q2 2026"), else the year it was recorded."""
    found = re.findall(r"(?:19|20)\d{2}", bonus.period)
    return int(found[-1]) if found else bonus.created_at.year


@router.get("/statement", response_model=CompStatementOut)
def statement(db: DbSession, user: CurrentUserDep, year: Annotated[int | None, Query(ge=2000, le=2100)] = None) -> CompStatementOut:
    """Your own total rewards: current base, bonuses for the year (accrued or paid) and employer cost of your benefits."""
    emp = me(user)
    today = _today(user)
    year = year or today.year
    as_of = min(today, date(year, 12, 31))
    record = comp.current_record(db, emp.id, as_of)
    bonuses = [b for b in db.scalars(select(CompBonus).where(CompBonus.employee_id == emp.id, CompBonus.status.in_(("accrued", "paid")))
                                     .order_by(CompBonus.created_at))
               if _bonus_year(b) == year]
    lines = [
        StatementBenefitLine(plan_id=plan.id, plan_name=plan.name, plan_type=plan.plan_type,
                             employer_annual_cost=plan.employer_annual_cost or 0, currency=plan.currency)
        for plan in db.scalars(select(BenefitPlan).join(BenefitEnrollment, BenefitEnrollment.plan_id == BenefitPlan.id)
                               .where(BenefitEnrollment.employee_id == emp.id, BenefitEnrollment.status == "approved")
                               .order_by(BenefitPlan.name))
    ]
    base = record.base_salary if record else 0.0
    bonus_total = round(sum(b.amount for b in bonuses), 2)
    benefits_total = round(sum(line.employer_annual_cost for line in lines if line.currency == emp.currency), 2)
    return CompStatementOut(
        employee_id=emp.id, year=year, currency=record.currency if record else emp.currency, grade=record.grade if record else emp.grade,
        base_salary=base, base_effective_date=record.effective_date if record else None, bonus_total=bonus_total,
        bonuses=[CompBonusOut.model_validate(b) for b in bonuses], benefits_employer_cost=benefits_total, benefits=lines,
        total_rewards=round(base + bonus_total + benefits_total, 2),
    )

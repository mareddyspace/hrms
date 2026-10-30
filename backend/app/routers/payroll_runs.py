"""Monthly payroll runs (/payroll/runs) and my payslips from locked runs (/payroll/my-slips). Rules in
app/services/payroll_runs.py.

GET  /payroll/runs?month=&country=           runs (HR / payroll, finance, executive; never the admin)
GET  /payroll/runs/inputs?month=&country=&entity=   each person's input pack, for the browser to work out payslips
POST /payroll/runs/prepare                   {month, country_code, legal_entity, lines: [...]} -> draft
GET  /payroll/runs/{id}                      run (with each person's lines for HR / payroll or a comp_access holder;
                                             totals and per-department totals only for other approvers)
POST /payroll/runs/{id}/submit               draft -> review
POST /payroll/runs/{id}/approve              review -> locked (a second person)
POST /payroll/runs/{id}/send-back            review -> draft {note}
GET  /payroll/runs/{id}/register.csv | bank.csv   exports: register for those who see lines; bank file for HR /
                                             payroll only, locked runs only
PUT  /payroll/bank-details/{employee_id}     HR fixes missing bank details
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Account, Employee, EmployeeBankDetail, PayrollRun, PayrollRunLine
from app.services import payroll_runs as rules
from app.services.activity import record_audit
from app.services.compensation import NO_PAY_ACCESS
from app.services.decisions import NOT_FOUND, me

router = APIRouter(prefix="/payroll", tags=["payroll runs"])

Month = Annotated[str, Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")]


class LineIn(BaseModel):
    employee_id: str = Field(max_length=64)
    paid_days: float = Field(ge=0, le=31)
    lwp_days: float = Field(default=0, ge=0, le=31)
    earnings: list[dict[str, Any]] = Field(max_length=60)
    deductions: list[dict[str, Any]] = Field(max_length=60)
    employer: list[dict[str, Any]] = Field(default_factory=list, max_length=60)
    slip: dict[str, Any] | None = None


class PrepareIn(BaseModel):
    month: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    country_code: str = Field(min_length=2, max_length=2)
    legal_entity: str = Field(min_length=1, max_length=200)
    lines: list[LineIn] = Field(max_length=5000)


class NoteIn(BaseModel):
    note: str = Field(default="", max_length=1000)


class BankIn(BaseModel):
    account_name: str = Field(min_length=1, max_length=200)
    account_number: str = Field(pattern=r"^[0-9A-Za-z]{6,34}$")
    bank_code: str = Field(min_length=2, max_length=20)
    bank_name: str = Field(min_length=1, max_length=120)


class PersonIn(BaseModel):
    employee_id: str
    employee_code: str
    name: str
    role: str
    country_code: str
    legal_entity: str
    location: str | None
    nationality: str | None
    employment_status: str | None
    employment_type: str | None
    joining_date: date
    last_working_day: date | None
    tax_regime: str
    currency: str
    annual_base: float | None
    days_in_month: int
    lwp_days: float
    reimbursements: float
    reimbursement_count: int
    cash_recovery: list[dict[str, Any]]
    encashment: float
    encashment_days: float
    overtime_hours: float
    overtime_pay: float
    bank_ok: bool
    bank_masked: str | None
    new_joiner: bool
    leaver: bool


class LineOut(BaseModel):
    employee_id: str
    employee_name: str
    employee_code: str
    days_in_month: int
    paid_days: float
    lwp_days: float
    gross: float
    deductions_total: float
    net: float
    earnings: list[dict[str, Any]]
    deductions: list[dict[str, Any]]
    employer: list[dict[str, Any]]
    reimbursements: float
    cash_recovery: float
    encashment: float
    overtime_hours: float
    overtime_pay: float
    bank_ok: bool
    flags: list[str]


class RunOut(BaseModel):
    id: str
    month: str
    country_code: str
    legal_entity: str
    currency: str
    status: str
    headcount: int
    totals: dict[str, Any]
    exceptions: list[dict[str, Any]]
    prepared_by: str | None
    prepared_at: datetime | None
    submitted_by: str | None
    submitted_at: datetime | None
    approved_by: str | None
    approved_at: datetime | None
    returned_note: str | None
    payday: date | None
    can_prepare: bool
    can_submit: bool
    can_approve: bool
    can_see_lines: bool = False
    can_export_bank: bool = False
    exceptions_count: int = 0
    exception_counts: dict[str, int] = Field(default_factory=dict)
    departments: list[dict[str, Any]] | None = None
    lines: list[LineOut] | None = None


class EntityOut(BaseModel):
    country_code: str
    legal_entity: str
    currency: str


class MySlipOut(BaseModel):
    run_id: str
    month: str
    slip: dict[str, Any] | None
    gross: float
    net: float


def _role(user: CurrentUser) -> str:
    return user.account.role


def _need(user: CurrentUser, roles: frozenset[str] | set[str], what: str) -> None:
    if _role(user) not in roles:
        raise HTTPException(403, f"Only HR / payroll, finance and the executive can {what}." if roles is not rules.PREPARE_ROLES
                            else f"Only HR / payroll can {what}.")


def _names(db: DbSession, account_ids: set[str | None]) -> dict[str, str]:
    ids = {a for a in account_ids if a}
    rows = db.execute(select(Account.id, Employee.full_name).join(Employee, Employee.id == Account.employee_id)
                      .where(Account.id.in_(ids or {""}))).all()
    return dict(rows)


def _out(db: DbSession, user: CurrentUser, run: PayrollRun, with_lines: bool = False) -> RunOut:
    names = _names(db, {run.prepared_by, run.submitted_by, run.approved_by})
    role, me_id = _role(user), user.id
    see_lines = rules.can_see_lines(db, user)
    exceptions = run.exceptions or []
    counts: dict[str, int] = {}
    for x in exceptions:
        counts[x.get("kind", "")] = counts.get(x.get("kind", ""), 0) + 1
    out = RunOut(
        id=run.id, month=run.month, country_code=run.country_code, legal_entity=run.legal_entity, currency=run.currency,
        status=run.status, headcount=run.headcount, totals=run.totals or {},
        # Totals-only viewers get counts, not who is held or below zero.
        exceptions=exceptions if see_lines else [], exceptions_count=len(exceptions), exception_counts=counts,
        can_see_lines=see_lines, can_export_bank=rules.can_export_bank(user),
        prepared_by=names.get(run.prepared_by or "", run.prepared_by), prepared_at=run.prepared_at,
        submitted_by=names.get(run.submitted_by or "", run.submitted_by), submitted_at=run.submitted_at,
        approved_by=names.get(run.approved_by or "", run.approved_by), approved_at=run.approved_at,
        returned_note=run.returned_note, payday=run.payday,
        can_prepare=run.status == "draft" and role in rules.PREPARE_ROLES,
        can_submit=run.status == "draft" and role in rules.PREPARE_ROLES and run.headcount > 0,
        can_approve=run.status == "review" and role in rules.APPROVE_ROLES and me_id not in (run.prepared_by, run.submitted_by),
    )
    if with_lines:
        out.departments = rules.department_totals(db, run)
        if see_lines:
            out.lines = [LineOut.model_validate(l, from_attributes=True) for l in rules.lines_of(db, run)]
    return out


def _err(exc: rules.RunError) -> HTTPException:
    text = str(exc)
    return HTTPException(409 if ("already" in text or "locked" in text) else 422, text)


def _run(db: DbSession, user: CurrentUser, run_id: str) -> PayrollRun:
    _need(user, rules.VIEW_ROLES, "see payroll runs")
    run = db.get(PayrollRun, run_id)
    if run is None or not rules.country_ok(user.scope, _role(user), run.country_code):
        raise NOT_FOUND
    return run


@router.get("/entities", response_model=list[EntityOut])
def entities(db: DbSession, user: CurrentUserDep) -> list[EntityOut]:
    """Country + legal entity pairs with people on them (the run picker)."""
    _need(user, rules.VIEW_ROLES, "see payroll runs")
    from app.models import Country

    cur = {c.code: c.currency for c in db.scalars(select(Country))}
    pairs = db.execute(select(Employee.country_code, Employee.legal_entity).distinct()).all()
    return [EntityOut(country_code=c, legal_entity=e, currency=cur.get(c, "")) for c, e in sorted(pairs)
            if e and rules.country_ok(user.scope, _role(user), c)]


@router.get("/runs", response_model=list[RunOut])
def list_runs(db: DbSession, user: CurrentUserDep, month: Month | None = None,
              country: Annotated[str | None, Query(max_length=2)] = None) -> list[RunOut]:
    _need(user, rules.VIEW_ROLES, "see payroll runs")
    stmt = select(PayrollRun)
    if month:
        stmt = stmt.where(PayrollRun.month == month)
    if country:
        stmt = stmt.where(PayrollRun.country_code == country.upper())
    runs = db.scalars(stmt.order_by(PayrollRun.month.desc(), PayrollRun.country_code).limit(200))
    return [_out(db, user, r) for r in runs if rules.country_ok(user.scope, _role(user), r.country_code)]


@router.get("/runs/inputs", response_model=list[PersonIn])
def run_inputs(db: DbSession, user: CurrentUserDep, month: Month, country: Annotated[str, Query(min_length=2, max_length=2)],
               entity: Annotated[str, Query(min_length=1, max_length=200)]) -> list[dict[str, Any]]:
    _need(user, rules.PREPARE_ROLES, "prepare payroll")
    cc = country.upper()
    if not rules.country_ok(user.scope, _role(user), cc):
        raise HTTPException(403, "That country is outside your data scope.")
    try:
        return rules.inputs(db, cc, entity, month)
    except rules.RunError as exc:
        raise _err(exc) from exc


@router.post("/runs/prepare", response_model=RunOut)
def prepare_run(body: PrepareIn, request: Request, db: DbSession, user: CurrentUserDep) -> RunOut:
    _need(user, rules.PREPARE_ROLES, "prepare payroll")
    cc = body.country_code.upper()
    if not rules.country_ok(user.scope, _role(user), cc):
        raise HTTPException(403, "That country is outside your data scope.")
    try:
        run = rules.prepare(db, cc, body.legal_entity, body.month, [l.model_dump() for l in body.lines], user.id,
                            client_ip(request))
    except rules.RunError as exc:
        db.rollback()
        raise _err(exc) from exc
    db.commit()
    return _out(db, user, run, True)


@router.get("/runs/{run_id}", response_model=RunOut)
def get_run(run_id: str, db: DbSession, user: CurrentUserDep) -> RunOut:
    return _out(db, user, _run(db, user, run_id), True)


@router.post("/runs/{run_id}/submit", response_model=RunOut)
def submit_run(run_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> RunOut:
    run = _run(db, user, run_id)
    _need(user, rules.PREPARE_ROLES, "send payroll for review")
    try:
        rules.submit(db, run, user.id, user.employee_id, client_ip(request))
    except rules.RunError as exc:
        db.rollback()
        raise _err(exc) from exc
    db.commit()
    return _out(db, user, run, True)


@router.post("/runs/{run_id}/approve", response_model=RunOut)
def approve_run(run_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> RunOut:
    run = _run(db, user, run_id)
    _need(user, rules.APPROVE_ROLES, "approve payroll")
    try:
        rules.approve(db, run, user.id, client_ip(request))
    except rules.RunError as exc:
        db.rollback()
        raise _err(exc) from exc
    db.commit()
    return _out(db, user, run, True)


@router.post("/runs/{run_id}/send-back", response_model=RunOut)
def send_back_run(run_id: str, body: NoteIn, request: Request, db: DbSession, user: CurrentUserDep) -> RunOut:
    run = _run(db, user, run_id)
    _need(user, rules.APPROVE_ROLES, "send payroll back")
    try:
        rules.send_back(db, run, user.id, body.note, client_ip(request))
    except rules.RunError as exc:
        db.rollback()
        raise _err(exc) from exc
    db.commit()
    return _out(db, user, run, True)


def _csv(text: str, filename: str) -> Response:
    return Response(content=text, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"})


@router.get("/runs/{run_id}/register.csv")
def register(run_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    run = _run(db, user, run_id)
    if not rules.can_see_lines(db, user):
        raise HTTPException(403, NO_PAY_ACCESS)
    record_audit(db, actor_id=user.id, action="payroll_register_exported", entity="payroll_runs", entity_id=run.id,
                 ip=client_ip(request))
    db.commit()
    return _csv(rules.register_csv(run, rules.lines_of(db, run)), f"payroll-register-{run.country_code}-{run.month}.csv")


@router.get("/runs/{run_id}/bank.csv")
def bank_file(run_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    run = _run(db, user, run_id)
    if not rules.can_export_bank(user):
        raise HTTPException(403, "Only HR / payroll can export the bank file.")
    if run.status != "locked":
        raise HTTPException(409, "The bank file is ready once the run is approved and locked.")
    record_audit(db, actor_id=user.id, action="payroll_bank_file_exported", entity="payroll_runs", entity_id=run.id,
                 ip=client_ip(request))
    db.commit()
    return _csv(rules.bank_csv(db, run, rules.lines_of(db, run)), f"bank-transfer-{run.country_code}-{run.month}.csv")


class ExportOut(BaseModel):
    filename: str
    csv: str
    rows: int


@router.get("/runs/{run_id}/export", response_model=ExportOut)
def export_run(run_id: str, request: Request, db: DbSession, user: CurrentUserDep,
               kind: Annotated[str, Query(pattern="^(register|bank)$")] = "register") -> ExportOut:
    """The same files as register.csv / bank.csv, as JSON (the portal saves them in the browser)."""
    res = (register if kind == "register" else bank_file)(run_id, request, db, user)
    text = bytes(res.body).decode("utf-8")
    name = res.headers["content-disposition"].split('filename="', 1)[1].rstrip('"')
    return ExportOut(filename=name, csv=text, rows=max(0, len(text.strip().splitlines()) - 1))


@router.put("/bank-details/{employee_id}")
def put_bank(employee_id: str, body: BankIn, request: Request, db: DbSession, user: CurrentUserDep) -> dict[str, Any]:
    _need(user, rules.PREPARE_ROLES, "change bank details")
    emp = db.get(Employee, employee_id)
    if emp is None or not user.scope.can_see(emp):
        raise NOT_FOUND
    row = db.get(EmployeeBankDetail, employee_id)
    before = {"account": rules._mask(row.account_number)} if row else None
    if row is None:
        row = EmployeeBankDetail(employee_id=employee_id, **body.model_dump(), updated_by=user.id)
        db.add(row)
    else:
        for k, v in body.model_dump().items():
            setattr(row, k, v)
        row.updated_by = user.id
    record_audit(db, actor_id=user.id, action="bank_details_changed", entity="employee_bank_details", entity_id=employee_id,
                 subject_id=employee_id, before=before, after={"account": rules._mask(body.account_number)},
                 ip=client_ip(request))
    db.commit()
    return {"employee_id": employee_id, "bank_ok": True, "bank_masked": rules._mask(body.account_number)}


@router.get("/my-slips", response_model=list[MySlipOut])
def my_slips(db: DbSession, user: CurrentUserDep) -> list[MySlipOut]:
    """My payslips from locked runs (other months are worked out by the portal)."""
    emp = me(user)
    rows = db.execute(select(PayrollRunLine, PayrollRun).join(PayrollRun, PayrollRun.id == PayrollRunLine.run_id)
                      .where(PayrollRunLine.employee_id == emp.id, PayrollRun.status == "locked")
                      .order_by(PayrollRun.month.desc())).all()
    return [MySlipOut(run_id=run.id, month=run.month, slip=line.slip, gross=line.gross, net=line.net) for line, run in rows]

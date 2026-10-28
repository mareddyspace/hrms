"""Expense claims and receipts.

Who sees a claim: the claimant, their reporting line, HR/admin/executive within scope, the claim's approvers,
and finance (role finance or admin). Receipt files only: the claimant, the claim's approvers, finance and HR.
Decisions go through the approvals engine (POST /approvals/{id}/decision or the convenience endpoint here).
Receipts are uploaded as the raw request body (Content-Type: the file's type), max 5 MB, PDF or image.
"""

from __future__ import annotations

import re
import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, Response
from sqlalchemy import select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import ApprovalInstance, Employee, ExpenseClaim, ExpenseReceipt
from app.schemas import DecisionIn, ExpenseClaimIn, ExpenseClaimOut, ExpensePayIn, ExpenseRulesOut, ReceiptOut
from app.schemas.expenses import EXPENSE_CATEGORIES
from app.services import approvals as engine
from app.services import expenses as rules
from app.services import storage
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, can_view, me
from app.services.leave import today_for
from app.services.workflow_defaults import (
    EXPENSE_FINANCE_THRESHOLD,
    decide_http,
    ensure_default,
    is_approver,
    notify_withdrawn,
    waiting_entity_ids,
)

router = APIRouter(prefix="/expenses", tags=["expenses"])

FINANCE_ROLES = frozenset({"finance", "admin"})


def is_finance(user: CurrentUser) -> bool:
    return user.account.role in FINANCE_ROLES


def _snapshot(c: ExpenseClaim) -> dict:
    return {"status": c.status, "category": c.category, "amount": c.amount, "currency": c.currency, "date": c.expense_date,
            "trip_id": c.trip_id, "paid_on": c.paid_on, "payment_reference": c.payment_reference}


def _outs(db: DbSession, claims: list[ExpenseClaim]) -> list[ExpenseClaimOut]:
    if not claims:
        return []
    ids = [c.id for c in claims]
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_({c.employee_id for c in claims}))).all())
    receipts: dict[str, list[ExpenseReceipt]] = {}
    for r in db.scalars(select(ExpenseReceipt).where(ExpenseReceipt.claim_id.in_(ids)).order_by(ExpenseReceipt.created_at)):
        receipts.setdefault(r.claim_id or "", []).append(r)
    instances = {i.id: i for i in db.scalars(select(ApprovalInstance).where(
        ApprovalInstance.id.in_([c.approval_instance_id for c in claims if c.approval_instance_id])))}
    out = []
    for c in claims:
        item = ExpenseClaimOut.model_validate(c)
        item.employee_name = names.get(c.employee_id)
        item.receipts = [ReceiptOut.model_validate(r) for r in receipts.get(c.id, [])]
        inst = instances.get(c.approval_instance_id or "")
        if inst is not None:
            item.approval_status, item.current_step = inst.status, inst.current_step
        out.append(item)
    return out


def _instance(db: DbSession, claim: ExpenseClaim) -> ApprovalInstance | None:
    return db.get(ApprovalInstance, claim.approval_instance_id) if claim.approval_instance_id else None


def _visible_claim(db: DbSession, user: CurrentUser, claim_id: str) -> tuple[ExpenseClaim, Employee]:
    claim = db.get(ExpenseClaim, claim_id)
    emp = db.get(Employee, claim.employee_id) if claim else None
    if claim is None or emp is None:
        raise NOT_FOUND
    if not (can_view(db, user, emp) or is_finance(user) or is_approver(_instance(db, claim), user.employee_id)):
        raise NOT_FOUND
    return claim, emp


@router.get("/rules", response_model=ExpenseRulesOut)
def get_rules(user: CurrentUserDep) -> ExpenseRulesOut:
    emp = me(user)
    limits = rules.limits_for(emp.country_code)
    return ExpenseRulesOut(
        country_code=emp.country_code, currency=emp.currency, max_claim=limits["max_claim"],
        receipt_required_over=limits["receipt_above"], max_cash_advance=limits["max_cash_advance"],
        claim_window_days=rules.CLAIM_WINDOW_DAYS, finance_threshold=EXPENSE_FINANCE_THRESHOLD,
        categories=list(EXPENSE_CATEGORIES), max_receipt_bytes=storage.MAX_RECEIPT_BYTES,
        receipt_types=sorted(storage.ALLOWED_TYPES),
    )


@router.get("", response_model=list[ExpenseClaimOut])
def list_claims(
    db: DbSession,
    user: CurrentUserDep,
    view: Annotated[str, Query(pattern="^(mine|to_decide|all)$", description="all = everyone in your data scope")] = "mine",
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    employee_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[ExpenseClaimOut]:
    stmt = select(ExpenseClaim).join(Employee, Employee.id == ExpenseClaim.employee_id)
    if view == "mine":
        stmt = stmt.where(ExpenseClaim.employee_id == (user.employee_id or ""))
    elif view == "to_decide":
        stmt = stmt.where(ExpenseClaim.id.in_(waiting_entity_ids(db, "expense", user.employee_id) or [""]))
    elif not is_finance(user):
        stmt = stmt.where(user.scope.employee_filter())
    if employee_id:
        stmt = stmt.where(ExpenseClaim.employee_id == employee_id)
    if status_filter:
        stmt = stmt.where(ExpenseClaim.status == status_filter)
    return _outs(db, list(db.scalars(stmt.order_by(ExpenseClaim.created_at.desc()).limit(limit))))


@router.post("", response_model=ExpenseClaimOut, status_code=status.HTTP_201_CREATED)
def create_claim(body: ExpenseClaimIn, request: Request, db: DbSession, user: CurrentUserDep) -> ExpenseClaimOut:
    emp = me(user)
    receipts = []
    for rid in dict.fromkeys(body.receipt_ids):
        receipt = db.get(ExpenseReceipt, rid)
        if receipt is None or receipt.employee_id != emp.id:
            raise HTTPException(422, "Receipt not found. Upload it first.")
        if receipt.claim_id is not None:
            raise HTTPException(409, "That receipt is already attached to another claim.")
        receipts.append(receipt)
    try:
        currency = rules.check_currency(body.currency, emp.currency)
        rules.validate_claim(
            db, employee_id=emp.id, country_code=emp.country_code, currency=currency, category=body.category,
            amount=body.amount, on=body.expense_date, today=today_for(emp), trip_id=body.trip_id, receipts=receipts,
        )
    except rules.Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except rules.RequestError as exc:
        raise HTTPException(422, str(exc)) from exc

    claim = ExpenseClaim(
        id=f"exp-{uuid.uuid4().hex[:12]}", employee_id=emp.id, category=body.category, amount=round(body.amount, 2),
        currency=currency, expense_date=body.expense_date, description=body.description.strip(), trip_id=body.trip_id,
        status="submitted",
    )
    db.add(claim)
    db.flush()
    for receipt in receipts:
        receipt.claim_id = claim.id
    record_audit(db, actor_id=user.id, action="expense_submitted", entity="expense_claim", entity_id=claim.id,
                 subject_id=emp.id, after=_snapshot(claim) | {"receipts": [r.id for r in receipts]}, ip=client_ip(request))
    ensure_default(db, "expense")
    try:
        instance = engine.start(db, "expense", claim.id, emp, claim.amount, actor_id=user.id)
    except engine.ApprovalError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    claim.approval_instance_id = instance.id
    db.commit()
    return _outs(db, [claim])[0]


@router.get("/{claim_id}", response_model=ExpenseClaimOut)
def get_claim(claim_id: str, db: DbSession, user: CurrentUserDep) -> ExpenseClaimOut:
    claim, _ = _visible_claim(db, user, claim_id)
    return _outs(db, [claim])[0]


@router.post("/{claim_id}/withdraw", response_model=ExpenseClaimOut)
def withdraw_claim(claim_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> ExpenseClaimOut:
    claim = db.get(ExpenseClaim, claim_id)
    if claim is None or claim.employee_id != user.employee_id:
        raise NOT_FOUND
    if claim.status != "submitted":
        raise HTTPException(409, f"Only submitted claims can be withdrawn; this one is {claim.status}.")
    emp = me(user)
    before = _snapshot(claim)
    instance = _instance(db, claim)
    notify_withdrawn(db, instance, emp.full_name, "expense claim", f"/expenses/{claim.id}")
    if instance is not None and instance.status == "pending":
        engine.cancel(db, instance, actor_id=user.id, ip=client_ip(request))
    claim.status = "withdrawn"
    record_audit(db, actor_id=user.id, action="expense_withdrawn", entity="expense_claim", entity_id=claim.id,
                 subject_id=emp.id, before=before, after=_snapshot(claim), ip=client_ip(request))
    db.commit()
    return _outs(db, [claim])[0]


@router.post("/{claim_id}/decision", response_model=ExpenseClaimOut)
def decide_claim(claim_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> ExpenseClaimOut:
    """Same as POST /approvals/{approval_instance_id}/decision."""
    claim, _ = _visible_claim(db, user, claim_id)
    decide_http(db, _instance(db, claim), user.employee_id, body.decision, body.note, user.id, client_ip(request))
    db.commit()
    return _outs(db, [claim])[0]


@router.post("/{claim_id}/pay", response_model=ExpenseClaimOut)
def mark_paid(claim_id: str, body: ExpensePayIn, request: Request, db: DbSession, user: CurrentUserDep) -> ExpenseClaimOut:
    if not is_finance(user):
        raise HTTPException(403, "Only Finance or an administrator can mark claims as paid.")
    claim, emp = _visible_claim(db, user, claim_id)
    if claim.status != "approved":
        raise HTTPException(409, f"Only approved claims can be paid; this one is {claim.status}.")
    today = today_for(user.employee) if user.employee else date.today()
    if body.paid_on > today:
        raise HTTPException(422, "The payment date can't be in the future.")
    if body.paid_on < claim.expense_date:
        raise HTTPException(422, "The payment date can't be before the expense date.")
    before = _snapshot(claim)
    claim.status, claim.paid_on = "paid", body.paid_on
    claim.payment_reference, claim.paid_by = body.payment_reference.strip(), user.employee_id or user.id
    record_audit(db, actor_id=user.id, action="expense_paid", entity="expense_claim", entity_id=claim.id,
                 subject_id=emp.id, before=before, after=_snapshot(claim), ip=client_ip(request))
    notify(db, recipient_id=emp.id, title="Expense claim paid",
           body=f"{claim.currency} {claim.amount:,.2f} for {claim.category} on {claim.expense_date} was paid on {claim.paid_on} "
                f"(reference {claim.payment_reference}).", href=f"/expenses/{claim.id}")
    db.commit()
    return _outs(db, [claim])[0]


# ---------- receipts ----------
def _clean_name(raw: str | None, content_type: str) -> str:
    name = re.split(r"[\\/]", raw or "")[-1]
    name = re.sub(r"[^\w.\- ()]", "_", name).strip(" .")[:200]
    return name or f"receipt.{storage.ALLOWED_TYPES[content_type]}"


async def _read_upload(request: Request) -> tuple[bytes, str, str]:
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > storage.MAX_RECEIPT_BYTES:
        raise HTTPException(413, "The file is larger than 5 MB.")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > storage.MAX_RECEIPT_BYTES:
            raise HTTPException(413, "The file is larger than 5 MB.")
    try:
        content_type, sha = storage.check_upload(bytes(data), request.headers.get("content-type"))
    except storage.StorageError as exc:
        raise HTTPException(413 if "5 MB" in str(exc) else 415 if "accepted" in str(exc) or "match" in str(exc) else 422,
                            str(exc)) from exc
    return bytes(data), content_type, sha


def _store_receipt(db: DbSession, user: CurrentUser, emp: Employee, data: bytes, content_type: str, sha: str,
                   filename: str | None, claim: ExpenseClaim | None, request: Request) -> ExpenseReceipt:
    reused = db.scalar(
        select(ExpenseReceipt.claim_id).join(ExpenseClaim, ExpenseClaim.id == ExpenseReceipt.claim_id).where(
            ExpenseReceipt.employee_id == emp.id, ExpenseReceipt.sha256 == sha,
            ExpenseClaim.status.in_(rules.OPEN_CLAIM_STATUSES),
        )
    )
    if reused:
        raise HTTPException(409, f"This receipt is already attached to claim {reused}.")
    rid = f"rcpt-{uuid.uuid4().hex[:16]}"
    stored = storage.save(f"receipts/{emp.id}", rid, data, content_type, sha)
    receipt = ExpenseReceipt(
        id=rid, claim_id=claim.id if claim else None, employee_id=emp.id, file_name=_clean_name(filename, content_type),
        content_type=stored.content_type, size_bytes=stored.size_bytes, sha256=stored.sha256,
        storage_path=stored.relative_path, uploaded_by=user.id,
    )
    db.add(receipt)
    db.flush()
    record_audit(db, actor_id=user.id, action="receipt_uploaded", entity="expense_receipt", entity_id=rid, subject_id=emp.id,
                 after={"claim_id": receipt.claim_id, "file_name": receipt.file_name, "content_type": receipt.content_type,
                        "size_bytes": receipt.size_bytes, "sha256": receipt.sha256}, ip=client_ip(request))
    try:
        db.commit()
    except Exception:
        storage.delete_quietly(stored.relative_path)
        raise
    return receipt


@router.post("/receipts", response_model=ReceiptOut, status_code=status.HTTP_201_CREATED,
             openapi_extra={"requestBody": {"required": True, "content": {t: {"schema": {"type": "string", "format": "binary"}}
                                                                         for t in storage.ALLOWED_TYPES}}})
async def upload_receipt(
    request: Request, db: DbSession, user: CurrentUserDep,
    filename: Annotated[str | None, Query(max_length=255)] = None,
) -> ExpenseReceipt:
    """Upload a receipt before creating the claim; pass its id in receipt_ids."""
    emp = me(user)
    data, content_type, sha = await _read_upload(request)
    return _store_receipt(db, user, emp, data, content_type, sha, filename, None, request)


@router.post("/{claim_id}/receipts", response_model=ReceiptOut, status_code=status.HTTP_201_CREATED,
             openapi_extra={"requestBody": {"required": True, "content": {t: {"schema": {"type": "string", "format": "binary"}}
                                                                         for t in storage.ALLOWED_TYPES}}})
async def add_receipt(
    claim_id: str, request: Request, db: DbSession, user: CurrentUserDep,
    filename: Annotated[str | None, Query(max_length=255)] = None,
) -> ExpenseReceipt:
    """Add a receipt to your own claim while it is still submitted."""
    claim = db.get(ExpenseClaim, claim_id)
    if claim is None or claim.employee_id != user.employee_id:
        raise NOT_FOUND
    if claim.status != "submitted":
        raise HTTPException(409, f"Receipts can only be added while the claim is submitted; this one is {claim.status}.")
    data, content_type, sha = await _read_upload(request)
    return _store_receipt(db, user, me(user), data, content_type, sha, filename, claim, request)


@router.get("/receipts/{receipt_id}", response_class=FileResponse)
def download_receipt(receipt_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    receipt = db.get(ExpenseReceipt, receipt_id)
    if receipt is None:
        raise NOT_FOUND
    owner = receipt.employee_id == user.employee_id
    if receipt.claim_id is None:
        if not owner:
            raise NOT_FOUND
    elif not owner:
        claim, emp = _visible_claim(db, user, receipt.claim_id)
        allowed = (
            is_finance(user)
            or is_approver(_instance(db, claim), user.employee_id)
            or (user.scope.is_hr and user.scope.can_see(emp))
        )
        if not allowed:
            raise HTTPException(403, "Only the claimant, the approvers, Finance and HR can open receipts.")
    try:
        response = storage.download(receipt.storage_path, media_type=receipt.content_type, filename=receipt.file_name)
    except storage.FileMissing as exc:
        raise HTTPException(410, "The receipt file is no longer available.") from exc
    except storage.StorageError as exc:
        raise NOT_FOUND from exc
    record_audit(db, actor_id=user.id, action="receipt_downloaded", entity="expense_receipt", entity_id=receipt.id,
                 subject_id=receipt.employee_id, ip=client_ip(request))
    db.commit()
    return response

"""Expense claim and travel request rules (same as the portal: src/countryPay.ts CLAIM_LIMITS, src/model.ts
validateExpense, src/store.tsx addExpense), and the hooks that update a claim / trip when its approval ends.

- a claim is in the claimant's own currency, dated today or up to 90 days back, at most the country's max claim
- claims above the country's receipt threshold need at least one receipt
- duplicate: the same person, date, category and amount on a claim that isn't rejected or withdrawn
- approval type "expense": manager, then finance (admin fallback) when the amount is 10000 or more
- approval type "travel": manager, then HR; an advance can't exceed the estimate or the country's cash-advance cap
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ApprovalDecision, ApprovalInstance, ExpenseClaim, ExpenseReceipt, TravelRequest
from app.services import approvals as engine
from app.services.activity import record_audit

CLAIM_LIMITS: dict[str, dict[str, float]] = {
    "IN": {"max_claim": 200000, "max_cash_advance": 100000, "receipt_above": 500},
    "US": {"max_claim": 2500, "max_cash_advance": 1500, "receipt_above": 25},
    "GB": {"max_claim": 2000, "max_cash_advance": 1200, "receipt_above": 20},
    "AU": {"max_claim": 3500, "max_cash_advance": 2000, "receipt_above": 40},
    "CA": {"max_claim": 3000, "max_cash_advance": 1800, "receipt_above": 30},
    "AE": {"max_claim": 9000, "max_cash_advance": 5000, "receipt_above": 100},
    "SA": {"max_claim": 9000, "max_cash_advance": 5000, "receipt_above": 100},
    "DE": {"max_claim": 2200, "max_cash_advance": 1300, "receipt_above": 25},
}
CLAIM_WINDOW_DAYS = 90
TRAVEL_BACKDATE_DAYS = 30
OPEN_CLAIM_STATUSES = ("submitted", "approved", "paid")


class RequestError(ValueError):
    """A rule was broken (422); the message is safe to show the user."""


class Conflict(RequestError):
    """The request clashes with existing data (409)."""


def limits_for(country_code: str) -> dict[str, float]:
    return CLAIM_LIMITS.get(country_code, CLAIM_LIMITS["IN"])


def _money(amount: float, currency: str) -> str:
    return f"{currency} {amount:,.0f}"


def check_currency(requested: str | None, local: str) -> str:
    if requested and requested != local:
        raise RequestError(f"Claims and estimates are in your local currency ({local}).")
    return local


def validate_claim(
    db: Session, *, employee_id: str, country_code: str, currency: str, category: str, amount: float, on: date,
    today: date, trip_id: str | None, receipts: list[ExpenseReceipt],
) -> None:
    limits = limits_for(country_code)
    if on > today:
        raise RequestError("The expense date can't be in the future.")
    if on < today - timedelta(days=CLAIM_WINDOW_DAYS):
        raise RequestError(f"Expenses must be claimed within {CLAIM_WINDOW_DAYS} days.")
    if amount > limits["max_claim"]:
        raise RequestError(f"A single claim can't be more than {_money(limits['max_claim'], currency)}. Split it or contact Finance.")
    if amount > limits["receipt_above"] and not receipts:
        raise RequestError(f"Attach the receipt for this amount (required above {_money(limits['receipt_above'], currency)}).")
    if trip_id:
        trip = db.get(TravelRequest, trip_id)
        if trip is None or trip.employee_id != employee_id:
            raise RequestError("Choose one of your own trips.")
        if trip.status != "approved":
            raise RequestError("Expenses can only be linked to an approved trip.")
    duplicate = db.scalar(
        select(ExpenseClaim.id).where(
            ExpenseClaim.employee_id == employee_id, ExpenseClaim.expense_date == on, ExpenseClaim.category == category,
            ExpenseClaim.amount == round(amount, 2), ExpenseClaim.status.in_(OPEN_CLAIM_STATUSES),
        )
    )
    if duplicate:
        raise Conflict(f"You've already claimed this expense (same date, category and amount): {duplicate}.")


def validate_travel(
    *, country_code: str, currency: str, start: date, end: date, estimated_cost: float, advance: float, today: date
) -> None:
    if end < start:
        raise RequestError("The trip can't end before it starts.")
    if start < today - timedelta(days=TRAVEL_BACKDATE_DAYS):
        raise RequestError(f"Trips can be requested at most {TRAVEL_BACKDATE_DAYS} days after they start.")
    if (end - start).days > 365:
        raise RequestError("A trip can't be longer than a year.")
    if advance > estimated_cost:
        raise RequestError("The advance can't be more than the estimated cost.")
    cap = limits_for(country_code)["max_cash_advance"]
    if advance > cap:
        raise RequestError(f"The cash advance can't be more than {_money(cap, currency)}.")


def _last_decider(db: Session, instance: ApprovalInstance) -> str | None:
    return db.scalar(
        select(ApprovalDecision.approver_id).where(ApprovalDecision.instance_id == instance.id).order_by(ApprovalDecision.id.desc())
    ) or instance.requester_id


@engine.on_finish("expense")
def _expense_finished(db: Session, instance: ApprovalInstance) -> None:
    claim = db.get(ExpenseClaim, instance.entity_id)
    if claim is None or claim.status != "submitted" or instance.status not in ("approved", "rejected"):
        return
    claim.status = instance.status
    record_audit(db, actor_id=_last_decider(db, instance), action=f"expense_{instance.status}", entity="expense_claim",
                 entity_id=claim.id, subject_id=claim.employee_id, before={"status": "submitted"}, after={"status": claim.status})


@engine.on_finish("travel")
def _travel_finished(db: Session, instance: ApprovalInstance) -> None:
    trip = db.get(TravelRequest, instance.entity_id)
    if trip is None or trip.status != "submitted" or instance.status not in ("approved", "rejected"):
        return
    trip.status = instance.status
    record_audit(db, actor_id=_last_decider(db, instance), action=f"travel_{instance.status}", entity="travel_request",
                 entity_id=trip.id, subject_id=trip.employee_id, before={"status": "submitted"}, after={"status": trip.status})

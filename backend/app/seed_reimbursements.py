"""Travel reimbursement history for every demo sign-in (backend/seed/accounts.json).

A travel reimbursement is an expense claim linked to an approved trip (expense_claims.trip_id). Each demo person gets
one past trip and four claims on it, one per status: paid, approved (waiting for Finance), submitted (waiting for the
approver) and rejected, so the Travel reimbursements page shows a real history with approvers and paid dates.

Insert-only and idempotent: fixed ids, a row that already exists is skipped (never updated or deleted). Dates are
relative to the day the seed runs. Decided claims go through the real approval chain so the approver is recorded; if
a chain can't be completed for someone (no eligible approver), that claim is kept without an approval record.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

from sqlalchemy.orm import Session

from app.models import ApprovalInstance, Employee, ExpenseClaim, TravelRequest
from app.services.leave import today_for

ACCOUNTS = Path(__file__).resolve().parents[1] / "seed" / "accounts.json"
FINANCE = "demo-hr-admin"  # pays claims in the demo (no finance sign-in), as in app/seed_pay_claims.py

# key, from, to, purpose, mode
TRIPS: dict[str, tuple[str, str, str, str]] = {
    "emp-mahesh": ("Kochi", "Bengaluru", "Northwind integration sprint", "air"),
    "emp-priya": ("Kochi", "Chennai", "Regression test sign-off with the client", "rail"),
    "emp-oliver": ("London", "Edinburgh", "Data centre migration review", "rail"),
    "emp-ram": ("Kochi", "Mumbai", "Quarterly delivery review", "air"),
    "demo-hr-admin": ("Kochi", "Pune", "Campus hiring drive", "air"),
    "demo-recruiter": ("New York", "Boston", "University career fair", "rail"),
    "demo-ceo": ("New York", "San Francisco", "Customer advisory board", "air"),
    "demo-admin": ("London", "Dublin", "Office network rollout", "air"),
}

# Amounts per currency for each claim kind (INR / GBP / USD); other currencies use the USD figures.
AMOUNTS: dict[str, dict[str, float]] = {
    "INR": {"fare": 8640.0, "hotel": 7350.0, "meals": 1860.0, "cab": 1240.0},
    "GBP": {"fare": 148.6, "hotel": 236.0, "meals": 54.2, "cab": 38.5},
    "USD": {"fare": 412.8, "hotel": 538.0, "meals": 96.4, "cab": 64.0},
}

# suffix, category, amount kind, day of trip, description, status
CLAIMS: list[tuple[str, str, str, int, str, str]] = [
    ("fare", "Travel", "fare", 0, "Return fare for the trip", "paid"),
    ("hotel", "Accommodation", "hotel", 2, "Hotel, three nights", "approved"),
    ("meals", "Food", "meals", 1, "Meals while travelling", "submitted"),
    ("cab", "Transportation", "cab", 1, "Local cabs between the hotel and the office", "rejected"),
]
TRIP_AGO, TRIP_NIGHTS = 24, 3


def _demo_people(db: Session) -> list[Employee]:
    try:
        ids = [a.get("employee_id") or a.get("id") for a in json.loads(ACCOUNTS.read_text(encoding="utf-8"))]
    except (OSError, ValueError):
        ids = list(TRIPS)
    return [e for pid in ids if pid in TRIPS and (e := db.get(Employee, pid)) is not None]


def _run_chain(db: Session, type_: str, entity_id: str, emp: Employee, amount: float, outcome: str) -> str | None:
    """Start the real approval and decide it to `outcome` ("approved" / "rejected" / "pending"). Returns the instance id,
    or None when the chain can't be completed (nothing is left behind in that case)."""
    from app.services import approvals as engine
    from app.services.workflow_defaults import ensure_default

    ensure_default(db, type_)
    nested = db.begin_nested()
    try:
        instance: ApprovalInstance = engine.start(db, type_, entity_id, emp, amount, actor_id=emp.id)
        for _ in range(len(instance.steps) + 1):
            if outcome == "pending" or instance.status != "pending":
                break
            decided = False
            for ids in engine.open_groups(db, instance).values():
                for approver in ids:
                    try:
                        if outcome == "rejected":
                            engine.decide(db, instance, approver, "reject", note="Covered by the per diem; not claimable separately.",
                                          actor_id=approver)
                        else:
                            engine.decide(db, instance, approver, "approve", note="Matches the trip and receipts.", actor_id=approver)
                        decided = True
                        break
                    except engine.ApprovalError:
                        continue
                if decided:
                    break
            if not decided:
                break
        wanted = "pending" if outcome == "pending" else outcome
        if instance.status != wanted:
            nested.rollback()
            return None
        nested.commit()
        return instance.id
    except Exception:  # noqa: BLE001 - sample data must never stop the seed
        nested.rollback()
        return None


def _add_trip(db: Session, emp: Employee, today: date) -> tuple[TravelRequest, bool]:
    tid = f"trv-rb-{emp.id}"
    existing = db.get(TravelRequest, tid)
    if existing is not None:
        return existing, False
    src, dst, purpose, mode = TRIPS[emp.id]
    amounts = AMOUNTS.get(emp.currency, AMOUNTS["USD"])
    start = today - timedelta(days=TRIP_AGO)
    trip = TravelRequest(id=tid, employee_id=emp.id, purpose=purpose, from_location=src, to_location=dst,
                         start_date=start, end_date=start + timedelta(days=TRIP_NIGHTS), mode=mode,
                         estimated_cost=round(sum(amounts.values()) * 1.1, 2), currency=emp.currency, advance_amount=0,
                         status="submitted")
    db.add(trip)
    db.flush()
    trip.approval_instance_id = _run_chain(db, "travel", trip.id, emp, trip.estimated_cost, "approved")
    trip.status = "approved"
    db.flush()
    return trip, True


def _add_claims(db: Session, emp: Employee, trip: TravelRequest) -> int:
    if trip.status != "approved" or trip.employee_id != emp.id:
        return 0
    amounts = AMOUNTS.get(emp.currency, AMOUNTS["USD"])
    added = 0
    for suffix, category, kind, day, text, status in CLAIMS:
        cid = f"exp-rb-{emp.id}-{suffix}"
        if db.get(ExpenseClaim, cid) is not None:
            continue
        on = trip.start_date + timedelta(days=day)
        claim = ExpenseClaim(id=cid, employee_id=emp.id, category=category, amount=amounts[kind], currency=emp.currency,
                             expense_date=on, description=f"{text}: {trip.from_location} to {trip.to_location}",
                             trip_id=trip.id, status="submitted")
        db.add(claim)
        db.flush()
        outcome = {"paid": "approved", "approved": "approved", "rejected": "rejected"}.get(status, "pending")
        claim.approval_instance_id = _run_chain(db, "expense", claim.id, emp, claim.amount, outcome)
        # Nobody could be asked to approve it: record it as approved rather than leave a claim no one can decide.
        claim.status = "approved" if status == "submitted" and claim.approval_instance_id is None else status
        if status == "paid":
            claim.paid_on = trip.end_date + timedelta(days=9)
            claim.payment_reference = f"TRV-{trip.start_date:%y%m}-{emp.id[-4:].upper()}"
            claim.paid_by = FINANCE
        db.flush()
        added += 1
    return added


def seed(db: Session) -> dict[str, int]:
    db.flush()
    trips = claims = 0
    for emp in _demo_people(db):
        trip, new = _add_trip(db, emp, today_for(emp))
        trips += int(new)
        claims += _add_claims(db, emp, trip)
    return {"reimbursement_trips_added": trips, "reimbursement_claims_added": claims}

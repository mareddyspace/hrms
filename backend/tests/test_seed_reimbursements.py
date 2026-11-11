"""Travel reimbursement history (app/seed_reimbursements.py): every demo sign-in has trip-linked claims; insert-once."""

from __future__ import annotations

from sqlalchemy import func, select

from app import seed_reimbursements
from app.db import SessionLocal
from app.models import ExpenseClaim, TravelRequest
from tests.conftest import PASSWORDS, login

API = "/api/v1"


def _counts() -> tuple[int, int]:
    with SessionLocal() as db:
        return (db.scalar(select(func.count()).select_from(TravelRequest).where(TravelRequest.id.like("trv-rb-%"))) or 0,
                db.scalar(select(func.count()).select_from(ExpenseClaim).where(ExpenseClaim.id.like("exp-rb-%"))) or 0)


def test_second_run_adds_nothing(database):
    before = _counts()
    assert before[0] >= 1 and before[1] >= 4  # seed.run() in conftest already added them
    with SessionLocal() as db:
        stats = seed_reimbursements.seed(db)
        db.commit()
    assert stats == {"reimbursement_trips_added": 0, "reimbursement_claims_added": 0}
    assert _counts() == before


def test_existing_rows_are_never_changed(database):
    with SessionLocal() as db:
        claim = db.get(ExpenseClaim, "exp-rb-emp-mahesh-hotel")
        assert claim is not None
        claim.description = "Edited by the user"
        db.commit()
        seed_reimbursements.seed(db)
        db.commit()
        assert db.get(ExpenseClaim, "exp-rb-emp-mahesh-hotel").description == "Edited by the user"


def test_every_sign_in_has_travel_claim_history(client, database):
    from app.models import Account
    from tests.talent_helpers import token_for

    with SessionLocal() as db:  # signed tokens: other tests lock or change these sign-ins on purpose
        accounts = [(a.id, a.role) for a in db.query(Account).filter(Account.email.in_(list(PASSWORDS)))]
    assert len(accounts) == 8
    for account_id, role in accounts:
        email = account_id
        headers = token_for(account_id, role)
        claims = client.get(f"{API}/expenses", params={"view": "mine"}, headers=headers).json()
        trips = {t["id"]: t for t in client.get(f"{API}/travel", params={"view": "mine"}, headers=headers).json()}
        linked = [c for c in claims if c["id"].startswith("exp-rb-")]
        assert len(linked) == 4, (email, len(linked))
        for c in linked:
            trip = trips[c["trip_id"]]
            assert trip["status"] == "approved"
            assert trip["start_date"] <= c["date"] <= trip["end_date"]
            assert c["currency"] == trip["currency"]
        statuses = {c["status"] for c in linked}
        assert {"paid", "rejected"} <= statuses and len(statuses) >= 3, (email, statuses)  # other tests may pay out the approved one
        paid = [c for c in linked if c["status"] == "paid"]
        assert paid and all(c["paid_on"] and c["payment_reference"] for c in paid)


def test_decided_claims_record_their_approver(database):
    from app.models import ApprovalDecision

    with SessionLocal() as db:
        claim = db.get(ExpenseClaim, "exp-rb-emp-mahesh-cab")
        assert claim is not None and claim.status == "rejected" and claim.approval_instance_id
        decision = db.scalars(select(ApprovalDecision).where(ApprovalDecision.instance_id == claim.approval_instance_id)).first()
        assert decision is not None and decision.decision == "reject" and decision.approver_id != "emp-mahesh"
        waiting = db.get(ExpenseClaim, "exp-rb-emp-mahesh-meals")
        assert waiting is not None and waiting.status == "submitted" and waiting.approval_instance_id

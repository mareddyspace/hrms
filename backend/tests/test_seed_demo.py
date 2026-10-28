"""Demo requests seeded by app/seed_demo.py (insert-once) and the internal job board (GET /recruiting/postings)."""

from __future__ import annotations

from app.db import SessionLocal
from app.models import ExpenseClaim, Interview, Joiner, LifecycleAction, Offer, ShiftSwap, TravelRequest


def test_demo_rows_exist_once():
    with SessionLocal() as db:
        assert db.get(ExpenseClaim, "exp-seed-babu-1") is not None
        assert db.get(TravelRequest, "trv-seed-babu-1") is not None
        assert db.get(Joiner, "ob-seed-neha").employee_id == "TZ0901"
        assert db.get(LifecycleAction, "lca-seed-babu-job").requested_by == "emp-ram"
        assert db.get(ShiftSwap, "sw-seed-babu-ram").teammate_id == "emp-ram"
        assert db.get(Offer, "off-seed-lucas").status == "pending_approval"
        assert db.get(Interview, "int-seed-aisha-1").feedback_status == "submitted"


def test_babu_sees_internal_postings_without_pipeline_details(client, babu):
    res = client.get("/api/v1/recruiting/postings", headers=babu)
    assert res.status_code == 200
    rows = res.json()
    assert {"JOB-221", "JOB-218", "JOB-230"} <= {r["id"] for r in rows}
    assert "JOB-210" not in {r["id"] for r in rows} and "JOB-205" not in {r["id"] for r in rows}
    assert all(r["candidate_count"] == 0 and r["approval_id"] is None for r in rows)

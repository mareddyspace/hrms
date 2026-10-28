"""Shift rosters: coverage blocks publishing (unless allow_gaps), team override, swaps with coverage re-check."""

from __future__ import annotations

from datetime import date, timedelta

from tests.conftest import login

SH = "/api/v1/shifts"


def _monday(weeks_ahead: int) -> date:
    today = date.today()
    return today - timedelta(days=today.weekday()) + timedelta(weeks=weeks_ahead)


def _assign(client, headers, emp, d, shift):
    return client.post(f"{SH}/roster/assign", headers=headers, json={"employee_id": emp, "work_date": d.isoformat(), "shift_id": shift})


def test_seeded_shift_types(client, babu):
    ids = {s["id"] for s in client.get(f"{SH}/types", headers=babu).json()}
    assert {"sh-morning", "sh-general", "sh-evening", "sh-night", "sh-weekend"} <= ids


def test_publish_blocked_by_under_coverage(client, babu, farhan):
    jordan = login(client, "jordan.blake@timez.com")
    week = _monday(30)
    assert _assign(client, jordan, "emp-mahesh", week, "sh-general").status_code == 403  # not Jordan's team
    assert _assign(client, babu, "emp-ram", week, "sh-general").status_code == 403
    assert _assign(client, jordan, "emp-ram", week + timedelta(days=1), "sh-weekend").status_code == 409  # weekend only
    assert _assign(client, jordan, "emp-ram", week, "sh-general").status_code == 200
    res = client.post(f"{SH}/roster/publish", headers=jordan, json={"week_start": week.isoformat()})
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert "Under-covered" in detail["message"] and detail["gaps"]
    roster = client.get(f"{SH}/roster", headers=jordan, params={"week_start": week.isoformat()}).json()
    assert roster["status"] == "draft" and roster["gaps"]
    res = client.post(f"{SH}/roster/publish", headers=jordan, json={"week_start": week.isoformat(), "allow_gaps": True})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "published" and res.json()["published_with_gaps"] is True
    assert client.post(f"{SH}/roster/publish", headers=jordan, json={"week_start": week.isoformat()}).status_code == 409


def test_team_override_beats_company_default(client, farhan):
    jordan = login(client, "jordan.blake@timez.com")
    ram = login(client, "ram.krishnan@timez.com")
    # managers set only their own team; HR sets the company default
    assert client.put(f"{SH}/coverage", headers=jordan, json={"scope": "*", "shift_id": "sh-night", "weekday": 3, "minimum": 1}).status_code == 403
    assert client.put(f"{SH}/coverage", headers=ram, json={"scope": "demo-ceo", "shift_id": "sh-night", "weekday": 3, "minimum": 1}).status_code == 403
    assert client.put(f"{SH}/coverage", headers=farhan, json={"scope": "*", "shift_id": "sh-night", "weekday": 3, "minimum": 2}).status_code == 200
    week = _monday(31)
    wed = week + timedelta(days=2)
    slot = lambda: next(s for s in client.get(f"{SH}/roster", headers=jordan, params={"week_start": week.isoformat()}).json()["coverage"]  # noqa: E731
                        if s["shift_id"] == "sh-night" and s["date"] == wed.isoformat())
    assert slot()["required"] == 2  # company rule
    assert client.put(f"{SH}/coverage", headers=jordan, json={"scope": "demo-ceo", "shift_id": "sh-night", "weekday": 3, "minimum": 0}).status_code == 200
    assert slot()["required"] == 0  # team override
    client.put(f"{SH}/coverage", headers=farhan, json={"scope": "*", "shift_id": "sh-night", "weekday": 3, "minimum": 0})


def test_full_week_publishes_and_swap_is_rechecked(client, farhan):
    jordan = login(client, "jordan.blake@timez.com")
    ram = login(client, "ram.krishnan@timez.com")
    week = _monday(32)
    for i in range(5):
        d = week + timedelta(days=i)
        for emp, shift in (("emp-ram", "sh-morning"), ("demo-hr-admin", "sh-general"), ("demo-admin", "sh-evening")):
            assert _assign(client, jordan, emp, d, shift).status_code == 200, (emp, d)
    assert _assign(client, jordan, "demo-hr-admin", week + timedelta(days=5), "sh-weekend").status_code == 200
    assert _assign(client, jordan, "demo-admin", week + timedelta(days=6), "sh-weekend").status_code == 200
    # rest rule: Night on Tuesday then Morning on Wednesday is too close
    assert _assign(client, jordan, "emp-ram", week + timedelta(days=1), "sh-night").status_code == 409
    res = client.post(f"{SH}/roster/publish", headers=jordan, json={"week_start": week.isoformat()})
    assert res.status_code == 200, res.text
    assert res.json()["published_with_gaps"] is False and res.json()["gaps"] == []
    wed = (week + timedelta(days=2)).isoformat()
    res = client.post(f"{SH}/swaps", headers=ram, json={"teammate_id": "demo-hr-admin", "work_date": wed, "reason": "Dentist"})
    assert res.status_code == 201, res.text
    sid = res.json()["id"]
    assert client.post(f"{SH}/swaps/{sid}/decision", headers=jordan, json={"decision": "approve"}).status_code == 409  # teammate first
    assert client.post(f"{SH}/swaps/{sid}/respond", headers=farhan, json={"accept": True}).json()["status"] == "awaiting_manager"
    assert client.post(f"{SH}/swaps/{sid}/decision", headers=ram, json={"decision": "approve"}).status_code == 403
    assert sid in {s["id"] for s in client.get(f"{SH}/swaps", headers=jordan, params={"view": "to_decide"}).json()}
    res = client.post(f"{SH}/swaps/{sid}/decision", headers=jordan, json={"decision": "approve"})
    assert res.status_code == 200 and res.json()["status"] == "approved"
    mine = {s["work_date"]: s["shift_id"] for s in client.get(f"{SH}/mine", headers=ram).json()}
    assert mine[wed] == "sh-general"


def test_coverage_recheck_detects_new_gap(client):
    """The approval re-check: moving the only Morning person away leaves a new Morning gap."""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import RosterShift
    from app.services import shifts as rules

    week = _monday(32)  # fully covered week from the test above
    thu = week + timedelta(days=3)
    with SessionLocal() as db:
        row = db.scalar(select(RosterShift).where(RosterShift.employee_id == "emp-ram", RosterShift.work_date == thu))
        assert row is not None and row.shift_id == "sh-morning"
        before = rules.coverage_gaps(db, "demo-ceo", week, date.today())
        after = rules.coverage_gaps(db, "demo-ceo", week, date.today(), {row.id: "sh-general"})
        fresh = rules.new_gaps(before, after)
        assert [(g.date, g.shift_id) for g in fresh] == [(thu, "sh-morning")]
        assert "Morning" in rules.describe(fresh)


def test_seeded_roster_visible_to_babu(client, babu):
    week = _monday(0)
    mine = client.get(f"{SH}/mine", headers=babu, params={"from_date": week.isoformat()}).json()
    days = {s["work_date"] for s in mine}
    assert week.isoformat() in days and (week + timedelta(days=7)).isoformat() in days

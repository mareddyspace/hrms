"""Celebrations: birthdays (day and month only, hidden on request), anniversaries, new joiners, wishes as kudos."""

from __future__ import annotations

from datetime import date, timedelta

from app.db import SessionLocal
from app.models import Employee, Kudos
from app.services.leave import today_for


def _set(emp_id: str, **values) -> date:
    with SessionLocal() as db:
        emp = db.get(Employee, emp_id)
        for k, v in values.items():
            setattr(emp, k, v)
        today = today_for(emp)
        db.commit()
    return today


def test_birthday_anniversary_and_privacy(client, babu, ram):
    with SessionLocal() as db:
        today = today_for(db.get(Employee, "emp-ram"))
    _set("emp-ram", date_of_birth=date(1988, today.month, today.day) if (today.month, today.day) != (2, 29) else date(1988, 2, 28),
         hide_birthday=False)
    res = client.get("/api/v1/celebrations", headers=babu)
    assert res.status_code == 200, res.text
    rows = [r for r in res.json() if r["employee_id"] == "emp-ram" and r["kind"] == "birthday"]
    assert rows and rows[0]["date"].startswith(str(today.year))  # this year's date, never the birth year
    assert "1988" not in res.text and "date_of_birth" not in res.text

    # Ram hides his birthday: it disappears for everyone.
    out = client.put("/api/v1/celebrations/me/preferences", json={"hide_birthday": True}, headers=ram)
    assert out.status_code == 200 and out.json() == {"hide_birthday": True}
    assert client.get("/api/v1/celebrations/me/preferences", headers=ram).json()["hide_birthday"] is True
    res = client.get("/api/v1/celebrations", headers=babu)
    assert not [r for r in res.json() if r["employee_id"] == "emp-ram" and r["kind"] == "birthday"]
    client.put("/api/v1/celebrations/me/preferences", json={"hide_birthday": False}, headers=ram)

    # Work anniversary: joined 3 years ago tomorrow.
    tomorrow = today + timedelta(days=1)
    with SessionLocal() as db:
        original = db.get(Employee, "emp-ram").joining_date
    _set("emp-ram", joining_date=date(tomorrow.year - 3, tomorrow.month, tomorrow.day if (tomorrow.month, tomorrow.day) != (2, 29) else 28))
    try:
        res = client.get("/api/v1/celebrations", params={"days": 31}, headers=babu)
        ann = [r for r in res.json() if r["employee_id"] == "emp-ram" and r["kind"] == "anniversary"]
        assert ann and ann[0]["years"] == 3
    finally:
        _set("emp-ram", joining_date=original)


def test_wishes_are_kudos_without_points(client, babu, ram):
    with SessionLocal() as db:
        today = today_for(db.get(Employee, "emp-ram"))
    _set("emp-ram", date_of_birth=date(1990, today.month, min(today.day, 28)) if today.day <= 28 else date(1990, today.month, today.day),
         hide_birthday=False)
    res = client.post("/api/v1/celebrations/wishes", json={"to_id": "emp-ram", "kind": "birthday", "message": ""}, headers=babu)
    assert res.status_code == 201, res.text
    assert res.json()["wished_by_me"] is True
    with SessionLocal() as db:
        k = db.query(Kudos).filter(Kudos.from_id == "emp-mahesh", Kudos.to_id == "emp-ram", Kudos.value == "Celebration").one()
        assert k.points == 0 and "birthday" in k.message.lower()
    # Once only; and never to yourself; nothing to celebrate -> 404.
    again = client.post("/api/v1/celebrations/wishes", json={"to_id": "emp-ram", "kind": "birthday"}, headers=babu)
    assert again.status_code == 409
    assert client.post("/api/v1/celebrations/wishes", json={"to_id": "emp-mahesh", "kind": "birthday"}, headers=babu).status_code == 422
    assert client.post("/api/v1/celebrations/wishes", json={"to_id": "emp-ram", "kind": "new_joiner"}, headers=babu).status_code == 404
    # Shows on the recognition wall; points allowance untouched.
    wall = client.get("/api/v1/recognition/kudos", headers=ram).json()
    assert any(w["value"] == "Celebration" and w["to_id"] == "emp-ram" for w in wall)
    pts = client.get("/api/v1/recognition/points", headers=babu).json()
    with SessionLocal() as db:
        given = sum(k.points for k in db.query(Kudos).filter(Kudos.from_id == "emp-mahesh", Kudos.month == k.month))
    assert pts["given_this_month"] == given  # the wish added 0 points


def test_hidden_birthday_cannot_be_wished(client, babu, ram):
    with SessionLocal() as db:
        today = today_for(db.get(Employee, "emp-mahesh"))
    _set("emp-mahesh", date_of_birth=date(1994, today.month, min(today.day, 28)), hide_birthday=True)
    try:
        res = client.post("/api/v1/celebrations/wishes", json={"to_id": "emp-mahesh", "kind": "birthday"}, headers=ram)
        assert res.status_code == 404
    finally:
        _set("emp-mahesh", hide_birthday=False)

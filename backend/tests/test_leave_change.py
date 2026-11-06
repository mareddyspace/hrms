"""Leave correction: change a pending request or upcoming approved leave in one step; it is approved again."""

from __future__ import annotations

from datetime import timedelta

from tests.test_leave import _workday

R = "/api/v1/leave/requests"


def _apply(client, headers, day, reason="Family event"):
    res = client.post(R, headers=headers, json={"leave_code": "casual", "from": day.isoformat(), "to": day.isoformat(),
                                                "reason": reason})
    assert res.status_code == 201, res.text
    return res.json()


def _status(client, headers, rid):
    return next(r["status"] for r in client.get(R, headers=headers, params={"limit": 500}).json() if r["id"] == rid)


def test_change_pending_then_approved_leave(client, babu, ram, farhan):
    a = _workday(client, babu, 120)
    b = _workday(client, babu, 127)
    c = _workday(client, babu, 134)
    first = _apply(client, babu, a)

    # only the owner can change it; bad dates change nothing
    body = {"leave_code": "casual", "from": b.isoformat(), "to": b.isoformat(), "reason": "Moved by a week"}
    assert client.post(f"{R}/{first['id']}/change", headers=ram, json=body).status_code == 404
    bad = body | {"from": b.isoformat(), "to": (b - timedelta(days=3)).isoformat()}
    assert client.post(f"{R}/{first['id']}/change", headers=babu, json=bad).status_code == 422
    assert _status(client, babu, first["id"]) == "pending"

    # pending -> the old one is withdrawn, the new one waits on Ram
    res = client.post(f"{R}/{first['id']}/change", headers=babu, json=body)
    assert res.status_code == 201, res.text
    second = res.json()
    assert second["status"] == "pending" and second["from"] == b.isoformat()
    assert _status(client, babu, first["id"]) == "withdrawn"
    assert second["id"] in {p["id"] for p in client.get("/api/v1/approvals/pending", headers=ram).json()}
    assert first["id"] not in {p["id"] for p in client.get("/api/v1/approvals/pending", headers=ram).json()}

    # approved upcoming leave -> cancelled and asked again; Ram is told
    assert client.post(f"{R}/{second['id']}/decision", headers=ram, json={"decision": "approve"}).status_code == 200
    res = client.post(f"{R}/{second['id']}/change", headers=babu,
                      json={"leave_code": "casual", "from": c.isoformat(), "to": c.isoformat(), "reason": "Moved again"})
    assert res.status_code == 201, res.text
    third = res.json()
    assert _status(client, babu, second["id"]) == "cancelled" and third["status"] == "pending"
    notes = client.get("/api/v1/notifications", headers=ram, params={"limit": 100}).json()
    assert any(n["title"] == "Babu Menon changed approved leave" for n in notes)

    # a withdrawn request can't be changed
    assert client.post(f"{R}/{first['id']}/change", headers=babu, json=body).status_code == 409

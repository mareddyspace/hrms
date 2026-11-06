"""Who can message whom: reporting line + HR; HR, admins and executives anyone; managers message their whole team."""

from __future__ import annotations

from tests.conftest import login
from tests.test_audit_rbac import sample_employee

C = "/api/v1/chat"


def test_contacts_follow_the_reporting_line(client, babu, farhan):
    body = client.get(f"{C}/contacts", headers=babu).json()
    rel = {c["id"]: c["relation"] for c in body["contacts"]}
    assert body["anyone"] is False
    assert rel["emp-ram"] == "manager" and rel["emp-priya"] == "teammate" and rel["demo-hr-admin"] == "hr"
    assert "emp-mahesh" not in rel  # not yourself
    stranger = sample_employee("GB", offset=13)
    assert stranger not in rel
    assert client.get(f"{C}/contacts", headers=farhan).json()["anyone"] is True


def test_start_chat_only_with_allowed_people(client, babu, farhan):
    stranger = sample_employee("GB", offset=13)
    res = client.post(f"{C}/conversations", headers=babu, json={"kind": "direct", "member_ids": [stranger]})
    assert res.status_code == 403 and "manager, teammates" in res.json()["detail"]
    assert client.post(f"{C}/conversations", headers=babu,
                       json={"kind": "direct", "member_ids": ["emp-priya"]}).status_code == 201
    group = client.post(f"{C}/conversations", headers=babu,
                        json={"kind": "group", "title": "QA group", "member_ids": ["emp-priya", "emp-oliver"]})
    assert group.status_code == 201
    assert client.post(f"{C}/conversations/{group.json()['id']}/members", headers=babu,
                       json={"member_ids": [stranger]}).status_code == 403
    # HR can reach anyone
    assert client.post(f"{C}/conversations", headers=farhan,
                       json={"kind": "direct", "member_ids": [stranger]}).status_code == 201


def test_manager_messages_whole_team(client, babu, ram):
    first = client.post(f"{C}/team", headers=ram, json={"text": "Stand-up moves to 11:00 today."})
    assert first.status_code == 201, first.text
    convo = first.json()
    assert {"emp-mahesh", "emp-priya", "emp-oliver", "emp-ram"} <= set(convo["participant_ids"])
    assert convo["messages"][-1]["text"] == "Stand-up moves to 11:00 today."
    again = client.post(f"{C}/team", headers=ram, json={"text": "Thanks all."}).json()
    assert again["id"] == convo["id"]  # the same team chat, not a new one each time
    assert convo["id"] in {c["id"] for c in client.get(f"{C}/conversations", headers=babu).json()}
    assert client.post(f"{C}/team", headers=babu, json={"text": "x"}).status_code == 409  # Babu has no team
    oliver = login(client, "oliver.hughes@timez.com")
    notes = client.get("/api/v1/notifications", headers=oliver, params={"limit": 50}).json()
    assert any(n["title"] == "Ram Krishnan to the team" for n in notes)

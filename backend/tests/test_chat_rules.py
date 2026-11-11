"""Who can message whom: reporting line + HR; only HR reaches anyone (not the CEO or admins); managers message their team."""

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


def _unlock(*emails: str) -> None:
    """test_auth locks Alex on purpose (five wrong passwords); start these sign-ins unlocked."""
    from app.db import SessionLocal
    from app.models import Account
    from app.services import login_throttle

    with SessionLocal() as db:
        for acc in db.query(Account).filter(Account.email.in_(emails)):
            acc.failed_attempts, acc.locked_until = 0, None
        db.commit()
    login_throttle.reset()


def test_ceo_and_admin_follow_the_reporting_line_too(client, babu):
    _unlock("jordan.blake@timez.com", "alex.morgan@timez.com")
    jordan = login(client, "jordan.blake@timez.com")
    alex = login(client, "alex.morgan@timez.com")
    ceo = client.get(f"{C}/contacts", headers=jordan).json()
    admin = client.get(f"{C}/contacts", headers=alex).json()
    assert ceo["anyone"] is False and admin["anyone"] is False
    ceo_rel = {c["id"]: c["relation"] for c in ceo["contacts"]}
    assert ceo_rel["emp-ram"] == "team" and ceo_rel["demo-admin"] == "team" and "demo-ceo" not in ceo_rel
    admin_rel = {c["id"]: c["relation"] for c in admin["contacts"]}
    assert admin_rel["demo-ceo"] == "manager" and admin_rel["demo-hr-admin"] == "hr"
    assert "emp-mahesh" not in admin_rel  # not in Alex's reporting line
    res = client.post(f"{C}/conversations", headers=alex, json={"kind": "direct", "member_ids": ["emp-mahesh"]})
    assert res.status_code == 403
    # the whole manager chain counts: Babu can reach the CEO (Ram's manager)
    rel = {c["id"]: c["relation"] for c in client.get(f"{C}/contacts", headers=babu).json()["contacts"]}
    assert rel["demo-ceo"] == "manager"


def test_contacts_are_alphabetical(client, babu):
    names = [c["name"] for c in client.get(f"{C}/contacts", headers=babu).json()["contacts"]]
    assert names == sorted(names, key=str.casefold)


def test_confidential_thread_cannot_smuggle_in_strangers(client, babu):
    stranger = sample_employee("GB", offset=13)
    res = client.post(f"{C}/conversations", headers=babu, json={
        "kind": "group", "title": "x", "member_ids": ["demo-hr-admin", stranger], "restricted": "hr_confidential"})
    assert res.status_code == 403

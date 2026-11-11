"""Sample mail and chats for every demo sign-in (app/seed_comms.py): inbox, sent, conversations; insert-once."""

from __future__ import annotations

from sqlalchemy import func, select

from app import seed_comms
from app.db import SessionLocal
from app.models import ChatConversation, MailMessage
from tests.conftest import PASSWORDS, login

API = "/api/v1"


def _seed_once() -> None:
    with SessionLocal() as db:
        seed_comms.seed(db)
        db.commit()


def test_second_run_adds_nothing(database):
    _seed_once()
    with SessionLocal() as db:
        before = (db.scalar(select(func.count()).select_from(MailMessage)),
                  db.scalar(select(func.count()).select_from(ChatConversation)))
        stats = seed_comms.seed(db)
        db.commit()
        after = (db.scalar(select(func.count()).select_from(MailMessage)),
                 db.scalar(select(func.count()).select_from(ChatConversation)))
    assert stats == {"comms_mail_added": 0, "comms_chats_added": 0}
    assert before == after


def test_every_sign_in_has_inbox_sent_and_chats(client, database):
    _seed_once()
    for email in PASSWORDS:
        headers = login(client, email)
        me = client.get(f"{API}/auth/me", headers=headers).json()["employee_id"]
        mail = client.get(f"{API}/mail", headers=headers).json()
        inbox = [m for m in mail if me in m["to_ids"] or me in m["cc_ids"]]
        sent = [m for m in mail if m["from_id"] == me]
        assert len(inbox) >= 4 and len(sent) >= 2, (email, len(inbox), len(sent))
        assert len({m["sent_at"][:10] for m in inbox}) >= 3, email  # spread over the past weeks
        assert all(m["category"] in {"Leave", "Attendance", "Work from home", "Pay", "General"}
                   for m in mail if m["id"].startswith("ml-comms-"))
        chats = client.get(f"{API}/chat/conversations", headers=headers).json()
        assert any(c["messages"] for c in chats), email


def test_seeded_chats_follow_the_messaging_rule(client, database):
    _seed_once()
    with SessionLocal() as db:
        convs = list(db.scalars(select(ChatConversation).where(ChatConversation.id.like("cv-comms-%"))))
        members = {c.id: (c.created_by, [m.person_id for m in c.members]) for c in convs}
    emails = {"emp-oliver": "oliver.hughes@timez.com", "emp-priya": "priya.nair@timez.com",
              "demo-ceo": "jordan.blake@timez.com", "demo-admin": "alex.morgan@timez.com",
              "demo-recruiter": "sophie.clark@timez.com", "demo-hr-admin": "farhan.ali@timez.com"}
    for creator, people in members.values():
        body = client.get(f"{API}/chat/contacts", headers=login(client, emails[creator])).json()
        allowed = {c["id"] for c in body["contacts"]}
        assert body["anyone"] or all(p in allowed for p in people if p != creator), (creator, people)

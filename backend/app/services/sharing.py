"""Helpers for the shared chat, mail, task, announcement and calendar routers, and their sample rows."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Announcement, CalendarAttendee, CalendarEvent, ChatConversation, ChatMember, ChatMessage, Employee, MailMessage,
    MailRecipient, Notification, SharedTask,
)
from app.services.activity import notify
from app.services.scope import HR_ROLES
from app.services.tickets import TEAMMATES, person_exists, person_name  # noqa: F401  (re-exported)

ADMIN_ROLES = frozenset({"admin", "super_admin"})

BABU, RAM, FARHAN, SOPHIE, JORDAN, ALEX, PRIYA = (
    "emp-mahesh", "emp-ram", "demo-hr-admin", "demo-recruiter", "demo-ceo", "demo-admin", "emp-priya")


def now() -> datetime:
    return datetime.now(timezone.utc)


def is_hr(role: str) -> bool:
    return role in HR_ROLES


def is_admin(role: str) -> bool:
    return role in ADMIN_ROLES


def tell(db: Session, recipient: str | None, actor_id: str | None, title: str, body: str, href: str,
         *, merge: bool = False) -> None:
    """In-app notification for someone with an employee record. With `merge`, an unread note with the same link is
    refreshed instead of adding another (a busy chat thread is one bell item, not fifty)."""
    if not recipient or recipient == actor_id or db.get(Employee, recipient) is None:
        return
    if merge:
        old = db.scalar(select(Notification).where(Notification.recipient_id == recipient, Notification.href == href,
                                                   Notification.read_at.is_(None)).limit(1))
        if old is not None:
            old.title, old.body, old.created_at = title[:200], body, now()
            return
    notify(db, recipient_id=recipient, title=title[:200], body=body, href=href)


def managed_ids(db: Session, user: Any) -> set[str]:
    """Everyone below this person, including directory-only teammates of people they manage."""
    me = user.employee_id
    reports = set(user.scope.reports or set())
    above = {me, *reports}
    reports |= {pid for pid, (_, manager) in TEAMMATES.items() if manager in above}
    reports.discard(me)
    return reports


def _ts(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# ---------- sample rows (same ids as the portal's browser seeds) ----------

_CHATS: list[dict[str, Any]] = [
    {"id": "cv-1", "kind": "direct", "title": "Ram Krishnan", "members": [BABU, RAM], "messages": [
        ("m1", RAM, "Can you update the timesheet before Friday standup?", "2026-10-13T10:32:00Z", None),
        ("m2", BABU, "Will do — drafting now.", "2026-10-13T10:40:00Z", None)], "read": {RAM: "2026-10-13T10:41:00Z",
                                                                                         BABU: "2026-10-13T10:40:00Z"}},
    {"id": "cv-2", "kind": "direct", "title": "Farhan Ali", "members": [BABU, FARHAN], "messages": [
        ("m3", FARHAN, "Your policy acknowledgement is still open — ping me if the link fails.", "2026-10-10T05:50:00Z",
         None)], "read": {BABU: "2026-10-10T06:00:00Z"}},
    {"id": "cv-3", "kind": "group", "title": "Engineering Bengaluru", "members": [BABU, RAM, PRIYA], "messages": [
        ("m4", RAM, "Sprint demo moved to Thursday 4pm IST.", "2026-10-14T02:45:00Z", None),
        ("m5", PRIYA, "Secure coding module due end of month — please enroll.", "2026-10-14T03:30:00Z",
         "secure-coding-outline.txt")], "read": {}},
    {"id": "cv-hr-1", "kind": "direct", "title": "Farhan Ali · Employee relations", "members": [FARHAN, SOPHIE],
     "restricted": "hr_confidential", "messages": [
        ("m-hr-1", SOPHIE, "ER intake logged for case #ER-204 — keep this thread HR-only.", "2026-10-11T04:30:00Z",
         None)], "read": {FARHAN: "2026-10-11T05:00:00Z"}},
]

_MAIL: list[dict[str, Any]] = [
    {"id": "ml-seed-1", "thread": "th-seed-wfh", "from": BABU, "to": [RAM], "category": "Work from home",
     "subject": "Work from home request – 3 and 4 November", "at": "2026-10-21T04:12:00Z", "read": [RAM],
     "body": "Hi Ram,\n\nI'd like to work from home on 3 and 4 November. We have a plumber and electrician scheduled at "
             "home both days. I'll be online for the sprint review.\n\nCould we discuss if that works for the team?\n\n"
             "Thanks,\nBabu"},
    {"id": "ml-seed-2", "thread": "th-seed-wfh", "from": RAM, "to": [BABU], "category": "Work from home",
     "subject": "Re: Work from home request – 3 and 4 November", "at": "2026-10-21T09:40:00Z", "read": [],
     "body": "Hi Babu,\n\nThat's fine. Please join the sprint review on video and make sure the release checklist is "
             "updated before Monday. Raise the WFH request in the portal so it's on record.\n\nRegards,\nRam"},
    {"id": "ml-seed-3", "thread": "th-seed-payslip", "from": SOPHIE, "to": [FARHAN], "category": "Pay",
     "subject": "Question about my October payslip", "at": "2026-10-24T14:05:00Z", "read": [],
     "body": "Hi Farhan,\n\nMy October payslip doesn't show the referral bonus for the September hire. Could you check "
             "whether it moves to the November run?\n\nThanks,\nSophie"},
    {"id": "ml-seed-4", "thread": "th-seed-attendance", "from": BABU, "to": [RAM], "category": "Attendance",
     "subject": "Missed punch on 23 October", "at": "2026-10-26T05:30:00Z", "read": [],
     "body": "Hi Ram,\n\nThe biometric reader at the main gate was down on 23 October so my check-in wasn't recorded. "
             "I was in office from 9:30 to 18:15. I've raised a regularisation request.\n\nThanks,\nBabu"},
]


def _task(tid: str, code: str, subject: str, status: str, due: str, notes: str, *, accepted: bool, progress: int,
          created: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    data = {
        "id": tid, "code": code, "employeeId": BABU, "subject": subject, "priority": "medium", "status": status,
        "assignedBy": "Ram", "owner": "Babu", "department": "Engineering", "role": "Software Engineer",
        "managerName": "Ram", "client": "Internal Engineering", "projectName": "Sprint 42", "notes": notes,
        "blocked": "", "automationNote": "Assigned by Ram", "createdAt": created, "estimatedHours": 2,
        "hoursSpent": 0, "score": 75, "lastActivityAt": created, "due": due, "progressPct": progress,
        "accepted": accepted, "subtasks": [], "attachments": [], "comments": [], "peopleIds": [], "ccIds": [],
        "activity": [{"id": f"act-{tid}-1", "at": created, "actor": "Ram", "action": "Assigned",
                      "detail": "Assigned to Babu"}],
    }
    data.update(extra or {})
    return data


_TASKS: list[dict[str, Any]] = [
    _task("task-1b", "TSK-1048", "Update sprint burndown notes for standup", "progress", "2026-11-04",
          "Refresh the burndown chart and note blockers before standup.", accepted=True, progress=45,
          created="2026-10-27T09:00:00", extra={"priority": "medium", "comments": [
              {"id": "c-1b", "author": "Ram", "text": "Keep the note under half a page.", "at": "2026-10-28T11:00:00"}]}),
    _task("task-srv-2", "TSK-1061", "Review the Northwind invoice export fix", "open", "2026-11-06",
          "Check the GST column on multi-state invoices before the client demo.", accepted=False, progress=0,
          created="2026-10-29T10:00:00", extra={"priority": "high", "client": "Northwind Billing",
                                                "projectName": "Northwind Billing"}),
]

_ANNOUNCEMENTS: list[dict[str, Any]] = [
    {"id": "an-1", "title": "Q4 All-hands", "scope": "Company", "audience": "All TimeZ", "state": "Published",
     "published_at": "2026-10-08T10:00:00Z", "author_id": None, "author_name": "Internal Comms",
     "body": "Join the global all-hands on 22 Oct. Agenda covers roadmap, hiring, and wellbeing resources."},
    {"id": "an-2", "title": "India Dussehra holiday calendar", "scope": "Country", "audience": "IN",
     "state": "Published", "published_at": "2026-10-01T09:00:00Z", "author_id": FARHAN, "author_name": "Farhan Ali",
     "body": "Bengaluru and Hyderabad offices follow the published holiday calendar. Confirm WFH coverage with your "
             "manager."},
    {"id": "an-3", "title": "Engineering on-call rotation update", "scope": "Department", "audience": "Engineering",
     "state": "Published", "published_at": "2026-10-11T12:00:00Z", "author_id": RAM, "author_name": "Ram Krishnan",
     "body": "New rotation starts 20 Oct. Managers: update the wiki before Friday."},
    {"id": "an-5", "title": "Updated code of conduct", "scope": "Company", "audience": "All TimeZ",
     "state": "Published", "published_at": "2026-10-28T09:00:00Z", "author_id": FARHAN, "author_name": "Farhan Ali",
     "must_acknowledge": True,
     "body": "The code of conduct now covers client data on personal devices. Read it and acknowledge by 7 Nov."},
]

_EVENTS: list[dict[str, Any]] = [
    {"id": "cal-srv-1", "kind": "meeting", "title": "Sprint 43 planning", "day": "2026-11-03", "time": "10:00",
     "location": "Conf · Orion", "owner": RAM, "attendees": [BABU, PRIYA],
     "description": "Bring estimates for the Northwind and Maple tickets."},
    {"id": "cal-srv-2", "kind": "meeting", "title": "Quarterly check-in", "day": "2026-11-05", "time": "15:30",
     "location": "Video call", "owner": RAM, "attendees": [BABU], "description": "Goals, feedback and training."},
]


def seed_samples(db: Session) -> int:
    """Insert-once by id; rows people changed are left alone."""
    added = 0
    for c in _CHATS:
        if db.get(ChatConversation, c["id"]) is not None:
            continue
        conv = ChatConversation(id=c["id"], kind=c["kind"], title=c["title"], restricted=c.get("restricted"),
                                created_by=c["members"][0])
        for pid in c["members"]:
            read = c["read"].get(pid)
            conv.members.append(ChatMember(person_id=pid, name=person_name(db, pid),
                                           last_read_at=_ts(read) if read else None))
        for mid, sender, text, at, attachment in c["messages"]:
            conv.messages.append(ChatMessage(id=mid, from_id=sender, from_name=person_name(db, sender), text=text,
                                             attachment_name=attachment, at=_ts(at)))
        db.add(conv)
        added += 1
    for m in _MAIL:
        if db.get(MailMessage, m["id"]) is not None:
            continue
        msg = MailMessage(id=m["id"], thread_id=m["thread"], from_id=m["from"], from_name=person_name(db, m["from"]),
                          subject=m["subject"], body=m["body"], category=m["category"], sent_at=_ts(m["at"]))
        for pid in m["to"]:
            msg.recipients.append(MailRecipient(person_id=pid, kind="to",
                                                read_at=_ts(m["at"]) if pid in m["read"] else None))
        db.add(msg)
        added += 1
    for t in _TASKS:
        if db.get(SharedTask, t["id"]) is not None:
            continue
        db.add(SharedTask(id=t["id"], code=t["code"], assignee_id=t["employeeId"], created_by=RAM, people_ids=[],
                          status=t["status"], due=date.fromisoformat(t["due"]), data=t, version=1))
        added += 1
    for a in _ANNOUNCEMENTS:
        if db.get(Announcement, a["id"]) is not None:
            continue
        db.add(Announcement(id=a["id"], title=a["title"], body=a["body"], scope=a["scope"], audience=a["audience"],
                            state=a["state"], published_at=_ts(a["published_at"]), author_id=a["author_id"],
                            author_name=a["author_name"], must_acknowledge=a.get("must_acknowledge", False)))
        added += 1
    for e in _EVENTS:
        if db.get(CalendarEvent, e["id"]) is not None:
            continue
        ev = CalendarEvent(id=e["id"], kind=e["kind"], title=e["title"], day=date.fromisoformat(e["day"]),
                           time=e["time"], location=e["location"], description=e["description"], owner_id=e["owner"])
        for pid in e["attendees"]:
            ev.attendees.append(CalendarAttendee(person_id=pid, response="pending"))
        db.add(ev)
        added += 1
    return added

"""Work ticket rules (same as src/data/ticketStore.ts): who sees a ticket, who may assign, plan and move it, and the
sample tickets. People are employee ids; the engineering teammates below are portal-only people (no employees row)
who report to Ram, exactly as src/demoAccounts.ts TEAMMATE_REPORTS_TO."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Employee, Ticket, TicketEvent, TicketTask
from app.services.scope import HR_ROLES, manager_chain_ids

TYPES = ("IT support", "HR query", "Bug", "Client issue", "Access request")
PRIORITIES = ("low", "medium", "high", "urgent")
STATUSES = ("Open", "In progress", "Waiting", "Resolved", "Closed")
OPEN_STATUSES = ("Open", "In progress", "Waiting")
ADMIN_ROLES = frozenset({"admin", "super_admin", "it_admin"})
IT_TYPES = frozenset({"IT support", "Access request"})

BABU, RAM, PRIYA, KABIR, ALEX, FARHAN = "emp-mahesh", "emp-ram", "emp-priya", "emp-kabir", "demo-admin", "demo-hr-admin"

# IT and access requests go to the IT desk; HR queries to HR. Others wait for a manager to assign.
QUEUE_OWNER = {"IT support": ALEX, "Access request": ALEX, "HR query": FARHAN}

# Portal-only engineering teammates: id -> (name, manager id).
TEAMMATES: dict[str, tuple[str, str]] = {
    PRIYA: ("Priya Nair", RAM),
    "emp-anu": ("Anu Rao", RAM),
    KABIR: ("Kabir Sharma", RAM),
    "emp-diya": ("Diya Patel", RAM),
}


def person_exists(db: Session, person_id: str) -> bool:
    return person_id in TEAMMATES or db.get(Employee, person_id) is not None


def person_name(db: Session, person_id: str | None) -> str:
    if not person_id:
        return "Unassigned"
    if person_id in TEAMMATES:
        return TEAMMATES[person_id][0]
    emp = db.get(Employee, person_id)
    return emp.full_name if emp else person_id


def chain(db: Session, person_id: str | None) -> list[str]:
    """Managers above this person, nearest first."""
    if not person_id:
        return []
    if person_id in TEAMMATES:
        manager = TEAMMATES[person_id][1]
        return [manager, *manager_chain_ids(db, manager)]
    return manager_chain_ids(db, person_id)


def manages(db: Session, manager_id: str | None, person_id: str | None) -> bool:
    return bool(manager_id and person_id) and manager_id in chain(db, person_id)


def is_open(t: Ticket) -> bool:
    return t.status in OPEN_STATUSES


def can_view(db: Session, t: Ticket, actor_id: str, role: str) -> bool:
    if actor_id in (t.requester_id, t.assignee_id, t.sub_owner_id) or actor_id in (t.watcher_ids or []):
        return True
    if any(k.owner_id == actor_id for k in t.tasks):
        return True
    if role in ADMIN_ROLES and t.type in IT_TYPES:
        return True
    if role in HR_ROLES and t.type == "HR query":
        return True
    return manages(db, actor_id, t.requester_id) or manages(db, actor_id, t.assignee_id)


def can_plan(db: Session, t: Ticket, actor_id: str) -> bool:
    """Owner, sub-owner, requester and the owner's managers change who works on it, the deadline and its tasks."""
    if not is_open(t):
        return False
    return actor_id in (t.assignee_id, t.sub_owner_id, t.requester_id) or manages(db, actor_id, t.assignee_id)


def next_statuses(t: Ticket, actor_id: str) -> list[str]:
    out: list[str] = []
    if t.assignee_id == actor_id:
        out += {"Open": ["In progress", "Waiting", "Resolved"], "In progress": ["Waiting", "Resolved"],
                "Waiting": ["In progress", "Resolved"]}.get(t.status, [])
    if t.requester_id == actor_id and t.status == "Resolved":
        out += ["Closed", "In progress"]
    return list(dict.fromkeys(out))


def next_id(db: Session) -> str:
    ids = db.scalars(select(Ticket.id)).all()
    top = max((int("".join(c for c in i if c.isdigit()) or 0) for i in ids), default=1000)
    return f"TCK-{max(top, 1000) + 1}"


def add_event(t: Ticket, by_id: str, kind: str, text: str, at: datetime | None = None) -> None:
    t.events.append(TicketEvent(by_id=by_id, kind=kind, text=text, at=at or datetime.now(timezone.utc)))


# ---------- sample tickets (src/data/ticketStore.ts seed) ----------

_IST = timezone(timedelta(hours=5, minutes=30))


def _at(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=_IST).astimezone(timezone.utc)


def _d(text: str | None) -> date | None:
    return date.fromisoformat(text) if text else None


SAMPLES: list[dict] = [
    dict(id="TCK-1042", title="Maple portal logs users out after 5 minutes",
         description="Clinic staff lose unsaved notes. Session timeout should be 30 minutes per the SOW.",
         type="Bug", priority="high", status="Open", project_id="p-maple", project_name="Maple Clinic Portal",
         requester_id=KABIR, assignee_id=BABU, sub_owner_id=PRIYA, watcher_ids=[RAM], due="2026-10-30",
         tasks=[("tt-1042-1", "Reproduce the logout on staging", BABU, "2026-10-27", True),
                ("tt-1042-2", "Set session timeout to 30 minutes", BABU, "2026-10-29", False),
                ("tt-1042-3", "Test with clinic staff accounts", PRIYA, "2026-10-30", False)],
         events=[("2026-10-26T10:12:00", KABIR, "created", "Raised the ticket."),
                 ("2026-10-26T11:05:00", RAM, "assigned", "Assigned to Babu Menon.")]),
    dict(id="TCK-1041", title="Monitor flickers on the docking station",
         description="External monitor blinks every few seconds when the laptop is docked. Desk B-14.",
         type="IT support", priority="medium", status="Open", requester_id=RAM, assignee_id=ALEX, due="2026-10-29",
         events=[("2026-10-23T09:40:00", RAM, "created", "Raised the ticket.")]),
    dict(id="TCK-1040", title="Northwind sends duplicate payment reminders",
         description="Customers on the monthly plan get two reminder emails. Started after the 15 Oct release.",
         type="Client issue", priority="urgent", status="In progress", project_id="p-north", project_name="Northwind Billing",
         requester_id=RAM, assignee_id=KABIR, watcher_ids=[BABU], due="2026-10-28",
         events=[("2026-10-21T14:20:00", RAM, "created", "Raised the ticket."),
                 ("2026-10-21T14:22:00", RAM, "assigned", "Assigned to Kabir Sharma."),
                 ("2026-10-22T10:05:00", KABIR, "status", "Open → In progress"),
                 ("2026-10-22T16:30:00", KABIR, "comment", "Reminder job runs twice after the cron change. Fix in review.")]),
    dict(id="TCK-1039", title="Invoice export drops the GST column",
         description="CSV export from the Northwind invoice list has no GST column for multi-state invoices.",
         type="Bug", priority="high", status="In progress", project_id="p-north", project_name="Northwind Billing",
         requester_id=PRIYA, assignee_id=BABU, due="2026-10-29",
         events=[("2026-10-19T11:00:00", PRIYA, "created", "Raised the ticket."),
                 ("2026-10-19T11:30:00", RAM, "assigned", "Assigned to Babu Menon."),
                 ("2026-10-20T09:45:00", BABU, "status", "Open → In progress")]),
    dict(id="TCK-1038", title="VPN access for Maple staging",
         description="Need VPN profile for the Maple staging network to reproduce client issues.",
         type="Access request", priority="medium", status="Waiting", project_id="p-maple", project_name="Maple Clinic Portal",
         requester_id=KABIR, assignee_id=ALEX, watcher_ids=[RAM],
         events=[("2026-10-20T10:10:00", KABIR, "created", "Raised the ticket."),
                 ("2026-10-20T15:00:00", ALEX, "status", "Open → Waiting"),
                 ("2026-10-20T15:01:00", ALEX, "comment", "Waiting on manager approval for staging access.")]),
    dict(id="TCK-1037", title="Form 16 from previous employer",
         description="How do I add last employer's Form 16 to this year's tax declaration?",
         type="HR query", priority="low", status="Closed", requester_id=PRIYA, assignee_id=FARHAN,
         events=[("2026-10-08T12:00:00", PRIYA, "created", "Raised the ticket."),
                 ("2026-10-09T10:00:00", FARHAN, "comment", "Upload it under Tax declarations → Previous employment."),
                 ("2026-10-09T10:01:00", FARHAN, "status", "Open → Resolved"),
                 ("2026-10-09T17:20:00", PRIYA, "status", "Resolved → Closed")]),
    dict(id="TCK-1036", title="Laptop battery drains in two hours",
         description="Battery health shows 61%. Need a replacement before the client visit.",
         type="IT support", priority="medium", status="Resolved", requester_id=BABU, assignee_id=ALEX,
         events=[("2026-10-12T09:15:00", BABU, "created", "Raised the ticket."),
                 ("2026-10-13T11:00:00", ALEX, "status", "Open → In progress"),
                 ("2026-10-15T16:40:00", ALEX, "comment", "Battery replaced. Please confirm and close."),
                 ("2026-10-15T16:41:00", ALEX, "status", "In progress → Resolved")]),
    dict(id="TCK-1035", title="Billing report totals off by a rupee",
         description="Monthly summary rounds each line before summing. Totals differ from the ledger by ₹1–₹3.",
         type="Bug", priority="low", status="Waiting", project_id="p-north", project_name="Northwind Billing",
         requester_id=BABU, assignee_id=PRIYA, watcher_ids=[RAM], due="2026-11-04",
         events=[("2026-10-14T13:30:00", BABU, "created", "Raised the ticket."),
                 ("2026-10-14T14:00:00", RAM, "assigned", "Assigned to Priya Nair."),
                 ("2026-10-16T10:20:00", PRIYA, "status", "Open → Waiting"),
                 ("2026-10-16T10:21:00", PRIYA, "comment", "Waiting on Northwind finance to confirm the rounding rule.")]),
]


def seed_samples(db: Session) -> int:
    """Insert the sample tickets once (by id); existing tickets are never changed."""
    if db.get(Employee, BABU) is None or db.get(Employee, RAM) is None:
        return 0
    added = 0
    for s in SAMPLES:
        if db.get(Ticket, s["id"]) is not None:
            continue
        events = s["events"]
        created, updated = _at(events[0][0]), _at(events[-1][0])
        t = Ticket(id=s["id"], title=s["title"], description=s["description"], type=s["type"], priority=s["priority"],
                   status=s["status"], project_id=s.get("project_id"), project_name=s.get("project_name"),
                   requester_id=s["requester_id"], assignee_id=s.get("assignee_id"), sub_owner_id=s.get("sub_owner_id"),
                   watcher_ids=list(s.get("watcher_ids", [])), due=_d(s.get("due")), created_at=created, updated_at=updated)
        for i, (tid, title, owner, due, done) in enumerate(s.get("tasks", [])):
            t.tasks.append(TicketTask(id=tid, position=i, title=title, owner_id=owner, due=_d(due), done=done, created_at=created))
        for at, by, kind, text in events:
            add_event(t, by, kind, text, _at(at))
        db.add(t)
        added += 1
    db.flush()
    return added

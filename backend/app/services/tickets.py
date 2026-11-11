"""Work ticket rules (same as src/data/ticketStore.ts): who sees a ticket, who may assign, plan and move it, and the
sample tickets. People are employee ids; the engineering teammates below are portal-only people (no employees row)
who report to Ram, exactly as src/demoAccounts.ts TEAMMATE_REPORTS_TO."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Employee, Ticket, TicketCategory, TicketEvent, TicketTask
from app.services.scope import HR_ACCESS_ROLES, manager_chain_ids

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


# Service targets per category for a medium-priority ticket: (first response hours, resolve hours, queue owner).
# Stored in ticket_categories (HR / admin edit them); these are the defaults inserted once.
DEFAULT_CATEGORIES: dict[str, tuple[int, int, str | None]] = {
    "IT support": (4, 24, ALEX),
    "Access request": (4, 24, ALEX),
    "HR query": (8, 72, FARHAN),
    "Bug": (8, 72, None),
    "Client issue": (2, 24, None),
}
SYSTEM = "system"  # by_id of events the app writes itself (escalation)
# Urgent work is due four times sooner than medium; low gets twice as long.
PRIORITY_FACTOR = {"urgent": 0.25, "high": 0.5, "medium": 1.0, "low": 2.0}


def ensure_categories(db: Session) -> int:
    """Insert the default categories that are missing (never changes an existing one)."""
    added = 0
    for name, (resp, resolve, owner) in DEFAULT_CATEGORIES.items():
        if db.get(TicketCategory, name) is None:
            db.add(TicketCategory(name=name, response_hours=resp, resolve_hours=resolve, queue_owner_id=owner, active=True))
            added += 1
    if added:
        db.flush()
    return added


def category_hours(db: Session, ticket_type: str) -> tuple[int, int, str | None]:
    row = db.get(TicketCategory, ticket_type)
    if row is not None:
        return row.response_hours, row.resolve_hours, row.queue_owner_id
    return DEFAULT_CATEGORIES.get(ticket_type, (8, 72, None))


def queue_owner(db: Session, ticket_type: str) -> str | None:
    owner = category_hours(db, ticket_type)[2]
    return owner if owner and person_exists(db, owner) else QUEUE_OWNER.get(ticket_type)


def targets(db: Session, ticket_type: str, priority: str, start: datetime) -> tuple[datetime, datetime]:
    """(respond by, resolve by) for a ticket of this type and priority raised at `start`."""
    resp, resolve, _ = category_hours(db, ticket_type)
    f = PRIORITY_FACTOR.get(priority, 1.0)
    return start + timedelta(hours=resp * f), start + timedelta(hours=resolve * f)


def _aware(d: datetime | None) -> datetime | None:
    return d.replace(tzinfo=timezone.utc) if d is not None and d.tzinfo is None else d


def effective_targets(db: Session, t: Ticket) -> tuple[datetime, datetime]:
    """Stored targets, or (older tickets raised before targets were stored) the category's targets from creation."""
    if t.response_due_at and t.resolve_due_at:
        return _aware(t.response_due_at), _aware(t.resolve_due_at)  # type: ignore[return-value]
    return targets(db, t.type, t.priority, _aware(t.created_at) or datetime.now(timezone.utc))


def first_response(t: Ticket) -> datetime | None:
    """When someone other than the requester first replied or moved the ticket (stored, else from its history)."""
    if t.first_response_at:
        return _aware(t.first_response_at)
    for e in t.events:
        if e.by_id not in (t.requester_id, SYSTEM) and e.kind in ("status", "comment") and not e.internal:
            return _aware(e.at)
    return None


def sla_state(db: Session, t: Ticket, now: datetime | None = None) -> str:
    """met | breached (resolved late, or open past the target) | soon (within a quarter of the window) | ok."""
    now = now or datetime.now(timezone.utc)
    _, resolve_by = effective_targets(db, t)
    if not is_open(t):
        done = _aware(t.resolved_at) or _aware(t.updated_at) or now
        return "met" if done <= resolve_by else "breached"
    if now > resolve_by:
        return "breached"
    window = resolve_by - (_aware(t.created_at) or now)
    return "soon" if (resolve_by - now) <= window / 4 else "ok"


def is_agent(db: Session, t: Ticket, actor_id: str, role: str) -> bool:
    """People working the ticket (not the requester): they see and write internal notes."""
    if actor_id == t.requester_id and actor_id != t.assignee_id:
        return False
    if actor_id in (t.assignee_id, t.sub_owner_id) or any(k.owner_id == actor_id for k in t.tasks):
        return True
    if role in ADMIN_ROLES and t.type in IT_TYPES:
        return True
    if role in HR_ACCESS_ROLES and t.type == "HR query":
        return True
    return manages(db, actor_id, t.assignee_id)


def escalation_target(db: Session, t: Ticket) -> str | None:
    """The owner's manager, or the queue owner when nobody owns it."""
    above = chain(db, t.assignee_id) if t.assignee_id else []
    return above[0] if above else queue_owner(db, t.type)


def escalate_overdue(db: Session, now: datetime | None = None) -> list[Ticket]:
    """Open tickets past their stored resolve target are escalated once (event + notifications)."""
    from app.services.activity import notify

    now = now or datetime.now(timezone.utc)
    out: list[Ticket] = []
    rows = db.scalars(select(Ticket).where(Ticket.status.in_(OPEN_STATUSES), Ticket.escalated_at.is_(None),
                                           Ticket.resolve_due_at.is_not(None))).all()
    for t in rows:
        if _aware(t.resolve_due_at) > now:  # type: ignore[operator]
            continue
        t.escalated_at = now
        target = escalation_target(db, t)
        add_event(t, SYSTEM, "status",
                  f"Resolve target missed — escalated to {person_name(db, target)}." if target else "Resolve target missed.")
        for person in dict.fromkeys([target, t.assignee_id]):
            if person and db.get(Employee, person) is not None:
                notify(db, recipient_id=person, title=f"{t.id} missed its resolve target",
                       body=f"{t.title} — {t.priority} {t.type}, owner {person_name(db, t.assignee_id)}.",
                       href=f"/tickets?id={t.id}")
        out.append(t)
    if out:
        db.flush()
    return out


def run_escalation(db: Session, day, send) -> int:  # type: ignore[no-untyped-def]
    """Background job hook (app/services/jobs.py)."""
    return len(escalate_overdue(db))


def person_exists(db: Session, person_id: str) -> bool:
    return person_id in TEAMMATES or db.get(Employee, person_id) is not None


def person_name(db: Session, person_id: str | None) -> str:
    if not person_id:
        return "Unassigned"
    if person_id == SYSTEM:
        return "TimeZ"
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
    if role in HR_ACCESS_ROLES and t.type == "HR query":
        return True
    return manages(db, actor_id, t.requester_id) or manages(db, actor_id, t.assignee_id)


def can_plan(db: Session, t: Ticket, actor_id: str) -> bool:
    """Owner, sub-owner, requester and the owner's managers change who works on it, the deadline and its tasks."""
    if not is_open(t):
        return False
    return actor_id in (t.assignee_id, t.sub_owner_id, t.requester_id) or manages(db, actor_id, t.assignee_id)


def can_take(db: Session, t: Ticket, actor_id: str, role: str) -> bool:
    """Who may pick up (assign to themselves) an open ticket they don't own: a manager of the requester or of the
    current owner, the IT desk for IT / access requests and HR for HR queries."""
    if not is_open(t) or t.assignee_id == actor_id:
        return False
    if role in ADMIN_ROLES and t.type in IT_TYPES:
        return True
    if role in HR_ACCESS_ROLES and t.type == "HR query":
        return True
    return manages(db, actor_id, t.requester_id) or manages(db, actor_id, t.assignee_id)


def next_statuses(t: Ticket, actor_id: str) -> list[str]:
    out: list[str] = []
    if t.assignee_id == actor_id:
        out += {"Open": ["In progress", "Waiting", "Resolved"], "In progress": ["Waiting", "Resolved"],
                "Waiting": ["In progress", "Resolved"]}.get(t.status, [])
    if t.requester_id == actor_id and t.status == "Resolved":
        out += ["Closed", "In progress"]
    # The requester may withdraw a ticket nobody has started on yet.
    if t.requester_id == actor_id and t.status == "Open":
        out += ["Closed"]
    return list(dict.fromkeys(out))


def next_id(db: Session) -> str:
    ids = db.scalars(select(Ticket.id)).all()
    top = max((int("".join(c for c in i if c.isdigit()) or 0) for i in ids), default=1000)
    return f"TCK-{max(top, 1000) + 1}"


def add_event(t: Ticket, by_id: str, kind: str, text: str, at: datetime | None = None, internal: bool = False) -> None:
    t.events.append(TicketEvent(by_id=by_id, kind=kind, text=text, at=at or datetime.now(timezone.utc), internal=internal))


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
    # HR, recruiting, CEO and IT desk samples, so every demo sign-in has tickets to work on.
    dict(id="TCK-1034", title="October payslip shows old HRA",
         description="HRA on my October payslip is still the pre-revision amount. Revision letter dated 1 Oct.",
         type="HR query", priority="high", status="Open", requester_id=BABU, assignee_id=FARHAN, due="2026-11-03",
         events=[("2026-10-28T09:20:00", BABU, "created", "Raised the ticket.")]),
    dict(id="TCK-1033", title="Relocation allowance for Pune move",
         description="Moving to the Pune office from 1 Dec. Which relocation allowance and documents apply?",
         type="HR query", priority="medium", status="In progress", requester_id=RAM, assignee_id=FARHAN, due="2026-11-06",
         events=[("2026-10-24T15:10:00", RAM, "created", "Raised the ticket."),
                 ("2026-10-25T10:00:00", FARHAN, "status", "Open → In progress"),
                 ("2026-10-25T10:02:00", FARHAN, "comment", "Checking the India mobility policy. Will confirm the amount.")]),
    dict(id="TCK-1032", title="LinkedIn Recruiter seat for Q4 hiring",
         description="Need a Recruiter Lite seat to source senior engineers for the Maple and Northwind openings.",
         type="Access request", priority="medium", status="Open", requester_id="demo-recruiter", assignee_id=ALEX,
         watcher_ids=[FARHAN], due="2026-11-05",
         events=[("2026-10-27T11:30:00", "demo-recruiter", "created", "Raised the ticket.")]),
    dict(id="TCK-1031", title="Offer letter template for UAE hires",
         description="UAE offers need the labour-contract clause and housing allowance line. Current template has neither.",
         type="HR query", priority="high", status="Waiting", requester_id="demo-recruiter", assignee_id=FARHAN, due="2026-11-02",
         events=[("2026-10-22T12:00:00", "demo-recruiter", "created", "Raised the ticket."),
                 ("2026-10-23T09:30:00", FARHAN, "status", "Open → Waiting"),
                 ("2026-10-23T09:31:00", FARHAN, "comment", "Waiting on legal to share the approved clause.")]),
    dict(id="TCK-1030", title="Board room screen does not detect laptop",
         description="HDMI and USB-C both fail in the 4th floor board room. Board call on Friday.",
         type="IT support", priority="urgent", status="Open", requester_id="demo-ceo", assignee_id=ALEX, due="2026-10-31",
         tasks=[("tt-1030-1", "Test the HDMI switcher", ALEX, "2026-10-30", False),
                ("tt-1030-2", "Keep a spare USB-C adapter in the room", ALEX, "2026-10-31", False)],
         events=[("2026-10-29T08:45:00", "demo-ceo", "created", "Raised the ticket.")]),
    dict(id="TCK-1029", title="Timesheet export misses weekend hours",
         description="Weekly export for the Maple team drops Saturday entries. Needs an owner.",
         type="Bug", priority="medium", status="Open", project_id="p-maple", project_name="Maple Clinic Portal",
         requester_id=RAM, watcher_ids=["demo-ceo"],
         events=[("2026-10-29T17:05:00", RAM, "created", "Raised the ticket.")]),
]

# More sample tickets for every sign-in person (insert-once by id, like the ones above).
OLIVER, SOPHIE, JORDAN = "emp-oliver", "demo-recruiter", "demo-ceo"
SAMPLES += [
    dict(id="TCK-1050", title="VPN drops every hour on the London network",
         description="The VPN disconnects about once an hour from the London office Wi-Fi; at home it is fine.",
         type="IT support", priority="high", status="Open", requester_id=OLIVER, assignee_id=ALEX, due="2026-11-10",
         events=[("2026-11-03T09:10:00", OLIVER, "created", "Raised the ticket.")]),
    dict(id="TCK-1051", title="Payslip shows the wrong tax code",
         description="My October payslip shows tax code 1257L but HMRC sent me 1185L.",
         type="HR query", priority="medium", status="In progress", requester_id=OLIVER, assignee_id=FARHAN, due="2026-11-12",
         events=[("2026-11-02T14:00:00", OLIVER, "created", "Raised the ticket."),
                 ("2026-11-03T10:15:00", FARHAN, "status", "Open → In progress"),
                 ("2026-11-03T10:16:00", FARHAN, "comment", "Checking the code with the payroll provider.")]),
    dict(id="TCK-1052", title="Access to the ATS for interview panel",
         description="New interviewers for JOB-221 need read access to candidate profiles in the ATS.",
         type="Access request", priority="medium", status="Open", requester_id=SOPHIE, assignee_id=ALEX, due="2026-11-11",
         watcher_ids=[RAM], events=[("2026-11-04T11:30:00", SOPHIE, "created", "Raised the ticket.")]),
    dict(id="TCK-1053", title="Offer letter template missing the UK notice clause",
         description="The UK offer letter template has no notice period paragraph; JOB-218 offer is waiting.",
         type="HR query", priority="high", status="Waiting", requester_id=SOPHIE, assignee_id=FARHAN, due="2026-11-09",
         events=[("2026-11-01T16:20:00", SOPHIE, "created", "Raised the ticket."),
                 ("2026-11-02T09:00:00", FARHAN, "status", "Open → Waiting"),
                 ("2026-11-02T09:01:00", FARHAN, "comment", "Waiting for legal to confirm the clause wording.")]),
    dict(id="TCK-1054", title="Board pack needs headcount by legal entity",
         description="For the Q4 board pack: headcount and joiners/leavers per legal entity, as of 31 October.",
         type="HR query", priority="medium", status="Resolved", requester_id=JORDAN, assignee_id=FARHAN, due="2026-11-05",
         events=[("2026-10-30T08:45:00", JORDAN, "created", "Raised the ticket."),
                 ("2026-11-04T17:10:00", FARHAN, "status", "In progress → Resolved"),
                 ("2026-11-04T17:11:00", FARHAN, "comment", "Report shared in the board folder.")]),
    dict(id="TCK-1055", title="Laptop battery swells",
         description="The laptop battery is bulging and the trackpad no longer clicks. Needs replacement.",
         type="IT support", priority="urgent", status="In progress", requester_id=JORDAN, assignee_id=ALEX, due="2026-11-07",
         events=[("2026-11-05T08:00:00", JORDAN, "created", "Raised the ticket."),
                 ("2026-11-05T08:20:00", ALEX, "status", "Open → In progress"),
                 ("2026-11-05T08:21:00", ALEX, "comment", "Loaner laptop ready at the IT desk.")]),
    dict(id="TCK-1056", title="Leave balance didn't carry forward",
         description="My 3 unused casual leave days from 2025 are not in my 2026 balance.",
         type="HR query", priority="low", status="Open", requester_id=PRIYA, assignee_id=FARHAN, due="2026-11-14",
         events=[("2026-11-04T12:00:00", PRIYA, "created", "Raised the ticket.")]),
    dict(id="TCK-1057", title="Globex migration script times out on large tenants",
         description="The data migration for Globex fails after 30 minutes on tenants with more than 2 million rows.",
         type="Bug", priority="high", status="Open", project_id="prj-globex", project_name="Globex cloud migration",
         requester_id=RAM, assignee_id=PRIYA, sub_owner_id=BABU, watcher_ids=[KABIR], due="2026-11-13",
         tasks=[("tt-1057-1", "Batch the copy in 100k-row chunks", PRIYA, "2026-11-10", False),
                ("tt-1057-2", "Re-run on the largest tenant", BABU, "2026-11-12", False)],
         events=[("2026-11-03T15:30:00", RAM, "created", "Raised the ticket."),
                 ("2026-11-03T15:31:00", RAM, "assigned", "Assigned to Priya Nair.")]),
    dict(id="TCK-1058", title="Add Oliver to the UK on-call rota",
         description="Oliver joins the UK support rota from 17 November; needs PagerDuty access.",
         type="Access request", priority="low", status="Closed", requester_id=RAM, assignee_id=ALEX, due="2026-11-06",
         events=[("2026-11-01T10:00:00", RAM, "created", "Raised the ticket."),
                 ("2026-11-03T11:00:00", ALEX, "status", "Open → Closed"),
                 ("2026-11-03T11:01:00", ALEX, "comment", "Access granted and tested.")]),
    dict(id="TCK-1059", title="Expense claim stuck in approval",
         description="My travel claim from 20 October still shows 'waiting on finance'.",
         type="HR query", priority="medium", status="Open", requester_id=BABU, assignee_id=FARHAN, due="2026-11-12",
         events=[("2026-11-05T09:45:00", BABU, "created", "Raised the ticket.")]),
]


def seed_samples(db: Session) -> int:
    """Insert the sample tickets once (by id); existing tickets are never changed."""
    if db.get(Employee, BABU) is None or db.get(Employee, RAM) is None:
        return 0
    ensure_categories(db)
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

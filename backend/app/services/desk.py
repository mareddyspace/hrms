"""HR service desk rules (same as the portal, src/data/collabData.ts + collabLocal.ts).

- Each category routes to an owner and has a resolution target in working days (Mon-Fri).
- Nobody works their own ticket: when the routed owner raised it, it stays unassigned for HR to pick up.
- The SLA clock runs while the ticket is Open or In progress ("Waiting on you" pauses it).
- First response: the first comment or status change by HR / the owner.
- Overdue tickets are escalated once by the SLA job (or by hand): priority goes up one level and HR leads are told.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import Account, DeskTicket
from app.services.activity import notify, record_audit
from app.services.scope import HR_ROLES

CATEGORIES = ("Payroll provider", "Benefits", "Documents", "IT access", "Leave", "Profile correction", "Other")
PRIORITIES = ("Low", "Normal", "High", "Urgent")
STATUSES = ("Open", "In progress", "Waiting on you", "Resolved", "Closed")
CLOCK_RUNNING = ("Open", "In progress")
OPEN_STATUSES = ("Open", "In progress", "Waiting on you")

# category -> (owner employee id, working days to resolve)
SLA: dict[str, tuple[str, int]] = {
    "Payroll provider": ("demo-hr-admin", 2),
    "Benefits": ("demo-hr-admin", 3),
    "Documents": ("demo-hr-admin", 3),
    "IT access": ("demo-admin", 1),
    "Leave": ("demo-hr-admin", 2),
    "Profile correction": ("demo-hr-admin", 2),
    "Other": ("demo-hr-admin", 3),
}
DESK_ROLES = HR_ROLES | {"admin"}


def add_working_days(start: datetime, days: int) -> datetime:
    current = start
    left = days
    while left > 0:
        current += timedelta(days=1)
        if current.weekday() < 5:
            left -= 1
    return current


def due_at(category: str, submitted: datetime) -> datetime:
    return add_working_days(submitted, SLA.get(category, SLA["Other"])[1])


def route(category: str, requester_id: str) -> str | None:
    owner = SLA.get(category, SLA["Other"])[0]
    return None if owner == requester_id else owner


def is_overdue(ticket: DeskTicket, now: datetime | None = None) -> bool:
    return ticket.status in CLOCK_RUNNING and ticket.due_at is not None and ticket.due_at < (now or utcnow())


def bump(priority: str) -> str:
    i = PRIORITIES.index(priority) if priority in PRIORITIES else 1
    return PRIORITIES[min(i + 1, len(PRIORITIES) - 1)]


def desk_staff(db: Session) -> list[str]:
    """Employee ids of HR and admin accounts (who work the desk)."""
    return list(db.scalars(select(Account.employee_id).where(
        Account.role.in_(DESK_ROLES), Account.active.is_(True), Account.employee_id.is_not(None)).order_by(Account.employee_id)))


def escalate(db: Session, ticket: DeskTicket, actor_id: str | None, reason: str = "SLA overdue") -> list[str]:
    """Raise priority, mark escalated and tell the owner and the other desk staff. Returns who was told."""
    before = {"priority": ticket.priority, "escalation_level": ticket.escalation_level}
    ticket.priority = bump(ticket.priority)
    ticket.escalation_level = (ticket.escalation_level or 0) + 1
    ticket.escalated_at = utcnow()
    recipients = [i for i in dict.fromkeys([ticket.assignee_id, *desk_staff(db)]) if i and i != ticket.requester_id]
    for rid in recipients:
        notify(db, recipient_id=rid, title=f"HR request escalated · {ticket.subject}"[:200],
               body=f"{ticket.category} request {ticket.id} is past its due time ({reason}). Priority is now {ticket.priority}.",
               href=f"/help?request={ticket.id}")
    record_audit(db, actor_id=actor_id, action="desk_ticket_escalated", entity="desk_ticket", entity_id=ticket.id,
                 subject_id=ticket.requester_id, before=before,
                 after={"priority": ticket.priority, "escalation_level": ticket.escalation_level, "reason": reason})
    return recipients


def escalate_overdue(db: Session, now: datetime | None = None) -> int:
    """SLA job: escalate every overdue ticket not escalated yet."""
    now = now or utcnow()
    count = 0
    for ticket in db.scalars(select(DeskTicket).where(DeskTicket.status.in_(CLOCK_RUNNING), DeskTicket.due_at < now,
                                                      DeskTicket.escalated_at.is_(None))):
        escalate(db, ticket, None)
        count += 1
    return count

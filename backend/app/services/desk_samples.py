"""Sample help desk requests so Request history and the HR / IT queue are not empty on a new database.
Insert-once by id; requests people changed are left alone."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import DeskTicket, DeskTicketComment, Employee
from app.services.desk import due_at

BABU, RAM, FARHAN, SOPHIE, ALEX = "emp-mahesh", "emp-ram", "demo-hr-admin", "demo-recruiter", "demo-admin"


def _ts(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


# id, requester, category, subcategory, contact, priority, status, assignee, submitted, subject, comments [(at, by, text)]
SAMPLES = [
    ("hr-sample-001", BABU, "Payroll provider", "Payslip query", "email", "High", "In progress", FARHAN,
     "2026-10-28T05:10:00Z", "HRA missing from October payslip",
     [("2026-10-28T05:10:00Z", BABU, "My October payslip shows HRA at the old rate. The revision letter is dated 1 October."),
      ("2026-10-28T09:40:00Z", FARHAN, "Thanks Babu. I've asked the payroll provider to recheck the October run."),
      ("2026-10-29T04:15:00Z", BABU, "Thanks. Will the difference come in November?")]),
    ("hr-sample-002", BABU, "Documents", "Employment letter", "email", "Normal", "Resolved", FARHAN,
     "2026-10-14T06:00:00Z", "Employment letter for home loan",
     [("2026-10-14T06:00:00Z", BABU, "I need an employment letter with salary details for my bank (HDFC)."),
      ("2026-10-15T08:30:00Z", FARHAN, "The signed letter is under Documents > Letters. Marking this resolved.")]),
    ("hr-sample-003", BABU, "Leave", "Leave balance", "chat", "Normal", "Open", FARHAN,
     "2026-10-20T07:30:00Z", "Carry-forward days not added",
     [("2026-10-20T07:30:00Z", BABU, "My 4 carry-forward days from last year are not in my balance.")]),
    ("hr-sample-004", RAM, "IT access", "Laptop / hardware", "phone", "Urgent", "Waiting on you", ALEX,
     "2026-10-29T03:00:00Z", "Laptop will not boot after update",
     [("2026-10-29T03:00:00Z", RAM, "Laptop stuck on the logo after last night's update. Client call at 3 pm."),
      ("2026-10-29T03:40:00Z", ALEX, "Can you bring it to the IT desk on floor 3, or share a good time to call?")]),
    ("hr-sample-005", SOPHIE, "Benefits", "Health insurance", "email", "Normal", "Open", FARHAN,
     "2026-10-29T15:20:00Z", "Add spouse to health plan",
     [("2026-10-29T15:20:00Z", SOPHIE, "I got married in October. How do I add my spouse to the medical plan?")]),
]


def seed(db: Session) -> int:
    added = 0
    for (tid, requester, cat, sub, contact, prio, status, assignee, submitted, subject, comments) in SAMPLES:
        if db.get(DeskTicket, tid) is not None or db.get(Employee, requester) is None:
            continue
        at = _ts(submitted)
        replies = [c for c in comments if c[1] != requester]
        t = DeskTicket(id=tid, requester_id=requester, category=cat, subcategory=sub, contact_preference=contact,
                       subject=subject, description=comments[0][2], priority=prio, status=status,
                       assignee_id=assignee if db.get(Employee, assignee) else None, submitted_at=at,
                       due_at=due_at(cat, at), first_response_at=_ts(replies[0][0]) if replies else None,
                       resolved_at=_ts(comments[-1][0]) if status in ("Resolved", "Closed") else None,
                       escalation_level=0, created_at=at, updated_at=_ts(comments[-1][0]))
        db.add(t)
        db.flush()
        for when, by, text in comments:
            db.add(DeskTicketComment(ticket_id=tid, author_id=by, text=text, system=False, created_at=_ts(when)))
        added += 1
    db.flush()
    return added

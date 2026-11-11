"""Due-date reminders for shared tasks (/tasks), run with the other background jobs (app/services/jobs.py).

Open tasks due tomorrow or today remind the owner; overdue tasks remind the owner, and from two days late also
whoever assigned it. At most once per day per task and person (reminder_log, through the jobs' _send helper).
Scheduled tasks (start later) and done tasks are skipped.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import SharedTask


def send_task_reminders(db: Session, today: date, send: Callable[..., bool]) -> int:
    sent = 0
    rows = db.scalars(select(SharedTask).where(SharedTask.status.in_(("open", "progress")), SharedTask.due.is_not(None),
                                               SharedTask.due <= today + timedelta(days=1)))
    for t in rows:
        subject = str((t.data or {}).get("subject") or t.code)
        href = f"/tasks?task={t.id}"
        late = (today - t.due).days  # type: ignore[operator]
        if late < 0:
            title, body = f"Task due tomorrow · {t.code}", f"{subject} is due tomorrow."
        elif late == 0:
            title, body = f"Task due today · {t.code}", f"{subject} is due today."
        else:
            title, body = f"Task overdue · {t.code}", f"{subject} is {late} day{'s' if late != 1 else ''} past its due date."
        sent += send(db, f"task:{t.id}", t.assignee_id, today, "task_due", title, body, href)
        if late >= 2 and t.created_by and t.created_by != t.assignee_id:
            sent += send(db, f"task:{t.id}", t.created_by, today, "task_due", title, body, href)
    return sent

"""Ask AI counts every open task and ticket exactly (not just the first 8 it lists)."""
from datetime import date, timedelta

from app.db import SessionLocal
from app.models import Employee, SharedTask
from app.services.ai_more_context import work_items_block


def test_open_task_count_is_exact():
    with SessionLocal() as db:
        me = db.get(Employee, "emp-mahesh")
        for i in range(12):
            db.add(SharedTask(id=f"tsk-count-{i}", code=f"T-CNT-{i}", assignee_id=me.id, created_by="emp-ram",
                              people_ids=[], status="open" if i % 2 else "progress",
                              due=date.today() + timedelta(days=i - 3), data={"subject": f"Count check {i}"}))
        db.flush()
        expected = sum(1 for t in db.query(SharedTask).filter(SharedTask.assignee_id == me.id, SharedTask.status != "done"))
        block = work_items_block(db, me)
        db.rollback()
    assert f"Open tasks assigned to you: {expected} " in block
    assert expected >= 12

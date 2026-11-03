"""Project details for the six sample projects (migration 0025): description, dates, hours budget, manager, member
roles, milestones, tasks, an update and some activity. Same content as the portal's local sample
(src/data/projectCatalog.ts).

Safe to run again and on a database people already use: a field is only filled while empty, and milestones / tasks /
posts / activity are only added to a project that has none yet (so edits and deletions are never undone). Shift types
get a location while they have none."""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Employee, Project, ProjectActivity, ProjectMember, ProjectMilestone, ProjectPost, ProjectTask,
)
from app.models.shifts import ShiftType

D = date.fromisoformat
BABU, RAM = "emp-mahesh", "emp-ram"
# Ram's other two engineers: (title, budget hours, responsibilities) on every project they join.
TEAMMATE_ROLES: dict[str, tuple[str, float, str]] = {
    "emp-priya": ("Tech lead", 160, "Architecture, code reviews and release planning."),
    "emp-oliver": ("QA engineer", 120, "Test plans, regression runs and release sign-off."),
}

# id: (description, start, end, budget h, Babu's title, Babu's budget h, Babu's responsibilities)
DETAILS: dict[str, tuple[str, str, str | None, float, str, float, str]] = {
    "p-north": ("Rebuild of the Northwind invoicing and payment collection system, moving billing runs off the legacy "
                "batch jobs.", "2024-11-04", "2026-12-18", 2400, "Frontend developer", 320,
                "Invoice and payment screens, exports and front-end tests."),
    "p-maple": ("Patient portal for Maple clinics: appointments, reports and secure messages with doctors.",
                "2026-02-02", "2027-03-26", 1600, "Full-stack developer", 240,
                "Lab report viewer and downloads, appointment reminders."),
    "prj-hrms": ("The TimeZ HRMS portal itself: leave, time, pay and people modules.", "2026-01-05", "2026-12-31", 1200,
                 "Developer", 200, "Roster and holiday screens, timesheet review."),
    "prj-internal": ("Meetings, training, hiring interviews and admin time.", "2026-01-01", "2026-12-31", 600,
                     "Member", 160, "Team meetings, training and interviews."),
    "prj-acme": ("Customer portal for Acme Corp: orders, returns and support tickets in one place.", "2026-04-06",
                 "2027-01-29", 900, "Frontend developer", 180, "Returns and order history screens."),
    "prj-globex": ("Moving Globex's on-premise apps to the cloud with zero downtime.", "2026-05-04", "2027-02-26", 800,
                   "Developer", 120, "Pilot app smoke tests and cut-over runbooks."),
}

# id: [(name, due, done, description)]
MILESTONES: dict[str, list[tuple[str, str, bool, str]]] = {
    "p-north": [("Discovery and design", "2025-01-31", True, "Workshops with finance, process maps and screen designs."),
                ("Invoice engine", "2025-06-30", True, "New invoice generation replacing the nightly batch."),
                ("Payment gateway", "2026-03-31", True, "Card and bank payments with reconciliation."),
                ("Customer self-service", "2026-11-13", False, "Customers see, download and dispute invoices."),
                ("Go-live", "2026-12-18", False, "Cut-over from the legacy billing system.")],
    "p-maple": [("Requirements sign-off", "2026-03-13", True, "Scope agreed with the clinic leads."),
                ("Appointments module", "2026-08-28", True, "Booking, rescheduling and reminders."),
                ("Lab reports", "2026-11-27", False, "Patients see and download their lab reports."),
                ("Secure messaging", "2027-02-12", False, "Messages between patients and doctors."),
                ("Launch", "2027-03-26", False, "Live for all clinics.")],
    "prj-hrms": [("Leave and attendance", "2026-03-31", True, "Leave requests, balances and attendance."),
                 ("Timesheets", "2026-06-30", True, "Daily timesheets with approvals."),
                 ("Payroll", "2026-09-30", True, "Monthly payroll runs and payslips."),
                 ("Shifts and roster", "2026-11-27", False, "Rosters, swaps and comp-off."),
                 ("Year-end release", "2026-12-31", False, "Year-end fixes and reports.")],
    "prj-internal": [("H1 training plan", "2026-06-30", True, "Training for the first half of the year."),
                     ("H2 training plan", "2026-12-31", False, "Training for the second half of the year.")],
    "prj-acme": [("Orders", "2026-07-31", True, "Order list, details and tracking."),
                 ("Returns", "2026-11-20", False, "Return requests and refunds."),
                 ("Support tickets", "2027-01-29", False, "Customers raise and follow support tickets.")],
    "prj-globex": [("Assessment", "2026-06-12", True, "Inventory of apps and dependencies."),
                   ("Pilot migration", "2026-10-16", False, "Two pilot apps moved to the cloud."),
                   ("Full cut-over", "2027-02-26", False, "All apps running in the cloud.")],
}

# id: [(code, title, due, status, estimate, assignee, description)]
TASKS: dict[str, list[tuple[str, str, str, str, float, str, str]]] = {
    "p-north": [("NW-412", "Invoice list filters and export", "2026-11-06", "in_progress", 12, BABU,
                 "Filter invoices by status, customer and date, and export the list to Excel."),
                ("NW-418", "Payment status timeline", "2026-11-12", "todo", 8, BABU,
                 "Show each payment's steps (initiated, authorised, settled) on the invoice page."),
                ("NW-401", "Dunning email preview", "2026-10-23", "in_review", 6, BABU,
                 "Preview the reminder email before it is sent to a customer."),
                ("NW-388", "Credit note form", "2026-10-09", "done", 10, BABU, "Raise a credit note against an invoice."),
                ("NW-420", "Go-live cut-over plan", "2026-12-04", "todo", 16, RAM, "Plan the switch from the legacy system.")],
    "p-maple": [("MC-207", "Lab report viewer", "2026-11-10", "in_progress", 16, BABU,
                 "Show a patient's lab results with reference ranges."),
                ("MC-211", "Report download as PDF", "2026-11-20", "todo", 6, BABU, "Download a lab report as a PDF."),
                ("MC-199", "Appointment reminders", "2026-10-16", "done", 8, BABU, "Text and email reminders a day before.")],
    "prj-hrms": [("HR-301", "Roster grid colours", "2026-11-05", "in_progress", 6, BABU, "Colour each shift on the roster grid."),
                 ("HR-305", "Optional holiday picker", "2026-11-14", "todo", 8, BABU, "Pick optional holidays from the list."),
                 ("HR-290", "Team timesheet review", "2026-10-30", "in_review", 10, BABU, "Managers approve days in one place.")],
    "prj-internal": [("INT-12", "Complete security awareness course", "2026-11-30", "todo", 2, BABU,
                      "The yearly security course in Learning.")],
    "prj-acme": [("AC-140", "Return request form", "2026-11-09", "in_progress", 10, BABU, "Customers request a return."),
                 ("AC-133", "Order history paging", "2026-10-19", "done", 4, BABU, "Page through older orders.")],
    "prj-globex": [("GX-57", "Pilot app smoke tests", "2026-11-04", "in_progress", 8, BABU,
                    "Run the smoke tests on the two pilot apps after the move.")],
}

ACTIVITY: dict[str, list[tuple[str, str, str]]] = {
    "p-north": [("2026-10-27", RAM, "Signed off the payment gateway milestone"),
                ("2026-10-24", RAM, "Moved the go-live review to 4 Dec")],
    "p-maple": [("2026-10-28", RAM, "Flagged lab reports as at risk: the clinic data feed is late")],
    "prj-hrms": [("2026-10-20", RAM, "Planned the year-end release")],
    "prj-internal": [("2026-10-15", RAM, "Opened H2 training sign-ups")],
    "prj-acme": [("2026-10-26", RAM, "Returns API ready for testing")],
    "prj-globex": [("2026-10-19", RAM, "Pilot moved two weeks: firewall approval pending")],
}

UPDATES: dict[str, str] = {
    "p-north": "Customer self-service is on track for 13 Nov. Go-live review moved to 4 Dec.",
    "p-maple": "Lab reports are at risk: the clinic's data feed is two weeks late. We are building against sample data.",
    "prj-globex": "Pilot migration slipped: firewall approval is still pending with Globex IT.",
}


def seed(db: Session) -> dict[str, int]:
    added = {"project_details": 0, "project_milestones": 0, "project_tasks": 0}
    if db.get(Employee, RAM) is None:
        return added
    for pid, (desc, start, end, budget, title, my_budget, duties) in DETAILS.items():
        project = db.get(Project, pid)
        if project is None:
            continue
        filled = False
        for field, value in (("description", desc), ("start_date", D(start)), ("end_date", D(end) if end else None),
                             ("budget_hours", budget), ("manager_id", RAM)):
            if getattr(project, field) is None and value is not None:
                setattr(project, field, value)
                filled = True
        added["project_details"] += int(filled)
        for member in db.scalars(select(ProjectMember).where(ProjectMember.project_id == pid)):
            if member.title is None:
                if member.employee_id == BABU:
                    member.title, member.responsibilities, member.budget_hours = title, duties, my_budget
                elif member.employee_id in TEAMMATE_ROLES:
                    member.title, member.budget_hours, member.responsibilities = TEAMMATE_ROLES[member.employee_id]
                elif member.employee_id == RAM:
                    member.title = "Project manager"
                    member.responsibilities = "Plans the work, runs reviews, approves time and owns the client relationship."
                else:
                    member.title, member.responsibilities = "Stakeholder", "Reviews progress and joins the monthly review."
        if db.scalar(select(ProjectMilestone.id).where(ProjectMilestone.project_id == pid).limit(1)) is None:
            for i, (name, due, done, mdesc) in enumerate(MILESTONES.get(pid, [])):
                db.add(ProjectMilestone(id=f"pm-seed-{pid}-{i}", project_id=pid, name=name, description=mdesc,
                                        due_date=D(due), completed_on=D(due) if done else None))
                added["project_milestones"] += 1
        if db.scalar(select(ProjectTask.id).where(ProjectTask.project_id == pid).limit(1)) is None:
            for code, ttitle, due, status, est, who, tdesc in TASKS.get(pid, []):
                assignee = who if db.get(ProjectMember, (pid, who)) else None
                db.add(ProjectTask(id=f"pt-seed-{code.lower()}", project_id=pid, code=code, title=ttitle, description=tdesc,
                                   assignee_id=assignee, due_date=D(due), estimate_hours=est, status=status))
                added["project_tasks"] += 1
        if db.scalar(select(ProjectActivity.id).where(ProjectActivity.project_id == pid).limit(1)) is None:
            for i, (on, who, text) in enumerate(ACTIVITY.get(pid, [])):
                db.add(ProjectActivity(id=f"pa-seed-{pid}-{i}", project_id=pid, actor_id=who, text=text, happened_on=D(on)))
        if pid in UPDATES and db.scalar(select(ProjectPost.id).where(ProjectPost.project_id == pid).limit(1)) is None:
            db.add(ProjectPost(id=f"pp-seed-{pid}", project_id=pid, author_id=RAM, kind="update", body=UPDATES[pid]))
    for shift in db.scalars(select(ShiftType).where(ShiftType.location.is_(None))):
        shift.location = "Kochi office"
    db.flush()
    return added

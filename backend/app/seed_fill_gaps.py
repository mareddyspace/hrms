"""Fill the blanks left on people's pages after every other seeder has run (runs last in app/seed.py).

Insert-only / fill-blanks-only, so it is safe on the live database:
- a row is only added for a person / project that has none of that kind yet, with a fixed id (``gap-...``);
- a column is only set while it is empty (NULL); nothing is ever updated if it has a value, nothing is deleted.
Every value is derived from ids (no randomness) and dates are relative to the day the seed runs, so a second run adds
and changes nothing.

1. Praise: 1-2 messages for every active person who has received none, from their manager or a teammate.
2. Certifications: role-appropriate ones for the eight demo sign-ins who have none.
3. Cash advance and leave encashment history for the admin, HR director and recruiter who have none (encashment only
   where the country allows it: privilege leave in India). The CEO is skipped: those pages are not on the CEO's menu.
4. Project posts and documents (links, no file) for every active project that has none.
5. Open assignment rows with no job profile: the profile of the person's position, else the one with their job title.
6. Career profiles with no mentor: a more senior colleague in the same department (same country first), else the
   skip-level manager.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    CareerProfile,
    CashAdvance,
    Certification,
    Employee,
    EmployeeAssignment,
    EncashmentRequest,
    JobProfile,
    PerfFeedback,
    Position,
    Project,
    ProjectDocument,
    ProjectMember,
    ProjectPost,
)

HR, ADMIN, RECRUITER, CEO = "demo-hr-admin", "demo-admin", "demo-recruiter", "demo-ceo"
DEMO_IDS = ("emp-mahesh", "emp-priya", "emp-oliver", "emp-ram", HR, RECRUITER, CEO, ADMIN)
ENCASH_COUNTRIES = ("IN",)  # privilege leave can be encashed in India only (policyLibrary.ts)


def _h(*parts: object) -> int:
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:12], 16)


def _at(day: date, hour: int = 10) -> datetime:
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return datetime.combine(day, time(hour, 0), tzinfo=UTC)


def _level(emp: Employee) -> int:
    grade = emp.grade or ""
    if grade.startswith("G") and grade[1:].isdigit():
        return {3: 2, 4: 2, 5: 3, 6: 3, 7: 3, 8: 4, 9: 4}.get(int(grade[1:]), 3)
    return {"L3": 2, "L4": 2, "L5": 3, "L6": 3, "M1": 4, "M2": 4, "M3": 4, "E1": 5}.get(grade, 3)


class _Ctx:
    def __init__(self, db: Session, today: date) -> None:
        self.today = today
        everyone = list(db.scalars(select(Employee).order_by(Employee.id)))
        self.by_id = {e.id: e for e in everyone}
        self.active = [e for e in everyone if e.employment_status in ("Active", "On Leave") and e.joining_date <= today
                       and (e.last_working_day is None or e.last_working_day >= today)]
        self.active_ids = {e.id for e in self.active}
        self.reports: dict[str, list[str]] = defaultdict(list)
        for e in self.active:
            if e.manager_id:
                self.reports[e.manager_id].append(e.id)


# ---------- 1. praise ----------
BADGES = ("Teamwork", "Ownership", "Customer focus", "Quality", "Going the extra mile", "Problem solving")
PRAISE_TEXT = (
    "Thank you for stepping in at short notice and getting it over the line.",
    "Really clear write-up this week; it saved everyone a meeting.",
    "Great job keeping things calm and moving during a busy month.",
    "Thanks for helping a new joiner find their feet so quickly.",
    "Your attention to detail caught an issue before it reached anyone outside the team.",
    "Thanks for sharing what you learned with the rest of the team.",
    "You turned a messy request into a simple plan everyone could follow.",
    "Appreciate how quickly you answered every question on this one.",
)


def _praise(db: Session, ctx: _Ctx) -> int:
    have = set(db.scalars(select(PerfFeedback.to_id).where(PerfFeedback.kind == "praise").distinct()))
    rows = []
    for emp in ctx.active:
        if emp.id in have:
            continue
        senders: list[str] = []
        if emp.manager_id and emp.manager_id in ctx.active_ids:
            senders.append(emp.manager_id)
        peers = sorted((i for i in ctx.reports.get(emp.manager_id or "", []) if i != emp.id), key=lambda i: _h(emp.id, i, "peer"))
        senders += peers[:1]
        if not senders:  # nobody above: one of their own team
            senders += sorted(ctx.reports.get(emp.id, []), key=lambda i: _h(emp.id, i, "rep"))[:1]
        senders = senders[: 1 + _h(emp.id, "praise-n") % 2]
        for n, sender in enumerate(senders):
            hv = _h(emp.id, sender, "praise")
            day = ctx.today - timedelta(days=14 + hv % 120)
            both_here = max(emp.joining_date, ctx.by_id[sender].joining_date)  # not before either of them joined
            if day < both_here:
                day = min(ctx.today, both_here + timedelta(days=7 + hv % 21))
            rows.append(PerfFeedback(id=f"gap-praise-{emp.id}-{n}"[:64], kind="praise", from_id=sender, to_id=emp.id,
                                     badge=BADGES[hv % len(BADGES)], message=PRAISE_TEXT[(hv >> 4) % len(PRAISE_TEXT)],
                                     created_at=_at(day, 9 + hv % 8)))
    db.add_all(rows)
    return len(rows)


# ---------- 2. certifications ----------
# person: [(name, issuer, years valid or None, issued days ago)]
DEMO_CERTS: dict[str, list[tuple[str, str, int | None, int]]] = {
    "emp-mahesh": [("AWS Certified Developer - Associate", "Amazon Web Services", 3, 410)],
    "emp-priya": [("Professional Scrum Master I", "Scrum.org", None, 720),
                  ("AWS Certified Solutions Architect - Associate", "Amazon Web Services", 3, 300)],
    "emp-oliver": [("ISTQB Certified Tester Foundation Level", "ISTQB", None, 900)],
    "emp-ram": [("Project Management Professional", "PMI", 3, 640), ("Certified ScrumMaster", "Scrum Alliance", 2, 200)],
    HR: [("SHRM Senior Certified Professional", "SHRM", 3, 520), ("CIPD Level 7 Advanced Diploma", "CIPD", None, 1400)],
    RECRUITER: [("Certified Internet Recruiter", "AIRS", 3, 380), ("LinkedIn Certified Professional - Recruiter", "LinkedIn", 2, 150)],
    CEO: [("Chartered Director", "Institute of Directors", None, 1800),
          ("Board Leadership Certificate", "National Association of Corporate Directors", None, 950)],
    ADMIN: [("Microsoft Certified: Azure Administrator Associate", "Microsoft", 1, 120),
            ("CompTIA Security+", "CompTIA", 3, 600), ("AWS Certified Security - Specialty", "Amazon Web Services", 3, 260)],
}


def _certifications(db: Session, ctx: _Ctx) -> int:
    have = set(db.scalars(select(Certification.employee_id).distinct()))
    rows = []
    for pid, certs in DEMO_CERTS.items():
        if pid in have or pid not in ctx.by_id:
            continue
        for i, (name, issuer, years, ago) in enumerate(certs):
            issued = ctx.today - timedelta(days=ago)
            expires = issued + timedelta(days=365 * years) if years else None
            rows.append(Certification(id=f"gap-cert-{pid}-{i}"[:64], employee_id=pid, name=name, issuer=issuer,
                                      issued_on=issued, expires_on=expires,
                                      credential_id=f"{issuer[:3].upper()}-{_h(pid, name) % 900000 + 100000}"))
    db.add_all(rows)
    return len(rows)


# ---------- 3. cash advances and leave encashment ----------
# person: [(suffix, amount in local currency, category, purpose, paid days ago or None, instalments, status)]
CASH: dict[str, list[tuple[str, float, str, str, int | None, int, str]]] = {
    ADMIN: [("repaid", 1500.0, "Relocation", "Deposit for a flat nearer the London office.", 230, 3, "Paid"),
            ("declined", 2500.0, "Personal", "Car repair after the winter.", None, 6, "Rejected")],
    HR: [("repaid", 50000.0, "Medical", "Parent's surgery not covered by insurance.", 260, 4, "Paid")],
    RECRUITER: [("repaid", 1800.0, "Education", "Evening course in talent analytics.", 200, 3, "Paid"),
                ("withdrawn", 900.0, "Travel", "Flights for a family wedding.", None, 2, "Withdrawn")],
}
# person: [(suffix, year offset, days, status, payout month offset in months or None)]
ENCASH: dict[str, list[tuple[str, int, float, str, int | None]]] = {
    HR: [("last-year", -1, 4.0, "Approved", None), ("declined", 0, 3.0, "Rejected", None)],
    # demo-admin (GB) and demo-recruiter (US): their leave can't be encashed, so they get none.
}


def _cash_and_encashment(db: Session, ctx: _Ctx) -> dict[str, int]:
    from app.services import self_service as ss

    have_cash = set(db.scalars(select(CashAdvance.employee_id).distinct()))
    have_enc = set(db.scalars(select(EncashmentRequest.employee_id).distinct()))
    cash = enc = 0
    for pid, rows in CASH.items():
        emp = ctx.by_id.get(pid)
        if emp is None or pid in have_cash or pid not in ctx.active_ids:
            continue
        for suffix, amount, category, purpose, paid_ago, n, status in rows:
            cid = f"ca-gap-{pid}-{suffix}"[:64]
            if db.get(CashAdvance, cid) is not None:
                continue
            paid_on = ctx.today - timedelta(days=paid_ago) if paid_ago is not None else None
            row = CashAdvance(id=cid, employee_id=pid, amount=amount, currency=emp.currency, category=category, purpose=purpose,
                              needed_by=paid_on or ctx.today - timedelta(days=30 + _h(cid) % 60), instalments=n, status=status,
                              paid_on=paid_on, paid_by=(HR if pid != HR else ADMIN) if paid_on else None,
                              reference=f"ADV-GAP-{_h(cid) % 90000 + 10000}" if paid_on else None)
            if status == "Paid" and paid_on is not None:  # long since repaid and settled
                row.settlement_status, row.settlement_spent, row.settlement_returned = "Verified", amount, 0.0
                row.settlement_on = paid_on + timedelta(days=20)
                row.settlement_note = "Receipts for the full amount."
                row.settlement_verified_by = HR if pid != HR else ADMIN
                row.settlement_verified_on = paid_on + timedelta(days=24)
            db.add(row)
            cash += 1
    for pid, rows in ENCASH.items():
        emp = ctx.by_id.get(pid)
        if emp is None or pid in have_enc or pid not in ctx.active_ids or emp.country_code not in ENCASH_COUNTRIES:
            continue
        rate = ss.per_day(db, emp)
        for suffix, year_off, days, status, _ in rows:
            eid = f"enc-gap-{pid}-{suffix}"[:64]
            if db.get(EncashmentRequest, eid) is not None:
                continue
            year = ctx.today.year + year_off
            month = f"{year}-12" if status == "Approved" and year_off < 0 else None
            db.add(EncashmentRequest(id=eid, employee_id=pid, leave_code="pto", year=year, days=days, per_day=rate,
                                     amount=round(rate * days, 2), currency=emp.currency, status=status, payout_month=month))
            enc += 1
    return {"gaps_cash_advances_added": cash, "gaps_encashments_added": enc}


# ---------- 4. project posts and documents ----------
POSTS = (
    ("update", "Sprint review done: everything planned for this sprint is in, and the next one is planned."),
    ("comment", "I have put the open questions for the client in the shared notes; please add yours before Thursday."),
    ("comment", "Test run is green on the latest build. Two minor issues logged as tasks."),
    ("comment", "Reminder: please log this week's hours against the project before Friday."),
    ("update", "Status: on track. The main risk is waiting on client sign-off for the next milestone."),
)
DOCS = (("Statement of work", "statement-of-work"), ("Release plan", "release-plan"), ("Meeting notes", "meeting-notes"))


def _projects(db: Session, ctx: _Ctx) -> dict[str, int]:
    have_posts = set(db.scalars(select(ProjectPost.project_id).distinct()))
    have_docs = set(db.scalars(select(ProjectDocument.project_id).distinct()))
    posts = docs = 0
    for project in db.scalars(select(Project).where(Project.active.is_(True)).order_by(Project.id)):
        members = sorted(m for m in db.scalars(select(ProjectMember.employee_id).where(ProjectMember.project_id == project.id))
                         if m in ctx.active_ids)
        lead = project.manager_id if project.manager_id in ctx.active_ids else (members[0] if members else None)
        if lead is None:
            continue
        authors = [lead] + [m for m in sorted(members, key=lambda m: _h(project.id, m)) if m != lead]
        if project.id not in have_posts:
            for n in range(2 + _h(project.id, "posts") % 2):
                kind, body = POSTS[(_h(project.id, "post") + n) % len(POSTS)]
                author = lead if kind == "update" else authors[(n + 1) % len(authors)] if len(authors) > 1 else lead
                post = ProjectPost(id=f"gap-pp-{project.id}-{n}"[:64], project_id=project.id, author_id=author, kind=kind, body=body)
                post.created_at = _at(ctx.today - timedelta(days=3 + 9 * n + _h(project.id, n) % 5), 11)
                db.add(post)
                posts += 1
        if project.id not in have_docs:
            slug = (project.code or project.id).lower()
            for n in range(1 + _h(project.id, "docs") % 2):
                title, path = DOCS[(_h(project.id, "doc") + n) % len(DOCS)]
                doc = ProjectDocument(id=f"gap-pd-{project.id}-{n}"[:64], project_id=project.id, title=title,
                                      url=f"https://docs.timez.example/projects/{slug}/{path}", added_by=lead)
                doc.created_at = _at(ctx.today - timedelta(days=20 + 15 * n + _h(project.id, "d", n) % 10), 14)
                db.add(doc)
                docs += 1
    return {"gaps_project_posts_added": posts, "gaps_project_documents_added": docs}


# ---------- 5. job profiles on open assignment rows ----------
def _job_profiles(db: Session, ctx: _Ctx) -> int:
    profiles = list(db.scalars(select(JobProfile).where(JobProfile.active.is_(True)).order_by(JobProfile.id)))
    if not profiles:
        return 0
    by_title: dict[str, list[JobProfile]] = defaultdict(list)
    for p in profiles:
        by_title[p.title.strip().lower()].append(p)
    ids = {p.id for p in profiles}
    positions = {p.id: p for p in db.scalars(select(Position))}
    positions |= {p.code: p for p in list(positions.values())}
    filled = 0
    for row in db.scalars(select(EmployeeAssignment).where(EmployeeAssignment.effective_to.is_(None),
                                                           EmployeeAssignment.job_profile_id.is_(None))):
        emp = ctx.by_id.get(row.employee_id)
        if emp is None or emp.id not in ctx.active_ids:
            continue
        pos = positions.get(row.position_id or emp.position_id or "")
        profile_id: Any = pos.profile_id if pos is not None and pos.profile_id in ids else None
        if profile_id is None:
            matches = by_title.get((row.job_title or emp.job_title or "").strip().lower(), [])
            matches = sorted(matches, key=lambda p: (p.grade != (row.grade or emp.grade), p.id))
            profile_id = matches[0].id if matches else None
        if profile_id:
            row.job_profile_id = profile_id
            filled += 1
    return filled


# ---------- 6. career mentors ----------
def _mentors(db: Session, ctx: _Ctx) -> int:
    filled = 0
    for row in db.scalars(select(CareerProfile).where(CareerProfile.mentor_id.is_(None)).order_by(CareerProfile.employee_id)):
        emp = ctx.by_id.get(row.employee_id)
        if emp is None or emp.id not in ctx.active_ids:
            continue
        seniors = sorted((e for e in ctx.active if e.department == emp.department and e.id not in (emp.id, emp.manager_id)
                          and _level(e) > _level(emp)),
                         key=lambda e: (e.country_code != emp.country_code, _h(emp.id, e.id, "mentor")))
        mentor = seniors[0].id if seniors else None
        if mentor is None and emp.manager_id:
            mgr = ctx.by_id.get(emp.manager_id)
            skip = mgr.manager_id if mgr is not None else None
            mentor = skip if skip in ctx.active_ids and skip != emp.id else None
        if mentor:
            row.mentor_id = mentor
            filled += 1
    return filled


def seed(db: Session) -> dict[str, int]:
    db.flush()
    ctx = _Ctx(db, date.today())
    stats = {"gaps_praise_added": _praise(db, ctx), "gaps_certifications_added": _certifications(db, ctx)}
    stats.update(_cash_and_encashment(db, ctx))
    stats.update(_projects(db, ctx))
    stats["gaps_job_profiles_filled"] = _job_profiles(db, ctx)
    stats["gaps_mentors_filled"] = _mentors(db, ctx)
    db.flush()
    return stats

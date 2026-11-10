"""Sample HR requests and queues, and the demo sign-in people's own records.

Insert-only and idempotent: adds rows only where none exist yet and never changes a value that is already set,
so it is safe to run again on a database that already holds real data.

- HR queues (Farhan / Alex): a resignation waiting for HR (manager already approved) and one withdrawn earlier,
  two confidential cases, letter requests (two waiting, one issued), profile corrections, Provident Fund policy
  acknowledgements from part of India, documents waiting for verification, a cash advance, leave encashment and a
  software licence each paid / waiting, benefit life events, a pay review proposal, a delegation for Ram's leave,
  a finished onboarding checklist, and ratings on closed help desk requests. These use people from the workbook
  (never Babu, Priya, Oliver or the other sign-ins, whose own counts the demo and the tests rely on), except the pay
  proposal (Priya, raised by Ram) which needs someone with pay on record.
- Own records for Ram, Farhan, Sophie, Jordan and Alex where they have none of that kind yet: leave (two past, one
  upcoming, all already decided), documents, expenses, a trip, tax declarations (their country's sections),
  dependents, a bonus, tasks, mail, calendar meetings and benefit enrolments. Everything is already decided, so no
  odd pending items appear (Jordan, the CEO, has nobody above him; his leave is recorded as approved).
Identifiers on documents are masked sample values.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import func, insert, select
from sqlalchemy.orm import Session

from app.models import (
    ApprovalDelegation, BenefitDependent, BenefitEnrollment, BenefitPlan, CalendarAttendee, CalendarEvent, CashAdvance,
    CompBonus, CompProposal, CompReviewCycle, DeskTicket, DocumentVersion, Employee, EmployeeDocument,
    EncashmentRequest, ExitCase, ExpenseClaim, Joiner, LeaveRequest, LetterRequest, LifeEvent, MailMessage,
    MailRecipient, OnboardingTask, PolicyAcknowledgment, ProfileCorrection, SharedTask, SoftwareRequest, SoftwareTitle,
    TaxDeclaration, TravelRequest,
)
from app.models.cases import HrCase, HrCaseNote
from app.models.policies import HrPolicy

BABU, PRIYA, OLIVER, RAM = "emp-mahesh", "emp-priya", "emp-oliver", "emp-ram"
HR, SOPHIE, CEO, ADMIN = "demo-hr-admin", "demo-recruiter", "demo-ceo", "demo-admin"
SIGN_INS = (BABU, PRIYA, OLIVER, RAM, HR, SOPHIE, CEO, ADMIN)
OWN = (RAM, HR, SOPHIE, CEO, ADMIN)  # people whose own pages this module fills
NOT_SAMPLED = set(SIGN_INS) | {"TZ0901"}  # never used for the HR queue samples (TZ0901: seed_demo's joiner)
PF_POLICY = "pf-contribution-change"


# ---------- helpers ----------

def _at(day: date, hour: int = 10) -> datetime:
    return datetime.combine(day, time(hour, 0), tzinfo=UTC)


def _workday(db: Session, emp: Employee, day: date, step: int = 1) -> date:
    from app.services.leave import holiday_dates

    holidays = holiday_dates(db, emp.country_code, day - timedelta(days=30), day + timedelta(days=30))
    while day.weekday() >= 5 or day in holidays:
        day += timedelta(days=step)
    return day


def _have(db: Session, model: Any, col: Any, ids: list[str] | tuple[str, ...]) -> set[str]:
    """Which of these people already have at least one row of this kind (one query)."""
    return set(db.scalars(select(col).where(col.in_(list(ids))).distinct()))


def _existing(db: Session, model: Any, ids: list[str]) -> set[str]:
    return set(db.scalars(select(model.id).where(model.id.in_(ids))))


def _people(db: Session) -> dict[str, Employee]:
    return {e.id: e for e in db.scalars(select(Employee).where(Employee.id.in_(SIGN_INS)))}


class _Pool:
    """Workbook people for the HR queue samples: active, permanent, with a manager outside Ram's demo team, joined
    over a year ago. Deterministic order (by id); each sample takes a different person."""

    def __init__(self, db: Session, today: date) -> None:
        rows = db.scalars(select(Employee).where(
            Employee.id.not_in(NOT_SAMPLED), Employee.employment_status == "Active", Employee.manager_id.is_not(None),
            Employee.manager_id != RAM, Employee.joining_date <= today - timedelta(days=400),
        ).order_by(Employee.id).limit(400))
        self.rows = [e for e in rows if (e.employment_type or "").lower().replace("-", " ").startswith("full")]
        self.used: set[str] = set()

    def take(self, country: str | None = None) -> Employee | None:
        for e in self.rows:
            if e.id not in self.used and (country is None or e.country_code == country):
                self.used.add(e.id)
                return e
        return None


def _past_manager(db: Session, instance: Any, note: str) -> None:
    """Approve the manager step so the request waits for HR / IT (as in app.seed_demo's probation sample)."""
    from app.services import approvals as engine

    if instance.status != "pending":
        return
    step = instance.steps[instance.current_step]
    if "manager" not in step.get("roles", []):
        return
    ids = step["groups"].get("manager") or []
    if ids:
        engine.decide(db, instance, ids[0], "approve", note=note, actor_id=ids[0])


def _pdf_doc(db: Session, emp: Employee, doc_id: str, category: str, title: str, lines: list[str], *,
             uploaded_by: str, expiry: date | None = None, description: str | None = None,
             verification: str | None = None, verified_by: str | None = None, verified_at: datetime | None = None) -> None:
    from app.seed_hr_content import _pdf
    from app.services import documents as docs

    vid = f"dv-seed-{uuid.uuid4().hex[:10]}"
    saved = docs.save_bytes(f"documents/{emp.id}", vid, _pdf(title, lines), "application/pdf")
    db.add(EmployeeDocument(id=doc_id, employee_id=emp.id, category=category, title=title, current_version=1,
                            expiry_date=expiry, uploaded_by=uploaded_by, description=description,
                            verification_status=verification, verified_by=verified_by, verified_at=verified_at))
    db.flush()
    db.add(DocumentVersion(id=vid, document_id=doc_id, version=1,
                           file_name=f"{title.replace(' — ', '-').replace(' ', '-').replace('/', '-')}.pdf",
                           content_type="application/pdf", size_bytes=saved.size_bytes, sha256=saved.sha256,
                           storage_path=saved.relative_path, uploaded_by=uploaded_by))


# ---------- HR queues ----------

def _exits(db: Session, pool: _Pool, today: date) -> int:
    from app.services import approvals as engine
    from app.services.exits import notice_days_for
    from app.services.workflow_defaults import ensure_default

    added = 0
    have = _existing(db, ExitCase, ["exit-seed-resign", "exit-seed-withdrawn"])
    if "exit-seed-resign" not in have and (emp := pool.take("IN")) is not None:
        submitted = today - timedelta(days=6)
        notice = notice_days_for(db, emp)
        last = submitted + timedelta(days=notice)
        case = ExitCase(id="exit-seed-resign", employee_id=emp.id, exit_type="resignation", submitted_on=submitted,
                        requested_last_day=last, standard_last_day=last, notice_days=notice, early_release=False,
                        reason="Moving to Pune to be closer to family.", note="Happy to serve the full notice period.",
                        status="Submitted", raised_by=emp.id, clearance=[], settlement={"status": "Pending"},
                        details={"handover_plan": "Hand over open work to the team lead over the notice period; "
                                                  "write up the runbooks in the team wiki."})
        db.add(case)
        db.flush()
        ensure_default(db, "exit")
        inst = engine.start(db, "exit", case.id, emp, None, actor_id=emp.id, context={"via_manager": True}, fallback=False)
        case.approval_instance_id = inst.id
        _past_manager(db, inst, "Discussed; could not change the decision. Approved from my side.")
        added += 1
    if "exit-seed-withdrawn" not in have and (emp := pool.take("US")) is not None:
        submitted = today - timedelta(days=75)
        notice = notice_days_for(db, emp)
        last = submitted + timedelta(days=notice)
        db.add(ExitCase(id="exit-seed-withdrawn", employee_id=emp.id, exit_type="resignation", submitted_on=submitted,
                        requested_last_day=last, standard_last_day=last, notice_days=notice, early_release=False,
                        reason="Offer from another company.", note="Withdrawn after the retention discussion.",
                        status="Withdrawn", raised_by=emp.id, clearance=[], settlement={"status": "Pending"},
                        details={"retention": [{"by_id": emp.manager_id, "by": "Manager",
                                                "note": "Agreed a move to the platform team and a training budget.",
                                                "on": (submitted + timedelta(days=4)).isoformat()}]}))
        added += 1
    return added


def _cases(db: Session, pool: _Pool, today: date) -> int:
    samples = [
        ("case-seed-grievance", "SMPL-GRV-01", "Grievance", "Normal", "Investigating", None, None,
         "My shift pattern was changed three times this month with less than a day's notice. I'd like the roster "
         "rules applied the same way to everyone on the team.", 9,
         [("filed", "Case filed.", False), ("status", "HR is speaking to the team lead and checking the roster history.",
                                             False)]),
        ("case-seed-safety", "SMPL-SAF-01", "Safety", "High", "Resolved",
         "The loose floor tile near the second-floor pantry was fixed and the area checked by facilities.", 20,
         "A loose floor tile by the second-floor pantry; two people have tripped on it this week.", 34,
         [("filed", "Case filed.", False), ("status", "Facilities replaced the tile and checked the rest of the floor.",
                                             False)]),
    ]
    have = _existing(db, HrCase, [s[0] for s in samples])
    added = 0
    for cid, code, category, priority, status, resolution, closed_ago, text, filed_ago, notes in samples:
        if cid in have or db.scalar(select(HrCase.id).where(HrCase.code == code)):
            continue
        reporter = pool.take("IN")
        if reporter is None or db.get(Employee, HR) is None:
            continue
        filed = _at(today - timedelta(days=filed_ago))
        db.add(HrCase(id=cid, code=code, category=category, description=text, anonymous=False, reporter_id=reporter.id,
                      priority=priority, status=status, assignee_id=HR, resolution=resolution,
                      closed_on=today - timedelta(days=closed_ago) if closed_ago else None, escalation_count=0,
                      created_at=filed, updated_at=filed))
        db.flush()
        for i, (kind, note, conf) in enumerate(notes):
            db.add(HrCaseNote(id=f"{cid}-n{i + 1}", case_id=cid, kind=kind, text=note,
                              author_id=reporter.id if kind == "filed" else HR, by_reporter=kind == "filed",
                              confidential=conf, status=status if kind == "status" else None,
                              created_at=filed + timedelta(days=2 * i)))
        added += 1
    return added


def _letters(db: Session, pool: _Pool, people: dict[str, Employee], today: date) -> int:
    from app.services import approvals as engine
    from app.services import letters

    added = 0
    have = _existing(db, LetterRequest, ["ltr-seed-employment", "ltr-seed-visa", "ltr-seed-ram-employment"])
    pending = [("ltr-seed-employment", "GB", "Employment", "Needed for a flat rental application.", None),
               ("ltr-seed-visa", "IN", "Visa/Travel", "Visa appointment at the German consulate.",
                "Germany, 14-21 December (conference and client visit)")]
    for lid, country, kind, note, details in pending:
        if lid in have or (emp := pool.take(country)) is None:
            continue
        req = LetterRequest(id=lid, employee_id=emp.id, letter_type=kind, status="pending", requested_by=emp.id,
                            note=note, details=details)
        if letters.missing_fields(kind, letters.collect_fields(db, req, emp)):
            continue
        db.add(req)
        db.flush()
        letters.ensure_workflow(db)
        req.approval_instance_id = engine.start(db, "letter", req.id, emp, None, actor_id=emp.id).id
        added += 1
    ram = people.get(RAM)
    if "ltr-seed-ram-employment" not in have and ram is not None and HR in people:
        req = LetterRequest(id="ltr-seed-ram-employment", employee_id=RAM, letter_type="Employment", status="pending",
                            requested_by=RAM, note="For a home loan application.")
        db.add(req)
        db.flush()
        try:
            with db.begin_nested():
                letters.issue(db, req, HR, HR)
            added += 1
        except letters.LetterError:
            db.delete(req)
            db.flush()
    return added


def _corrections(db: Session, pool: _Pool, today: date) -> int:
    samples = [
        ("pcr-seed-1", "work_arrangement", "Hybrid", "My manager agreed I work from home on Mondays and Fridays.",
         "pending", None),
        ("pcr-seed-2", "middle_name", "Kumar", "My middle name is on my passport but missing here.", "pending", None),
        ("pcr-seed-3", "job_title", "Senior Analyst", "I think my title was not updated after the April review.",
         "rejected", "Checked with your manager: the title change takes effect with the next review cycle."),
    ]
    have = _existing(db, ProfileCorrection, [s[0] for s in samples])
    added = 0
    for i, (pid, field, value, reason, status, note) in enumerate(samples):
        if pid in have or (emp := pool.take("IN")) is None:
            continue
        current = getattr(emp, field, None)
        if field == "work_arrangement" and current == value:
            value, reason = "Remote", "I moved out of the city; my manager agreed I work fully remote."
        if current == value:
            continue
        when = _at(today - timedelta(days=3 + 9 * i))
        db.add(ProfileCorrection(id=pid, employee_id=emp.id, field=field, current_value=current, requested_value=value,
                                 reason=reason, status=status, requested_by=emp.id,
                                 decided_by=HR if status != "pending" else None,
                                 decided_at=when + timedelta(days=2) if status != "pending" else None,
                                 decision_note=note, created_at=when, updated_at=when))
        added += 1
    return added


def _policy_acks(db: Session, today: date) -> int:
    """About half of India acknowledged the PF change (bulk insert, only when nobody has yet)."""
    policy = db.get(HrPolicy, PF_POLICY)
    if policy is None or not policy.current_version:
        return 0
    if db.scalar(select(func.count()).select_from(PolicyAcknowledgment).where(PolicyAcknowledgment.policy_id == PF_POLICY)):
        return 0
    ids = list(db.scalars(select(Employee.id).where(Employee.country_code == "IN", Employee.id.not_in(NOT_SAMPLED),
                                                    Employee.employment_status == "Active").order_by(Employee.id)))
    chosen = ids[::2]
    if not chosen:
        return 0
    base = _at(today - timedelta(days=6), 4)
    rows = [{"employee_id": eid, "policy_id": PF_POLICY, "policy_version": str(policy.current_version),
             "acknowledged_at": base + timedelta(minutes=37 * i), "ip": None,
             "comment": "Will the change show on the December payslip?" if i == 3 else None}
            for i, eid in enumerate(chosen)]
    db.execute(insert(PolicyAcknowledgment), rows)
    return len(rows)


def _verification_docs(db: Session, pool: _Pool, today: date) -> int:
    samples = [("doc-seed-verify-1", "IN", "Education", "Degree certificate",
                ["Bachelor of Technology, Computer Science", "Awarded 2016", "", "Sample copy for verification."]),
               ("doc-seed-verify-2", "GB", "Identity", "Proof of address",
                ["Council tax bill, 2026-27", "Address on file: sample address, London", "", "Sample copy."]),
               ("doc-seed-verify-3", "US", "Identity", "Updated passport",
                ["Passport (renewed)", "Passport number ******402", "", "Masked copy for HR to verify."])]
    have = _existing(db, EmployeeDocument, [s[0] for s in samples])
    added = 0
    for did, country, category, title, lines in samples:
        if did in have or (emp := pool.take(country)) is None:
            continue
        _pdf_doc(db, emp, did, category, title, [emp.full_name, ""] + lines, uploaded_by=emp.id,
                 description="Uploaded by the employee.", verification="pending",
                 expiry=today + timedelta(days=10 * 365) if title == "Updated passport" else None)
        added += 1
    return added


def _self_service(db: Session, pool: _Pool, today: date) -> int:
    from app.services import self_service as ss

    added = 0
    have_cash = _existing(db, CashAdvance, ["ca-seed-paid", "ca-seed-waiting"])
    if "ca-seed-paid" not in have_cash and (emp := pool.take("IN")) is not None:
        paid = today - timedelta(days=55)
        db.add(CashAdvance(id="ca-seed-paid", employee_id=emp.id, amount=30000.0, currency=emp.currency,
                           category="Medical", purpose="Parent's knee surgery; balance after insurance.",
                           needed_by=paid, instalments=3, status="Paid", paid_on=paid, paid_by=HR,
                           reference="ADV-SAMPLE-0001"))
        added += 1
    if "ca-seed-waiting" not in have_cash and (emp := pool.take("GB")) is not None:
        row = CashAdvance(id="ca-seed-waiting", employee_id=emp.id, amount=1500.0, currency=emp.currency,
                          category="Relocation", purpose="Deposit for a flat closer to the office.",
                          needed_by=today + timedelta(days=14), instalments=6, status="Submitted")
        db.add(row)
        db.flush()
        inst = ss._start(db, ss.CASH, row, emp, row.amount, emp.id)
        _past_manager(db, inst, "Fine by me.")
        added += 1
    have_enc = _existing(db, EncashmentRequest, ["enc-seed-paid", "enc-seed-waiting"])
    for eid, status, days in (("enc-seed-paid", "Approved", 5.0), ("enc-seed-waiting", "Submitted", 3.0)):
        if eid in have_enc or (emp := pool.take("IN")) is None:
            continue
        rate = 1800.0
        month = ss.month_key((today.replace(day=1) - timedelta(days=1))) if status == "Approved" else ss.payout_month(today)
        row = EncashmentRequest(id=eid, employee_id=emp.id, leave_code="pto", year=today.year, days=days, per_day=rate,
                                amount=round(rate * days, 2), currency=emp.currency, status=status, payout_month=month)
        db.add(row)
        db.flush()
        if status == "Submitted":
            inst = ss._start(db, ss.ENCASH, row, emp, row.amount, emp.id)
            _past_manager(db, inst, "Approved.")
        added += 1
    ss.ensure_catalogue(db)
    have_sw = _existing(db, SoftwareRequest, ["swr-seed-ram", "swr-seed-sophie", "swr-seed-waiting"])
    for sid, who, title_id, reason, months, ago in (
            ("swr-seed-ram", RAM, "sw-jetbrains", "IDE for code reviews and the year-end release.", None, 210),
            ("swr-seed-sophie", SOPHIE, "sw-notion", "Interview kits and the hiring wiki.", 12, 90)):
        if sid in have_sw or db.get(Employee, who) is None or db.get(SoftwareTitle, title_id) is None:
            continue
        on = today - timedelta(days=ago)
        db.add(SoftwareRequest(id=sid, employee_id=who, title_id=title_id, reason=reason, duration_months=months,
                               status="Active", assigned_on=on, expires_on=ss.add_months(on, months) if months else None,
                               licence_key=f"LIC-SAMPLE-{sid[-3:].upper()}", raised_by=who))
        added += 1
    if "swr-seed-waiting" not in have_sw and db.get(SoftwareTitle, "sw-tableau") is not None \
            and (emp := pool.take("US")) is not None:
        row = SoftwareRequest(id="swr-seed-waiting", employee_id=emp.id, title_id="sw-tableau",
                              reason="Quarterly pipeline dashboards for the regional sales review.", duration_months=6,
                              status="Submitted", raised_by=emp.id)
        db.add(row)
        db.flush()
        inst = ss._start(db, ss.SOFTWARE, row, emp, None, emp.id)
        _past_manager(db, inst, "Needed for the Q4 review.")
        added += 1
    return added


def _life_events(db: Session, pool: _Pool, today: date) -> int:
    from app.services.benefits import LIFE_EVENT_WINDOW_DAYS

    added = 0
    have = _existing(db, LifeEvent, ["le-seed-birth", "le-seed-marriage"])
    for lid, country, kind, ago, status in (("le-seed-birth", "US", "Birth or adoption", 9, "open"),
                                            ("le-seed-marriage", "IN", "Marriage", 120, "closed")):
        if lid in have or (emp := pool.take(country)) is None:
            continue
        on = today - timedelta(days=ago)
        db.add(LifeEvent(id=lid, employee_id=emp.id, event_type=kind, event_date=on,
                         window_ends=on + timedelta(days=LIFE_EVENT_WINDOW_DAYS), status=status,
                         closed_by=HR if status == "closed" else None))
        added += 1
    return added


def _proposal(db: Session, people: dict[str, Employee], today: date) -> int:
    """Ram proposes a 6% raise for Priya in the open review cycle (waits for HR). Only for permanent staff past
    probation with pay on record, in a cycle that covers their country."""
    from app.services import compensation as comp
    from app.services.approval_targets import start_about
    from app.services import approvals as engine

    if db.get(CompProposal, "prop-seed-priya") is not None:
        return 0
    priya, ram = people.get(PRIYA), people.get(RAM)
    if priya is None or ram is None or priya.manager_id != RAM:
        return 0
    if not (priya.employment_type or "").lower().replace("-", " ").startswith("full") or \
            (priya.joining_date and priya.joining_date > today - timedelta(days=365)):
        return 0
    cycle = next((c for c in db.scalars(select(CompReviewCycle).where(CompReviewCycle.status == "open")
                                        .order_by(CompReviewCycle.opens_on.desc()))
                  if comp.cycle_open_on(c, today) and (not c.countries or priya.country_code in c.countries)), None)
    current = comp.current_record(db, PRIYA, today)
    if cycle is None or current is None or db.scalar(select(CompProposal.id).where(
            CompProposal.cycle_id == cycle.id, CompProposal.employee_id == PRIYA)):
        return 0
    pct = 6.0
    p = CompProposal(id="prop-seed-priya", cycle_id=cycle.id, employee_id=PRIYA, proposed_by=RAM,
                     currency=current.currency, current_base=current.base_salary, current_grade=current.grade,
                     increase_pct=pct, proposed_base=round(float(current.base_salary) * (1 + pct / 100), 2),
                     proposed_grade=current.grade, bonus_amount=None, status="pending",
                     justification="Led the payment retry design and the release plan; consistently strong reviews.")
    db.add(p)
    db.flush()
    comp.ensure_workflow(db)
    try:
        with db.begin_nested():
            inst = start_about(db, "compensation", p.id, ram, priya, amount=pct, actor_id=RAM,
                               title=f"Pay proposal to approve: {priya.full_name}",
                               body=f"{pct:g}% increase proposed by {ram.full_name} ({cycle.name}).",
                               href=f"/compensation/proposals/{p.id}")
    except engine.ApprovalError:
        db.delete(p)
        db.flush()
        return 0
    p.approval_instance_id = inst.id
    return 1


def _delegations(db: Session, people: dict[str, Employee], today: date, ram_leave: tuple[date, date] | None) -> int:
    """Ram hands leave / time approvals to Farhan while he is away (a future window, so nothing changes today);
    Jordan's earlier one to Farhan has ended."""
    added = 0
    have = _existing(db, ApprovalDelegation, ["dlg-seed-ram", "dlg-seed-ceo"])
    if "dlg-seed-ram" not in have and RAM in people and HR in people:
        start, end = ram_leave or (today + timedelta(days=21), today + timedelta(days=23))
        if start > today:
            db.add(ApprovalDelegation(id="dlg-seed-ram", delegator_id=RAM, delegate_id=HR, starts_on=start, ends_on=end,
                                      types=["leave", "timesheet", "attendance_correction"],
                                      note="On leave; Farhan covers my team's leave and time approvals.", active=True,
                                      created_by=RAM))
            added += 1
    if "dlg-seed-ceo" not in have and CEO in people and HR in people:
        db.add(ApprovalDelegation(id="dlg-seed-ceo", delegator_id=CEO, delegate_id=HR,
                                  starts_on=today - timedelta(days=48), ends_on=today - timedelta(days=41),
                                  types=["travel", "expense"], note="Travelling for the board meeting.", active=True,
                                  created_by=CEO))
        added += 1
    return added


def _onboarding(db: Session, today: date) -> int:
    """A finished checklist for someone who joined two to four months ago and has none."""
    from app.services.onboarding import template_for

    if db.get(Joiner, "ob-seed-done") is not None:
        return 0
    with_joiner = select(Joiner.employee_id)
    emp = db.scalar(select(Employee).where(
        Employee.id.not_in(NOT_SAMPLED), Employee.employment_status == "Active", Employee.manager_id.is_not(None),
        Employee.joining_date.between(today - timedelta(days=120), today - timedelta(days=60)),
        Employee.id.not_in(with_joiner)).order_by(Employee.joining_date.desc(), Employee.id))
    if emp is None or emp.joining_date is None:
        return 0
    start = emp.joining_date
    done_at = _at(start + timedelta(days=30), 12)
    db.add(Joiner(id="ob-seed-done", employee_id=emp.id, name=emp.full_name, job_title=emp.job_title or "",
                  country_code=emp.country_code, manager_id=emp.manager_id, start_date=start, policy_ack=True,
                  policy_ack_at=_at(start, 6), policy_ack_by=emp.id, policy_ack_by_hr=False, status="completed",
                  completed_at=done_at, preboarding_at=_at(start - timedelta(days=7)), preboarding_by=emp.id,
                  preboarding={"personal": {"preferred_name": emp.first_name or emp.full_name},
                               "equipment": ["Laptop", "Headset"], "it_request": {"email": True, "vpn": True}},
                  created_at=_at(start - timedelta(days=21)), updated_at=done_at))
    db.flush()
    for t in template_for(db, emp.country_code, emp.legal_entity, emp.employment_type):
        due = start + timedelta(days=t["due_offset_days"])
        owner = {"hr": HR, "manager": emp.manager_id, "employee": emp.id}.get(t["owner_role"], HR)
        db.add(OnboardingTask(id=f"ot-seed-done-{t['key']}"[:64], joiner_id="ob-seed-done", key=t["key"],
                              title=t["title"], owner_role=t["owner_role"], category=t["category"], due_date=due,
                              depends_on=t["depends_on"], status="done", done_at=_at(min(due, start + timedelta(days=30))),
                              done_by=owner))
    return 1


def _desk_ratings(db: Session) -> int:
    comments = ["Sorted quickly, thank you.", "Clear answer and a follow-up the next day.", "Fixed, though it took a few days."]
    rated = 0
    for t in db.scalars(select(DeskTicket).where(DeskTicket.status.in_(("Resolved", "Closed")),
                                                 DeskTicket.satisfaction.is_(None)).order_by(DeskTicket.id)):
        t.satisfaction = 5 if rated % 3 != 2 else 4
        if not t.satisfaction_comment:
            t.satisfaction_comment = comments[rated % 3]
        rated += 1
    return rated


# ---------- the sign-in people's own records ----------

LEAVE = {  # person: [(id suffix, code, days ago (negative = ahead), length in workdays, reason)]
    RAM: [("1", "pto", 160, 3, "Family wedding in Madurai"), ("2", "sick", 58, 1, "Viral fever"),
          ("3", "pto", -24, 2, "Long weekend with family")],
    HR: [("1", "pto", 130, 4, "Family visit to Hyderabad"), ("2", "casual", 40, 1, "Child's school annual day"),
         ("3", "pto", -31, 3, "Year-end break")],
    CEO: [("1", "pto", 145, 5, "Summer vacation"), ("2", "pto", -36, 3, "Year-end holiday with family")],
    ADMIN: [("1", "pto", 100, 5, "Holiday in the Lake District"), ("2", "sick", 33, 1, "Migraine"),
            ("3", "pto", -17, 2, "Moving house")],
    SOPHIE: [("1", "pto", 120, 3, "Visiting family in Denver"), ("2", "sick", 47, 1, "Dentist appointment")],
}


def _leave(db: Session, people: dict[str, Employee], today: date) -> tuple[int, tuple[date, date] | None]:
    from app.services.leave import holiday_dates, working_days

    from app.models import AttendanceSession

    have = _have(db, LeaveRequest, LeaveRequest.employee_id, OWN)
    worked = set(map(tuple, db.execute(select(AttendanceSession.employee_id, AttendanceSession.work_date)
                            .where(AttendanceSession.employee_id.in_(OWN))).all()))
    added, ram_window = 0, None
    for who, rows in LEAVE.items():
        emp = people.get(who)
        if emp is None or who in have:
            continue
        approver = emp.manager_id if emp.manager_id and emp.manager_id in people else None
        for suffix, code, ago, length, reason in rows:
            start = _workday(db, emp, today - timedelta(days=ago))
            end = start
            for _ in range(length - 1):
                end = _workday(db, emp, end + timedelta(days=1))
            days = working_days(start, end, holiday_dates(db, emp.country_code, start, end))
            span = {start + timedelta(days=i) for i in range((end - start).days + 1)}
            if days <= 0 or any((who, d) in worked for d in span):  # never a day off on a day they clocked in
                continue
            decided = _at(start - timedelta(days=10 if code == "pto" else 0), 9)
            db.add(LeaveRequest(id=f"lv-seed-{who}-{suffix}"[:64], employee_id=who, leave_code=code, from_date=start,
                                to_date=end, half="none", days=days, reason=reason, status="approved",
                                decided_by=approver, decided_at=decided,
                                decision_note=None if approver else "Recorded by HR (no approver above the CEO).",
                                handover_to=None, created_at=decided - timedelta(days=1), updated_at=decided))
            added += 1
            if who == RAM and ago < 0:
                ram_window = (start, end)
    if ram_window is None and RAM in have:
        row = db.scalar(select(LeaveRequest).where(LeaveRequest.employee_id == RAM, LeaveRequest.from_date > today,
                                                   LeaveRequest.status == "approved").order_by(LeaveRequest.from_date))
        ram_window = (row.from_date, row.to_date) if row else None
    return added, ram_window


def _own_documents(db: Session, people: dict[str, Employee], today: date) -> int:
    from app.seed_teammates import _uk_documents

    have = _have(db, EmployeeDocument, EmployeeDocument.employee_id, OWN)
    added = 0
    for who in OWN:
        emp = people.get(who)
        if emp is None or who in have:
            continue
        name = emp.full_name
        joined = emp.joining_date.strftime("%d %B %Y").lstrip("0") if emp.joining_date else ""
        offer = ("offer", "Employment", "Offer letter", [
            emp.legal_entity or "TimeZ", "", f"Dear {emp.first_name or name},", "",
            f"We are pleased to offer you the position of {emp.job_title} in {emp.department},",
            f"starting {joined}. Pay and benefits are set out in Annexure A.", "",
            "Authorised Signatory, Human Resources", "", f"Accepted by {name}."], None)
        if emp.country_code == "GB":
            items = _uk_documents(emp, today)
        elif emp.country_code == "IN":
            items = [("pan", "Identity", "PAN card", ["Income Tax Department, Government of India", "",
                                                       f"Name   {name.upper()}", "PAN    ABCDE****F", "",
                                                       "Masked sample copy. Verified by HR."], None),
                     ("aadhaar", "Identity", "Aadhaar card", ["Unique Identification Authority of India", "",
                                                               f"Name    {name}", "Number  XXXX XXXX 0000", "",
                                                               "Masked sample copy. Verified by HR."], None),
                     offer,
                     ("relieving", "Employment", "Relieving letter (previous employer)", [
                         "Previous employer (sample)", "", f"This is to confirm that {name} was relieved",
                         "of their duties after serving the notice period.", "", "Sample copy."], None)]
        else:
            items = [("license", "Identity", "Driver's license", [
                         "State driver's license (sample)", "", f"Name     {name}", "Number   D***-****-0000", "",
                         "Masked sample copy. Verified by HR."], today + timedelta(days=3 * 365)),
                     ("i9", "Identity", "Form I-9 verification", [
                         "Employment eligibility verification", "", f"Employee   {name}",
                         f"Verified on {joined}", "Result     Eligible to work in the United States", "",
                         "Recorded by HR."], None),
                     offer,
                     ("w4", "Payroll", "Form W-4", [
                         "Employee's withholding certificate", "", f"Employee   {name}",
                         "Filing status   Married filing jointly", "SSN     ***-**-0000", "", "Sample copy."], None)]
        for suffix, category, title, lines, expiry in items:
            doc_id = f"doc-seed-{who}-{suffix}"[:64]
            _pdf_doc(db, emp, doc_id, category, title, lines, uploaded_by=HR, expiry=expiry, verification="verified",
                     verified_by=HR if who != HR else ADMIN, verified_at=_at(today - timedelta(days=200)))
            added += 1
    return added


EXPENSES = {  # person: [(suffix, category, amount, days ago, description, status)]
    RAM: [("1", "Food", 3200.0, 41, "Team lunch after the Northwind release", "paid"),
          ("2", "Transportation", 860.0, 12, "Cab to the client office in Whitefield", "approved")],
    HR: [("1", "Travel", 5400.0, 52, "Train to Chennai for the campus drive", "paid"),
         ("2", "Food", 1450.0, 15, "Snacks for the new joiner induction", "approved")],
    SOPHIE: [("1", "Transportation", 64.0, 37, "Taxi to the Austin career fair", "paid"),
             ("2", "Internet", 45.0, 9, "Home internet, October (remote interviews)", "approved")],
    CEO: [("1", "Accommodation", 980.0, 44, "Hotel in London for the UK all-hands", "paid"),
          ("2", "Food", 210.0, 8, "Dinner with the Acme leadership team", "approved")],
    ADMIN: [("1", "Supplies", 89.0, 60, "USB security keys for the on-call laptops", "paid"),
            ("2", "Transportation", 34.5, 11, "Train to the Reading data centre", "approved")],
}


def _expenses(db: Session, people: dict[str, Employee], today: date) -> int:
    have = _have(db, ExpenseClaim, ExpenseClaim.employee_id, OWN)
    added = 0
    for who, rows in EXPENSES.items():
        emp = people.get(who)
        if emp is None or who in have:
            continue
        for suffix, category, amount, ago, text, status in rows:
            on = today - timedelta(days=ago)
            paid = status == "paid"
            db.add(ExpenseClaim(id=f"exp-seed-{who}-{suffix}"[:64], employee_id=who, category=category, amount=amount,
                                currency=emp.currency, expense_date=on, description=text, status=status,
                                paid_on=on + timedelta(days=14) if paid else None,
                                payment_reference=f"PAY-SAMPLE-{who[-3:].upper()}{suffix}" if paid else None,
                                paid_by=HR if paid else None))
            added += 1
    return added


TRIPS = {  # person: (purpose, from, to, days ahead (negative = past), nights, mode, cost)
    RAM: ("Quarterly planning with the Northwind team", "Bengaluru", "Mumbai", -34, 2, "air", 21500.0),
    HR: ("Campus hiring drive", "Bengaluru", "Chennai", -52, 1, "rail", 5400.0),
    SOPHIE: ("Career fair and university partnerships", "Austin", "Boston", 19, 3, "air", 1650.0),
    CEO: ("UK all-hands and client meetings", "New York", "London", -44, 4, "air", 4200.0),
    ADMIN: ("Data centre access review", "London", "Reading", -11, 0, "rail", 34.5),
}


def _trips(db: Session, people: dict[str, Employee], today: date) -> int:
    have = _have(db, TravelRequest, TravelRequest.employee_id, OWN)
    added = 0
    for who, (purpose, src, dst, ahead, nights, mode, cost) in TRIPS.items():
        emp = people.get(who)
        if emp is None or who in have:
            continue
        start = today + timedelta(days=ahead)
        db.add(TravelRequest(id=f"trv-seed-{who}"[:64], employee_id=who, purpose=purpose, from_location=src,
                             to_location=dst, start_date=start, end_date=start + timedelta(days=nights), mode=mode,
                             estimated_cost=cost, currency=emp.currency, advance_amount=0, status="approved"))
        added += 1
    return added


TAX = {  # country: [(section, title, amount)]
    "IN": [("80C", "PPF and ELSS investments", 150000), ("80D", "Family health insurance premium", 25000)],
    "US": [("401(k)", "Extra pre-tax 401(k) contribution", 6000), ("HSA", "Health savings account", 2000)],
    "GB": [("Pension", "Extra pension contribution", 3000)],
}


def _tax(db: Session, people: dict[str, Employee], today: date) -> int:
    from app.services import tax_declarations as decl

    have = _have(db, TaxDeclaration, TaxDeclaration.employee_id, OWN)
    added = 0
    for who in OWN:
        emp = people.get(who)
        if emp is None or who in have or emp.country_code not in decl.SECTIONS or emp.country_code not in TAX:
            continue
        fy, _ = decl.declarable_years(emp.country_code, today)[0]
        submitted, decided = _at(today - timedelta(days=40)), _at(today - timedelta(days=33))
        verifier = HR if who != HR else ADMIN
        for i, (section, title, amount) in enumerate(TAX[emp.country_code]):
            db.add(TaxDeclaration(
                id=f"td-seed-{who}-{i + 1}"[:64], employee_id=who, country_code=emp.country_code, financial_year=fy,
                regime="old" if emp.country_code == "IN" else None, section=section, title=title, amount=amount,
                verified_amount=amount, currency=emp.currency, status="verified", submitted_at=submitted,
                decided_by=verifier, decided_at=decided, decision_note="Proof checked.",
                history=[{"at": submitted.isoformat(), "by": who, "action": "Submitted for verification"},
                         {"at": decided.isoformat(), "by": verifier, "action": "Verified"}]))
            added += 1
    return added


DEPENDENTS = {  # person: [(suffix, name, relationship, birth date, gender)]
    RAM: [("1", "Lakshmi Krishnan", "Spouse", "1987-04-11", "Female"), ("2", "Arjun Krishnan", "Child", "2016-09-02", "Male")],
    HR: [("1", "Ayesha Ali", "Spouse", "1986-12-19", "Female"), ("2", "Imran Ali", "Parent", "1956-03-07", "Male")],
    SOPHIE: [("1", "Daniel Clark", "Spouse", "1988-06-23", "Male")],
    CEO: [("1", "Rachel Blake", "Spouse", "1976-02-14", "Female"), ("2", "Ethan Blake", "Child", "2010-05-30", "Male"),
          ("3", "Lily Blake", "Child", "2013-11-08", "Female")],
    ADMIN: [("1", "Sam Morgan", "Partner", "1990-08-17", "Male")],
}


def _dependents(db: Session, people: dict[str, Employee], today: date) -> int:
    have = _have(db, BenefitDependent, BenefitDependent.employee_id, OWN)
    added = 0
    for who, rows in DEPENDENTS.items():
        if who not in people or who in have:
            continue
        for suffix, name, rel, born, gender in rows:
            db.add(BenefitDependent(id=f"dep-seed-{who}-{suffix}"[:64], employee_id=who, name=name, relationship=rel,
                                    date_of_birth=date.fromisoformat(born), gender=gender, verification="verified",
                                    verified_by=HR if who != HR else ADMIN, verified_at=_at(today - timedelta(days=250))))
            added += 1
    return added


BONUSES = {  # person: (type, amount)
    HR: ("Annual performance bonus", 240000), SOPHIE: ("Annual performance bonus", 9000),
    CEO: ("Annual performance bonus", 120000), ADMIN: ("Annual performance bonus", 4500), RAM: ("Annual performance bonus", 220000),
}


def _bonuses(db: Session, people: dict[str, Employee], today: date) -> int:
    have = _have(db, CompBonus, CompBonus.employee_id, OWN)
    added = 0
    for who, (kind, amount) in BONUSES.items():
        emp = people.get(who)
        if emp is None or who in have:
            continue
        db.add(CompBonus(id=f"bon-seed-{who}"[:64], employee_id=who, bonus_type=kind, period=f"FY{today.year - 1}",
                         amount=amount, currency=emp.currency, status="paid", created_by=HR, decided_by=CEO if who != CEO else None))
        added += 1
    return added


def _enrollments(db: Session, people: dict[str, Employee], today: date) -> int:
    have = _have(db, BenefitEnrollment, BenefitEnrollment.employee_id, OWN)
    plans = {p.id: p for p in db.scalars(select(BenefitPlan))}
    added = 0
    for who in OWN:
        emp = people.get(who)
        if emp is None or who in have:
            continue
        mine = [p for p in plans.values() if p.country_code == emp.country_code][:2]
        for plan in mine:
            effective = max(emp.joining_date or date(today.year, 1, 1), date(today.year, 1, 1))
            db.add(BenefitEnrollment(id=f"be-seed-{who}-{plan.id}"[:64], employee_id=who, plan_id=plan.id,
                                     status="approved", effective_date=effective, decided_by=HR if who != HR else ADMIN,
                                     decided_at=_at(effective - timedelta(days=10))))
            added += 1
    return added


TASKS = {  # assignee: [(suffix, code, subject, status, due in days, priority, assigned by, notes)]
    RAM: [("1", "TSK-2101", "Approve the December on-call rota", "open", 3, "high", CEO,
           "Check the holiday cover before publishing.")],
    HR: [("1", "TSK-2102", "Review the 2027 holiday calendar for India", "progress", 6, "medium", CEO,
          "Confirm the optional holiday list with the office managers."),
         ("2", "TSK-2103", "Close out Q3 exit interviews", "open", 12, "low", CEO, "Summarise themes for the leadership review.")],
    SOPHIE: [("1", "TSK-2104", "Shortlist for the Senior React Engineer role", "progress", 4, "high", RAM,
              "Five profiles by Friday; Ram will pick panels.")],
    CEO: [("1", "TSK-2105", "Sign off the 2027 headcount plan", "open", 9, "high", HR,
           "Final numbers from finance are in the shared folder.")],
    ADMIN: [("1", "TSK-2106", "Quarterly access review for admin accounts", "progress", 5, "high", CEO,
             "Remove access for anyone who changed roles this quarter."),
            ("2", "TSK-2107", "Renew the SSO signing certificate", "open", 20, "medium", CEO,
             "Current certificate expires next month.")],
}


def _tasks(db: Session, people: dict[str, Employee], today: date) -> int:
    have = _have(db, SharedTask, SharedTask.assignee_id, OWN)
    added = 0
    for who, rows in TASKS.items():
        emp = people.get(who)
        if emp is None or who in have:
            continue
        for suffix, code, subject, status, due_in, priority, by, notes in rows:
            tid = f"task-seed-{who}-{suffix}"[:64]
            by_name = people[by].first_name if by in people else "HR"
            created = (today - timedelta(days=4)).isoformat() + "T09:00:00"
            due = today + timedelta(days=due_in)
            data = {
                "id": tid, "code": code, "employeeId": who, "subject": subject, "priority": priority, "status": status,
                "assignedBy": by_name, "owner": emp.first_name or emp.full_name, "department": emp.department,
                "role": emp.job_title, "managerName": by_name, "client": "Internal", "projectName": "Operations",
                "notes": notes, "blocked": "", "automationNote": f"Assigned by {by_name}", "createdAt": created,
                "estimatedHours": 2, "hoursSpent": 1 if status == "progress" else 0, "score": 75, "lastActivityAt": created,
                "due": due.isoformat(), "progressPct": 40 if status == "progress" else 0, "accepted": status == "progress",
                "subtasks": [], "attachments": [], "comments": [], "peopleIds": [], "ccIds": [],
                "activity": [{"id": f"act-{tid}-1", "at": created, "actor": by_name, "action": "Assigned",
                              "detail": f"Assigned to {emp.first_name or emp.full_name}"}],
            }
            db.add(SharedTask(id=tid, code=code, assignee_id=who, created_by=by, people_ids=[], status=status, due=due,
                              data=data, version=1))
            added += 1
    return added


MAIL = {  # recipient: [(suffix, from, category, subject, days ago, read, body)]
    ADMIN: [("1", HR, "IT", "Access for the two December joiners", 2, False,
             "Hi Alex,\n\nTwo joiners start on the first Monday of December. Could you set up their accounts and "
             "laptops the Friday before?\n\nThanks,\nFarhan"),
            ("2", CEO, "IT", "SSO certificate renewal", 6, True,
             "Alex,\n\nPlease plan the SSO certificate renewal for a quiet evening and let the managers know.\n\nJordan")],
    CEO: [("1", HR, "People", "2027 headcount plan: final draft", 1, False,
           "Hi Jordan,\n\nThe final draft is ready for your sign-off. Engineering and Sales have the biggest changes.\n\n"
           "Regards,\nFarhan")],
    SOPHIE: [("1", RAM, "Hiring", "Panel for the Senior React Engineer role", 3, False,
              "Hi Sophie,\n\nPriya and I can take the technical rounds next week. Tuesday and Thursday afternoons IST "
              "work best.\n\nRam")],
    HR: [("1", ADMIN, "IT", "Payroll export job moved to 02:00", 5, True,
          "Hi Farhan,\n\nThe nightly payroll export now runs at 02:00 UK time. No change for you.\n\nAlex")],
}


def _mail(db: Session, people: dict[str, Employee], today: date) -> int:
    have = _have(db, MailRecipient, MailRecipient.person_id, list(MAIL))
    added = 0
    for who, rows in MAIL.items():
        if who not in people or who in have:
            continue
        for suffix, sender, category, subject, ago, read, body in rows:
            if sender not in people:
                continue
            mid = f"ml-seed-{who}-{suffix}"[:64]
            at = _at(today - timedelta(days=ago), 5)
            msg = MailMessage(id=mid, thread_id=f"th-seed-{who}-{suffix}"[:64], from_id=sender,
                              from_name=people[sender].full_name, subject=subject, body=body, category=category, sent_at=at)
            msg.recipients.append(MailRecipient(person_id=who, kind="to", read_at=at + timedelta(hours=1) if read else None))
            db.add(msg)
            added += 1
    return added


EVENTS = [  # id suffix, owner, title, days ahead, time, location, attendees, description
    ("lt-weekly", CEO, "Leadership team weekly", 1, "16:00", "Video call", [HR, RAM, ADMIN],
     "Hiring, attrition and the year-end plan."),
    ("hr-1on1", HR, "1:1 with Sophie", 2, "10:30", "Video call", [SOPHIE], "Hiring pipeline and the campus drive."),
    ("hiring-sync", SOPHIE, "Hiring sync: Senior React Engineer", 3, "09:30", "Video call", [RAM],
     "Shortlist review and interview panels."),
    ("access-review", ADMIN, "Quarterly access review", 6, "14:00", "Conf · Thames", [HR],
     "Walk through admin and HR role changes this quarter."),
]


def _calendar(db: Session, people: dict[str, Employee], today: date) -> int:
    owners = _have(db, CalendarEvent, CalendarEvent.owner_id, OWN)
    attending = _have(db, CalendarAttendee, CalendarAttendee.person_id, OWN)
    busy = owners | attending
    added = 0
    for suffix, owner, title, ahead, at, place, attendees, text in EVENTS:
        eid = f"cal-seed-{suffix}"
        if owner not in people or owner in busy or db.get(CalendarEvent, eid) is not None:
            continue
        emp = people[owner]
        ev = CalendarEvent(id=eid, kind="meeting", title=title, day=_workday(db, emp, today + timedelta(days=ahead)),
                           time=at, location=place, description=text, owner_id=owner)
        for pid in attendees:
            if pid in people:
                ev.attendees.append(CalendarAttendee(person_id=pid, response="accepted" if pid != SOPHIE else "pending"))
        db.add(ev)
        added += 1
    return added


def seed(db: Session) -> dict[str, int]:
    db.flush()
    people = _people(db)
    if HR not in people:
        return {}
    today = date.today()
    pool = _Pool(db, today)
    stats: dict[str, int] = {}
    leave_added, ram_leave = _leave(db, people, today)
    stats["hr_activity_leave_added"] = leave_added
    db.flush()
    stats["hr_activity_documents_added"] = _own_documents(db, people, today)
    stats["hr_activity_expenses_added"] = _expenses(db, people, today)
    stats["hr_activity_trips_added"] = _trips(db, people, today)
    stats["hr_activity_tax_declarations_added"] = _tax(db, people, today)
    stats["hr_activity_dependents_added"] = _dependents(db, people, today)
    stats["hr_activity_bonuses_added"] = _bonuses(db, people, today)
    stats["hr_activity_enrollments_added"] = _enrollments(db, people, today)
    stats["hr_activity_tasks_added"] = _tasks(db, people, today)
    stats["hr_activity_mail_added"] = _mail(db, people, today)
    stats["hr_activity_events_added"] = _calendar(db, people, today)
    db.flush()
    stats["hr_activity_exits_added"] = _exits(db, pool, today)
    stats["hr_activity_cases_added"] = _cases(db, pool, today)
    stats["hr_activity_letters_added"] = _letters(db, pool, people, today)
    stats["hr_activity_corrections_added"] = _corrections(db, pool, today)
    stats["hr_activity_policy_acks_added"] = _policy_acks(db, today)
    stats["hr_activity_verification_docs_added"] = _verification_docs(db, pool, today)
    stats["hr_activity_self_service_added"] = _self_service(db, pool, today)
    stats["hr_activity_life_events_added"] = _life_events(db, pool, today)
    stats["hr_activity_proposals_added"] = _proposal(db, people, today)
    stats["hr_activity_delegations_added"] = _delegations(db, people, today, ram_leave)
    stats["hr_activity_onboarding_added"] = _onboarding(db, today)
    stats["hr_activity_desk_ratings_added"] = _desk_ratings(db)
    db.flush()
    return stats

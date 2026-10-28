"""Benefits rules (same as the portal: src/data/rewardLocal.ts).

- plans belong to one country; eligibility JSON: excluded employment types, minimum months of service, grades
- statutory (mandatory) plans can't be requested or waived; auto-enrolled plans are joined automatically
- elections and dependent cover change only while a window is open: open enrollment (dates or an HR override) or
  the 30 days after a life event the employee reported
- dependents are verified by HR before they can be covered; a covered dependent can't be removed or rejected
- HR decides enrollment requests (HR's own go to their line manager); never your own
- nominee shares for one nomination must total 100%
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.deps import CurrentUser
from app.models import Account, BenefitPlan, BenefitWindow, Employee, LifeEvent
from app.services.scope import HR_ROLES, manager_chain_ids

LIFE_EVENT_TYPES = ("Marriage", "Birth or adoption", "Divorce", "Death of a dependent", "Spouse lost coverage")
LIFE_EVENT_WINDOW_DAYS = 30
DEPENDENT_RELATIONSHIPS = ("Spouse", "Partner", "Child", "Parent", "Parent-in-law")
PLAN_TYPES = ("Medical", "Dental", "Vision", "Life", "Retirement", "Wellness", "Other")


class BenefitError(ValueError):
    """A rule was broken (422); the message is safe to show the user."""


class BenefitConflict(BenefitError):
    """Clashes with the current state (409)."""


def months_between(start: date, end: date) -> int:
    months = (end.year - start.year) * 12 + (end.month - start.month)
    if end.day < start.day:
        months -= 1
    return months


def add_months(day: date, months: int) -> date:
    y, m = divmod(day.month - 1 + months, 12)
    year, month = day.year + y, m + 1
    for d in (day.day, 30, 29, 28):
        try:
            return date(year, month, d)
        except ValueError:
            continue
    return date(year, month, 28)


def eligibility_rules(plan: BenefitPlan) -> list[str]:
    rules = [f"Works in {plan.country_code}"]
    e = plan.eligibility or {}
    if e.get("exclude_employment_types"):
        rules.append(f"Not {' or '.join(e['exclude_employment_types']).lower()} staff")
    if e.get("min_service_months"):
        n = int(e["min_service_months"])
        rules.append(f"At least {n} month{'' if n == 1 else 's'} of service")
    if e.get("grades"):
        rules.append(f"Grade {', '.join(e['grades'])}")
    return rules


def check_eligibility(plan: BenefitPlan, emp: Employee, today: date) -> tuple[bool, str]:
    if emp.country_code != plan.country_code:
        return False, f"Only for staff in {plan.country_code}"
    e = plan.eligibility or {}
    kind = (emp.employment_type or "").lower()
    if any(t.lower() in kind for t in e.get("exclude_employment_types") or []):
        return False, f"Not open to {(emp.employment_type or '').lower()} staff"
    minimum = int(e.get("min_service_months") or 0)
    if minimum and months_between(emp.joining_date, today) < minimum:
        return False, f"Needs {minimum} months of service (eligible from {add_months(emp.joining_date, minimum).isoformat()})"
    grades = e.get("grades") or []
    if grades and emp.grade not in grades:
        return False, f"Grade {emp.grade or 'unknown'} is not covered"
    return True, ""


def window_is_open(win: BenefitWindow, today: date) -> bool:
    if win.override == "open":
        return True
    if win.override == "closed":
        return False
    return win.start_date <= today <= win.end_date


def windows_for(db: Session, country_code: str) -> list[BenefitWindow]:
    return list(db.scalars(select(BenefitWindow).where(or_(BenefitWindow.country_code.is_(None),
                                                           BenefitWindow.country_code == country_code))
                           .order_by(BenefitWindow.start_date.desc())))


def active_life_event(db: Session, employee_id: str, today: date) -> LifeEvent | None:
    return db.scalar(select(LifeEvent).where(LifeEvent.employee_id == employee_id, LifeEvent.status == "open",
                                             LifeEvent.window_ends >= today, LifeEvent.event_date <= today)
                     .order_by(LifeEvent.window_ends.desc()))


@dataclass
class ChangeWindow:
    open: bool
    text: str
    window_id: str | None = None
    life_event_id: str | None = None
    until: date | None = None


def change_window(db: Session, emp: Employee, today: date) -> ChangeWindow:
    windows = windows_for(db, emp.country_code)
    for win in windows:
        if window_is_open(win, today):
            until = None if win.override == "open" else win.end_date
            return ChangeWindow(True, f"{win.name} is open" + (f" until {until.isoformat()}." if until else "."), win.id, None, until)
    event = active_life_event(db, emp.id, today)
    if event is not None:
        return ChangeWindow(True, f"{event.event_type} window is open until {event.window_ends.isoformat()}.", None, event.id,
                            event.window_ends)
    upcoming = [w for w in windows if w.override != "closed" and w.start_date > today]
    label = (f" ({upcoming[-1].start_date.isoformat()} to {upcoming[-1].end_date.isoformat()})" if upcoming
             else f" ({windows[0].start_date.isoformat()} to {windows[0].end_date.isoformat()})" if windows else "")
    return ChangeWindow(False, f"Benefit changes are allowed only during open enrollment{label} or within "
                               f"{LIFE_EVENT_WINDOW_DAYS} days of a life event.")


def require_window(db: Session, emp: Employee, today: date) -> ChangeWindow:
    win = change_window(db, emp, today)
    if not win.open:
        raise BenefitConflict(win.text)
    return win


def is_benefits_hr(user: CurrentUser) -> bool:
    return user.account.role in HR_ROLES


def can_decide_for(db: Session, user: CurrentUser, emp: Employee) -> bool:
    """HR in scope decides; HR's own items go to their line manager. Never your own."""
    if not user.employee_id or emp.id == user.employee_id:
        return False
    if is_benefits_hr(user) and user.scope.can_see(emp):
        return True
    subject_role = db.scalar(select(Account.role).where(Account.employee_id == emp.id))
    return subject_role in HR_ROLES and user.employee_id in manager_chain_ids(db, emp.id)


def life_event_window_end(event_date: date) -> date:
    return event_date + timedelta(days=LIFE_EVENT_WINDOW_DAYS)

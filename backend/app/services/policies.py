"""Policies HR publishes (app/models/policies.py): audience, versions, acknowledgements, reminders.

- HR (HR_ROLES) and admins create and edit policies. Edits go into the draft version (the next number); publishing
  makes it current and notifies everyone it targets ("Needs your acknowledgement" when requires_ack).
- Audience: all, by country (country codes) or by department (names). People who have left are never targeted.
- An acknowledgement is for one version; a new version needs a new one.
"""

from __future__ import annotations

import re
import uuid
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import Employee, PolicyAcknowledgment
from app.models.policies import HrPolicy, HrPolicyVersion
from app.services.activity import notify
from app.services.headcount import started_clause
from app.services.scope import HR_ROLES

EDITOR_ROLES = HR_ROLES | {"admin"}
LEFT_STATUSES = ("Terminated", "Exited", "Resigned", "Separated", "Inactive")


class PolicyError(ValueError):
    """A rule was broken (422); the message is safe to show."""


def can_edit(role: str) -> bool:
    return role in EDITOR_ROLES


def slug(title: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40] or "policy"
    return f"{base}-{uuid.uuid4().hex[:6]}"


def clean_sections(sections: list[Any]) -> list[dict[str, Any]]:
    out = []
    for s in sections:
        heading = (s.heading if hasattr(s, "heading") else s.get("heading", "")).strip()
        rules = [r.strip() for r in (s.rules if hasattr(s, "rules") else s.get("rules", [])) if r and r.strip()]
        if heading or rules:
            out.append({"heading": heading or "Rules", "rules": rules[:40]})
    return out


def versions(db: Session, policy_id: str) -> list[HrPolicyVersion]:
    return list(db.scalars(select(HrPolicyVersion).where(HrPolicyVersion.policy_id == policy_id)
                           .order_by(HrPolicyVersion.version.desc())))


def draft_of(db: Session, policy: HrPolicy) -> HrPolicyVersion | None:
    return db.scalar(select(HrPolicyVersion).where(HrPolicyVersion.policy_id == policy.id, HrPolicyVersion.status == "draft"))


def targets(policy: HrPolicy, emp: Employee) -> bool:
    if (emp.employment_status or "") in LEFT_STATUSES:
        return False
    values = set(policy.audience_values or [])
    if policy.audience_type == "country":
        return emp.country_code in values
    if policy.audience_type == "department":
        return (emp.department or "") in values
    return True


def target_query(policy: HrPolicy):
    # People working here now (as in headcount): joiners who haven't started are asked once they start.
    stmt = select(Employee).where(Employee.employment_status.not_in(LEFT_STATUSES), started_clause(date.today()))
    values = list(policy.audience_values or [])
    if policy.audience_type == "country":
        stmt = stmt.where(Employee.country_code.in_(values or [""]))
    elif policy.audience_type == "department":
        stmt = stmt.where(Employee.department.in_(values or [""]))
    return stmt


def check_audience(audience_type: str, values: list[str]) -> list[str]:
    clean = sorted({v.strip() for v in values if v and v.strip()})
    if audience_type != "all" and not clean:
        raise PolicyError("Choose at least one country or department.")
    return clean if audience_type != "all" else []


def publish(db: Session, policy: HrPolicy, actor_employee_id: str | None) -> int:
    """Draft -> current version; notifies the audience. Returns how many people were notified."""
    draft = draft_of(db, policy)
    if draft is None:
        raise PolicyError("There are no changes to publish.")
    if not draft.sections and not draft.summary.strip():
        raise PolicyError("Add the policy text before publishing.")
    if policy.current_version and not draft.change_summary.strip():
        raise PolicyError("Say what changed in this version.")
    draft.status, draft.published_at, draft.published_by = "published", utcnow(), actor_employee_id
    policy.current_version, policy.status = draft.version, "published"
    db.flush()
    return notify_audience(db, policy, draft, reminder=False)


def pending_people(db: Session, policy: HrPolicy, scope_filter: Any = None) -> tuple[list[Employee], dict[str, PolicyAcknowledgment]]:
    stmt = target_query(policy)
    if scope_filter is not None:
        stmt = stmt.where(scope_filter)
    people = list(db.scalars(stmt.order_by(Employee.full_name)))
    acks = {a.employee_id: a for a in db.scalars(select(PolicyAcknowledgment).where(
        PolicyAcknowledgment.policy_id == policy.id, PolicyAcknowledgment.policy_version == str(policy.current_version)))}
    return people, acks


def notify_audience(db: Session, policy: HrPolicy, version: HrPolicyVersion, *, reminder: bool,
                    only: list[Employee] | None = None) -> int:
    people = only if only is not None else list(db.scalars(target_query(policy)))
    change = version.change_summary.strip()
    if reminder:
        title = f"Reminder: acknowledge {policy.title}"
        body = f"Please read and acknowledge version {version.version}."
    elif policy.requires_ack:
        title = f"Needs your acknowledgement: {policy.title}"
        body = change or f"Version {version.version} is published. Please read and acknowledge it."
    else:
        title = f"Policy updated: {policy.title}"
        body = change or f"Version {version.version} is published."
    if version.effective_date and not reminder:
        body = f"{body} Effective {version.effective_date.strftime('%d %b %Y').lstrip('0')}."
    for emp in people:
        notify(db, recipient_id=emp.id, title=title[:200], body=body[:1000], href=f"/policies?policy={policy.id}")
    return len(people)

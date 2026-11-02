"""Comments, "more information" requests, supporting files and the audit trail of a self-service request
(migration 0028). One set of rules for every request type, so each page shows the same history panel.

- Anyone who can see the request can read its thread. The requester and the people deciding it may comment.
- "Request more information" (kind info_request): someone the request currently waits on, or HR / finance / admin
  who can see it, never the requester. The requester is notified; their next comment is the reply (info_reply) and
  notifies whoever asked. A request has open questions while the latest info_request is newer than the latest reply.
- Files: the requester (or HR / finance / admin) adds PDF or image files up to 5 MB (same checks as receipts).
- Visibility comes from each module's own router helper, so these endpoints never show more than the module does.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import CurrentUser
from app.models import ApprovalInstance, AuditLog, Employee, RequestAttachment, RequestComment
from app.services import approvals as engine
from app.services.activity import notify

ENTITY_TYPES = ("expense", "travel", "cash_advance", "encashment", "overtime", "document")
LABELS = {"expense": "expense claim", "travel": "travel request", "cash_advance": "cash advance",
          "encashment": "leave encashment", "overtime": "overtime request", "document": "document"}
AUDIT_ENTITIES = {"expense": "expense_claim", "travel": "travel_request", "cash_advance": "cash_advances",
                  "encashment": "encashment_requests", "overtime": "overtime_requests", "document": "employee_document"}
REVIEWER_ROLES = frozenset({"hr_admin", "hr", "hrbp", "admin", "super_admin", "finance"})
PURPOSES = ("supporting", "settlement", "booking")
MAX_FILES = 10


class ExtrasError(ValueError):
    """Refused; the message is safe to show (422, or 403 when it starts with "Only")."""


@dataclass
class Target:
    entity_type: str
    row: Any
    owner: Employee
    instance: ApprovalInstance | None
    href: str


def href_for(entity_type: str, entity_id: str) -> str:
    return {"expense": f"/expenses?open={entity_id}", "travel": f"/travel?open={entity_id}",
            "cash_advance": f"/cash?open={entity_id}", "encashment": f"/encashment?open={entity_id}",
            "overtime": f"/overtime?open={entity_id}", "document": "/documents"}[entity_type]


def resolve(db: Session, user: CurrentUser, entity_type: str, entity_id: str) -> Target:
    """The request if this user may see it (each module's own check), else the module's 404."""
    from app.models import CashAdvance, EncashmentRequest

    if entity_type == "expense":
        from app.routers.expenses import _visible_claim

        row, owner = _visible_claim(db, user, entity_id)
    elif entity_type == "travel":
        from app.routers.travel import _visible

        row, owner = _visible(db, user, entity_id)
    elif entity_type in ("cash_advance", "encashment"):
        from app.routers.self_service import _get, _hr_or_admin

        row, owner = _get(db, user, CashAdvance if entity_type == "cash_advance" else EncashmentRequest, entity_id,
                          _hr_or_admin(user))
    elif entity_type == "overtime":
        from app.routers.overtime import _get as get_overtime

        row, owner = get_overtime(db, user, entity_id)
    elif entity_type == "document":
        from app.routers.documents import _visible_doc

        row, owner = _visible_doc(db, user, entity_id)
    else:
        raise ExtrasError("Unknown request type.")
    instance_id = getattr(row, "approval_instance_id", None)
    instance = db.get(ApprovalInstance, instance_id) if instance_id else None
    return Target(entity_type, row, owner, instance, href_for(entity_type, entity_id))


def is_reviewer(user: CurrentUser) -> bool:
    return user.account.role in REVIEWER_ROLES


def can_request_info(db: Session, user: CurrentUser, target: Target) -> bool:
    me = user.employee_id
    if not me or me == target.owner.id:
        return False
    return engine.can_act(db, target.instance, me) or is_reviewer(user)


def comments_of(db: Session, entity_type: str, entity_id: str) -> list[RequestComment]:
    return list(db.scalars(select(RequestComment).where(RequestComment.entity_type == entity_type,
                                                        RequestComment.entity_id == entity_id)
                           .order_by(RequestComment.created_at, RequestComment.id)))


def info_open(comments: list[RequestComment]) -> bool:
    asked = [c.created_at for c in comments if c.kind == "info_request"]
    replied = [c.created_at for c in comments if c.kind == "info_reply"]
    return bool(asked) and (not replied or max(asked) > max(replied))


def open_info_ids(db: Session, entity_type: str, ids: list[str]) -> set[str]:
    """Which of these requests have an unanswered "more information" question."""
    if not ids:
        return set()
    rows = db.scalars(select(RequestComment).where(RequestComment.entity_type == entity_type,
                                                   RequestComment.entity_id.in_(ids),
                                                   RequestComment.kind.in_(("info_request", "info_reply"))))
    by: dict[str, list[RequestComment]] = {}
    for c in rows:
        by.setdefault(c.entity_id, []).append(c)
    return {k for k, v in by.items() if info_open(v)}


def add_comment(db: Session, user: CurrentUser, target: Target, body: str, info: bool) -> RequestComment:
    text = (body or "").strip()
    if not text:
        raise ExtrasError("Write a comment first.")
    me = user.employee_id
    author = db.get(Employee, me) if me else None
    is_owner = me == target.owner.id
    comments = comments_of(db, target.entity_type, target.row.id)
    if info:
        if not can_request_info(db, user, target):
            raise ExtrasError("Only the people deciding this request can ask for more information.")
        kind = "info_request"
    elif is_owner:
        kind = "info_reply" if info_open(comments) else "comment"
    else:
        delegate = target.instance is not None and engine.is_delegate_for(db, target.instance, me)
        if not (can_request_info(db, user, target) or delegate):
            raise ExtrasError("Only the requester and the people deciding it can comment.")
        kind = "comment"
    row = RequestComment(id=f"rc-{uuid.uuid4().hex[:12]}", entity_type=target.entity_type, entity_id=target.row.id,
                         author_id=me, author_name=author.full_name if author else user.account.email,
                         kind=kind, body=text[:2000])
    db.add(row)
    label = LABELS[target.entity_type]
    who = row.author_name
    if is_owner:
        recipients: set[str] = set()
        if target.instance is not None:
            for ids in engine.open_groups(db, target.instance).values():
                recipients.update(ids)
        recipients.update(c.author_id for c in comments if c.kind == "info_request" and c.author_id)
        for rid in recipients - {me}:
            notify(db, recipient_id=rid, title=f"{who} {'answered your question on' if kind == 'info_reply' else 'commented on'} a {label}",
                   body=text[:300], href=target.href)
    else:
        notify(db, recipient_id=target.owner.id,
               title=f"More information needed on your {label}" if info else f"{who} commented on your {label}",
               body=text[:300], href=target.href)
    from app.services.activity import record_audit

    record_audit(db, actor_id=user.id, action=f"{target.entity_type}_{kind}", entity=AUDIT_ENTITIES[target.entity_type],
                 entity_id=target.row.id, subject_id=target.owner.id, after={"comment": text[:200]})
    db.flush()
    return row


def can_attach(user: CurrentUser, target: Target) -> bool:
    return user.employee_id == target.owner.id or is_reviewer(user)


def attachments_of(db: Session, entity_type: str, entity_id: str) -> list[RequestAttachment]:
    return list(db.scalars(select(RequestAttachment).where(RequestAttachment.entity_type == entity_type,
                                                           RequestAttachment.entity_id == entity_id)
                           .order_by(RequestAttachment.created_at)))


def audit_trail(db: Session, target: Target) -> list[dict[str, Any]]:
    """Who did what to this request (the module's own audit rows and its approval decisions), oldest first."""
    from app.models import Account

    stmt = select(AuditLog).where(AuditLog.entity == AUDIT_ENTITIES[target.entity_type], AuditLog.entity_id == target.row.id)
    rows = list(db.scalars(stmt))
    if target.instance is not None:
        rows += list(db.scalars(select(AuditLog).where(AuditLog.entity == "approval_instance",
                                                       AuditLog.entity_id == target.instance.id)))
    actors = {r.actor_id for r in rows if r.actor_id}
    names: dict[str, str] = {}
    if actors:
        for acc_id, emp_id in db.execute(select(Account.id, Account.employee_id).where(Account.id.in_(actors))).all():
            emp = db.get(Employee, emp_id) if emp_id else None
            if emp is not None:
                names[acc_id] = emp.full_name
        for emp_id, name in db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_(actors))).all():
            names.setdefault(emp_id, name)
    rows.sort(key=lambda r: (r.at, r.id))
    return [{"action": r.action, "actor": names.get(r.actor_id or "", "System" if not r.actor_id else r.actor_id),
             "at": r.at} for r in rows]

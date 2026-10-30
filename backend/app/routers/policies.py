"""Policies HR writes in the portal: create, edit (draft), publish a version, archive; employees acknowledge.

Rules: app/services/policies.py. Built-in library policies (src/data/policyLibrary.ts) stay in the portal; a
policy saved here with the same id replaces the built-in one once published.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Country, Employee, PolicyAcknowledgment
from app.models.policies import HrPolicy, HrPolicyVersion
from app.schemas.policies import (
    PolicyAckBody,
    PolicyAudienceOptionsOut,
    PolicyIn,
    PolicyMyAckOut,
    PolicyOut,
    PolicyPersonOut,
    PolicyPublishOut,
    PolicyRemindOut,
    PolicyTrackingOut,
    PolicyVersionOut,
)
from app.services import policies as svc
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, me

router = APIRouter(prefix="/policies", tags=["policies"])


def _editor(user: CurrentUser) -> bool:
    return svc.can_edit(user.account.role)


def _require_editor(user: CurrentUser) -> None:
    if not _editor(user):
        raise HTTPException(403, "Only HR can change policies.")


def _out(db: DbSession, user: CurrentUser, p: HrPolicy) -> PolicyOut:
    editor = _editor(user)
    emp = user.employee
    rows = [v for v in svc.versions(db, p.id) if editor or v.status == "published"]
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(
        Employee.id.in_({v.published_by for v in rows if v.published_by} or {""}))).all())
    my_ack = None
    if emp is not None and p.current_version:
        ack = db.scalar(select(PolicyAcknowledgment).where(PolicyAcknowledgment.employee_id == emp.id,
                                                          PolicyAcknowledgment.policy_id == p.id)
                        .order_by(PolicyAcknowledgment.acknowledged_at.desc()))
        if ack is not None:
            my_ack = PolicyMyAckOut(version=ack.policy_version, acknowledged_at=ack.acknowledged_at, comment=ack.comment)
    versions = []
    for v in rows:
        item = PolicyVersionOut.model_validate(v)
        item.published_by_name = names.get(v.published_by or "")
        versions.append(item)
    return PolicyOut(id=p.id, title=p.title, category=p.category, status=p.status, audience_type=p.audience_type,
                     audience_values=list(p.audience_values or []), requires_ack=p.requires_ack,
                     current_version=p.current_version, updated_at=p.updated_at,
                     targets_me=bool(emp is not None and svc.targets(p, emp)), my_ack=my_ack, versions=versions)


def _get(db: DbSession, user: CurrentUser, policy_id: str) -> HrPolicy:
    p = db.get(HrPolicy, policy_id)
    if p is None:
        raise NOT_FOUND
    if not _editor(user) and (p.status != "published" or user.employee is None or not svc.targets(p, user.employee)):
        raise NOT_FOUND
    return p


@router.get("", response_model=list[PolicyOut])
def list_policies(db: DbSession, user: CurrentUserDep) -> list[PolicyOut]:
    """HR: every policy (drafts and archived too). Everyone else: published policies that apply to them."""
    rows = list(db.scalars(select(HrPolicy).order_by(HrPolicy.title)))
    if not _editor(user):
        emp = user.employee
        rows = [p for p in rows if p.status == "published" and emp is not None and svc.targets(p, emp)]
    return [_out(db, user, p) for p in rows]


@router.get("/audience-options", response_model=PolicyAudienceOptionsOut)
def audience_options(db: DbSession, user: CurrentUserDep) -> PolicyAudienceOptionsOut:
    _require_editor(user)
    countries = [{"code": c.code, "name": c.name} for c in db.scalars(select(Country).order_by(Country.name))]
    departments = sorted({d for d in db.scalars(select(Employee.department).distinct()) if d})
    return PolicyAudienceOptionsOut(countries=countries, departments=departments)


def _apply(db: DbSession, user: CurrentUser, p: HrPolicy, body: PolicyIn) -> HrPolicyVersion:
    try:
        values = svc.check_audience(body.audience_type, body.audience_values)
    except svc.PolicyError as exc:
        raise HTTPException(422, str(exc)) from exc
    p.title, p.category = body.title.strip(), body.category.strip()
    p.audience_type, p.audience_values, p.requires_ack = body.audience_type, values, body.requires_ack
    p.updated_by = user.id
    draft = svc.draft_of(db, p)
    if draft is None:
        start = max(p.current_version, body.base_version if not p.current_version else 0)
        draft = HrPolicyVersion(policy_id=p.id, version=start + 1, status="draft")
        db.add(draft)
    draft.summary = body.summary.strip()
    draft.sections = svc.clean_sections(body.sections)
    draft.change_summary = body.change_summary.strip()
    draft.effective_date = body.effective_date
    db.flush()
    return draft


@router.post("", response_model=PolicyOut, status_code=status.HTTP_201_CREATED)
def create_policy(body: PolicyIn, request: Request, db: DbSession, user: CurrentUserDep) -> PolicyOut:
    """A new policy (or an editable copy of a built-in one: pass its id and version) saved as a draft."""
    _require_editor(user)
    pid = body.id or svc.slug(body.title)
    if db.get(HrPolicy, pid) is not None:
        raise HTTPException(409, "This policy already exists here. Edit it instead.")
    p = HrPolicy(id=pid, title=body.title.strip(), category=body.category.strip(), status="draft", current_version=0,
                 created_by=user.id)
    db.add(p)
    db.flush()
    draft = _apply(db, user, p, body)
    record_audit(db, actor_id=user.id, action="policy_created", entity="policy", entity_id=p.id,
                 after={"title": p.title, "version": draft.version, "audience": p.audience_type}, ip=client_ip(request))
    db.commit()
    return _out(db, user, p)


@router.put("/{policy_id}", response_model=PolicyOut)
def update_policy(policy_id: str, body: PolicyIn, request: Request, db: DbSession, user: CurrentUserDep) -> PolicyOut:
    """Saves changes as the next version's draft (the published version stays current until you publish)."""
    _require_editor(user)
    p = _get(db, user, policy_id)
    if p.status == "archived":
        raise HTTPException(409, "Restore this policy before editing it.")
    draft = _apply(db, user, p, body)
    record_audit(db, actor_id=user.id, action="policy_draft_saved", entity="policy", entity_id=p.id,
                 after={"version": draft.version, "audience": p.audience_type, "values": p.audience_values},
                 ip=client_ip(request))
    db.commit()
    return _out(db, user, p)


@router.delete("/{policy_id}/draft", response_model=PolicyOut)
def discard_draft(policy_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> PolicyOut:
    _require_editor(user)
    p = _get(db, user, policy_id)
    draft = svc.draft_of(db, p)
    if draft is None:
        raise HTTPException(409, "There is no draft to discard.")
    if not p.current_version:
        raise HTTPException(409, "This policy has never been published. Archive it instead.")
    db.delete(draft)
    record_audit(db, actor_id=user.id, action="policy_draft_discarded", entity="policy", entity_id=p.id, ip=client_ip(request))
    db.commit()
    return _out(db, user, p)


@router.post("/{policy_id}/publish", response_model=PolicyPublishOut)
def publish_policy(policy_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> PolicyPublishOut:
    """The draft becomes the current version; everyone it applies to is notified."""
    _require_editor(user)
    p = _get(db, user, policy_id)
    if p.status == "archived":
        raise HTTPException(409, "Restore this policy before publishing it.")
    try:
        notified = svc.publish(db, p, user.employee_id)
    except svc.PolicyError as exc:
        raise HTTPException(422, str(exc)) from exc
    record_audit(db, actor_id=user.id, action="policy_published", entity="policy", entity_id=p.id,
                 after={"version": p.current_version, "notified": notified}, ip=client_ip(request))
    db.commit()
    return PolicyPublishOut(policy=_out(db, user, p), notified=notified)


@router.post("/{policy_id}/archive", response_model=PolicyOut)
def archive_policy(policy_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> PolicyOut:
    _require_editor(user)
    p = _get(db, user, policy_id)
    if p.status == "archived":
        raise HTTPException(409, "This policy is already archived.")
    before = p.status
    p.status, p.updated_by = "archived", user.id
    record_audit(db, actor_id=user.id, action="policy_archived", entity="policy", entity_id=p.id,
                 before={"status": before}, after={"status": "archived"}, ip=client_ip(request))
    db.commit()
    return _out(db, user, p)


@router.post("/{policy_id}/restore", response_model=PolicyOut)
def restore_policy(policy_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> PolicyOut:
    _require_editor(user)
    p = _get(db, user, policy_id)
    if p.status != "archived":
        raise HTTPException(409, "Only archived policies can be restored.")
    p.status, p.updated_by = ("published" if p.current_version else "draft"), user.id
    record_audit(db, actor_id=user.id, action="policy_restored", entity="policy", entity_id=p.id,
                 after={"status": p.status}, ip=client_ip(request))
    db.commit()
    return _out(db, user, p)


@router.post("/{policy_id}/acknowledge", response_model=PolicyOut)
def acknowledge(policy_id: str, body: PolicyAckBody, request: Request, db: DbSession, user: CurrentUserDep) -> PolicyOut:
    """Acknowledge the current version, optionally with a comment or question (sent to whoever published it)."""
    emp = me(user)
    p = db.get(HrPolicy, policy_id)
    if p is None or p.status != "published" or not svc.targets(p, emp):
        raise NOT_FOUND
    version = str(p.current_version)
    if db.scalar(select(PolicyAcknowledgment.id).where(PolicyAcknowledgment.employee_id == emp.id,
                                                       PolicyAcknowledgment.policy_id == p.id,
                                                       PolicyAcknowledgment.policy_version == version)):
        raise HTTPException(409, "You have already acknowledged this version.")
    comment = (body.comment or "").strip() or None
    db.add(PolicyAcknowledgment(employee_id=emp.id, policy_id=p.id, policy_version=version, ip=client_ip(request),
                                comment=comment))
    if comment:
        current = db.scalar(select(HrPolicyVersion).where(HrPolicyVersion.policy_id == p.id,
                                                          HrPolicyVersion.version == p.current_version))
        publisher = current.published_by if current else None
        if publisher and publisher != emp.id:
            notify(db, recipient_id=publisher, title=f"Question on {p.title}"[:200],
                   body=f"{emp.full_name}: {comment}"[:1000], href=f"/policies?policy={p.id}&tab=acks")
    record_audit(db, actor_id=user.id, action="policy_acknowledged", entity="policy", entity_id=p.id, subject_id=emp.id,
                 after={"version": version, "comment": bool(comment)}, ip=client_ip(request))
    db.commit()
    return _out(db, user, p)


def _person(e: Employee, ack: PolicyAcknowledgment | None) -> PolicyPersonOut:
    return PolicyPersonOut(employee_id=e.id, name=e.full_name, department=e.department, country_code=e.country_code,
                           acknowledged_at=ack.acknowledged_at if ack else None, comment=ack.comment if ack else None)


@router.get("/{policy_id}/tracking", response_model=PolicyTrackingOut)
def tracking(policy_id: str, db: DbSession, user: CurrentUserDep) -> PolicyTrackingOut:
    """Who must acknowledge the current version (in your data scope), who has, and their comments."""
    _require_editor(user)
    p = _get(db, user, policy_id)
    people, acks = svc.pending_people(db, p, user.scope.employee_filter())
    done = [_person(e, acks[e.id]) for e in people if e.id in acks]
    pending = [_person(e, None) for e in people if e.id not in acks]
    pct = round(100 * len(done) / len(people)) if people else 0
    return PolicyTrackingOut(policy_id=p.id, version=p.current_version, targeted=len(people), acknowledged=len(done),
                             percent=pct, pending=pending, done=done)


@router.post("/{policy_id}/remind", response_model=PolicyRemindOut)
def remind(policy_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> PolicyRemindOut:
    """Notify everyone (in your scope) who hasn't acknowledged the current version yet."""
    _require_editor(user)
    p = _get(db, user, policy_id)
    if p.status != "published" or not p.requires_ack:
        raise HTTPException(409, "Only published policies that need acknowledgement have reminders.")
    people, acks = svc.pending_people(db, p, user.scope.employee_filter())
    pending = [e for e in people if e.id not in acks]
    current = db.scalar(select(HrPolicyVersion).where(HrPolicyVersion.policy_id == p.id,
                                                      HrPolicyVersion.version == p.current_version))
    count = svc.notify_audience(db, p, current, reminder=True, only=pending) if current and pending else 0
    record_audit(db, actor_id=user.id, action="policy_reminder_sent", entity="policy", entity_id=p.id,
                 after={"version": p.current_version, "reminded": count}, ip=client_ip(request))
    db.commit()
    return PolicyRemindOut(reminded=count)

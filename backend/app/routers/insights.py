"""Leadership insights: director dashboard with drill-down, contractors with contract extension approvals, and the
server-side report builder (run, CSV export, saved reports).

- GET  /insights/leadership              headcount, attrition, hiring, performance, learning, cost (pay roles only),
                                         by country / department; filters country, department, range (30d|90d|ytd|12m)
- GET  /insights/leadership/drill        the people behind a number (no personal identifiers)
- GET  /insights/contractors             contractors in scope with contract end alerts and pending extensions
- POST /insights/contractors/{id}/extensions          manager / HR asks to extend a contract (reason required)
- GET  /insights/contract-extensions                  requests I raised or (HR) can decide
- POST /insights/contract-extensions/{id}/decision    HR approves / rejects with a comment -> employee record updated
- GET  /insights/reports/sources, POST /insights/reports/run, POST /insights/reports/export (CSV, audited)
- GET/POST/PUT/DELETE /insights/reports/saved         saved report definitions (owner; shared ones visible to HR)
Rules: app/services/insights.py.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import ContractExtension, Employee, SavedReport
from app.services import insights as svc
from app.services.activity import notify, record_audit
from app.services.approvals import _accounts_with_roles
from app.services.scope import HR_ROLES, manager_chain_ids

router = APIRouter(prefix="/insights", tags=["insights"])

RangeKey = Literal["30d", "90d", "ytd", "12m"]


def _require_dashboard(user: CurrentUser) -> None:
    if not svc.can_see_dashboard(user):
        raise HTTPException(403, "The leadership dashboard is for managers, HR and directors.")


# ---------- director dashboard ----------
@router.get("/leadership")
def leadership(db: DbSession, user: CurrentUserDep, country: str | None = None, department: str | None = None,
               range: RangeKey = "ytd") -> dict[str, Any]:  # noqa: A002 - query name used by the portal
    _require_dashboard(user)
    return svc.leadership(db, user, country=country or None, department=department or None, range_key=range)


@router.get("/leadership/drill")
def leadership_drill(db: DbSession, user: CurrentUserDep,
                     metric: Annotated[str, Query(pattern="^(" + "|".join(svc.DRILL_METRICS) + ")$")],
                     country: str | None = None, department: str | None = None,
                     range: RangeKey = "ytd") -> list[dict[str, Any]]:  # noqa: A002
    _require_dashboard(user)
    return svc.drill(db, user, metric=metric, country=country or None, department=department or None, range_key=range)


# ---------- contractors ----------
class ExtensionIn(BaseModel):
    new_end: date
    reason: str = Field(min_length=5, max_length=1000)


class ExtensionDecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    comment: str = Field(default="", max_length=1000)


def _ext_out(db: DbSession, e: ContractExtension, user: CurrentUser) -> dict[str, Any]:
    emp = db.get(Employee, e.employee_id)
    who = db.get(Employee, e.requested_by)
    decider = db.get(Employee, e.decided_by) if e.decided_by else None
    return {
        "id": e.id, "employee_id": e.employee_id, "employee_name": emp.full_name if emp else e.employee_id,
        "requested_by": e.requested_by, "requested_by_name": who.full_name if who else e.requested_by,
        "current_end": e.current_end, "new_end": e.new_end, "reason": e.reason, "status": e.status,
        "decided_by_name": decider.full_name if decider else None, "decided_at": e.decided_at,
        "decision_comment": e.decision_comment, "created_at": e.created_at,
        "can_decide": _can_decide(user, e, emp),
    }


def _can_decide(user: CurrentUser, e: ContractExtension, emp: Employee | None) -> bool:
    return (e.status == "pending" and emp is not None and user.scope.is_hr and user.scope.can_see(emp)
            and e.requested_by != user.employee_id and e.employee_id != user.employee_id)


@router.get("/contractors")
def contractors(db: DbSession, user: CurrentUserDep) -> list[dict[str, Any]]:
    now = svc.today(user)
    people = svc.contractors_in_scope(db, user)
    pending = {e.employee_id: e for e in db.scalars(select(ContractExtension).where(
        ContractExtension.status == "pending", ContractExtension.employee_id.in_([p.id for p in people])))} if people else {}
    managers = dict(db.execute(select(Employee.id, Employee.full_name)).all())
    out = []
    for p in people:
        end = p.contract_end_date
        ext = pending.get(p.id)
        out.append({
            "id": p.id, "name": p.full_name, "job_title": p.job_title, "department": p.department,
            "country_code": p.country_code, "manager": managers.get(p.manager_id) if p.manager_id else None,
            "employment_type": p.employment_type, "joining_date": p.joining_date, "contract_end_date": end,
            "days_left": (end - now).days if end else None, "alert": svc.contractor_alert(end, now),
            "pending_extension": _ext_out(db, ext, user) if ext else None,
        })
    order = {"expired": 0, "ending_30": 1, "ending_60": 2, "no_end_date": 3, "ok": 4}
    return sorted(out, key=lambda r: (order[r["alert"]], r["contract_end_date"] or date.max, r["name"]))


@router.post("/contractors/{employee_id}/extensions", status_code=status.HTTP_201_CREATED)
def request_extension(employee_id: str, body: ExtensionIn, request: Request, db: DbSession, user: CurrentUserDep) -> dict[str, Any]:
    emp = db.get(Employee, employee_id)
    if emp is None or not svc.is_contractor(emp) or emp.employment_status == "Terminated":
        raise HTTPException(404, "Contractor not found.")
    in_line = user.employee_id is not None and user.employee_id in manager_chain_ids(db, emp.id)
    if not ((user.scope.is_hr and user.scope.can_see(emp)) or in_line) or emp.id == user.employee_id:
        raise HTTPException(403, "Only the contractor's manager or HR can ask to extend this contract.")
    now = svc.today(user)
    current = emp.contract_end_date
    if body.new_end <= max(current or now, now):
        raise HTTPException(422, "The new end date must be after the current end date and after today.")
    if body.new_end > (current or now) + timedelta(days=3 * 366):
        raise HTTPException(422, "Extend by at most three years at a time.")
    if db.scalar(select(ContractExtension.id).where(ContractExtension.employee_id == emp.id, ContractExtension.status == "pending")):
        raise HTTPException(409, "An extension for this contract is already waiting for a decision.")
    ext = ContractExtension(id=f"cext-{uuid.uuid4().hex[:10]}", employee_id=emp.id, requested_by=user.employee_id or "",
                            current_end=current, new_end=body.new_end, reason=body.reason.strip(), status="pending")
    db.add(ext)
    record_audit(db, actor_id=user.id, action="contract_extension_requested", entity="contract_extension", entity_id=ext.id,
                 subject_id=emp.id, after={"current_end": str(current) if current else None, "new_end": str(body.new_end)},
                 ip=client_ip(request))
    for hr_id in _accounts_with_roles(db, set(HR_ROLES), emp.country_code):
        if hr_id != user.employee_id:
            notify(db, recipient_id=hr_id, title=f"Contract extension for {emp.full_name}",
                   body=f"Extend to {body.new_end}: {ext.reason}", href="/compliance-calendar")
    db.commit()
    return _ext_out(db, ext, user)


@router.get("/contract-extensions")
def list_extensions(db: DbSession, user: CurrentUserDep, status_: Annotated[str | None, Query(alias="status")] = None) -> list[dict[str, Any]]:
    q = select(ContractExtension).order_by(ContractExtension.created_at.desc()).limit(300)
    if status_:
        q = q.where(ContractExtension.status == status_)
    if not user.scope.is_hr:
        line = list(user.scope.reports)
        q = q.where(or_(ContractExtension.requested_by == user.employee_id, ContractExtension.employee_id.in_(line)))
    out = []
    for e in db.scalars(q):
        emp = db.get(Employee, e.employee_id)
        if user.scope.is_hr and emp is not None and not user.scope.can_see(emp) and e.requested_by != user.employee_id:
            continue
        out.append(_ext_out(db, e, user))
    return out


@router.post("/contract-extensions/{ext_id}/decision")
def decide_extension(ext_id: str, body: ExtensionDecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> dict[str, Any]:
    ext = db.get(ContractExtension, ext_id)
    emp = db.get(Employee, ext.employee_id) if ext else None
    if ext is None or emp is None:
        raise HTTPException(404, "Request not found.")
    if ext.status != "pending":
        raise HTTPException(409, "This request has already been decided.")
    if not _can_decide(user, ext, emp):
        raise HTTPException(403, "Only HR (not the person who asked) can decide a contract extension.")
    comment = body.comment.strip()
    if body.decision == "reject" and len(comment) < 5:
        raise HTTPException(422, "Say why the extension is rejected.")
    before = {"contract_end_date": str(emp.contract_end_date) if emp.contract_end_date else None}
    ext.status = "approved" if body.decision == "approve" else "rejected"
    ext.decided_by, ext.decided_at, ext.decision_comment = user.employee_id, utcnow(), comment or None
    if ext.status == "approved":
        emp.contract_end_date = ext.new_end
    record_audit(db, actor_id=user.id, action=f"contract_extension_{ext.status}", entity="contract_extension",
                 entity_id=ext.id, subject_id=emp.id, before=before,
                 after={"contract_end_date": str(emp.contract_end_date) if emp.contract_end_date else None, "comment": comment or None},
                 ip=client_ip(request))
    verdict = "approved" if ext.status == "approved" else "not approved"
    notify(db, recipient_id=ext.requested_by, title=f"Contract extension for {emp.full_name} {verdict}",
           body=(f"New end date {ext.new_end}. " if ext.status == "approved" else "") + (comment or ""), href="/compliance-calendar")
    if ext.status == "approved" and emp.id != ext.requested_by:
        notify(db, recipient_id=emp.id, title="Your contract has been extended", body=f"New end date {ext.new_end}.",
               href="/profile")
    db.commit()
    return _ext_out(db, ext, user)


# ---------- report builder ----------
class ReportIn(BaseModel):
    source: str = Field(min_length=1, max_length=32)
    columns: list[str] = Field(default_factory=list, max_length=40)
    filters: dict[str, Any] = Field(default_factory=dict)
    group_by: str | None = Field(default=None, max_length=64)
    search: str | None = Field(default=None, max_length=200)
    sort: str | None = Field(default=None, max_length=64)
    desc: bool = False


class SavedReportIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    source: str = Field(min_length=1, max_length=32)
    columns: list[str] = Field(default_factory=list, max_length=40)
    filters: dict[str, Any] = Field(default_factory=dict)
    group_by: str | None = Field(default=None, max_length=64)
    shared: bool = False


def _run(db: DbSession, user: CurrentUser, body: ReportIn | SavedReportIn, **extra: Any) -> dict[str, Any]:
    try:
        return svc.run_report(db, user, source=body.source, columns=body.columns, filters=body.filters,
                              group_by=body.group_by, **extra)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from None
    except svc.ReportError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("/reports/sources")
def report_sources(user: CurrentUserDep) -> list[dict[str, Any]]:
    return svc.sources_for(user)


@router.post("/reports/run")
def run_report(body: ReportIn, request: Request, db: DbSession, user: CurrentUserDep) -> dict[str, Any]:
    out = _run(db, user, body, search=body.search, sort=body.sort, desc=body.desc)
    if body.source == "compensation":  # reading other people's pay is always audited
        record_audit(db, actor_id=user.id, action="pay_viewed", entity="report", entity_id=body.source,
                     after={"rows": out["total"]}, ip=client_ip(request))
        db.commit()
    return out


@router.post("/reports/export")
def export_report(body: ReportIn, request: Request, db: DbSession, user: CurrentUserDep) -> dict[str, str]:
    out = _run(db, user, body, search=body.search, sort=body.sort, desc=body.desc)
    record_audit(db, actor_id=user.id, action="report_exported", entity="report", entity_id=body.source,
                 after={"rows": len(out["rows"]), "columns": [c["key"] for c in out["columns"]], "filters": body.filters},
                 ip=client_ip(request))
    db.commit()
    stamp = svc.today(user).isoformat()
    return {"filename": f"timez-{re.sub('[^a-z0-9]+', '-', body.source.lower())}-{stamp}.csv", "content": svc.to_csv(out)}


def _saved_out(r: SavedReport, user: CurrentUser) -> dict[str, Any]:
    return {"id": r.id, "name": r.name, "source": r.source, "columns": r.columns or [], "filters": r.filters or {},
            "group_by": r.group_by, "shared": r.shared, "mine": r.owner_id == user.employee_id,
            "updated_at": r.updated_at}


def _check_definition(db: DbSession, user: CurrentUser, body: SavedReportIn) -> None:
    _run(db, user, body)  # validates the source, columns, filters and grouping against what this user may see


@router.get("/reports/saved")
def list_saved(db: DbSession, user: CurrentUserDep) -> list[dict[str, Any]]:
    cond = SavedReport.owner_id == user.employee_id
    if user.scope.is_hr:
        cond = or_(cond, SavedReport.shared.is_(True))
    return [_saved_out(r, user) for r in db.scalars(select(SavedReport).where(cond).order_by(SavedReport.name))]


@router.post("/reports/saved", status_code=status.HTTP_201_CREATED)
def save_report(body: SavedReportIn, db: DbSession, user: CurrentUserDep) -> dict[str, Any]:
    if not user.employee_id:
        raise HTTPException(403, "Saved reports need an employee profile.")
    _check_definition(db, user, body)
    if db.scalar(select(SavedReport.id).where(SavedReport.owner_id == user.employee_id, SavedReport.name == body.name.strip())):
        raise HTTPException(409, "You already have a report with this name.")
    row = SavedReport(id=f"rpt-{uuid.uuid4().hex[:10]}", owner_id=user.employee_id, name=body.name.strip(), source=body.source,
                      columns=body.columns, filters=body.filters, group_by=body.group_by, shared=body.shared)
    db.add(row)
    db.commit()
    return _saved_out(row, user)


def _own_report(db: DbSession, user: CurrentUser, report_id: str) -> SavedReport:
    row = db.get(SavedReport, report_id)
    if row is None or row.owner_id != user.employee_id:
        raise HTTPException(404, "Report not found.")
    return row


@router.put("/reports/saved/{report_id}")
def update_report(report_id: str, body: SavedReportIn, db: DbSession, user: CurrentUserDep) -> dict[str, Any]:
    row = _own_report(db, user, report_id)
    _check_definition(db, user, body)
    row.name, row.source, row.columns, row.filters = body.name.strip(), body.source, body.columns, body.filters
    row.group_by, row.shared = body.group_by, body.shared
    db.commit()
    return _saved_out(row, user)


@router.delete("/reports/saved/{report_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_report(report_id: str, db: DbSession, user: CurrentUserDep) -> None:
    db.delete(_own_report(db, user, report_id))
    db.commit()

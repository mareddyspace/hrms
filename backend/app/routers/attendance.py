from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select

from app.db import utcnow
from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import AttendanceCorrection, AttendanceSession, Employee
from app.schemas import (
    AttendanceSessionOut,
    AttendanceSummaryOut,
    CheckInIn,
    CheckOutIn,
    CorrectionIn,
    CorrectionOut,
    DecisionIn,
)
from app.services import attendance as rules
from app.services import time_approvals as chain
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, can_decide, can_view, decidable_filter, me, target

router = APIRouter(prefix="/attendance", tags=["attendance"])


def _session_snapshot(s: AttendanceSession) -> dict:
    return {
        "work_date": s.work_date,
        "check_in": s.check_in,
        "check_out": s.check_out,
        "break_minutes": s.break_minutes,
        "work_mode": s.work_mode,
        "source": s.source,
        "is_late": s.is_late,
        "is_early_leave": s.is_early_leave,
        "worked_minutes": s.worked_minutes,
        "corrected": s.corrected,
    }


def _correction_snapshot(c: AttendanceCorrection) -> dict:
    return {
        "status": c.status,
        "work_date": c.work_date,
        "requested_check_in": c.requested_check_in,
        "requested_check_out": c.requested_check_out,
        "decided_by": c.decided_by,
        "decision_note": c.decision_note,
    }


def _correction_out(c: AttendanceCorrection, name: str | None, approval: dict | None = None) -> CorrectionOut:
    out = CorrectionOut.model_validate(c)
    out.employee_name = name
    out.approval = approval
    return out


def _correction_out_one(db: DbSession, viewer_id: str | None, c: AttendanceCorrection, name: str | None) -> CorrectionOut:
    return _correction_out(c, name, chain.progress_map(db, chain.CORRECTION, [c.id], viewer_id).get(c.id))


@router.post("/check-in", response_model=AttendanceSessionOut, status_code=status.HTTP_201_CREATED)
def check_in(body: CheckInIn, request: Request, db: DbSession, user: CurrentUserDep) -> AttendanceSession:
    emp = me(user)
    moment = rules.now()
    work_date = moment.astimezone(rules.zone(emp)).date()
    existing = db.scalar(
        select(AttendanceSession).where(AttendanceSession.employee_id == emp.id, AttendanceSession.work_date == work_date)
    )
    if existing is not None:
        raise HTTPException(409, "You have already checked in today." if existing.check_out is None else "You have already checked out today.")
    session = rules.new_session(emp, work_date, moment, body.work_mode, body.source)
    session.note = (body.note or "").strip() or None
    rules.apply_flags(session)
    db.add(session)
    db.flush()
    record_audit(
        db, actor_id=user.id, action="attendance_check_in", entity="attendance_session", entity_id=session.id,
        subject_id=emp.id, after=_session_snapshot(session), ip=client_ip(request),
    )
    if session.is_late and emp.manager_id:
        notify(
            db,
            recipient_id=emp.manager_id,
            title=f"{emp.full_name} checked in late",
            body=f"{session.late_minutes} min after the {session.shift_start} shift start on {work_date}.",
            href=f"/attendance?employee_id={emp.id}",
        )
    db.commit()
    return session


@router.post("/check-out", response_model=AttendanceSessionOut)
def check_out(body: CheckOutIn, request: Request, db: DbSession, user: CurrentUserDep) -> AttendanceSession:
    emp = me(user)
    moment = rules.now()
    # The open session: today's, or yesterday's for a shift that runs past midnight.
    session = db.scalar(
        select(AttendanceSession)
        .where(
            AttendanceSession.employee_id == emp.id,
            AttendanceSession.check_out.is_(None),
            AttendanceSession.work_date >= moment.astimezone(rules.zone(emp)).date() - timedelta(days=1),
        )
        .order_by(AttendanceSession.work_date.desc())
    )
    if session is None:
        raise HTTPException(409, "You are not checked in.")
    if moment <= session.check_in:
        raise HTTPException(409, "Check-out must be after check-in.")
    before = _session_snapshot(session)
    session.check_out = moment
    if body.break_minutes is not None:
        session.break_minutes = body.break_minutes
    if body.note and body.note.strip():
        session.note = body.note.strip()
    rules.apply_flags(session)
    record_audit(
        db, actor_id=user.id, action="attendance_check_out", entity="attendance_session", entity_id=session.id,
        subject_id=emp.id, before=before, after=_session_snapshot(session), ip=client_ip(request),
    )
    notify(
        db,
        recipient_id=emp.id,
        title="Checked out",
        body=f"{(session.worked_minutes or 0) / 60:.2f} h worked on {session.work_date}.",
        href="/attendance",
    )
    db.commit()
    return session


@router.get("", response_model=list[AttendanceSessionOut])
def list_sessions(
    db: DbSession,
    user: CurrentUserDep,
    employee_id: str | None = None,
    from_date: Annotated[date | None, Query(alias="from")] = None,
    to_date: Annotated[date | None, Query(alias="to")] = None,
) -> list[AttendanceSession]:
    emp = target(db, user, employee_id)
    to_date = to_date or rules.local_today(emp)
    from_date = from_date or to_date - timedelta(days=30)
    if to_date < from_date or (to_date - from_date).days > 366:
        raise HTTPException(422, "Choose a date range of at most a year.")
    return list(
        db.scalars(
            select(AttendanceSession)
            .where(
                AttendanceSession.employee_id == emp.id,
                AttendanceSession.work_date >= from_date,
                AttendanceSession.work_date <= to_date,
            )
            .order_by(AttendanceSession.work_date.desc())
        )
    )


@router.get("/summary", response_model=AttendanceSummaryOut)
def summary(
    db: DbSession,
    user: CurrentUserDep,
    month: Annotated[str | None, Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$", description="YYYY-MM")] = None,
    employee_id: str | None = None,
) -> AttendanceSummaryOut:
    emp = target(db, user, employee_id)
    if month:
        year, mon = (int(x) for x in month.split("-"))
    else:
        today = rules.local_today(emp)
        year, mon = today.year, today.month
    return AttendanceSummaryOut(**vars(rules.month_summary(db, emp, year, mon)))


@router.post("/corrections", response_model=CorrectionOut, status_code=status.HTTP_201_CREATED)
def request_correction(body: CorrectionIn, request: Request, db: DbSession, user: CurrentUserDep) -> CorrectionOut:
    emp = me(user)
    if not body.reason.strip():
        raise HTTPException(422, "Enter a reason.")
    session = db.scalar(
        select(AttendanceSession).where(AttendanceSession.employee_id == emp.id, AttendanceSession.work_date == body.work_date)
    )
    check_in = rules.to_utc(body.requested_check_in, emp) if body.requested_check_in else None
    check_out = rules.to_utc(body.requested_check_out, emp) if body.requested_check_out else None
    try:
        rules.validate_correction_times(
            emp, body.work_date, check_in or (session.check_in if session else None), check_out, session is not None
        )
    except rules.AttendanceError as exc:
        raise HTTPException(422, str(exc)) from exc
    open_one = db.scalar(
        select(AttendanceCorrection.id).where(
            AttendanceCorrection.employee_id == emp.id,
            AttendanceCorrection.work_date == body.work_date,
            AttendanceCorrection.status == "pending",
        )
    )
    if open_one:
        raise HTTPException(409, "There is already an open correction for that date.")

    item = AttendanceCorrection(
        id=f"atc-{uuid.uuid4().hex[:12]}",
        employee_id=emp.id,
        work_date=body.work_date,
        session_id=session.id if session else None,
        requested_check_in=check_in,
        requested_check_out=check_out,
        reason=body.reason.strip(),
        status="pending",
    )
    db.add(item)
    db.flush()
    record_audit(
        db, actor_id=user.id, action="attendance_correction_requested", entity="attendance_correction",
        entity_id=item.id, subject_id=emp.id, after=_correction_snapshot(item), ip=client_ip(request),
    )
    # approval chain "attendance_correction" (manager); the engine tells the approvers
    if emp.manager_id:
        chain.start(db, chain.CORRECTION, item.id, emp, user.id)
    db.commit()
    return _correction_out_one(db, user.employee_id, item, emp.full_name)


@router.get("/corrections", response_model=list[CorrectionOut])
def list_corrections(
    db: DbSession,
    user: CurrentUserDep,
    view: Annotated[str, Query(pattern="^(mine|to-decide)$")] = "mine",
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[CorrectionOut]:
    stmt = select(AttendanceCorrection, Employee.full_name).join(Employee, Employee.id == AttendanceCorrection.employee_id)
    if view == "mine":
        stmt = stmt.where(AttendanceCorrection.employee_id == (user.employee_id or ""))
    else:
        stmt = stmt.where(decidable_filter(user), AttendanceCorrection.status == (status_filter or "pending"))
    if status_filter:
        stmt = stmt.where(AttendanceCorrection.status == status_filter)
    rows = db.execute(stmt.order_by(AttendanceCorrection.created_at.desc()).limit(limit)).all()
    approvals = chain.progress_map(db, chain.CORRECTION, [c.id for c, _ in rows], user.employee_id)
    return [_correction_out(c, name, approvals.get(c.id)) for c, name in rows]


@router.post("/corrections/{correction_id}/decision", response_model=CorrectionOut)
def decide_correction(
    correction_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep
) -> CorrectionOut:
    item = db.get(AttendanceCorrection, correction_id)
    emp = db.get(Employee, item.employee_id) if item else None
    instance = chain.pending_instance(db, chain.CORRECTION, item.id) if item else None
    if item is None or emp is None or not (can_view(db, user, emp) or chain.may_follow(db, user, instance)):
        raise NOT_FOUND
    if instance is not None and item.status == "pending":
        # through the approval chain; the correction is applied when the last step approves it
        chain.decide(db, user, instance, emp, body.decision, body.note, client_ip(request))
        db.commit()
        return _correction_out_one(db, user.employee_id, item, emp.full_name)
    if not can_decide(db, user, emp):
        raise HTTPException(403, "You can't decide this request.")
    if item.status != "pending":
        raise HTTPException(409, f"This request is already {item.status}.")
    if body.decision == "reject" and not (body.note or "").strip():
        raise HTTPException(422, "Add a note saying why the request is rejected.")

    before = _correction_snapshot(item)
    if body.decision == "approve":
        session = db.scalar(
            select(AttendanceSession).where(AttendanceSession.employee_id == emp.id, AttendanceSession.work_date == item.work_date)
        )
        session_before = _session_snapshot(session) if session else None
        if session is None:
            if item.requested_check_in is None:
                raise HTTPException(409, "There is no attendance for that day and the request has no check-in time.")
            session = rules.new_session(emp, item.work_date, item.requested_check_in, "office", "web")
            db.add(session)
        elif item.requested_check_in is not None:
            session.check_in = item.requested_check_in
        if item.requested_check_out is not None:
            session.check_out = item.requested_check_out
        if session.check_out is not None and session.check_out <= session.check_in:
            raise HTTPException(409, "The corrected check-out would be before check-in.")
        session.corrected = True
        rules.apply_flags(session)
        db.flush()
        item.session_id = session.id
        record_audit(
            db, actor_id=user.id, action="attendance_corrected", entity="attendance_session", entity_id=session.id,
            subject_id=emp.id, before=session_before, after=_session_snapshot(session), ip=client_ip(request),
        )
    item.status = "approved" if body.decision == "approve" else "rejected"
    item.decided_by = user.employee_id
    item.decided_at = utcnow()
    item.decision_note = (body.note or "").strip() or None
    record_audit(
        db, actor_id=user.id, action=f"attendance_correction_{item.status}", entity="attendance_correction",
        entity_id=item.id, subject_id=emp.id, before=before, after=_correction_snapshot(item), ip=client_ip(request),
    )
    decider = user.employee.full_name if user.employee else user.id
    notify(
        db,
        recipient_id=emp.id,
        title=f"Attendance correction {item.status}",
        body=f"{decider} {item.status} your correction for {item.work_date}."
        + (f" Note: {item.decision_note}" if item.decision_note else ""),
        href=f"/attendance/corrections/{item.id}",
    )
    db.commit()
    return _correction_out(item, emp.full_name)

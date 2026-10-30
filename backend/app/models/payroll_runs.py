"""Monthly payroll runs, overtime / comp-off requests, bank details and the HR compliance calendar (migration 0023).

payroll_runs: one per month + country + legal entity. status: draft -> review -> locked (approved by a second
person; a locked run never changes). Lines hold each person's input pack and the payslip worked out from it.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class PayrollRun(TimestampMixin, Base):
    __tablename__ = "payroll_runs"
    __table_args__ = (UniqueConstraint("month", "country_code", "legal_entity", name="uq_payroll_run_month_entity"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    month: Mapped[str] = mapped_column(String(7), index=True)  # YYYY-MM
    country_code: Mapped[str] = mapped_column(ForeignKey("countries.code"), index=True)
    legal_entity: Mapped[str] = mapped_column(String(200))
    currency: Mapped[str] = mapped_column(String(3))
    status: Mapped[str] = mapped_column(String(16), index=True)  # draft | review | locked
    headcount: Mapped[int] = mapped_column(Integer, default=0)
    totals: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # gross, deductions, net, employer, ...
    exceptions: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)  # [{employee_id, name, kind, text}]
    prepared_by: Mapped[str | None] = mapped_column(String(64))
    prepared_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    submitted_by: Mapped[str | None] = mapped_column(String(64))
    submitted_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    approved_by: Mapped[str | None] = mapped_column(String(64))
    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    returned_note: Mapped[str | None] = mapped_column(Text)
    payday: Mapped[date | None] = mapped_column(Date)


class PayrollRunLine(Base):
    __tablename__ = "payroll_run_lines"
    __table_args__ = (UniqueConstraint("run_id", "employee_id", name="uq_payroll_line_run_employee"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("payroll_runs.id", ondelete="CASCADE"), index=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    employee_name: Mapped[str] = mapped_column(String(200))
    employee_code: Mapped[str] = mapped_column(String(32))
    days_in_month: Mapped[int] = mapped_column(Integer)
    paid_days: Mapped[float] = mapped_column(Float)
    lwp_days: Mapped[float] = mapped_column(Float, default=0)
    gross: Mapped[float] = mapped_column(Float)
    deductions_total: Mapped[float] = mapped_column(Float)
    net: Mapped[float] = mapped_column(Float)
    earnings: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    deductions: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    employer: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    reimbursements: Mapped[float] = mapped_column(Float, default=0)
    cash_recovery: Mapped[float] = mapped_column(Float, default=0)
    encashment: Mapped[float] = mapped_column(Float, default=0)
    overtime_hours: Mapped[float] = mapped_column(Float, default=0)
    overtime_pay: Mapped[float] = mapped_column(Float, default=0)
    bank_ok: Mapped[bool] = mapped_column(Boolean, default=True)
    flags: Mapped[list[str]] = mapped_column(JSON, default=list)  # new_joiner | leaver | missing_bank | negative_net
    slip: Mapped[dict[str, Any] | None] = mapped_column(JSON)  # the payslip as the portal shows it


class EmployeeBankDetail(TimestampMixin, Base):
    """Where net pay goes. The account number is masked in responses (last 4 digits)."""

    __tablename__ = "employee_bank_details"

    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), primary_key=True)
    account_name: Mapped[str] = mapped_column(String(200))
    account_number: Mapped[str] = mapped_column(String(34))
    bank_code: Mapped[str] = mapped_column(String(20))  # IFSC / sort code / routing / SWIFT
    bank_name: Mapped[str] = mapped_column(String(120))
    updated_by: Mapped[str | None] = mapped_column(String(64))


class OvertimeRequest(TimestampMixin, Base):
    """Overtime worked on a past date, approval type "overtime" (manager).

    status: Submitted -> Approved | Rejected | Withdrawn. outcome "pay": paid in the payroll run of payout_month
    (paid_run_id once locked); "comp_off": adds comp_off_days to the comp-off leave balance.
    """

    __tablename__ = "overtime_requests"
    __table_args__ = (Index("ix_overtime_employee_date", "employee_id", "work_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    work_date: Mapped[date] = mapped_column(Date)
    hours: Mapped[float] = mapped_column(Float)
    reason: Mapped[str] = mapped_column(Text)
    outcome: Mapped[str] = mapped_column(String(8))  # pay | comp_off
    status: Mapped[str] = mapped_column(String(16), index=True)
    approval_instance_id: Mapped[str | None] = mapped_column(String(64))
    attendance_minutes: Mapped[int | None] = mapped_column(Integer)  # worked minutes that day; NULL = no attendance
    hourly_rate: Mapped[float] = mapped_column(Float, default=0)
    multiplier: Mapped[float] = mapped_column(Float, default=1.5)
    amount: Mapped[float] = mapped_column(Float, default=0)
    currency: Mapped[str] = mapped_column(String(3))
    comp_off_days: Mapped[float] = mapped_column(Float, default=0)
    payout_month: Mapped[str | None] = mapped_column(String(7))
    paid_run_id: Mapped[str | None] = mapped_column(String(64))
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class ComplianceDueDate(TimestampMixin, Base):
    """A statutory due date HR tracks (sample dates, configurable).

    frequency: monthly (every month on `day`) | quarterly (`months` lists the due months, e.g. [1, 4, 7, 10]) |
    annual (`months` = [month]). A day past the month's end falls on its last day.
    """

    __tablename__ = "compliance_due_dates"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    country_code: Mapped[str] = mapped_column(String(2), index=True)
    name: Mapped[str] = mapped_column(String(200))
    frequency: Mapped[str] = mapped_column(String(16))  # monthly | quarterly | annual
    day: Mapped[int] = mapped_column(Integer)
    months: Mapped[list[int] | None] = mapped_column(JSON)
    href: Mapped[str | None] = mapped_column(String(200))
    note: Mapped[str | None] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, default=True)

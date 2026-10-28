"""Learning: course catalog, enrollments, certifications and employee skills."""

from __future__ import annotations

from datetime import date

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin


class Course(TimestampMixin, Base):
    __tablename__ = "courses"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(200), unique=True)
    provider: Mapped[str] = mapped_column(String(200))
    url: Mapped[str | None] = mapped_column(String(500))
    category: Mapped[str | None] = mapped_column(String(64))
    duration_hours: Mapped[float] = mapped_column(Numeric(6, 2, asdecimal=False))
    mandatory: Mapped[bool] = mapped_column(Boolean, default=False)
    audience: Mapped[str] = mapped_column(String(32), default="All")  # All | Engineering | Managers | Hiring
    skills: Mapped[list[str]] = mapped_column(JSON, default=list)  # skill names
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class Enrollment(TimestampMixin, Base):
    __tablename__ = "enrollments"
    __table_args__ = (UniqueConstraint("course_id", "employee_id", name="uq_enrollment_course_employee"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="assigned")  # assigned | in_progress | completed
    progress: Mapped[int] = mapped_column(Integer, default=0)
    due: Mapped[date | None] = mapped_column(Date)
    completed_on: Mapped[date | None] = mapped_column(Date)
    score: Mapped[int | None] = mapped_column(Integer)  # 0-100, recorded by HR
    assigned_by: Mapped[str | None] = mapped_column(String(64))


class Certification(TimestampMixin, Base):
    __tablename__ = "certifications"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    issuer: Mapped[str | None] = mapped_column(String(200))
    issued_on: Mapped[date] = mapped_column(Date)
    expires_on: Mapped[date | None] = mapped_column(Date, index=True)  # NULL = never expires
    credential_id: Mapped[str | None] = mapped_column(String(100))


class EmployeeSkill(TimestampMixin, Base):
    __tablename__ = "employee_skills"
    __table_args__ = (UniqueConstraint("employee_id", "skill", name="uq_employee_skill"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    skill: Mapped[str] = mapped_column(String(100))
    level: Mapped[int] = mapped_column(Integer)  # 1-5
    target_level: Mapped[int | None] = mapped_column(Integer)  # 1-5

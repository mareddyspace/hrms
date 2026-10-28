"""Skills library and careers (migration 0012): skills, career paths between job profiles, employee career profiles."""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin

SKILL_CATEGORIES = ("technical", "behavioural")
SKILL_LEVELS = ("Awareness", "Working", "Intermediate", "Advanced", "Expert")  # 1-5 on employee_skills
CAREER_TIMEFRAMES = ("Next 6 months", "6–12 months", "1–2 years", "2+ years")
CAREER_FUNCTIONS = ("Engineering", "People", "Talent Acquisition", "Total Rewards", "Product", "IT", "Leadership")


class Skill(TimestampMixin, Base):
    """One skill in the library (front end: SKILL_LIBRARY in src/data/talentData.ts)."""

    __tablename__ = "skills"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # sk-1
    name: Mapped[str] = mapped_column(String(100), unique=True)
    category: Mapped[str] = mapped_column(String(16), index=True)  # technical | behavioural
    area: Mapped[str | None] = mapped_column(String(64))  # Engineering, Leadership, People, ...
    description: Mapped[str] = mapped_column(Text, default="")
    related_profile_ids: Mapped[list[str]] = mapped_column(JSON, default=list)  # job_profiles.id
    related_course_ids: Mapped[list[str]] = mapped_column(JSON, default=list)  # courses.id
    certifications: Mapped[list[str]] = mapped_column(JSON, default=list)  # certification names
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_by: Mapped[str | None] = mapped_column(String(64))


class CareerPath(TimestampMixin, Base):
    """A next role (front end: TARGET_ROLES). required_skills: {skill id: level name}."""

    __tablename__ = "career_paths"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # tr-1
    title: Mapped[str] = mapped_column(String(200))  # the target role
    track: Mapped[str] = mapped_column(String(32), index=True)  # engineering | people | recruiting | reward | product | it | executive
    function: Mapped[str] = mapped_column(String(64))
    from_profile_id: Mapped[str | None] = mapped_column(ForeignKey("job_profiles.id"), index=True)
    to_profile_id: Mapped[str | None] = mapped_column(ForeignKey("job_profiles.id"), index=True)
    required_skills: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class CareerProfile(TimestampMixin, Base):
    """What someone wants next. Visible to them, people above them and HR."""

    __tablename__ = "career_profiles"

    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), primary_key=True)
    current_role: Mapped[str | None] = mapped_column(String(200))
    target_role_ids: Mapped[list[str]] = mapped_column(JSON, default=list)  # career_paths.id, up to 3
    interests: Mapped[list[str]] = mapped_column(JSON, default=list)  # functions (CAREER_FUNCTIONS)
    timeframe: Mapped[str] = mapped_column(String(32), default="6–12 months")
    open_to_relocation: Mapped[bool] = mapped_column(Boolean, default=False)
    mentor_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"))
    note: Mapped[str] = mapped_column(Text, default="")
    updated_by: Mapped[str | None] = mapped_column(String(64))

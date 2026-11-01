"""Project details shared by everyone on a project: milestones, tasks, updates / comments, documents and the
activity trail (migration 0025). Members see them; the project manager (and HR / admin) edits them."""

from __future__ import annotations

from datetime import date

from sqlalchemy import Date, ForeignKey, Index, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin


class ProjectMilestone(TimestampMixin, Base):
    __tablename__ = "project_milestones"
    __table_args__ = (Index("ix_project_milestone_project_due", "project_id", "due_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    due_date: Mapped[date] = mapped_column(Date)
    completed_on: Mapped[date | None] = mapped_column(Date)


class ProjectTask(TimestampMixin, Base):
    __tablename__ = "project_tasks"
    __table_args__ = (Index("ix_project_task_project", "project_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    assignee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), index=True)
    milestone_id: Mapped[str | None] = mapped_column(String(64))
    due_date: Mapped[date | None] = mapped_column(Date)
    estimate_hours: Mapped[float] = mapped_column(Numeric(7, 2, asdecimal=False), default=0)
    status: Mapped[str] = mapped_column(String(16), default="todo")  # todo | in_progress | in_review | done


class ProjectPost(TimestampMixin, Base):
    """A status update (manager) or a comment (any member)."""

    __tablename__ = "project_posts"
    __table_args__ = (Index("ix_project_post_project", "project_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    author_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    kind: Mapped[str] = mapped_column(String(16), default="comment")  # update | comment
    body: Mapped[str] = mapped_column(Text)


class ProjectDocument(TimestampMixin, Base):
    """A file uploaded to the project (PDF / image) or a link to one kept elsewhere."""

    __tablename__ = "project_documents"
    __table_args__ = (Index("ix_project_document_project", "project_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(200))
    url: Mapped[str | None] = mapped_column(String(500))
    file_name: Mapped[str | None] = mapped_column(String(200))
    content_type: Mapped[str | None] = mapped_column(String(100))
    size_bytes: Mapped[int | None] = mapped_column(Integer)
    storage_path: Mapped[str | None] = mapped_column(String(300))
    added_by: Mapped[str] = mapped_column(ForeignKey("employees.id"))


class ProjectActivity(TimestampMixin, Base):
    __tablename__ = "project_activity"
    __table_args__ = (Index("ix_project_activity_project", "project_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    actor_id: Mapped[str | None] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(String(400))
    # A seeded line keeps its own date (created_at is when the row was written).
    happened_on: Mapped[date | None] = mapped_column(Date)


class CompOffCredit(TimestampMixin, Base):
    """One comp-off day earned by working a published shift on a weekly off or a holiday (granted by the manager).
    Used by comp-off leave; expires after 90 days (app/services/shifts.py)."""

    __tablename__ = "comp_off_credits"
    __table_args__ = (Index("ix_comp_off_credit_employee", "employee_id", "worked_date", unique=True),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    worked_date: Mapped[date] = mapped_column(Date)
    days: Mapped[float] = mapped_column(Numeric(4, 2, asdecimal=False), default=1)
    reason: Mapped[str] = mapped_column(String(200))
    granted_by: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    expires_on: Mapped[date] = mapped_column(Date)

"""daily timesheets: one row per person and day submitted for approval

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-29 23:00:00

Adds timesheet_days (employee_id, work_date, status, submitted_at, decided_by, decided_at, decision_note).
Entries keep their week (timesheet_weeks); weeks already submitted or approved stay as they are.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0019'
down_revision: Union[str, Sequence[str], None] = '0018'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'timesheet_days',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('employee_id', sa.String(length=64), nullable=False),
        sa.Column('work_date', sa.Date(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('submitted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('decided_by', sa.String(length=64), nullable=True),
        sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('decision_note', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['decided_by'], ['employees.id'], ),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('employee_id', 'work_date', name='uq_timesheet_day_employee_date'),
    )
    with op.batch_alter_table('timesheet_days', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_timesheet_days_employee_id'), ['employee_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_timesheet_days_work_date'), ['work_date'], unique=False)
        batch_op.create_index(batch_op.f('ix_timesheet_days_status'), ['status'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('timesheet_days', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_timesheet_days_status'))
        batch_op.drop_index(batch_op.f('ix_timesheet_days_work_date'))
        batch_op.drop_index(batch_op.f('ix_timesheet_days_employee_id'))
    op.drop_table('timesheet_days')

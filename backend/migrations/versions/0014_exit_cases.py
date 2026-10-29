"""exits: exit_cases (resignation, termination, retirement, end of contract) and employees.last_working_day

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-29 16:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0014'
down_revision: Union[str, Sequence[str], None] = '0013'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('employees') as batch:
        batch.add_column(sa.Column('last_working_day', sa.Date(), nullable=True))
    op.create_table(
        'exit_cases',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('employee_id', sa.String(length=64), nullable=False),
        sa.Column('exit_type', sa.String(length=32), nullable=False),
        sa.Column('submitted_on', sa.Date(), nullable=False),
        sa.Column('requested_last_day', sa.Date(), nullable=False),
        sa.Column('standard_last_day', sa.Date(), nullable=False),
        sa.Column('approved_last_working_day', sa.Date(), nullable=True),
        sa.Column('notice_days', sa.Integer(), nullable=False),
        sa.Column('early_release', sa.Boolean(), nullable=False),
        sa.Column('early_release_approved', sa.Boolean(), nullable=True),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('raised_by', sa.String(length=64), nullable=False),
        sa.Column('approval_instance_id', sa.String(length=64), nullable=True),
        sa.Column('clearance', sa.JSON(), nullable=False),
        sa.Column('interview', sa.JSON(), nullable=True),
        sa.Column('settlement', sa.JSON(), nullable=False),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id']),
        sa.ForeignKeyConstraint(['raised_by'], ['employees.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_exit_cases_employee_id', 'exit_cases', ['employee_id'])
    op.create_index('ix_exit_cases_status_lwd', 'exit_cases', ['status', 'approved_last_working_day'])


def downgrade() -> None:
    op.drop_index('ix_exit_cases_status_lwd', table_name='exit_cases')
    op.drop_index('ix_exit_cases_employee_id', table_name='exit_cases')
    op.drop_table('exit_cases')
    with op.batch_alter_table('employees') as batch:
        batch.drop_column('last_working_day')

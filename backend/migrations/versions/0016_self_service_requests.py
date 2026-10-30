"""self service: cash_advances, encashment_requests, software_titles, software_requests; exit_cases.details

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-29 20:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0016'
down_revision: Union[str, Sequence[str], None] = '0015'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _stamps() -> list[sa.Column]:
    return [
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        'cash_advances',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('employee_id', sa.String(length=64), nullable=False),
        sa.Column('amount', sa.Float(), nullable=False),
        sa.Column('currency', sa.String(length=8), nullable=False),
        sa.Column('category', sa.String(length=64), nullable=False),
        sa.Column('purpose', sa.Text(), nullable=False),
        sa.Column('needed_by', sa.Date(), nullable=False),
        sa.Column('instalments', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('approval_instance_id', sa.String(length=64), nullable=True),
        sa.Column('paid_on', sa.Date(), nullable=True),
        sa.Column('paid_by', sa.String(length=64), nullable=True),
        sa.Column('reference', sa.String(length=64), nullable=True),
        *_stamps(),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_cash_advances_employee_id', 'cash_advances', ['employee_id'])
    op.create_table(
        'encashment_requests',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('employee_id', sa.String(length=64), nullable=False),
        sa.Column('leave_code', sa.String(length=32), nullable=False),
        sa.Column('year', sa.Integer(), nullable=False),
        sa.Column('days', sa.Float(), nullable=False),
        sa.Column('per_day', sa.Float(), nullable=False),
        sa.Column('amount', sa.Float(), nullable=False),
        sa.Column('currency', sa.String(length=8), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('approval_instance_id', sa.String(length=64), nullable=True),
        sa.Column('payout_month', sa.String(length=7), nullable=True),
        *_stamps(),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_encashment_requests_employee_id', 'encashment_requests', ['employee_id'])
    op.create_table(
        'software_titles',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('category', sa.String(length=64), nullable=False),
        sa.Column('vendor', sa.String(length=120), nullable=False),
        sa.Column('monthly_cost', sa.Float(), nullable=False),
        sa.Column('currency', sa.String(length=8), nullable=False),
        sa.Column('needs_approval', sa.Boolean(), nullable=False),
        sa.Column('seats', sa.Integer(), nullable=False),
        sa.Column('active', sa.Boolean(), nullable=False),
        *_stamps(),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_table(
        'software_requests',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('employee_id', sa.String(length=64), nullable=False),
        sa.Column('title_id', sa.String(length=64), nullable=False),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('duration_months', sa.Integer(), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('approval_instance_id', sa.String(length=64), nullable=True),
        sa.Column('assigned_on', sa.Date(), nullable=True),
        sa.Column('expires_on', sa.Date(), nullable=True),
        sa.Column('ended_on', sa.Date(), nullable=True),
        sa.Column('ended_by', sa.String(length=64), nullable=True),
        sa.Column('licence_key', sa.String(length=64), nullable=True),
        sa.Column('raised_by', sa.String(length=64), nullable=True),
        *_stamps(),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id']),
        sa.ForeignKeyConstraint(['title_id'], ['software_titles.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_software_requests_employee_id', 'software_requests', ['employee_id'])
    op.create_index('ix_software_requests_title_id', 'software_requests', ['title_id'])
    with op.batch_alter_table('exit_cases') as batch:
        batch.add_column(sa.Column('details', sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('exit_cases') as batch:
        batch.drop_column('details')
    op.drop_index('ix_software_requests_title_id', table_name='software_requests')
    op.drop_index('ix_software_requests_employee_id', table_name='software_requests')
    op.drop_table('software_requests')
    op.drop_table('software_titles')
    op.drop_index('ix_encashment_requests_employee_id', table_name='encashment_requests')
    op.drop_table('encashment_requests')
    op.drop_index('ix_cash_advances_employee_id', table_name='cash_advances')
    op.drop_table('cash_advances')

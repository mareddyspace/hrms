"""leave eligibility rules, holiday calendars, leave carry-forward, country config

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-29 10:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0011'
down_revision: Union[str, Sequence[str], None] = '0010'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_POLICY_COLUMNS = (
    ('gender', sa.String(8)),
    ('min_service_months', sa.Integer()),
    ('employment_types', sa.JSON()),
    ('max_per_request', sa.Numeric(precision=6, scale=1, asdecimal=False)),
    ('min_notice_days', sa.Integer()),
)
_COUNTRY_COLUMNS = (
    ('languages', sa.JSON()),
    ('work_week_days', sa.JSON()),
    ('standard_daily_hours', sa.Numeric(precision=4, scale=2, asdecimal=False)),
    ('probation_months', sa.Integer()),
    ('notice_days', sa.Integer()),
    ('required_documents', sa.JSON()),
    ('workflow_notes', sa.Text()),
)


def upgrade() -> None:
    with op.batch_alter_table('leave_policies') as batch:
        for name, type_ in _POLICY_COLUMNS:
            batch.add_column(sa.Column(name, type_, nullable=True))
        batch.add_column(sa.Column('not_in_probation', sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column('active', sa.Boolean(), nullable=False, server_default=sa.true()))

    with op.batch_alter_table('holidays') as batch:
        batch.add_column(sa.Column('calendar', sa.String(100), nullable=True))
        batch.add_column(sa.Column('active', sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.drop_constraint('uq_holiday_country_date', type_='unique')
        batch.create_unique_constraint('uq_holiday_country_calendar_date', ['country_code', 'calendar', 'date'])

    with op.batch_alter_table('countries') as batch:
        for name, type_ in _COUNTRY_COLUMNS:
            batch.add_column(sa.Column(name, type_, nullable=True))

    op.create_table(
        'leave_carry_forwards',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('employee_id', sa.String(64), nullable=False),
        sa.Column('leave_code', sa.String(32), nullable=False),
        sa.Column('policy_id', sa.String(64), nullable=True),
        sa.Column('to_year', sa.Integer(), nullable=False),
        sa.Column('unused', sa.Numeric(precision=6, scale=1, asdecimal=False), nullable=False),
        sa.Column('days', sa.Numeric(precision=6, scale=1, asdecimal=False), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['leave_code'], ['leave_types.code']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('employee_id', 'leave_code', 'to_year', name='uq_carry_employee_code_year'),
    )
    with op.batch_alter_table('leave_carry_forwards') as batch:
        batch.create_index('ix_leave_carry_forwards_employee_id', ['employee_id'], unique=False)
        batch.create_index('ix_leave_carry_forwards_to_year', ['to_year'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('leave_carry_forwards') as batch:
        batch.drop_index('ix_leave_carry_forwards_to_year')
        batch.drop_index('ix_leave_carry_forwards_employee_id')
    op.drop_table('leave_carry_forwards')

    with op.batch_alter_table('countries') as batch:
        for name, _type in reversed(_COUNTRY_COLUMNS):
            batch.drop_column(name)

    with op.batch_alter_table('holidays') as batch:
        batch.drop_constraint('uq_holiday_country_calendar_date', type_='unique')
        batch.create_unique_constraint('uq_holiday_country_date', ['country_code', 'date'])
        batch.drop_column('active')
        batch.drop_column('calendar')

    with op.batch_alter_table('leave_policies') as batch:
        batch.drop_column('active')
        batch.drop_column('not_in_probation')
        for name, _type in reversed(_POLICY_COLUMNS):
            batch.drop_column(name)

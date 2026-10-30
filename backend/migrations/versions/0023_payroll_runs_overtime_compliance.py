"""payroll runs and lines, bank details, overtime / comp-off requests, compliance due dates; birthday privacy and contract end

Revision ID: 0023
Revises: 0022
Create Date: 2026-10-30 16:00:00

Monthly payroll: Draft -> Review -> Locked (a second person approves). Overtime is paid in the run or added as comp-off.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0023'
down_revision: Union[str, Sequence[str], None] = '0022'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _stamps() -> list[sa.Column]:
    return [
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        'payroll_runs',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('month', sa.String(length=7), nullable=False),
        sa.Column('country_code', sa.String(length=2), nullable=False),
        sa.Column('legal_entity', sa.String(length=200), nullable=False),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('headcount', sa.Integer(), nullable=False),
        sa.Column('totals', sa.JSON(), nullable=False),
        sa.Column('exceptions', sa.JSON(), nullable=False),
        sa.Column('prepared_by', sa.String(length=64), nullable=True),
        sa.Column('prepared_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('submitted_by', sa.String(length=64), nullable=True),
        sa.Column('submitted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('approved_by', sa.String(length=64), nullable=True),
        sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('returned_note', sa.Text(), nullable=True),
        sa.Column('payday', sa.Date(), nullable=True),
        *_stamps(),
        sa.ForeignKeyConstraint(['country_code'], ['countries.code']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('month', 'country_code', 'legal_entity', name='uq_payroll_run_month_entity'),
    )
    op.create_index('ix_payroll_runs_month', 'payroll_runs', ['month'])
    op.create_index('ix_payroll_runs_country_code', 'payroll_runs', ['country_code'])
    op.create_index('ix_payroll_runs_status', 'payroll_runs', ['status'])

    op.create_table(
        'payroll_run_lines',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('run_id', sa.String(length=64), nullable=False),
        sa.Column('employee_id', sa.String(length=64), nullable=False),
        sa.Column('employee_name', sa.String(length=200), nullable=False),
        sa.Column('employee_code', sa.String(length=32), nullable=False),
        sa.Column('days_in_month', sa.Integer(), nullable=False),
        sa.Column('paid_days', sa.Float(), nullable=False),
        sa.Column('lwp_days', sa.Float(), nullable=False),
        sa.Column('gross', sa.Float(), nullable=False),
        sa.Column('deductions_total', sa.Float(), nullable=False),
        sa.Column('net', sa.Float(), nullable=False),
        sa.Column('earnings', sa.JSON(), nullable=False),
        sa.Column('deductions', sa.JSON(), nullable=False),
        sa.Column('employer', sa.JSON(), nullable=False),
        sa.Column('reimbursements', sa.Float(), nullable=False),
        sa.Column('cash_recovery', sa.Float(), nullable=False),
        sa.Column('encashment', sa.Float(), nullable=False),
        sa.Column('overtime_hours', sa.Float(), nullable=False),
        sa.Column('overtime_pay', sa.Float(), nullable=False),
        sa.Column('bank_ok', sa.Boolean(), nullable=False),
        sa.Column('flags', sa.JSON(), nullable=False),
        sa.Column('slip', sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(['run_id'], ['payroll_runs.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('run_id', 'employee_id', name='uq_payroll_line_run_employee'),
    )
    op.create_index('ix_payroll_run_lines_run_id', 'payroll_run_lines', ['run_id'])
    op.create_index('ix_payroll_run_lines_employee_id', 'payroll_run_lines', ['employee_id'])

    op.create_table(
        'employee_bank_details',
        sa.Column('employee_id', sa.String(length=64), nullable=False),
        sa.Column('account_name', sa.String(length=200), nullable=False),
        sa.Column('account_number', sa.String(length=34), nullable=False),
        sa.Column('bank_code', sa.String(length=20), nullable=False),
        sa.Column('bank_name', sa.String(length=120), nullable=False),
        sa.Column('updated_by', sa.String(length=64), nullable=True),
        *_stamps(),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('employee_id'),
    )

    op.create_table(
        'overtime_requests',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('employee_id', sa.String(length=64), nullable=False),
        sa.Column('work_date', sa.Date(), nullable=False),
        sa.Column('hours', sa.Float(), nullable=False),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('outcome', sa.String(length=8), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('approval_instance_id', sa.String(length=64), nullable=True),
        sa.Column('attendance_minutes', sa.Integer(), nullable=True),
        sa.Column('hourly_rate', sa.Float(), nullable=False),
        sa.Column('multiplier', sa.Float(), nullable=False),
        sa.Column('amount', sa.Float(), nullable=False),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('comp_off_days', sa.Float(), nullable=False),
        sa.Column('payout_month', sa.String(length=7), nullable=True),
        sa.Column('paid_run_id', sa.String(length=64), nullable=True),
        sa.Column('decided_by', sa.String(length=64), nullable=True),
        sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
        *_stamps(),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_overtime_requests_employee_id', 'overtime_requests', ['employee_id'])
    op.create_index('ix_overtime_requests_status', 'overtime_requests', ['status'])
    op.create_index('ix_overtime_employee_date', 'overtime_requests', ['employee_id', 'work_date'])

    op.create_table(
        'compliance_due_dates',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('country_code', sa.String(length=2), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('frequency', sa.String(length=16), nullable=False),
        sa.Column('day', sa.Integer(), nullable=False),
        sa.Column('months', sa.JSON(), nullable=True),
        sa.Column('href', sa.String(length=200), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('active', sa.Boolean(), nullable=False),
        *_stamps(),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_compliance_due_dates_country_code', 'compliance_due_dates', ['country_code'])

    # Plain ADD COLUMN (no table copy): SQLite keeps the rows other tables point at, PostgreSQL is unaffected.
    op.add_column('employees', sa.Column('hide_birthday', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('employees', sa.Column('contract_end_date', sa.Date(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('employees') as t:
        t.drop_column('contract_end_date')
        t.drop_column('hide_birthday')
    op.drop_index('ix_compliance_due_dates_country_code', table_name='compliance_due_dates')
    op.drop_table('compliance_due_dates')
    op.drop_index('ix_overtime_employee_date', table_name='overtime_requests')
    op.drop_index('ix_overtime_requests_status', table_name='overtime_requests')
    op.drop_index('ix_overtime_requests_employee_id', table_name='overtime_requests')
    op.drop_table('overtime_requests')
    op.drop_table('employee_bank_details')
    op.drop_index('ix_payroll_run_lines_employee_id', table_name='payroll_run_lines')
    op.drop_index('ix_payroll_run_lines_run_id', table_name='payroll_run_lines')
    op.drop_table('payroll_run_lines')
    op.drop_index('ix_payroll_runs_status', table_name='payroll_runs')
    op.drop_index('ix_payroll_runs_country_code', table_name='payroll_runs')
    op.drop_index('ix_payroll_runs_month', table_name='payroll_runs')
    op.drop_table('payroll_runs')

"""effective-dated org history, job profile details, assignment placement, two-step sign-in, sessions, audit result

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-29 10:00:00

"""
from datetime import date
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0013'
down_revision: Union[str, Sequence[str], None] = '0012'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('org_units') as batch:
        batch.add_column(sa.Column('effective_from', sa.Date(), nullable=True))
        batch.add_column(sa.Column('effective_to', sa.Date(), nullable=True))
        batch.add_column(sa.Column('manager_id', sa.String(length=64), nullable=True))
        batch.add_column(sa.Column('headcount', sa.Integer(), nullable=True))
    with op.batch_alter_table('job_profiles') as batch:
        batch.add_column(sa.Column('effective_from', sa.Date(), nullable=True))
        batch.add_column(sa.Column('effective_to', sa.Date(), nullable=True))
        batch.add_column(sa.Column('job_level', sa.String(length=32), nullable=True))
        batch.add_column(sa.Column('experience_min_years', sa.Integer(), nullable=True))
        batch.add_column(sa.Column('experience_max_years', sa.Integer(), nullable=True))
        batch.add_column(sa.Column('education', sa.String(length=200), nullable=True))
        batch.add_column(sa.Column('responsibilities', sa.JSON(), nullable=True))
    with op.batch_alter_table('positions') as batch:
        batch.add_column(sa.Column('effective_from', sa.Date(), nullable=True))
        batch.add_column(sa.Column('effective_to', sa.Date(), nullable=True))
    op.create_table(
        'org_change_history',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('entity', sa.String(length=32), nullable=False),
        sa.Column('entity_id', sa.String(length=64), nullable=False),
        sa.Column('effective_from', sa.Date(), nullable=False),
        sa.Column('effective_to', sa.Date(), nullable=True),
        sa.Column('change', sa.String(length=32), nullable=False),
        sa.Column('changed_fields', sa.JSON(), nullable=False),
        sa.Column('snapshot', sa.JSON(), nullable=False),
        sa.Column('changed_by', sa.String(length=64), nullable=True),
        sa.Column('reason', sa.String(length=500), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_org_history_entity_from', 'org_change_history', ['entity', 'entity_id', 'effective_from'])

    with op.batch_alter_table('employee_assignments') as batch:
        batch.add_column(sa.Column('business_unit', sa.String(length=200), nullable=True))
        batch.add_column(sa.Column('division', sa.String(length=200), nullable=True))
        batch.add_column(sa.Column('cost_centre', sa.String(length=64), nullable=True))
        batch.add_column(sa.Column('job_profile_id', sa.String(length=64), nullable=True))
        batch.add_column(sa.Column('position_id', sa.String(length=64), nullable=True))

    with op.batch_alter_table('accounts') as batch:
        batch.add_column(sa.Column('mfa_enabled', sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column('mfa_secret', sa.String(length=64), nullable=True))
        batch.add_column(sa.Column('mfa_enabled_at', sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column('mfa_last_step', sa.Integer(), nullable=True))
        batch.add_column(sa.Column('mfa_backup_codes', sa.JSON(), nullable=True))

    with op.batch_alter_table('refresh_tokens') as batch:
        batch.add_column(sa.Column('session_id', sa.String(length=64), nullable=True))
        batch.add_column(sa.Column('session_started_at', sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column('ip', sa.String(length=64), nullable=True))
        batch.add_column(sa.Column('user_agent', sa.String(length=300), nullable=True))
    op.create_index('ix_refresh_tokens_session_id', 'refresh_tokens', ['session_id'])

    with op.batch_alter_table('audit_log') as batch:
        batch.add_column(sa.Column('result', sa.String(length=16), nullable=True))
        batch.add_column(sa.Column('user_agent', sa.String(length=300), nullable=True))

    # Existing org records start on the company's first joining date (the seed adds their baseline versions).
    bind = op.get_bind()
    first = bind.execute(sa.text('SELECT MIN(joining_date) FROM employees')).scalar()
    if first is not None:
        start = first if isinstance(first, date) else date.fromisoformat(str(first)[:10])
        for table in ('org_units', 'job_profiles', 'positions'):
            bind.execute(sa.text(f'UPDATE {table} SET effective_from = :d WHERE effective_from IS NULL'), {'d': start})


def downgrade() -> None:
    with op.batch_alter_table('audit_log') as batch:
        batch.drop_column('user_agent')
        batch.drop_column('result')
    op.drop_index('ix_refresh_tokens_session_id', table_name='refresh_tokens')
    with op.batch_alter_table('refresh_tokens') as batch:
        for col in ('user_agent', 'ip', 'last_used_at', 'session_started_at', 'session_id'):
            batch.drop_column(col)
    with op.batch_alter_table('accounts') as batch:
        for col in ('mfa_backup_codes', 'mfa_last_step', 'mfa_enabled_at', 'mfa_secret', 'mfa_enabled'):
            batch.drop_column(col)
    with op.batch_alter_table('employee_assignments') as batch:
        for col in ('position_id', 'job_profile_id', 'cost_centre', 'division', 'business_unit'):
            batch.drop_column(col)
    op.drop_index('ix_org_history_entity_from', table_name='org_change_history')
    op.drop_table('org_change_history')
    with op.batch_alter_table('positions') as batch:
        batch.drop_column('effective_to')
        batch.drop_column('effective_from')
    with op.batch_alter_table('job_profiles') as batch:
        for col in ('responsibilities', 'education', 'experience_max_years', 'experience_min_years', 'job_level',
                    'effective_to', 'effective_from'):
            batch.drop_column(col)
    with op.batch_alter_table('org_units') as batch:
        for col in ('headcount', 'manager_id', 'effective_to', 'effective_from'):
            batch.drop_column(col)

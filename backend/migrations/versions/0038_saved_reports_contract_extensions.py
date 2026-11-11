"""saved reports (server-side report builder); contract extension requests (contractors)

Revision ID: 0038
Revises: the newest revision before it (0037 when present)
Create Date: 2026-11-11 18:00:00

Additive only: two new tables, no data changes.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


def _previous() -> str:
    """Parallel work may add 0035 / 0037; chain onto the newest revision below 0038 so the history stays one line."""
    here = Path(__file__).parent
    numbers = sorted(int(p.name[:4]) for p in here.glob("[0-9][0-9][0-9][0-9]_*.py") if p.name[:4].isdigit())
    return f"{max(n for n in numbers if n < 38):04d}"


revision: str = '0038'
down_revision: Union[str, Sequence[str], None] = '0037'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'saved_reports',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('owner_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('source', sa.String(length=32), nullable=False),
        sa.Column('columns', sa.JSON(), nullable=False),
        sa.Column('filters', sa.JSON(), nullable=False),
        sa.Column('group_by', sa.String(length=64), nullable=True),
        sa.Column('shared', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_saved_reports_owner_id', 'saved_reports', ['owner_id'])
    op.create_table(
        'contract_extensions',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('employee_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('requested_by', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('current_end', sa.Date(), nullable=True),
        sa.Column('new_end', sa.Date(), nullable=False),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('decided_by', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=True),
        sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('decision_comment', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_contract_extensions_employee_id', 'contract_extensions', ['employee_id'])


def downgrade() -> None:
    op.drop_index('ix_contract_extensions_employee_id', table_name='contract_extensions')
    op.drop_table('contract_extensions')
    op.drop_index('ix_saved_reports_owner_id', table_name='saved_reports')
    op.drop_table('saved_reports')

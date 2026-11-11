"""employee experience: assets and asset requests, immigration documents, privacy consents / requests / retention

Revision ID: 0037
Revises: the newest revision before it (0036 when present)
Create Date: 2026-11-11 19:00:00

Additive only: six new tables, no data changes.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


def _previous() -> str:
    """Parallel work may add 0035 / 0036; chain onto the newest revision below 0037 so the history stays one line."""
    here = Path(__file__).parent
    numbers = sorted(int(p.name[:4]) for p in here.glob("[0-9][0-9][0-9][0-9]_*.py") if p.name[:4].isdigit())
    return f"{max(n for n in numbers if n < 37):04d}"


revision: str = '0037'
down_revision: Union[str, Sequence[str], None] = '0036'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _stamps() -> list[sa.Column]:
    return [sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False)]


def upgrade() -> None:
    op.create_table(
        'assets',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('tag', sa.String(length=40), nullable=False, unique=True),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('category', sa.String(length=40), nullable=False),
        sa.Column('serial_no', sa.String(length=80), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('employee_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=True),
        sa.Column('assigned_on', sa.Date(), nullable=True),
        sa.Column('condition', sa.String(length=16), nullable=False),
        sa.Column('country_code', sa.String(length=2), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('history', sa.JSON(), nullable=True),
        *_stamps(),
    )
    op.create_index('ix_assets_category', 'assets', ['category'])
    op.create_index('ix_assets_status', 'assets', ['status'])
    op.create_index('ix_assets_employee_id', 'assets', ['employee_id'])
    op.create_table(
        'asset_requests',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('employee_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('category', sa.String(length=40), nullable=False),
        sa.Column('item', sa.String(length=120), nullable=False),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('needed_by', sa.Date(), nullable=True),
        sa.Column('asset_id', sa.String(length=64), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('manager_id', sa.String(length=64), nullable=True),
        sa.Column('decided_by', sa.String(length=64), nullable=True),
        sa.Column('decision_note', sa.Text(), nullable=True),
        sa.Column('closed_on', sa.Date(), nullable=True),
        sa.Column('history', sa.JSON(), nullable=True),
        *_stamps(),
    )
    op.create_index('ix_asset_requests_employee_id', 'asset_requests', ['employee_id'])
    op.create_index('ix_asset_request_status', 'asset_requests', ['status'])
    op.create_table(
        'immigration_documents',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('employee_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('doc_type', sa.String(length=40), nullable=False),
        sa.Column('number', sa.String(length=40), nullable=False),
        sa.Column('issuing_country', sa.String(length=80), nullable=False),
        sa.Column('issue_date', sa.Date(), nullable=False),
        sa.Column('expiry_date', sa.Date(), nullable=False),
        sa.Column('sponsor', sa.String(length=120), nullable=True),
        sa.Column('renewal_in_progress', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('verification', sa.String(length=16), nullable=False),
        sa.Column('verification_note', sa.Text(), nullable=True),
        sa.Column('verified_by', sa.String(length=64), nullable=True),
        sa.Column('verified_on', sa.Date(), nullable=True),
        sa.Column('updated_by', sa.String(length=64), nullable=True),
        sa.Column('history', sa.JSON(), nullable=True),
        *_stamps(),
    )
    op.create_index('ix_immigration_documents_employee_id', 'immigration_documents', ['employee_id'])
    op.create_index('ix_immigration_document_expiry', 'immigration_documents', ['expiry_date'])
    op.create_table(
        'privacy_consents',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('employee_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('topic', sa.String(length=40), nullable=False),
        sa.Column('granted', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_privacy_consent_person_topic', 'privacy_consents', ['employee_id', 'topic'])
    op.create_table(
        'privacy_requests',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('employee_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('details', sa.Text(), nullable=False),
        sa.Column('due_on', sa.Date(), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('handled_by', sa.String(length=64), nullable=True),
        sa.Column('closed_on', sa.Date(), nullable=True),
        sa.Column('outcome', sa.Text(), nullable=True),
        sa.Column('history', sa.JSON(), nullable=True),
        *_stamps(),
    )
    op.create_index('ix_privacy_requests_employee_id', 'privacy_requests', ['employee_id'])
    op.create_index('ix_privacy_requests_status', 'privacy_requests', ['status'])
    op.create_table(
        'privacy_retention_rules',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('category', sa.String(length=160), nullable=False, unique=True),
        sa.Column('period', sa.Integer(), nullable=False),
        sa.Column('unit', sa.String(length=8), nullable=False),
        sa.Column('legal_basis', sa.String(length=80), nullable=False),
        *_stamps(),
    )


def downgrade() -> None:
    for table in ('privacy_retention_rules', 'privacy_requests', 'privacy_consents', 'immigration_documents',
                  'asset_requests', 'assets'):
        op.drop_table(table)

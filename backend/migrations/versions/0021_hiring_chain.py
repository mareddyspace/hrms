"""hiring chain: requisition budget and reason, job postings, applications, scorecards, offer letter and answer link

Revision ID: 0021
Revises: 0020
Create Date: 2026-10-30 10:00:00

Requisition -> approval -> job posting (internal board + public careers page) -> application -> screening ->
interview -> scorecard -> offer (letter) -> candidate answers through a link -> joiner.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0021'
down_revision: Union[str, Sequence[str], None] = '0020'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('requisitions') as t:
        t.add_column(sa.Column('budget', sa.Numeric(precision=14, scale=2, asdecimal=False), nullable=True))
        t.add_column(sa.Column('budget_currency', sa.String(length=3), nullable=True))
        t.add_column(sa.Column('reason', sa.String(length=24), nullable=True))
        t.add_column(sa.Column('justification', sa.Text(), nullable=True))
        t.add_column(sa.Column('raised_by', sa.String(length=64), nullable=True))

    op.create_table(
        'job_postings',
        sa.Column('id', sa.String(length=32), nullable=False),
        sa.Column('requisition_id', sa.String(length=32), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('location', sa.String(length=200), nullable=False),
        sa.Column('employment_type', sa.String(length=32), nullable=False),
        sa.Column('closing_date', sa.Date(), nullable=False),
        sa.Column('on_careers_site', sa.Boolean(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('published_by', sa.String(length=64), nullable=True),
        sa.Column('published_on', sa.Date(), nullable=False),
        sa.Column('closed_on', sa.Date(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['requisition_id'], ['requisitions.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_job_postings_requisition_id', 'job_postings', ['requisition_id'], unique=True)
    op.create_index('ix_job_postings_status', 'job_postings', ['status'])

    with op.batch_alter_table('candidates') as t:
        t.add_column(sa.Column('posting_id', sa.String(length=32), nullable=True))
        t.add_column(sa.Column('employee_id', sa.String(length=64), nullable=True))
        t.add_column(sa.Column('cover_note', sa.Text(), nullable=True))
        t.add_column(sa.Column('match_score', sa.Integer(), nullable=True))
    op.create_index('ix_candidates_employee_id', 'candidates', ['employee_id'])

    with op.batch_alter_table('interviews') as t:
        t.add_column(sa.Column('ratings', sa.JSON(), nullable=True))
        t.add_column(sa.Column('recommendation', sa.String(length=16), nullable=True))

    with op.batch_alter_table('offers') as t:
        t.add_column(sa.Column('letter', sa.JSON(), nullable=True))
        t.add_column(sa.Column('response_token', sa.String(length=64), nullable=True))
        t.add_column(sa.Column('responded_via', sa.String(length=16), nullable=True))
    op.create_index('ix_offers_response_token', 'offers', ['response_token'], unique=True)


def downgrade() -> None:
    op.drop_index('ix_offers_response_token', table_name='offers')
    with op.batch_alter_table('offers') as t:
        t.drop_column('responded_via')
        t.drop_column('response_token')
        t.drop_column('letter')
    with op.batch_alter_table('interviews') as t:
        t.drop_column('recommendation')
        t.drop_column('ratings')
    op.drop_index('ix_candidates_employee_id', table_name='candidates')
    with op.batch_alter_table('candidates') as t:
        t.drop_column('match_score')
        t.drop_column('cover_note')
        t.drop_column('employee_id')
        t.drop_column('posting_id')
    op.drop_index('ix_job_postings_status', table_name='job_postings')
    op.drop_index('ix_job_postings_requisition_id', table_name='job_postings')
    op.drop_table('job_postings')
    with op.batch_alter_table('requisitions') as t:
        t.drop_column('raised_by')
        t.drop_column('justification')
        t.drop_column('reason')
        t.drop_column('budget_currency')
        t.drop_column('budget')

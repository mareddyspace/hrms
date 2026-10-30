"""policies HR publishes (hr_policies, hr_policy_versions), acknowledgement comments, own text on letter requests,
skill details (years, last used, evidence link)

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-29 22:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0018'
down_revision: Union[str, Sequence[str], None] = '0017'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'hr_policies',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('category', sa.String(length=64), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('audience_type', sa.String(length=16), nullable=False),
        sa.Column('audience_values', sa.JSON(), nullable=False),
        sa.Column('requires_ack', sa.Boolean(), nullable=False),
        sa.Column('current_version', sa.Integer(), nullable=False),
        sa.Column('created_by', sa.String(length=64), nullable=True),
        sa.Column('updated_by', sa.String(length=64), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_hr_policies_status', 'hr_policies', ['status'])
    op.create_table(
        'hr_policy_versions',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('policy_id', sa.String(length=64), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('summary', sa.Text(), nullable=False),
        sa.Column('sections', sa.JSON(), nullable=False),
        sa.Column('change_summary', sa.Text(), nullable=False),
        sa.Column('effective_date', sa.Date(), nullable=True),
        sa.Column('published_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('published_by', sa.String(length=64), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['policy_id'], ['hr_policies.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('policy_id', 'version', name='uq_hr_policy_version'),
    )
    op.create_index('ix_hr_policy_versions_policy_id', 'hr_policy_versions', ['policy_id'])
    with op.batch_alter_table('policy_acknowledgments') as batch:
        batch.add_column(sa.Column('comment', sa.Text(), nullable=True))
    with op.batch_alter_table('letter_requests') as batch:
        batch.add_column(sa.Column('custom_text', sa.Text(), nullable=True))
    with op.batch_alter_table('employee_skills') as batch:
        batch.add_column(sa.Column('years', sa.Float(), nullable=True))
        batch.add_column(sa.Column('last_used', sa.String(length=7), nullable=True))
        batch.add_column(sa.Column('evidence_url', sa.String(length=500), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('employee_skills') as batch:
        batch.drop_column('evidence_url')
        batch.drop_column('last_used')
        batch.drop_column('years')
    with op.batch_alter_table('letter_requests') as batch:
        batch.drop_column('custom_text')
    with op.batch_alter_table('policy_acknowledgments') as batch:
        batch.drop_column('comment')
    op.drop_index('ix_hr_policy_versions_policy_id', table_name='hr_policy_versions')
    op.drop_table('hr_policy_versions')
    op.drop_index('ix_hr_policies_status', table_name='hr_policies')
    op.drop_table('hr_policies')

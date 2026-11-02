"""continuous performance feedback (praise, private feedback, feedback requests)

Revision ID: 0029
Revises: 0028
Create Date: 2026-11-02 12:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0029'
down_revision: Union[str, Sequence[str], None] = '0028'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'perf_feedback',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('from_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('to_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('message', sa.Text(), nullable=False),
        sa.Column('badge', sa.String(length=40), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=True),
        sa.Column('request_id', sa.String(length=64), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_perf_feedback_kind', 'perf_feedback', ['kind'])
    op.create_index('ix_perf_feedback_from_id', 'perf_feedback', ['from_id'])
    op.create_index('ix_perf_feedback_created_at', 'perf_feedback', ['created_at'])
    op.create_index('ix_perf_feedback_to_kind', 'perf_feedback', ['to_id', 'kind'])


def downgrade() -> None:
    op.drop_index('ix_perf_feedback_to_kind', table_name='perf_feedback')
    op.drop_index('ix_perf_feedback_created_at', table_name='perf_feedback')
    op.drop_index('ix_perf_feedback_from_id', table_name='perf_feedback')
    op.drop_index('ix_perf_feedback_kind', table_name='perf_feedback')
    op.drop_table('perf_feedback')

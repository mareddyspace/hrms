"""attendance breaks; leave handover and attachment; holiday descriptions; optional holiday details and deadline

Revision ID: 0024
Revises: 0023
Create Date: 2026-10-30 18:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0024'
down_revision: Union[str, Sequence[str], None] = '0023'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('attendance_sessions', sa.Column('breaks', sa.JSON(), nullable=True))
    op.add_column('leave_requests', sa.Column('handover_to', sa.String(length=64), nullable=True))
    op.add_column('leave_requests', sa.Column('attachment_name', sa.String(length=200), nullable=True))
    op.add_column('leave_requests', sa.Column('attachment_type', sa.String(length=100), nullable=True))
    op.add_column('leave_requests', sa.Column('attachment_path', sa.String(length=300), nullable=True))
    op.add_column('holidays', sa.Column('description', sa.Text(), nullable=True))
    op.add_column('optional_holidays', sa.Column('description', sa.Text(), nullable=True))
    op.add_column('optional_holidays', sa.Column('region', sa.String(length=100), nullable=True))
    op.add_column('optional_holidays', sa.Column('legal_entity', sa.String(length=200), nullable=True))
    op.add_column('optional_holidays', sa.Column('select_by', sa.Date(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('optional_holidays') as b:
        b.drop_column('select_by')
        b.drop_column('legal_entity')
        b.drop_column('region')
        b.drop_column('description')
    with op.batch_alter_table('holidays') as b:
        b.drop_column('description')
    with op.batch_alter_table('leave_requests') as b:
        b.drop_column('attachment_path')
        b.drop_column('attachment_type')
        b.drop_column('attachment_name')
        b.drop_column('handover_to')
    with op.batch_alter_table('attendance_sessions') as b:
        b.drop_column('breaks')

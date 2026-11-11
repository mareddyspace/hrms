"""tickets: category service targets, resolution / rating / escalation, internal notes; task and ticket file
attachments; projects: status, health, member allocation and task priority. Additive only.

Revision ID: 0033
Revises: 0032
Create Date: 2026-11-11 15:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0033'
down_revision: Union[str, Sequence[str], None] = '0032'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for name in ('response_due_at', 'resolve_due_at', 'first_response_at', 'resolved_at', 'escalated_at'):
        op.add_column('tickets', sa.Column(name, sa.DateTime(timezone=True), nullable=True))
    op.add_column('tickets', sa.Column('resolution_note', sa.Text(), nullable=True))
    op.add_column('tickets', sa.Column('satisfaction', sa.Integer(), nullable=True))
    op.add_column('tickets', sa.Column('satisfaction_note', sa.Text(), nullable=True))
    op.add_column('tickets', sa.Column('reopen_count', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('ticket_events', sa.Column('internal', sa.Boolean(), nullable=False, server_default=sa.false()))

    op.create_table(
        'ticket_categories',
        sa.Column('name', sa.String(length=32), primary_key=True),
        sa.Column('response_hours', sa.Integer(), nullable=False),
        sa.Column('resolve_hours', sa.Integer(), nullable=False),
        sa.Column('queue_owner_id', sa.String(length=64), nullable=True),
        sa.Column('active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        'work_attachments',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('entity_type', sa.String(length=16), nullable=False),
        sa.Column('entity_id', sa.String(length=64), nullable=False),
        sa.Column('file_name', sa.String(length=200), nullable=False),
        sa.Column('content_type', sa.String(length=100), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column('storage_path', sa.String(length=300), nullable=False),
        sa.Column('uploaded_by', sa.String(length=64), nullable=False),
        sa.Column('internal', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_work_attachment_entity', 'work_attachments', ['entity_type', 'entity_id'])

    op.add_column('projects', sa.Column('status', sa.String(length=16), nullable=True))
    op.add_column('projects', sa.Column('health', sa.String(length=16), nullable=True))
    op.add_column('project_members', sa.Column('allocation_pct', sa.Integer(), nullable=True))
    op.add_column('project_tasks', sa.Column('priority', sa.String(length=16), nullable=True))


def downgrade() -> None:
    op.drop_column('project_tasks', 'priority')
    op.drop_column('project_members', 'allocation_pct')
    op.drop_column('projects', 'health')
    op.drop_column('projects', 'status')
    op.drop_index('ix_work_attachment_entity', table_name='work_attachments')
    op.drop_table('work_attachments')
    op.drop_table('ticket_categories')
    op.drop_column('ticket_events', 'internal')
    for name in ('reopen_count', 'satisfaction_note', 'satisfaction', 'resolution_note', 'escalated_at', 'resolved_at',
                 'first_response_at', 'resolve_due_at', 'response_due_at'):
        op.drop_column('tickets', name)

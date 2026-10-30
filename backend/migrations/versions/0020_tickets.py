"""work tickets shared through the backend: tickets, ticket_tasks, ticket_events

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-29 23:30:00

Separate from the HR helpdesk (desk_tickets). Watchers are a JSON list on the ticket.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0020'
down_revision: Union[str, Sequence[str], None] = '0019'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'tickets',
        sa.Column('id', sa.String(length=32), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('type', sa.String(length=32), nullable=False),
        sa.Column('priority', sa.String(length=16), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('project_id', sa.String(length=64), nullable=True),
        sa.Column('project_name', sa.String(length=200), nullable=True),
        sa.Column('requester_id', sa.String(length=64), nullable=False),
        sa.Column('assignee_id', sa.String(length=64), nullable=True),
        sa.Column('sub_owner_id', sa.String(length=64), nullable=True),
        sa.Column('watcher_ids', sa.JSON(), nullable=False),
        sa.Column('due', sa.Date(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_tickets_type', 'tickets', ['type'])
    op.create_index('ix_tickets_status', 'tickets', ['status'])
    op.create_index('ix_tickets_requester_id', 'tickets', ['requester_id'])
    op.create_index('ix_ticket_assignee_status', 'tickets', ['assignee_id', 'status'])
    op.create_table(
        'ticket_tasks',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('ticket_id', sa.String(length=32), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('owner_id', sa.String(length=64), nullable=True),
        sa.Column('due', sa.Date(), nullable=True),
        sa.Column('done', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['ticket_id'], ['tickets.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_ticket_tasks_ticket_id', 'ticket_tasks', ['ticket_id'])
    op.create_index('ix_ticket_tasks_owner_id', 'ticket_tasks', ['owner_id'])
    op.create_table(
        'ticket_events',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('ticket_id', sa.String(length=32), nullable=False),
        sa.Column('at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('by_id', sa.String(length=64), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('text', sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(['ticket_id'], ['tickets.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_ticket_event_ticket_at', 'ticket_events', ['ticket_id', 'at'])


def downgrade() -> None:
    op.drop_index('ix_ticket_event_ticket_at', table_name='ticket_events')
    op.drop_table('ticket_events')
    op.drop_index('ix_ticket_tasks_owner_id', table_name='ticket_tasks')
    op.drop_index('ix_ticket_tasks_ticket_id', table_name='ticket_tasks')
    op.drop_table('ticket_tasks')
    op.drop_index('ix_ticket_assignee_status', table_name='tickets')
    op.drop_index('ix_tickets_requester_id', table_name='tickets')
    op.drop_index('ix_tickets_status', table_name='tickets')
    op.drop_index('ix_tickets_type', table_name='tickets')
    op.drop_table('tickets')

"""shared collaboration: chat, in-portal mail, tasks, announcements with acknowledgements, calendar events

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-30 14:00:00

Until now these lived only in each browser (localStorage), so nothing reached other people.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa



revision: str = '0022'
down_revision: Union[str, Sequence[str], None] = '0021'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _stamps() -> list[sa.Column]:
    return [sa.Column('created_at', sa.DateTime(timezone=True), nullable=False), sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False)]


def upgrade() -> None:
    op.create_table(
        'chat_conversations',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('kind', sa.String(length=8), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('restricted', sa.String(length=24), nullable=True),
        sa.Column('created_by', sa.String(length=64), nullable=False),
        *_stamps(),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_table(
        'chat_members',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('conversation_id', sa.String(length=64), nullable=False),
        sa.Column('person_id', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('last_read_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['conversation_id'], ['chat_conversations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('conversation_id', 'person_id', name='uq_chat_member'),
    )
    op.create_index('ix_chat_members_conversation_id', 'chat_members', ['conversation_id'])
    op.create_index('ix_chat_members_person_id', 'chat_members', ['person_id'])
    op.create_table(
        'chat_messages',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('conversation_id', sa.String(length=64), nullable=False),
        sa.Column('from_id', sa.String(length=64), nullable=False),
        sa.Column('from_name', sa.String(length=200), nullable=False),
        sa.Column('text', sa.Text(), nullable=False),
        sa.Column('attachment_name', sa.String(length=200), nullable=True),
        sa.Column('at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['conversation_id'], ['chat_conversations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_chat_message_conv_at', 'chat_messages', ['conversation_id', 'at'])

    op.create_table(
        'mail_messages',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('thread_id', sa.String(length=64), nullable=False),
        sa.Column('from_id', sa.String(length=64), nullable=False),
        sa.Column('from_name', sa.String(length=200), nullable=False),
        sa.Column('subject', sa.String(length=300), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('category', sa.String(length=32), nullable=True),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_mail_messages_thread_id', 'mail_messages', ['thread_id'])
    op.create_index('ix_mail_messages_from_id', 'mail_messages', ['from_id'])
    op.create_table(
        'mail_recipients',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('message_id', sa.String(length=64), nullable=False),
        sa.Column('person_id', sa.String(length=64), nullable=False),
        sa.Column('kind', sa.String(length=4), nullable=False),
        sa.Column('read_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['message_id'], ['mail_messages.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('message_id', 'person_id', name='uq_mail_recipient'),
    )
    op.create_index('ix_mail_recipients_message_id', 'mail_recipients', ['message_id'])
    op.create_index('ix_mail_recipients_person_id', 'mail_recipients', ['person_id'])

    op.create_table(
        'shared_tasks',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('code', sa.String(length=32), nullable=False),
        sa.Column('assignee_id', sa.String(length=64), nullable=False),
        sa.Column('created_by', sa.String(length=64), nullable=False),
        sa.Column('people_ids', sa.JSON(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('due', sa.Date(), nullable=True),
        sa.Column('data', sa.JSON(), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        *_stamps(),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_shared_tasks_assignee_id', 'shared_tasks', ['assignee_id'])
    op.create_index('ix_shared_tasks_created_by', 'shared_tasks', ['created_by'])

    op.create_table(
        'announcements',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('scope', sa.String(length=16), nullable=False),
        sa.Column('audience', sa.String(length=120), nullable=False),
        sa.Column('state', sa.String(length=16), nullable=False),
        sa.Column('published_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('scheduled_for', sa.DateTime(timezone=True), nullable=True),
        sa.Column('author_id', sa.String(length=64), nullable=True),
        sa.Column('author_name', sa.String(length=200), nullable=False),
        sa.Column('must_acknowledge', sa.Boolean(), nullable=False),
        *_stamps(),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_announcements_state', 'announcements', ['state'])
    op.create_table(
        'announcement_reads',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('announcement_id', sa.String(length=64), nullable=False),
        sa.Column('person_id', sa.String(length=64), nullable=False),
        sa.Column('read_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('acknowledged_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['announcement_id'], ['announcements.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('announcement_id', 'person_id', name='uq_announcement_read'),
    )
    op.create_index('ix_announcement_reads_announcement_id', 'announcement_reads', ['announcement_id'])
    op.create_index('ix_announcement_reads_person_id', 'announcement_reads', ['person_id'])

    op.create_table(
        'calendar_events',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('day', sa.Date(), nullable=False),
        sa.Column('time', sa.String(length=5), nullable=True),
        sa.Column('location', sa.String(length=200), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('owner_id', sa.String(length=64), nullable=False),
        *_stamps(),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_calendar_events_day', 'calendar_events', ['day'])
    op.create_index('ix_calendar_events_owner_id', 'calendar_events', ['owner_id'])
    op.create_table(
        'calendar_attendees',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('event_id', sa.String(length=64), nullable=False),
        sa.Column('person_id', sa.String(length=64), nullable=False),
        sa.Column('response', sa.String(length=12), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['calendar_events.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('event_id', 'person_id', name='uq_calendar_attendee'),
    )
    op.create_index('ix_calendar_attendees_event_id', 'calendar_attendees', ['event_id'])
    op.create_index('ix_calendar_attendees_person_id', 'calendar_attendees', ['person_id'])


def downgrade() -> None:
    for table in ('calendar_attendees', 'calendar_events', 'announcement_reads', 'announcements', 'shared_tasks',
                  'mail_recipients', 'mail_messages', 'chat_messages', 'chat_members', 'chat_conversations'):
        op.drop_table(table)

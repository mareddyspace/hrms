"""mail drafts; announcement category and pin; help desk subcategory, contact preference and FAQ votes

Revision ID: 0027
Revises: 0026
Create Date: 2026-10-30 20:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa



revision: str = '0027'
down_revision: Union[str, Sequence[str], None] = '0026'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'mail_drafts',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('owner_id', sa.String(length=64), nullable=False),
        sa.Column('to_ids', sa.JSON(), nullable=False),
        sa.Column('cc_ids', sa.JSON(), nullable=False),
        sa.Column('subject', sa.String(length=300), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('category', sa.String(length=32), nullable=True),
        sa.Column('thread_id', sa.String(length=64), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_mail_drafts_owner_id', 'mail_drafts', ['owner_id'])
    op.add_column('announcements', sa.Column('category', sa.String(length=32), nullable=True))
    op.add_column('announcements', sa.Column('pinned', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('desk_tickets', sa.Column('subcategory', sa.String(length=64), nullable=True))
    op.add_column('desk_tickets', sa.Column('contact_preference', sa.String(length=16), nullable=True))
    op.create_table(
        'desk_faq_votes',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('faq_id', sa.String(length=64), nullable=False),
        sa.Column('person_id', sa.String(length=64), nullable=False),
        sa.Column('helpful', sa.Boolean(), nullable=False),
        sa.Column('voted_at', sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint('faq_id', 'person_id', name='uq_desk_faq_vote'),
    )
    op.create_index('ix_desk_faq_votes_faq_id', 'desk_faq_votes', ['faq_id'])
    op.create_index('ix_desk_faq_votes_person_id', 'desk_faq_votes', ['person_id'])


def downgrade() -> None:
    op.drop_index('ix_desk_faq_votes_person_id', table_name='desk_faq_votes')
    op.drop_index('ix_desk_faq_votes_faq_id', table_name='desk_faq_votes')
    op.drop_table('desk_faq_votes')
    with op.batch_alter_table('desk_tickets') as b:
        b.drop_column('contact_preference')
        b.drop_column('subcategory')
    with op.batch_alter_table('announcements') as b:
        b.drop_column('pinned')
        b.drop_column('category')
    op.drop_index('ix_mail_drafts_owner_id', table_name='mail_drafts')
    op.drop_table('mail_drafts')

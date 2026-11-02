"""request comments and files; expense / travel details; cash advance settlement; document verification

Revision ID: 0028
Revises: 0027
Create Date: 2026-11-02 11:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0028'
down_revision: Union[str, Sequence[str], None] = '0027'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'request_comments',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('entity_type', sa.String(length=32), nullable=False),
        sa.Column('entity_id', sa.String(length=64), nullable=False),
        sa.Column('author_id', sa.String(length=64), nullable=True),
        sa.Column('author_name', sa.String(length=200), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_request_comment_entity', 'request_comments', ['entity_type', 'entity_id'])
    op.create_table(
        'request_attachments',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('entity_type', sa.String(length=32), nullable=False),
        sa.Column('entity_id', sa.String(length=64), nullable=False),
        sa.Column('purpose', sa.String(length=32), nullable=False),
        sa.Column('employee_id', sa.String(length=64), nullable=False),
        sa.Column('file_name', sa.String(length=255), nullable=False),
        sa.Column('content_type', sa.String(length=100), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column('sha256', sa.String(length=64), nullable=False),
        sa.Column('storage_path', sa.String(length=500), nullable=False),
        sa.Column('uploaded_by', sa.String(length=64), nullable=True),
        sa.Column('uploaded_by_name', sa.String(length=200), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_request_attachment_entity', 'request_attachments', ['entity_type', 'entity_id'])
    op.create_index('ix_request_attachments_employee_id', 'request_attachments', ['employee_id'])
    op.add_column('expense_claims', sa.Column('details', sa.JSON(), nullable=True))
    op.add_column('travel_requests', sa.Column('details', sa.JSON(), nullable=True))
    op.add_column('travel_requests', sa.Column('booking', sa.JSON(), nullable=True))
    for name, kind in (('expected_settlement', sa.Date()), ('trip_id', sa.String(length=64)), ('project', sa.String(length=120)),
                       ('settlement_status', sa.String(length=16)), ('settlement_spent', sa.Float()),
                       ('settlement_returned', sa.Float()), ('settlement_note', sa.Text()), ('settlement_on', sa.Date()),
                       ('settlement_reference', sa.String(length=64)), ('settlement_verified_by', sa.String(length=64)),
                       ('settlement_verified_on', sa.Date())):
        op.add_column('cash_advances', sa.Column(name, kind, nullable=True))
    op.add_column('employee_documents', sa.Column('description', sa.Text(), nullable=True))
    op.add_column('employee_documents', sa.Column('verification_status', sa.String(length=16), nullable=True))
    op.add_column('employee_documents', sa.Column('verification_note', sa.Text(), nullable=True))
    op.add_column('employee_documents', sa.Column('verified_by', sa.String(length=64), nullable=True))
    op.add_column('employee_documents', sa.Column('verified_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('employee_documents') as b:
        for name in ('verified_at', 'verified_by', 'verification_note', 'verification_status', 'description'):
            b.drop_column(name)
    with op.batch_alter_table('cash_advances') as b:
        for name in ('settlement_verified_on', 'settlement_verified_by', 'settlement_reference', 'settlement_on',
                     'settlement_note', 'settlement_returned', 'settlement_spent', 'settlement_status', 'project', 'trip_id',
                     'expected_settlement'):
            b.drop_column(name)
    with op.batch_alter_table('travel_requests') as b:
        b.drop_column('booking')
        b.drop_column('details')
    with op.batch_alter_table('expense_claims') as b:
        b.drop_column('details')
    op.drop_index('ix_request_attachments_employee_id', table_name='request_attachments')
    op.drop_index('ix_request_attachment_entity', table_name='request_attachments')
    op.drop_table('request_attachments')
    op.drop_index('ix_request_comment_entity', table_name='request_comments')
    op.drop_table('request_comments')

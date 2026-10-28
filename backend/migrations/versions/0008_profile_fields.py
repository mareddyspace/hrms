"""employee profile fields (company, nationality, address, emergency contact, background) and profile corrections

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-28 21:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0008'
down_revision: Union[str, Sequence[str], None] = '0007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    ('nationality', sa.String(64)),
    ('address_line', sa.String(300)),
    ('address_city', sa.String(100)),
    ('address_postcode', sa.String(20)),
    ('address_country', sa.String(100)),
    ('emergency_name', sa.String(200)),
    ('emergency_relationship', sa.String(64)),
    ('emergency_phone', sa.String(64)),
    ('work_arrangement', sa.String(16)),
    ('preferred_language', sa.String(64)),
    ('languages', sa.JSON()),
    ('education', sa.JSON()),
    ('experience', sa.JSON()),
    ('career_goals', sa.Text()),
)


def upgrade() -> None:
    with op.batch_alter_table('employees') as batch:
        batch.add_column(sa.Column('company', sa.String(100), nullable=False, server_default='TimeZ'))
        for name, type_ in _COLUMNS:
            batch.add_column(sa.Column(name, type_, nullable=True))

    op.create_table(
        'profile_corrections',
        sa.Column('id', sa.String(64), primary_key=True),
        sa.Column('employee_id', sa.String(64), sa.ForeignKey('employees.id', ondelete='CASCADE'), nullable=False),
        sa.Column('field', sa.String(32), nullable=False),
        sa.Column('current_value', sa.Text(), nullable=True),
        sa.Column('requested_value', sa.Text(), nullable=True),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('status', sa.String(16), nullable=False),
        sa.Column('requested_by', sa.String(64), nullable=False),
        sa.Column('decided_by', sa.String(64), nullable=True),
        sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('decision_note', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_profile_corrections_employee_id', 'profile_corrections', ['employee_id'])
    op.create_index('ix_profile_corrections_status', 'profile_corrections', ['status'])


def downgrade() -> None:
    op.drop_index('ix_profile_corrections_status', table_name='profile_corrections')
    op.drop_index('ix_profile_corrections_employee_id', table_name='profile_corrections')
    op.drop_table('profile_corrections')
    with op.batch_alter_table('employees') as batch:
        for name, _ in reversed(_COLUMNS):
            batch.drop_column(name)
        batch.drop_column('company')

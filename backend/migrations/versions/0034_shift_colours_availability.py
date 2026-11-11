"""shift type colour and country; employee shift availability (unavailable days / weekdays, preferred shift)

Revision ID: 0034
Revises: 0033
Create Date: 2026-11-11 12:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0034'
down_revision: Union[str, Sequence[str], None] = '0033'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('shift_types', sa.Column('color', sa.String(length=16), nullable=True))
    op.add_column('shift_types', sa.Column('country_code', sa.String(length=2), nullable=True))
    op.create_table(
        'shift_availability',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('employee_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),  # unavailable | preferred
        sa.Column('work_date', sa.Date(), nullable=True),  # one day, or
        sa.Column('weekday', sa.Integer(), nullable=True),  # every week: 0 = Sunday ... 6 = Saturday
        sa.Column('shift_id', sa.String(length=64), nullable=True),  # preferred shift (kind = preferred)
        sa.Column('note', sa.String(length=300), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_shift_availability_employee_id', 'shift_availability', ['employee_id'])


def downgrade() -> None:
    op.drop_index('ix_shift_availability_employee_id', table_name='shift_availability')
    op.drop_table('shift_availability')
    op.drop_column('shift_types', 'country_code')
    op.drop_column('shift_types', 'color')

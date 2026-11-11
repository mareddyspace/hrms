"""who hired each person: recruiter and hiring manager (names, shown on the profile)

Revision ID: 0030
Revises: 0029
Create Date: 2026-11-11 09:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0030'
down_revision: Union[str, Sequence[str], None] = '0029'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('employees', sa.Column('hired_by', sa.String(length=200), nullable=True))
    op.add_column('employees', sa.Column('hiring_manager', sa.String(length=200), nullable=True))


def downgrade() -> None:
    op.drop_column('employees', 'hiring_manager')
    op.drop_column('employees', 'hired_by')

"""payroll: employees.tax_regime (India new / old income tax regime, chosen by the employee)

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-29 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0015'
down_revision: Union[str, Sequence[str], None] = '0014'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('employees') as batch:
        batch.add_column(sa.Column('tax_regime', sa.String(length=8), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('employees') as batch:
        batch.drop_column('tax_regime')

"""onboarding template scope (legal entity, employment type, active) and the joiner pre-boarding form

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-28 23:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0010'
down_revision: Union[str, Sequence[str], None] = '0009'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('onboarding_template_tasks') as batch:
        batch.add_column(sa.Column('legal_entity', sa.String(200), nullable=True))
        batch.add_column(sa.Column('employment_type', sa.String(32), nullable=True))
        batch.add_column(sa.Column('active', sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.drop_constraint('uq_onboarding_template_country_key', type_='unique')
        batch.create_unique_constraint('uq_onboarding_template_scope_key',
                                       ['country_code', 'legal_entity', 'employment_type', 'key'])
    with op.batch_alter_table('joiners') as batch:
        batch.add_column(sa.Column('preboarding', sa.JSON(), nullable=True))
        batch.add_column(sa.Column('preboarding_at', sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column('preboarding_by', sa.String(64), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('joiners') as batch:
        batch.drop_column('preboarding_by')
        batch.drop_column('preboarding_at')
        batch.drop_column('preboarding')
    with op.batch_alter_table('onboarding_template_tasks') as batch:
        batch.drop_constraint('uq_onboarding_template_scope_key', type_='unique')
        batch.create_unique_constraint('uq_onboarding_template_country_key', ['country_code', 'key'])
        batch.drop_column('active')
        batch.drop_column('employment_type')
        batch.drop_column('legal_entity')

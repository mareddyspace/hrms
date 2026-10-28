"""approval chains for leave / attendance / timesheets, delegation, decisions on behalf of

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-29 01:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0009'
down_revision: Union[str, Sequence[str], None] = '0008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'delegations',
        sa.Column('id', sa.String(64), primary_key=True),
        sa.Column('delegator_id', sa.String(64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('delegate_id', sa.String(64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('starts_on', sa.Date(), nullable=False),
        sa.Column('ends_on', sa.Date(), nullable=False),
        sa.Column('types', sa.JSON(), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_by', sa.String(64), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_delegations_delegator_id', 'delegations', ['delegator_id'])
    op.create_index('ix_delegations_delegate_window', 'delegations', ['delegate_id', 'starts_on', 'ends_on'])
    with op.batch_alter_table('approval_decisions') as batch:
        batch.add_column(sa.Column('on_behalf_of', sa.String(64), nullable=True))
    with op.batch_alter_table('leave_types') as batch:
        batch.add_column(sa.Column('needs_hr_approval', sa.Boolean(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('leave_types') as batch:
        batch.drop_column('needs_hr_approval')
    with op.batch_alter_table('approval_decisions') as batch:
        batch.drop_column('on_behalf_of')
    op.drop_index('ix_delegations_delegate_window', table_name='delegations')
    op.drop_index('ix_delegations_delegator_id', table_name='delegations')
    op.drop_table('delegations')

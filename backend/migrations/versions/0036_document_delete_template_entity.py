"""documents: soft delete (deleted_at / deleted_by); letter templates per legal entity

Revision ID: 0036
Revises: the newest revision before it (0035 when present)
Create Date: 2026-11-11 15:00:00

Additive only: three nullable columns, no data changes. A deleted document keeps its row and files (audit trail);
it just stops showing anywhere.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


def _previous() -> str:
    """Parallel work may add 0035; chain onto the newest revision below 0036 so the history stays one line."""
    here = Path(__file__).parent
    numbers = sorted(int(p.name[:4]) for p in here.glob("[0-9][0-9][0-9][0-9]_*.py") if p.name[:4].isdigit())
    return f"{max(n for n in numbers if n < 36):04d}"


revision: str = '0036'
down_revision: Union[str, Sequence[str], None] = '0034'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('employee_documents', sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('employee_documents', sa.Column('deleted_by', sa.String(length=64), nullable=True))
    op.add_column('letter_templates', sa.Column('legal_entity', sa.String(length=200), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('letter_templates') as batch:
        batch.drop_column('legal_entity')
    with op.batch_alter_table('employee_documents') as batch:
        batch.drop_column('deleted_by')
        batch.drop_column('deleted_at')

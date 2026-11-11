"""holiday type (national / regional / company / optional), regions (states / cities) and legal entity;
leave policy "encashable" flag

Revision ID: 0032
Revises: the newest revision before it (0031 when present)
Create Date: 2026-11-11 12:30:00

Data: fill-blank only. Sample holidays still without a type get one from app/services/holiday_rules.classify()
(e.g. India: 3 national, 6 company, state holidays by office, the other festivals optional). Nothing is deleted.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


def _previous() -> str:
    """Parallel work may add 0031; chain onto the newest revision below 0032 so the history stays one line."""
    here = Path(__file__).parent
    numbers = sorted(int(p.name[:4]) for p in here.glob("[0-9][0-9][0-9][0-9]_*.py") if p.name[:4].isdigit())
    return f"{max(n for n in numbers if n < 32):04d}"


revision: str = '0032'
down_revision: Union[str, Sequence[str], None] = '0030'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('holidays', sa.Column('holiday_type', sa.String(length=16), nullable=True))
    op.add_column('holidays', sa.Column('regions', sa.JSON(), nullable=True))
    op.add_column('holidays', sa.Column('legal_entity', sa.String(length=200), nullable=True))
    op.add_column('leave_policies', sa.Column('encashable', sa.Boolean(), nullable=True))

    from app.services.holiday_rules import classify, is_seed_id

    holidays = sa.table('holidays', sa.column('id', sa.String), sa.column('country_code', sa.String),
                        sa.column('name', sa.String), sa.column('holiday_type', sa.String),
                        sa.column('regions', sa.JSON))
    conn = op.get_bind()
    rows = conn.execute(sa.select(holidays.c.id, holidays.c.country_code, holidays.c.name)
                        .where(holidays.c.holiday_type.is_(None))).all()
    for hid, country, name in rows:
        found = classify(country, name) if is_seed_id(hid) else None
        if found is None:
            continue
        kind, regions = found
        conn.execute(holidays.update().where(holidays.c.id == hid, holidays.c.holiday_type.is_(None))
                     .values(holiday_type=kind, regions=regions))


def downgrade() -> None:
    op.drop_column('leave_policies', 'encashable')
    op.drop_column('holidays', 'legal_entity')
    op.drop_column('holidays', 'regions')
    op.drop_column('holidays', 'holiday_type')

"""optional (restricted) holidays per country, booked as leave type "optional"

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-29 21:00:00

Adds the optional_holidays table, the "optional" leave type and its India / US policies (2 and 1 picks a year)
and the 2026 sample list, so an existing database works without re-running the seed. Rows that already exist
are left alone; countries that aren't in the database yet are skipped (the seed adds them later).
"""
from datetime import date, datetime, timezone
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0017'
down_revision: Union[str, Sequence[str], None] = '0016'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_HOLIDAYS = [
    ("oh-in-mahavir", "IN", date(2026, 3, 31), "Mahavir Jayanti"),
    ("oh-in-onam", "IN", date(2026, 8, 26), "Onam"),
    ("oh-in-rakhi", "IN", date(2026, 8, 27), "Raksha Bandhan"),
    ("oh-in-karva", "IN", date(2026, 10, 29), "Karva Chauth"),
    ("oh-in-chhath", "IN", date(2026, 11, 16), "Chhath Puja"),
    ("oh-in-xmas-eve", "IN", date(2026, 12, 24), "Christmas Eve"),
    ("oh-in-nye", "IN", date(2026, 12, 31), "New Year's Eve"),
    ("oh-us-thanks", "US", date(2026, 11, 27), "Day after Thanksgiving"),
    ("oh-us-xmas-eve", "US", date(2026, 12, 24), "Christmas Eve"),
]
_QUOTAS = {"IN": 2, "US": 1}


def upgrade() -> None:
    op.create_table(
        'optional_holidays',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('country_code', sa.String(length=2), nullable=False),
        sa.Column('date', sa.Date(), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('active', sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['country_code'], ['countries.code']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('country_code', 'date', name='uq_optional_holiday_country_date'),
    )
    op.create_index('ix_optional_holidays_country_code', 'optional_holidays', ['country_code'])

    conn = op.get_bind()
    now = datetime.now(timezone.utc)
    countries = {row[0] for row in conn.execute(sa.text("SELECT code FROM countries"))}
    has_type = conn.execute(sa.text("SELECT 1 FROM leave_types WHERE code = 'optional'")).first() is not None
    if not has_type:
        conn.execute(
            sa.text("INSERT INTO leave_types (code, name, half_day_allowed, active, created_at, updated_at) "
                    "VALUES ('optional', 'Optional holiday', :f, :t, :now, :now)"),
            {"f": False, "t": True, "now": now},
        )
    for cc in sorted(countries):
        pid = f"optional-{cc}-2026"
        if conn.execute(sa.text("SELECT 1 FROM leave_policies WHERE id = :id"), {"id": pid}).first() is not None:
            continue
        conn.execute(
            sa.text("INSERT INTO leave_policies (id, leave_code, country_code, name, quota, carry_forward_max, accrual, "
                    "effective_from, effective_to, gender, not_in_probation, active, created_at, updated_at) "
                    "VALUES (:id, 'optional', :cc, 'Optional holiday', :quota, 0, 'annual', :from_, NULL, 'any', :f, :t, :now, :now)"),
            {"id": pid, "cc": cc, "quota": _QUOTAS.get(cc, 0), "from_": date(2026, 1, 1), "f": False, "t": True, "now": now},
        )
    table = sa.table(
        'optional_holidays',
        sa.column('id', sa.String), sa.column('country_code', sa.String), sa.column('date', sa.Date),
        sa.column('name', sa.String), sa.column('active', sa.Boolean),
        sa.column('created_at', sa.DateTime(timezone=True)), sa.column('updated_at', sa.DateTime(timezone=True)),
    )
    rows = [
        {"id": hid, "country_code": cc, "date": day, "name": name, "active": True, "created_at": now, "updated_at": now}
        for hid, cc, day, name in _HOLIDAYS if cc in countries
    ]
    if rows:
        op.bulk_insert(table, rows)


def downgrade() -> None:
    # The "optional" leave type and policies stay: leave requests may point at them.
    op.drop_index('ix_optional_holidays_country_code', table_name='optional_holidays')
    op.drop_table('optional_holidays')

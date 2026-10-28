"""Create/upgrade all tables: python -m app.db_init  (same as `alembic upgrade head`)."""

from __future__ import annotations

from alembic import command
from alembic.config import Config

from app.config import BACKEND_DIR, get_settings


def upgrade_to_head() -> None:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    command.upgrade(cfg, "head")


if __name__ == "__main__":
    upgrade_to_head()
    print(f"Database schema is up to date ({'SQLite dev file' if get_settings().is_sqlite else 'PostgreSQL'}).")

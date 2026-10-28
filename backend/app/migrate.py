"""Optional start-up migration (RUN_MIGRATIONS_ON_START=true), for hosts without a pre-deploy step (Render free).

On PostgreSQL the upgrade runs inside one transaction that first takes pg_advisory_xact_lock, so two instances
starting together can't run it twice: the second waits, then finds the schema already at head. A transaction-level
lock (not a session lock) also works through Neon's pooled (PgBouncer) endpoint. PostgreSQL DDL is transactional,
so a failed migration rolls back completely.

Seeding is never automatic: run `python -m app.seed` by hand (see DEPLOY.md).
Run by hand: python -m app.migrate
"""

from __future__ import annotations

import logging
import time

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from sqlalchemy import text

from app.config import BACKEND_DIR, get_settings

log = logging.getLogger("timez.migrate")

# Any fixed 64-bit number; only has to be the same for every instance of this app.
ADVISORY_LOCK_KEY = 7_316_220_041


def _alembic_config() -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    return cfg


def upgrade_with_lock() -> tuple[str | None, str | None]:
    """alembic upgrade head under an advisory lock. Returns (revision before, revision after)."""
    from app.db import engine

    cfg = _alembic_config()
    with engine.begin() as conn:
        if conn.dialect.name == "postgresql":
            conn.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": ADVISORY_LOCK_KEY})
        before = MigrationContext.configure(conn).get_current_revision()
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "head")
        after = MigrationContext.configure(conn).get_current_revision()
    return before, after


def run_if_enabled() -> None:
    """Called from the app's lifespan. Raises on failure so a broken deploy doesn't start serving."""
    if not get_settings().run_migrations_on_start:
        return
    started = time.monotonic()
    log.info("RUN_MIGRATIONS_ON_START: upgrading the database schema to head")
    try:
        before, after = upgrade_with_lock()
    except Exception:
        log.exception("Database migration failed; not starting")
        raise
    took = time.monotonic() - started
    if before == after:
        log.info("Database schema already at head (%s); %.1fs", after, took)
    else:
        log.info("Database schema upgraded %s -> %s in %.1fs", before or "empty", after, took)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    b, a = upgrade_with_lock()
    print(f"Database schema: {b or 'empty'} -> {a}")

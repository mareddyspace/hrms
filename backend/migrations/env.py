"""Alembic environment: uses the app's engine (DATABASE_URL from backend/.env, or the SQLite dev file)."""

from __future__ import annotations

from alembic import context

import app.models  # noqa: F401  (registers tables)
from app.db import Base, UTCDateTime, engine

target_metadata = Base.metadata


def render_item(type_, obj, autogen_context):  # type: ignore[no-untyped-def]
    if type_ == "type" and isinstance(obj, UTCDateTime):
        return "sa.DateTime(timezone=True)"
    return False


def run_migrations_offline() -> None:
    context.configure(url=engine.url, target_metadata=target_metadata, literal_binds=True, render_item=render_item)
    with context.begin_transaction():
        context.run_migrations()


def _run_with(connection) -> None:  # type: ignore[no-untyped-def]
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_item=render_item,
        render_as_batch=connection.dialect.name == "sqlite",
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    # app/migrate.py passes its own connection (holding the advisory lock inside an open transaction).
    given = context.config.attributes.get("connection")
    if given is not None:
        _run_with(given)
        return
    with engine.connect() as connection:
        _run_with(connection)


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

"""Key / value platform settings with code defaults (a missing row means the default)."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.models import PlatformSetting

DEFAULTS: dict[str, Any] = {
    # Closed HR cases older than this many years are archived to a stub (portal: privacy retention rule).
    "case_retention_years": 5,
    # Internal Committee for POSH cases (employee ids). Members can see and work POSH cases.
    "posh_committee": ["demo-hr-admin"],
}


def get_setting(db: Session, key: str) -> Any:
    row = db.get(PlatformSetting, key)
    return row.value if row is not None else DEFAULTS.get(key)


def set_setting(db: Session, key: str, value: Any, actor_id: str | None) -> Any:
    row = db.get(PlatformSetting, key)
    before = row.value if row is not None else DEFAULTS.get(key)
    if row is None:
        db.add(PlatformSetting(key=key, value=value, updated_by=actor_id))
    else:
        row.value, row.updated_by = value, actor_id
    return before


def all_settings(db: Session) -> dict[str, Any]:
    return {key: get_setting(db, key) for key in DEFAULTS}

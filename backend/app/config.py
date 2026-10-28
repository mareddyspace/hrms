"""Settings, read from backend/.env (environment variables win over the file)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEV_SQLITE_PATH = BACKEND_DIR / "timez-dev.db"


def normalize_database_url(raw: str | None) -> str:
    """Turn the pasted URL into a SQLAlchemy URL.

    - empty            -> SQLite file backend/timez-dev.db
    - postgres(ql)://  -> postgresql+psycopg:// (query string such as ?sslmode=require is kept)
    - anything else    -> used as is (e.g. sqlite:///... for tests)
    """
    url = (raw or "").strip().strip('"').strip("'")
    if not url:
        return f"sqlite:///{DEV_SQLITE_PATH.as_posix()}"
    for prefix in ("postgresql+psycopg2://", "postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    # DATABASE_URL (never logged); see normalize_database_url.
    database_url_raw: str = Field(default="", validation_alias="DATABASE_URL", repr=False)
    jwt_secret: str = Field(default="", repr=False)
    cors_origins: str = "http://localhost:5173,http://localhost:5174"
    access_token_minutes: int = 30
    refresh_token_days: int = 7
    max_failed_logins: int = 5
    lockout_minutes: int = 15
    # Not signed in for this many days: the next sign-in must set a new password.
    password_stale_days: int = 90
    # Local testing only: POST /people/me/otp also returns the code (dev_code). Never set in production.
    otp_dev_echo: bool = Field(default=False, validation_alias="OTP_DEV_ECHO")

    # HR Copilot via OpenRouter (app/services/ai_copilot.py). No key = Copilot answers come from the portal's
    # built-in rules. The key is never logged or returned.
    openrouter_api_key: str = Field(default="", validation_alias="OPENROUTER_API_KEY", repr=False)
    ai_model: str = Field(default="", validation_alias="AI_MODEL")
    ai_model_fallbacks: str = Field(default="", validation_alias="AI_MODEL_FALLBACKS")  # comma-separated
    ai_timeout_seconds: float = Field(default=25.0, validation_alias="AI_TIMEOUT_SECONDS")

    @property
    def ai_models(self) -> list[str]:
        """AI_MODEL first, then AI_MODEL_FALLBACKS, without duplicates."""
        out: list[str] = []
        for name in [self.ai_model, *self.ai_model_fallbacks.split(",")]:
            name = name.strip()
            if name and name not in out:
                out.append(name)
        return out

    @property
    def ai_enabled(self) -> bool:
        return bool(self.openrouter_api_key.strip()) and bool(self.ai_models)

    @property
    def database_url(self) -> str:
        return normalize_database_url(self.database_url_raw)

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if not settings.jwt_secret or len(settings.jwt_secret) < 16:
        raise RuntimeError("JWT_SECRET in backend/.env must be set (at least 16 characters).")
    return settings

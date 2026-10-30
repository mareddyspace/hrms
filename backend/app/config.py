"""Settings, read from backend/.env (environment variables win over the file)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, model_validator
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
    # Extra allowed origins as a regular expression, e.g. Vercel preview URLs:
    # ^https://hrms(-[a-z0-9-]+)?\.vercel\.app$   Empty = only CORS_ORIGINS.
    cors_origin_regex: str = Field(default="", validation_alias="CORS_ORIGIN_REGEX")

    # "production" turns on the strict start-up checks (JWT_SECRET) and HSTS.
    app_env: str = Field(default="development", validation_alias="APP_ENV")
    # /docs and /openapi.json. Unset = on in development, off in production. In production, DOCS_ENABLED=true serves
    # them only after signing in with a portal account (HTTP Basic, app/docs_auth.py).
    docs_enabled: bool | None = Field(default=None, validation_alias="DOCS_ENABLED")
    log_level: str = Field(default="INFO", validation_alias="LOG_LEVEL")
    # Run `alembic upgrade head` once at start-up (Render free has no pre-deploy command).
    run_migrations_on_start: bool = Field(default=False, validation_alias="RUN_MIGRATIONS_ON_START")
    access_token_minutes: int = 30
    refresh_token_days: int = 7
    max_failed_logins: int = 5
    lockout_minutes: int = 15
    # Password older than this many days (password_changed_at): the next sign-in must set a new password.
    password_stale_days: int = 90
    # Local testing only: POST /people/me/otp also returns the code (dev_code). Never set in production.
    otp_dev_echo: bool = Field(default=False, validation_alias="OTP_DEV_ECHO")

    # HR Copilot via OpenRouter (app/services/ai_copilot.py). No key = Copilot answers come from the portal's
    # built-in rules. The key is never logged or returned.
    openrouter_api_key: str = Field(default="", validation_alias="OPENROUTER_API_KEY", repr=False)
    ai_model: str = Field(default="", validation_alias="AI_MODEL")
    ai_model_fallbacks: str = Field(default="", validation_alias="AI_MODEL_FALLBACKS")  # comma-separated
    ai_timeout_seconds: float = Field(default=14.0, validation_alias="AI_TIMEOUT_SECONDS")

    @model_validator(mode="after")
    def _default_docs(self) -> "Settings":
        if self.docs_enabled is None:
            self.docs_enabled = not self.is_production
        return self

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
    def is_production(self) -> bool:
        return self.app_env.strip().lower() in ("production", "prod")

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


# Placeholder / sample values that must never sign real tokens.
WEAK_SECRETS = {"changeme", "change-me", "change_me", "secret", "jwt-secret", "dev-secret", "development",
                "test-secret-test-secret-test-secret", "your-secret-here", "please-change-me"}


def check_jwt_secret(settings: Settings) -> None:
    secret = settings.jwt_secret.strip()
    if not secret or len(secret) < 16:
        raise RuntimeError("JWT_SECRET must be set (at least 16 characters).")
    if settings.is_production and (len(secret) < 32 or secret.lower() in WEAK_SECRETS or len(set(secret)) < 8):
        raise RuntimeError("APP_ENV=production needs a strong random JWT_SECRET (at least 32 characters, not a sample value).")


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    check_jwt_secret(settings)
    return settings

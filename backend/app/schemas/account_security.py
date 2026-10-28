"""Two-step sign-in (MFA), signed-in devices (sessions) and the MFA policy. Import names from this module directly."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas import TokenOut


class MfaLoginOut(TokenOut):
    """Sign-in result. When mfa_required is true no tokens are issued yet: send mfa_token and a code to /auth/mfa/verify."""

    access_token: str = ""
    refresh_token: str = ""
    expires_in: int = 0
    mfa_required: bool = False
    mfa_token: str | None = None
    # The admin policy needs this account to set up two-step sign-in before anything else works.
    mfa_setup_required: bool = False


class MfaVerifyIn(BaseModel):
    mfa_token: str = Field(min_length=10, max_length=2000)
    code: str = Field(min_length=6, max_length=32)


class MfaStatusOut(BaseModel):
    enabled: bool
    enabled_at: datetime | None
    backup_codes_left: int
    required_by_policy: bool
    setup_required: bool


class MfaSetupOut(BaseModel):
    secret: str  # the setup key to type into an authenticator app
    otpauth_uri: str
    issuer: str
    account_name: str


class MfaEnableIn(BaseModel):
    code: str = Field(min_length=6, max_length=16)


class MfaBackupCodesOut(BaseModel):
    backup_codes: list[str]  # shown once


class MfaPasswordIn(BaseModel):
    password: str = Field(min_length=1, max_length=256)


class MfaPolicyIn(BaseModel):
    require_mfa_admin_hr: bool


class MfaPolicyOut(BaseModel):
    require_mfa_admin_hr: bool


class SessionOut(BaseModel):
    session_id: str
    started_at: datetime | None
    last_used_at: datetime | None
    expires_at: datetime
    ip: str | None
    user_agent: str | None
    current: bool = False


class SessionsRevokedOut(BaseModel):
    revoked: int

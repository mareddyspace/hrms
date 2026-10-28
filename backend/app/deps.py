"""Request dependencies: database session and the signed-in user with their data scope."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Account, Employee
from app.security import decode_token
from app.services.data_scope import scope_for
from app.services.scope import Scope

DbSession = Annotated[Session, Depends(get_db)]
_bearer = HTTPBearer(auto_error=False)

_UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Not signed in or session expired.",
    headers={"WWW-Authenticate": "Bearer"},
)


@dataclass
class CurrentUser:
    account: Account
    employee: Employee | None
    scope: Scope

    @property
    def id(self) -> str:
        return self.account.id

    @property
    def employee_id(self) -> str | None:
        return self.account.employee_id


# While a password change is required, only these work (sign-in details and the change itself).
_ALLOWED_WHILE_MUST_CHANGE = ("/auth/me", "/auth/change-password", "/auth/refresh", "/health")


def _check_session_and_mfa(request: Request, db: Session, account: Account, session_id: str | None) -> None:
    """A signed-out / revoked device stops working at once; the admin MFA policy limits admin & HR until set up."""
    from sqlalchemy import or_, select

    from app.models import RefreshToken
    from app.services import mfa

    if session_id and db.scalar(select(RefreshToken.jti).where(
            RefreshToken.account_id == account.id, RefreshToken.revoked_at.is_(None),
            or_(RefreshToken.session_id == session_id, RefreshToken.jti == session_id)).limit(1)) is None:
        raise _UNAUTHORIZED
    path = request.url.path
    if "/auth/" not in path and "/security/" not in path and mfa.setup_required(db, account):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Set up two-step sign-in to continue.")


def get_current_user(
    request: Request,
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> CurrentUser:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _UNAUTHORIZED
    claims = decode_token(credentials.credentials, "access")
    if claims is None:
        raise _UNAUTHORIZED
    account = db.get(Account, claims["sub"])
    if account is None or not account.active:
        raise _UNAUTHORIZED
    if account.must_change_password and not request.url.path.endswith(_ALLOWED_WHILE_MUST_CHANGE):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Set a new password to continue.")
    _check_session_and_mfa(request, db, account, claims.get("sid"))
    employee = db.get(Employee, account.employee_id) if account.employee_id else None
    return CurrentUser(account=account, employee=employee, scope=scope_for(db, account))  # role default + saved data scope


CurrentUserDep = Annotated[CurrentUser, Depends(get_current_user)]


def client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None

"""Authentication service — login, refresh, user provisioning."""

import uuid
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import ForbiddenError, UnauthorizedError, ValidationError
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.db.models.user import User
from app.ports import cognito
from app.shared.audit import record_audit


async def get_user_by_email(session: AsyncSession, email: str) -> Optional[User]:
    # Case-insensitive lookup, matching the lower(email) unique index.
    result = await session.execute(select(User).where(func.lower(User.email) == email.strip().lower()))
    return result.scalar_one_or_none()


async def authenticate(session: AsyncSession, email: str, password: str) -> User:
    user = await get_user_by_email(session, email)
    if user is None or not verify_password(password, user.password_hash):
        # Same message either way — do not reveal which accounts exist.
        raise UnauthorizedError("Invalid email or password")
    if not user.is_active:
        raise ForbiddenError("This account is deactivated")
    return user


async def authenticate_cognito(session: AsyncSession, email: str, password: str) -> User | None:
    """Authenticate against Cognito and create/update local user.

    Returns None if Cognito is not configured or authentication fails.
    """
    if not (settings.cognito_user_pool_id and settings.cognito_app_client_id):
        return None

    cognito_resp = await cognito.cognito_sign_in(email, password)
    if cognito_resp is None:
        return None

    # Extract Cognito user info
    auth_result = cognito_resp.get("AuthenticationResult", {})
    id_token = auth_result.get("IdToken")

    if not id_token:
        return None

    # Decode ID token to get user attributes (sub, email, etc.)
    # We don't verify signature here since we trust the Cognito response
    import json
    import base64

    def decode_cognito_token(token: str) -> dict:
        parts = token.split(".")
        if len(parts) != 3:
            return {}
        payload = parts[1]
        # Add padding if needed
        padding = "=" * (-len(payload) % 4)
        decoded = base64.urlsafe_b64decode(payload + padding)
        return json.loads(decoded)

    claims = decode_cognito_token(id_token)
    sub = claims.get("sub", "")
    cognito_email = claims.get("email", email)

    # Look up or create local user
    user = await get_user_by_email(session, cognito_email)
    if user is None:
        # Create new local user from Cognito info
        user = User(
            id=uuid.UUID(sub) if sub else uuid.uuid4(),
            email=cognito_email,
            display_name=claims.get("name", "") or cognito_email.split("@")[0],
            # No usable local password: Cognito owns the credential. An
            # unguessable random hash means verify_password() can never succeed
            # even if someone tries to fall back to /login with this account.
            password_hash=hash_password(uuid.uuid4().hex + uuid.uuid4().hex),
            role=claims.get("custom:role", "viewer"),
            is_active=True,
        )
        session.add(user)
        await session.flush()
        await record_audit(
            session,
            actor_id=user.id,
            action="user.create",
            resource_type="user",
            resource_id=user.id,
            metadata={"email": cognito_email, "role": user.role, "source": "cognito"},
        )
    else:
        # Update existing user with Cognito info
        user.display_name = claims.get("name", "") or user.display_name
        user.role = claims.get("custom:role", user.role)
        user.is_active = True

    return user


def issue_tokens(user: User) -> dict:
    access = create_access_token(
        user.id, user.role, settings.jwt_secret, settings.jwt_access_ttl_min
    )
    refresh = create_refresh_token(user.id, settings.jwt_secret, settings.jwt_refresh_ttl_days)
    return {
        "access_token": access,
        "refresh_token": refresh,
        "token_type": "bearer",
        "expires_in": settings.jwt_access_ttl_min * 60,
    }


async def refresh_access_token(session: AsyncSession, refresh_token: str) -> dict:
    payload = decode_token(refresh_token, settings.jwt_secret)
    if payload is None or payload.get("type") != "refresh":
        raise UnauthorizedError("Invalid refresh token")
    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError):
        raise UnauthorizedError("Invalid refresh token")
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise UnauthorizedError("Invalid refresh token")
    return issue_tokens(user)


async def create_user(
    session: AsyncSession,
    *,
    email: str,
    display_name: str,
    password: str,
    role: str,
    actor_id: uuid.UUID | None = None,
) -> User:
    email = email.strip().lower()
    if not email or "@" not in email:
        raise ValidationError("A valid email address is required")
    if len(password) < 8:
        raise ValidationError("Password must be at least 8 characters")
    if role not in {"admin", "analyst", "viewer"}:
        raise ValidationError(f"Unknown role: {role}")
    if await get_user_by_email(session, email) is not None:
        raise ValidationError("A user with that email already exists")

    user = User(
        id=uuid.uuid4(),
        email=email,
        display_name=display_name.strip() or email,
        password_hash=hash_password(password),
        role=role,
        is_active=True,
    )
    session.add(user)
    await session.flush()
    await record_audit(
        session,
        actor_id=actor_id,
        action="user.create",
        resource_type="user",
        resource_id=user.id,
        metadata={"email": email, "role": role},
    )
    return user

"""Cognito authentication adapter.

Wraps the AWS Cognito Identity Provider (IdP) client to support
user-pool-based authentication alongside the existing local JWT auth.
"""

import uuid
from typing import Optional

import boto3
from botocore.config import Config

from app.core.config import settings


def cognito_client():
    """Create a boto3 Cognito IdP client from validated settings."""
    session = boto3.Session(
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
        aws_session_token=settings.aws_session_token,
        region_name=settings.cognito_region or settings.aws_region,
    )
    return session.client(
        "cognito-idp",
        config=Config(
            retries={"max_attempts": 6, "mode": "adaptive"},
            connect_timeout=10,
            read_timeout=60,
        ),
    )


async def cognito_sign_in(email: str, password: str) -> Optional[dict]:
    """Authenticate against Cognito and return the IdP response.

    Returns the raw `cognito-idp.admin_initiate_auth` response dict on
    success, or None if Cognito is not configured.
    """
    if not (settings.cognito_user_pool_id and settings.cognito_app_client_id):
        return None

    client = cognito_client()
    try:
        response = client.admin_initiate_auth(
            UserPoolId=settings.cognito_user_pool_id,
            ClientId=settings.cognito_app_client_id,
            AuthFlow="USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": email, "PASSWORD": password},
        )
        return response
    except Exception:
        return None


async def cognito_get_user(sub: str) -> Optional[dict]:
    """Look up a Cognito user by their sub (UUID) claim."""
    if not settings.cognito_user_pool_id:
        return None
    client = cognito_client()
    try:
        response = client.admin_list_users(
            UserPoolId=settings.cognito_user_pool_id,
            Filter=f'sub = "{sub}"',
        )
        users = response.get("Users", [])
        return users[0] if users else None
    except Exception:
        return None


async def cognito_get_user_by_email(email: str) -> Optional[dict]:
    """Look up a Cognito user by email."""
    if not settings.cognito_user_pool_id:
        return None
    client = cognito_client()
    try:
        response = client.admin_list_users(
            UserPoolId=settings.cognito_user_pool_id,
            Filter=f'email = "{email}"',
        )
        users = response.get("Users", [])
        return users[0] if users else None
    except Exception:
        return None


def cognito_user_attributes(user: dict) -> dict[str, str]:
    """Extract a flat attribute map from a Cognito user record."""
    attrs: dict[str, str] = {}
    for attr in user.get("Attributes", []):
        name = attr.get("Name", "")
        value = attr.get("Value", "")
        if name and value:
            attrs[name] = value
    return attrs


def cognito_user_id(user: dict) -> str:
    """Return the user's sub (UUID) from a Cognito user record."""
    attrs = cognito_user_attributes(user)
    return attrs.get("sub", "") or user.get("Username", "")


def cognito_user_email(user: dict) -> str:
    """Return the user's email from a Cognito user record."""
    attrs = cognito_user_attributes(user)
    return attrs.get("email", "") or user.get("Username", "")


def cognito_user_display_name(user: dict) -> str:
    """Return the user's display name from a Cognito user record."""
    attrs = cognito_user_attributes(user)
    return attrs.get("name", "") or attrs.get("email", "") or user.get("Username", "")


def cognito_user_role(user: dict) -> str:
    """Return the user's role from a Cognito user record.

    Falls back to "viewer" if no role is set.
    """
    attrs = cognito_user_attributes(user)
    return attrs.get("custom:role", "viewer")


def cognito_user_is_active(user: dict) -> bool:
    """Return whether the Cognito user is active."""
    return user.get("Enabled", True)
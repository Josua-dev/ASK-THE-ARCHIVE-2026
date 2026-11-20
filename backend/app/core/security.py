"""Authentication primitives: argon2id hashing + HS256 JWT + signed links.

The platform runs on its own infrastructure, so there is no external identity
provider to federate with. Sessions are self-issued HS256 JWTs; the password
hash is argon2id.

Signed links are a second, deliberately narrow credential: a short-lived,
HMAC-protected token that authorises exactly one document download or page
preview. It carries no session authority, so it can safely appear in a URL.
"""

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
import uuid

import jwt
from argon2 import PasswordHasher

ph = PasswordHasher()


def hash_password(password: str) -> str:
    return ph.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        ph.verify(password_hash, password)
        return True
    except Exception:
        return False


def create_access_token(
    user_id: uuid.UUID,
    role: str,
    secret: str,
    ttl_min: int,
) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "role": role,
        "type": "access",
        "iat": now,
        "exp": now + timedelta(minutes=ttl_min),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def create_refresh_token(user_id: uuid.UUID, secret: str, ttl_days: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "type": "refresh",
        "jti": uuid.uuid4().hex,
        "iat": now,
        "exp": now + timedelta(days=ttl_days),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def decode_token(token: str, secret: str) -> Optional[dict]:
    try:
        return jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


def new_refresh_jti() -> str:
    return uuid.uuid4().hex


# ── Signed links ──────────────────────────────────────────────────────────
# A signed link is `<selector>.<expires_at>.<signature>`:
#   selector  — random nonce identifying the grant
#   expires_at — unix seconds
#   signature — HMAC-SHA256 over "selector.expires_at.scope"
#
# The signature binds the link to a scope ("download:<document_id>" or
# "preview:<document_id>:<page>") so a link minted for a download cannot be
# replayed against a different document or a preview endpoint.

_LINK_SEP = "."


def _sign(selector: str, expires_at: int, scope: str, secret: str) -> str:
    message = f"{selector}.{expires_at}.{scope}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def create_signed_link(scope: str, secret: str, ttl_sec: int) -> str:
    """Mint a signed link for `scope`, valid for `ttl_sec` seconds."""
    selector = secrets.token_urlsafe(12)
    expires_at = int(datetime.now(timezone.utc).timestamp()) + int(ttl_sec)
    signature = _sign(selector, expires_at, scope, secret)
    return f"{selector}{_LINK_SEP}{expires_at}{_LINK_SEP}{signature}"


def verify_signed_link(token: str, scope: str, secret: str) -> bool:
    """Return True when `token` is a valid, unexpired link for `scope`."""
    try:
        selector, expires_at_raw, signature = token.split(_LINK_SEP)
        expires_at = int(expires_at_raw)
    except (ValueError, AttributeError):
        return False

    if expires_at < int(datetime.now(timezone.utc).timestamp()):
        return False

    expected = _sign(selector, expires_at, scope, secret)
    # Constant-time compare: a timing leak here would let an attacker
    # recover a valid signature byte by byte.
    return hmac.compare_digest(expected, signature)

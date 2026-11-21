"""Conversation sharing.

A conversation can be handed to another person with an explicit permission:
"read" lets them follow the thread, "contribute" lets them ask questions in it
as well.

The access rules live here rather than in the chat router because several
features need the same answer — the chat list, the message history and the
research module all have to decide whether a given user may see a given
conversation, and they must all decide it the same way.
"""

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.conversation import Conversation
from app.db.models.conversation_share import ConversationShare
from app.db.models.user import User

# Access levels, from most to least privileged.
ACCESS_OWNER = "owner"
ACCESS_CONTRIBUTE = "contribute"
ACCESS_READ = "read"
ACCESS_NONE = ""

# Permissions that may be stored on a share.
SHARE_PERMISSIONS = ("read", "contribute")


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def resolve_conversation_access(
    session: AsyncSession, user: User, conversation_id: uuid.UUID
) -> tuple[Optional[Conversation], str]:
    """Resolve what `user` may do with `conversation_id`.

    Returns the conversation and one of "owner", "contribute", "read" or "".
    An empty string means the conversation does not exist for this user — the
    caller must not disclose whether it exists at all.
    """
    conversation = await session.get(Conversation, conversation_id)
    if conversation is None:
        return None, ACCESS_NONE

    if conversation.user_id == user.id:
        return conversation, ACCESS_OWNER

    share = await session.scalar(
        select(ConversationShare).where(
            ConversationShare.conversation_id == conversation_id,
            ConversationShare.shared_with_user_id == user.id,
        )
    )
    if share is None:
        return None, ACCESS_NONE

    return conversation, share.permission


def can_contribute(access: str) -> bool:
    """Owners and 'contribute' recipients may add to a conversation."""
    return access in (ACCESS_OWNER, ACCESS_CONTRIBUTE)


async def list_shared_conversations(
    session: AsyncSession, user: User, *, limit: int = 100
) -> list[tuple[Conversation, str]]:
    """Conversations shared with the user, with their access level."""
    stmt = (
        select(Conversation, ConversationShare.permission)
        .join(
            ConversationShare,
            ConversationShare.conversation_id == Conversation.id,
        )
        .where(ConversationShare.shared_with_user_id == user.id)
        .order_by(ConversationShare.created_at.desc())
        .limit(limit)
    )
    rows = (await session.execute(stmt)).all()
    return [(row[0], row[1]) for row in rows]


async def list_shares(
    session: AsyncSession, conversation_id: uuid.UUID
) -> list[ConversationShare]:
    stmt = (
        select(ConversationShare)
        .where(ConversationShare.conversation_id == conversation_id)
        .order_by(ConversationShare.created_at)
    )
    return list((await session.execute(stmt)).scalars().all())


async def share_conversation(
    session: AsyncSession,
    owner: User,
    conversation: Conversation,
    recipient: User,
    permission: str,
) -> ConversationShare:
    """Create or update a share.

    The recipient must be a different, active user.
    """
    if permission not in SHARE_PERMISSIONS:
        raise ValueError("Permission must be 'read' or 'contribute'")
    if recipient.id == owner.id:
        raise ValueError("A conversation cannot be shared with its owner")
    if not recipient.is_active:
        raise ValueError("That account is not active")

    existing = await session.scalar(
        select(ConversationShare).where(
            ConversationShare.conversation_id == conversation.id,
            ConversationShare.shared_with_user_id == recipient.id,
        )
    )
    if existing is not None:
        existing.permission = permission
        existing.created_by = owner.id
        existing.created_at = _now()
        await session.flush()
        return existing

    share = ConversationShare(
        id=uuid.uuid4(),
        conversation_id=conversation.id,
        shared_with_user_id=recipient.id,
        permission=permission,
        created_by=owner.id,
        created_at=_now(),
    )
    session.add(share)
    await session.flush()
    return share


async def revoke_share(
    session: AsyncSession, conversation_id: uuid.UUID, recipient_id: uuid.UUID
) -> bool:
    """Remove a share. Returns True when a share was actually removed."""
    share = await session.scalar(
        select(ConversationShare).where(
            ConversationShare.conversation_id == conversation_id,
            ConversationShare.shared_with_user_id == recipient_id,
        )
    )
    if share is None:
        return False
    await session.delete(share)
    await session.flush()
    return True


async def count_shares(session: AsyncSession, conversation_id: uuid.UUID) -> int:
    return int(
        await session.scalar(
            select(func.count())
            .select_from(ConversationShare)
            .where(ConversationShare.conversation_id == conversation_id)
        )
        or 0
    )

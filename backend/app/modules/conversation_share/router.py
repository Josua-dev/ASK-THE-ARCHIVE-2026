"""Routes for sharing a conversation with another user."""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.core.errors import ForbiddenError, NotFoundError, ValidationError
from app.db.models.conversation import Conversation
from app.db.models.user import User
from app.db.session import get_db_session
from app.modules.conversation_share.schemas import (
    ConversationAccessOut,
    ShareCreate,
    ShareListOut,
    ShareOut,
)
from app.modules.conversation_share.service import (
    ACCESS_OWNER,
    list_shares,
    resolve_conversation_access,
    revoke_share,
    share_conversation,
)
from app.shared.audit import record_audit

router = APIRouter(prefix="/api/v1/conversations", tags=["conversation-sharing"])


async def _owned_conversation(
    session: AsyncSession, user: User, conversation_id: uuid.UUID
) -> Conversation:
    """The conversation, but only if the caller owns it.

    Sharing is a right of the owner: a recipient may read a conversation they
    were given, but may not re-share it.
    """
    conversation = await session.get(Conversation, conversation_id)
    if conversation is None:
        raise NotFoundError("Conversation not found")
    if conversation.user_id != user.id:
        raise ForbiddenError("Only the conversation owner can manage sharing")
    return conversation


@router.get("/shared-with-me")
async def conversations_shared_with_me(
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Conversations other people have shared with the caller."""
    from app.modules.conversation_share.service import list_shared_conversations

    rows = await list_shared_conversations(session, user)
    return [
        {
            "id": str(conversation.id),
            "title": conversation.title,
            "created_at": conversation.created_at.isoformat()
            if conversation.created_at
            else None,
            "access": access,
        }
        for conversation, access in rows
    ]


@router.get("/users")
async def shareable_users(
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Active users the caller may share a conversation with."""
    stmt = (
        select(User)
        .where(User.is_active.is_(True), User.id != user.id)
        .order_by(User.display_name)
        .limit(200)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [
        {
            "id": str(row.id),
            "email": row.email,
            "display_name": row.display_name,
            "role": row.role,
        }
        for row in rows
    ]


@router.get("/{conversation_id}/shares", response_model=ShareListOut)
async def list_conversation_shares(
    conversation_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Who this conversation is shared with."""
    await _owned_conversation(session, user, conversation_id)

    shares = await list_shares(session, conversation_id)
    items: list[ShareOut] = []
    for share in shares:
        recipient = await session.get(User, share.shared_with_user_id)
        items.append(
            ShareOut(
                id=share.id,
                conversation_id=share.conversation_id,
                shared_with_user_id=share.shared_with_user_id,
                shared_with_email=recipient.email if recipient else None,
                shared_with_name=recipient.display_name if recipient else None,
                permission=share.permission,
                created_by=share.created_by,
                created_at=share.created_at.isoformat() if share.created_at else None,
            )
        )
    return ShareListOut(items=items, total=len(items))


@router.post("/{conversation_id}/shares", response_model=ShareOut)
async def create_conversation_share(
    conversation_id: uuid.UUID,
    payload: ShareCreate,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Share a conversation with another user."""
    await _owned_conversation(session, user, conversation_id)

    recipient = await session.get(User, payload.shared_with_user_id)
    if recipient is None:
        raise NotFoundError("No user with that id")

    try:
        share = await share_conversation(
            session, user, conversation, recipient, payload.permission
        )
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc

    await record_audit(
        session,
        actor_id=user.id,
        action="conversation.share",
        resource_type="conversation",
        resource_id=conversation_id,
        metadata={
            "shared_with_user_id": str(recipient.id),
            "permission": share.permission,
        },
    )
    await session.commit()

    return ShareOut(
        id=share.id,
        conversation_id=share.conversation_id,
        shared_with_user_id=share.shared_with_user_id,
        shared_with_email=recipient.email,
        shared_with_name=recipient.display_name,
        permission=share.permission,
        created_by=share.created_by,
        created_at=share.created_at.isoformat() if share.created_at else None,
    )


@router.delete("/{conversation_id}/shares/{user_id}", status_code=204)
async def delete_conversation_share(
    conversation_id: uuid.UUID,
    user_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Stop sharing a conversation with a user."""
    await _owned_conversation(session, user, conversation_id)

    removed = await revoke_share(session, conversation_id, user_id)
    if not removed:
        raise NotFoundError("That conversation was not shared with that user")

    await record_audit(
        session,
        actor_id=user.id,
        action="conversation.unshare",
        resource_type="conversation",
        resource_id=conversation_id,
        metadata={"shared_with_user_id": str(user_id)},
    )
    await session.commit()
    return None


@router.get("/{conversation_id}/access", response_model=ConversationAccessOut)
async def conversation_access(
    conversation_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """What the caller may do with this conversation."""
    conversation, access = await resolve_conversation_access(
        session, user, conversation_id
    )
    if conversation is None:
        raise NotFoundError("Conversation not found")

    return ConversationAccessOut(
        conversation_id=conversation.id,
        access=access or ACCESS_OWNER,
        can_read=True,
        can_contribute=access in (ACCESS_OWNER, "contribute"),
    )

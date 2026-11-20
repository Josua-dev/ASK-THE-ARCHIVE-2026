"""Sharing a conversation with another user, with an explicit permission."""

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Column, ForeignKey, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.db.types import tstz, utcnow

if TYPE_CHECKING:
    from app.db.models.conversation import Conversation
    from app.db.models.user import User


class ConversationShare(Base):
    """A conversation shared with one other user.

    `permission` is one of: read, contribute.
    "read" lets the recipient read the conversation but not add to it.
    "contribute" lets the recipient also ask questions in it.
    """

    __tablename__ = "conversation_shares"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    shared_with_user_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    permission = Column(Text, nullable=False, default="read")
    created_by = Column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at = Column(tstz(), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint(
            "conversation_id", "shared_with_user_id", name="uq_conversation_shares_conv_user"
        ),
    )

    conversation = relationship("Conversation", lazy="joined")
    shared_with_user = relationship("User", foreign_keys=[shared_with_user_id], lazy="joined")

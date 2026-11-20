"""A Research Mode report — the eight-section structured answer."""

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Column, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.db.types import tstz, utcnow

if TYPE_CHECKING:
    from app.db.models.conversation import Conversation
    from app.db.models.message import Message
    from app.db.models.user import User


class ResearchReport(Base):
    """A persisted Research Mode report.

    `sections` is an ordered list of exactly the eight report sections:
      [{"key": str, "title": str, "body": str, "citations": [int]}]
    where the keys are, in order: executive_summary, key_findings,
    supporting_evidence, relevant_documents, conflicting_information,
    missing_information, important_observations, source_citations.

    `citations` is a flat list of the citation objects used across the report:
      {"index": int, "document_id": str, "filename": str, "page": int|null,
       "excerpt": str}
    """

    __tablename__ = "research_reports"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    message_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
    )
    question = Column(Text, nullable=False)
    sections = Column(JSONB, nullable=False, default=list)
    citations = Column(JSONB, nullable=False, default=list)
    model = Column(Text, nullable=True)
    tokens_used = Column(Integer, nullable=True)
    created_by = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_at = Column(tstz(), nullable=False, default=utcnow)

    conversation = relationship("Conversation", lazy="joined")

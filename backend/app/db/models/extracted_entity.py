"""Entities extracted from documents, and the mentions that anchor them."""

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Column, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.db.types import tstz, utcnow

if TYPE_CHECKING:
    from app.db.models.chunk import DocumentChunk
    from app.db.models.document import Document


class ExtractedEntity(Base):
    """A canonical entity seen somewhere in the archive.

    `kind` is one of: person, organisation, contract_ref, department,
    project, date, money, policy. Free-text kinds are allowed so the taxonomy
    can grow without a migration, but the listed values are the ones the
    product relies on.
    """

    __tablename__ = "extracted_entities"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    kind = Column(Text, nullable=False, index=True)
    # The name as it appears in the source text.
    name = Column(Text, nullable=False)
    # Case-folded name used to match the same entity across documents.
    normalized_name = Column(Text, nullable=False, index=True)
    # Extra typed attributes, e.g. {"role": "signatory"} or {"currency": "GBP"}.
    attributes = Column(JSONB, nullable=False, default=dict)
    mention_count = Column(Integer, nullable=False, default=0)
    first_seen_at = Column(tstz(), nullable=True)
    last_seen_at = Column(tstz(), nullable=True)
    created_at = Column(tstz(), nullable=False, default=utcnow)

    mentions = relationship(
        "EntityMention",
        back_populates="entity",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class EntityMention(Base):
    """One occurrence of an entity, anchored to a chunk and a page range."""

    __tablename__ = "entity_mentions"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entity_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("extracted_entities.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    document_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # The chunk the mention was found in. Nullable because a mention can
    # survive a re-index that replaced the chunk rows.
    chunk_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("document_chunks.id", ondelete="SET NULL"),
        nullable=True,
    )
    page_start = Column(Integer, nullable=True)
    page_end = Column(Integer, nullable=True)
    # The exact text in which the entity appears.
    excerpt = Column(Text, nullable=False)
    created_at = Column(tstz(), nullable=False, default=utcnow)

    entity = relationship("ExtractedEntity", back_populates="mentions", lazy="joined")

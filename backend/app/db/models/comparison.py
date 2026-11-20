"""AI document comparison — a run comparing two documents, and its findings."""

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Column, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.db.types import tstz, utcnow

if TYPE_CHECKING:
    from app.db.models.document import Document
    from app.db.models.user import User


class DocumentComparison(Base):
    """One comparison between two documents.

    `status` is one of: queued, running, completed, failed.
    """

    __tablename__ = "document_comparisons"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_a_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    document_b_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status = Column(Text, nullable=False, default="queued", index=True)
    # One-paragraph narrative of what the comparison found.
    summary = Column(Text, nullable=True)
    model = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    created_by = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_at = Column(tstz(), nullable=False, default=utcnow)
    completed_at = Column(tstz(), nullable=True)

    findings = relationship(
        "ComparisonFinding",
        back_populates="comparison",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ComparisonFinding.sort_order",
    )
    document_a = relationship("Document", foreign_keys=[document_a_id], lazy="joined")
    document_b = relationship("Document", foreign_keys=[document_b_id], lazy="joined")


class ComparisonFinding(Base):
    """One difference between the two compared documents.

    `kind` is one of: added, removed, modified, changed_date, changed_value,
    different_obligation, inconsistency.
    `severity` is one of: info, low, medium, high.
    `citation_a` and `citation_b` are provenance objects, or null when that
    side has no counterpart:
      {"document_id": str, "filename": str, "page": int|null, "excerpt": str}
    """

    __tablename__ = "comparison_findings"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    comparison_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("document_comparisons.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind = Column(Text, nullable=False)
    category = Column(Text, nullable=True)
    title = Column(Text, nullable=False)
    detail = Column(Text, nullable=True)
    severity = Column(Text, nullable=True)
    citation_a = Column(JSONB, nullable=True)
    citation_b = Column(JSONB, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)

    comparison = relationship("DocumentComparison", back_populates="findings")

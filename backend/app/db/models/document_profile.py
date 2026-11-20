"""Structured intelligence profile for one document.

Every list column holds a list of JSON objects. The canonical shape of each
is documented here so the API can rely on it:

  parties             [{"name": str, "role": str, "page": int|null}]
  organisations       [{"name": str, "page": int|null}]
  individuals         [{"name": str, "role": str, "page": int|null}]
  important_dates     [{"label": str, "date": "YYYY-MM-DD", "page": int|null}]
  monetary_values     [{"label": str, "amount": float, "currency": str, "page": int|null}]
  contract_references [{"reference": str, "page": int|null}]
  important_clauses   [{"title": str, "text": str, "page": int|null}]
  obligations         [{"text": str, "party": str|null, "due": str|null, "page": int|null}]
  keywords            [str]
  related_documents   [{"document_id": str, "reason": str}]
  source_refs         [{"field": str, "page": int|null, "excerpt": str}]
"""

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Column, Float, ForeignKey, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.db.types import tstz, utcnow

if TYPE_CHECKING:
    from app.db.models.document import Document


class DocumentProfile(Base):
    __tablename__ = "document_profiles"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    # The document type as determined by the profile pass.
    doc_type = Column(Text, nullable=True)
    parties = Column(JSONB, nullable=False, default=list)
    organisations = Column(JSONB, nullable=False, default=list)
    individuals = Column(JSONB, nullable=False, default=list)
    important_dates = Column(JSONB, nullable=False, default=list)
    monetary_values = Column(JSONB, nullable=False, default=list)
    # The single dominant currency of the document, when there is one.
    currency = Column(Text, nullable=True)
    contract_references = Column(JSONB, nullable=False, default=list)
    important_clauses = Column(JSONB, nullable=False, default=list)
    obligations = Column(JSONB, nullable=False, default=list)
    keywords = Column(JSONB, nullable=False, default=list)
    related_documents = Column(JSONB, nullable=False, default=list)
    # Page-level provenance for each extracted field, so every profile value
    # can be traced back to the page it came from.
    source_refs = Column(JSONB, nullable=False, default=list)
    # Overall extraction confidence, 0.0-1.0.
    confidence = Column(Float, nullable=True)
    # Which model produced the profile.
    model = Column(Text, nullable=True)
    created_at = Column(tstz(), nullable=False, default=utcnow)
    updated_at = Column(tstz(), nullable=False, default=utcnow, onupdate=utcnow)

    document = relationship("Document", lazy="joined")

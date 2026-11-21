"""Physical checkout history for a document.

A document can be taken out of the archive and returned later. Every checkout
is a row here; ``checked_in_at`` is NULL while the document is out. A partial
unique index guarantees a document has at most one open checkout at a time.
"""

import uuid

from sqlalchemy import Column, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.db.types import utcnow


class DocumentCheckout(Base):
    __tablename__ = "document_checkouts"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    checked_out_by = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    checked_out_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    due_at = Column(DateTime(timezone=True), nullable=False)
    # NULL while the document is still out; set when it is returned.
    checked_in_at = Column(DateTime(timezone=True), nullable=True)
    checked_in_by = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    document = relationship("Document", back_populates="checkouts")
    checkout_user = relationship("User", foreign_keys=[checked_out_by])
    checkin_user = relationship("User", foreign_keys=[checked_in_by])

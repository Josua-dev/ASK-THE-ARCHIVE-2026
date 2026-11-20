"""Version history for a document — every stored revision of an original."""

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, Column, ForeignKey, Integer, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.db.types import tstz, utcnow

if TYPE_CHECKING:
    from app.db.models.document import Document
    from app.db.models.user import User


class DocumentVersion(Base):
    __tablename__ = "document_versions"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Monotonic per-document revision number, starting at 1.
    version_no = Column(Integer, nullable=False)
    # Where the bytes for THIS revision live (a local filesystem storage key).
    storage_key = Column(Text, nullable=False)
    filename = Column(Text, nullable=False)
    byte_size = Column(BigInteger, nullable=False)
    checksum_sha256 = Column(Text, nullable=False)
    # Human note describing what changed in this revision.
    note = Column(Text, nullable=True)
    created_by = Column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at = Column(tstz(), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("document_id", "version_no", name="uq_document_versions_no"),
    )

    document = relationship("Document", lazy="joined")
    created_by_user = relationship("User", lazy="joined")

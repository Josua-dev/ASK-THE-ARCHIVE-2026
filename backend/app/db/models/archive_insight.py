"""Automated archive insights — detected issues awaiting review.

An insight is an observation about the archive, never a verified fact. It
carries its own evidence so the UI can show what it is based on, and the
reader decides whether to trust it.

`kind` is one of: expiring_soon, missing_metadata, potential_duplicate,
conflicting_date, inconsistent_value, missing_contract_info, obligation_due,
needs_review.
`severity` is one of: info, low, medium, high.
`status` is one of: open, acknowledged, resolved, dismissed.
"""

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Column, ForeignKey, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID as PG_UUID
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.db.types import tstz, utcnow

if TYPE_CHECKING:
    from app.db.models.user import User


class ArchiveInsight(Base):
    __tablename__ = "archive_insights"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    kind = Column(Text, nullable=False, index=True)
    severity = Column(Text, nullable=False, default="info", index=True)
    title = Column(Text, nullable=False)
    detail = Column(Text, nullable=True)
    # The documents this insight concerns.
    document_ids = Column(ARRAY(PG_UUID(as_uuid=True)), nullable=False, default=list)
    # Supporting evidence, e.g.
    # [{"document_id": str, "filename": str, "page": int|null, "excerpt": str}]
    evidence = Column(JSONB, nullable=False, default=list)
    status = Column(Text, nullable=False, default="open", index=True)
    detected_at = Column(tstz(), nullable=False, default=utcnow, index=True)
    acknowledged_by = Column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    acknowledged_at = Column(tstz(), nullable=True)

    acknowledged_by_user = relationship("User", lazy="joined")

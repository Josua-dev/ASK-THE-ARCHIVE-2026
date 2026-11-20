"""A user's own search history, used for recent searches and suggestions."""

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Column, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.db.types import tstz, utcnow

if TYPE_CHECKING:
    from app.db.models.user import User


class SearchHistory(Base):
    """One executed search.

    `mode` is one of: semantic, keyword, hybrid.
    `filters` records the structured filters that were applied, e.g.
      {"doc_type": "contract", "entity": "Northgate Supplies Ltd"}
    """

    __tablename__ = "search_history"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    query = Column(Text, nullable=False)
    mode = Column(Text, nullable=False, default="hybrid")
    result_count = Column(Integer, nullable=False, default=0)
    filters = Column(JSONB, nullable=False, default=dict)
    created_at = Column(tstz(), nullable=False, default=utcnow, index=True)

    user = relationship("User", lazy="joined")

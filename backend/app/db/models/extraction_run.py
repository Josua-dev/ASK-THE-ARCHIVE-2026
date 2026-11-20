"""Extraction Studio — a structured extraction run and the rows it produced."""

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


class ExtractionRun(Base):
    """One extraction request.

    `status` is one of: queued, running, completed, failed.
    `columns` is the chosen output schema, e.g.
      [{"key": "supplier", "label": "Supplier", "type": "text"},
       {"key": "value", "label": "Agreement value", "type": "number"}]
    """

    __tablename__ = "extraction_runs"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # The natural-language instruction, e.g. "Extract every supplier ...".
    instruction = Column(Text, nullable=False)
    # The refined question form the model actually answered.
    question = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="queued", index=True)
    columns = Column(JSONB, nullable=False, default=list)
    row_count = Column(Integer, nullable=False, default=0)
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

    rows = relationship(
        "ExtractionRow",
        back_populates="run",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ExtractionRow.row_index",
    )


class ExtractionRow(Base):
    """One extracted record.

    `data` maps the run's column keys to values:
      {"supplier": "Northgate Supplies Ltd", "value": 125000.0}
    `citations` is a list of provenance objects:
      {"column": str, "document_id": str, "filename": str, "page": int|null,
       "excerpt": str}
    """

    __tablename__ = "extraction_rows"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    run_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("extraction_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    row_index = Column(Integer, nullable=False)
    data = Column(JSONB, nullable=False, default=dict)
    document_id = Column(
        PG_UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="SET NULL"),
        nullable=True,
    )
    citations = Column(JSONB, nullable=False, default=list)
    created_at = Column(tstz(), nullable=False, default=utcnow)

    run = relationship("ExtractionRun", back_populates="rows")

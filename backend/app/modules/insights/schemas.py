"""Request and response models for Archive Insights."""

import uuid
from typing import Optional

from pydantic import BaseModel, Field


class InsightEvidence(BaseModel):
    document_id: str
    filename: Optional[str] = None
    page: Optional[int] = None
    excerpt: Optional[str] = None


class ArchiveInsightOut(BaseModel):
    id: Optional[uuid.UUID] = None
    kind: str
    severity: str = "info"
    title: str
    detail: Optional[str] = None
    document_ids: list[str] = Field(default_factory=list)
    evidence: list[InsightEvidence] = Field(default_factory=list)
    status: str = "open"
    detected_at: Optional[str] = None
    acknowledged_by: Optional[uuid.UUID] = None
    acknowledged_at: Optional[str] = None


class InsightListOut(BaseModel):
    items: list[ArchiveInsightOut] = Field(default_factory=list)
    total: int = 0
    counts: dict[str, int] = Field(default_factory=dict)


class InsightStatusUpdate(BaseModel):
    status: str = Field(pattern="^(open|acknowledged|resolved|dismissed)$")

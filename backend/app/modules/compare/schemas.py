"""Request and response models for document comparison."""

import uuid
from typing import Optional

from pydantic import BaseModel, Field


class ComparisonCitation(BaseModel):
    document_id: str
    filename: str
    page: Optional[int] = None
    excerpt: Optional[str] = None


class ComparisonFindingOut(BaseModel):
    id: uuid.UUID
    kind: str
    category: Optional[str] = None
    title: str
    detail: Optional[str] = None
    severity: Optional[str] = None
    citation_a: Optional[ComparisonCitation] = None
    citation_b: Optional[ComparisonCitation] = None
    sort_order: int = 0


class DocumentComparisonOut(BaseModel):
    id: uuid.UUID
    document_a_id: uuid.UUID
    document_b_id: uuid.UUID
    filename_a: Optional[str] = None
    filename_b: Optional[str] = None
    status: str
    summary: Optional[str] = None
    model: Optional[str] = None
    error: Optional[str] = None
    created_by: Optional[uuid.UUID] = None
    created_at: Optional[str] = None
    completed_at: Optional[str] = None
    findings: list[ComparisonFindingOut] = Field(default_factory=list)


class ComparisonListItem(BaseModel):
    id: uuid.UUID
    document_a_id: uuid.UUID
    document_b_id: uuid.UUID
    filename_a: Optional[str] = None
    filename_b: Optional[str] = None
    status: str
    summary: Optional[str] = None
    created_at: Optional[str] = None
    finding_count: int = 0


class ComparisonListOut(BaseModel):
    items: list[ComparisonListItem]
    total: int


class CompareRequest(BaseModel):
    document_a_id: uuid.UUID
    document_b_id: uuid.UUID
    instruction: Optional[str] = None

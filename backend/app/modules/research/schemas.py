"""Request and response models for Research Mode reports."""

import uuid
from typing import Optional

from pydantic import BaseModel, Field


class ResearchCitation(BaseModel):
    index: int
    document_id: str
    filename: str
    page_start: int
    page_end: int
    excerpt: str


class ResearchSection(BaseModel):
    key: str
    title: str
    body: str
    citations: list[int] = Field(default_factory=list)


class ResearchReportOut(BaseModel):
    id: uuid.UUID
    conversation_id: Optional[uuid.UUID] = None
    message_id: Optional[uuid.UUID] = None
    question: str
    sections: list[ResearchSection] = Field(default_factory=list)
    citations: list[ResearchCitation] = Field(default_factory=list)
    model: Optional[str] = None
    tokens_used: Optional[int] = None
    created_by: Optional[uuid.UUID] = None
    created_at: Optional[str] = None


class ResearchReportSummary(BaseModel):
    id: uuid.UUID
    question: str
    model: Optional[str] = None
    created_at: Optional[str] = None
    citation_count: int = 0


class ResearchListOut(BaseModel):
    items: list[ResearchReportSummary]
    total: int


class ResearchRequest(BaseModel):
    question: str
    conversation_id: Optional[uuid.UUID] = None
    instruction: Optional[str] = None

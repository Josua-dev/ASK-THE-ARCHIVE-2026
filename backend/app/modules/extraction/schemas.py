"""Request and response models for the Extraction Studio."""

import uuid
from typing import Optional

from pydantic import BaseModel, Field


class ExtractionColumn(BaseModel):
    key: str
    label: str
    type: str = "text"


class ExtractionCreate(BaseModel):
    instruction: str
    document_ids: list[uuid.UUID] = Field(default_factory=list)
    columns: list[ExtractionColumn] = Field(default_factory=list)
    max_rows: int = Field(default=200, ge=1, le=2000)


class ExtractionCitation(BaseModel):
    column: str
    document_id: str
    filename: str
    page: Optional[int] = None
    excerpt: str


class ExtractionRowOut(BaseModel):
    id: uuid.UUID
    row_index: int
    data: dict = Field(default_factory=dict)
    document_id: Optional[str] = None
    citations: list[ExtractionCitation] = Field(default_factory=list)


class ExtractionRunOut(BaseModel):
    id: uuid.UUID
    instruction: str
    question: Optional[str] = None
    status: str
    columns: list[ExtractionColumn] = Field(default_factory=list)
    row_count: int = 0
    model: Optional[str] = None
    error: Optional[str] = None
    created_by: Optional[uuid.UUID] = None
    created_at: Optional[str] = None
    completed_at: Optional[str] = None
    rows: list[ExtractionRowOut] = Field(default_factory=list)


class ExtractionListItem(BaseModel):
    id: uuid.UUID
    instruction: str
    status: str
    row_count: int
    model: Optional[str] = None
    created_at: Optional[str] = None


class ExtractionListOut(BaseModel):
    items: list[ExtractionListItem]
    total: int

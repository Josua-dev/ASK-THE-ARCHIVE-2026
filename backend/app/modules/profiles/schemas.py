"""Request and response models for document intelligence profiles."""

import uuid
from typing import Any, Optional

from pydantic import BaseModel, Field


class ProfileEntry(BaseModel):
    """A single extracted fact.

    `page` is the page the fact was read from, or None when the model could
    not attribute it to a page.
    """

    name: Optional[str] = None
    role: Optional[str] = None
    label: Optional[str] = None
    date: Optional[str] = None
    amount: Optional[float] = None
    currency: Optional[str] = None
    reference: Optional[str] = None
    title: Optional[str] = None
    text: Optional[str] = None
    party: Optional[str] = None
    due: Optional[str] = None
    reason: Optional[str] = None
    field: Optional[str] = None
    excerpt: Optional[str] = None
    page: Optional[int] = None


class ProfileSourceRef(BaseModel):
    field: str
    page: Optional[int] = None
    excerpt: Optional[str] = None


class ProfileRelatedDocument(BaseModel):
    document_id: str
    reason: Optional[str] = None


class DocumentProfileOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    filename: Optional[str] = None
    doc_type: Optional[str] = None
    parties: list[ProfileEntry] = Field(default_factory=list)
    organisations: list[ProfileEntry] = Field(default_factory=list)
    individuals: list[ProfileEntry] = Field(default_factory=list)
    important_dates: list[ProfileEntry] = Field(default_factory=list)
    monetary_values: list[ProfileEntry] = Field(default_factory=list)
    currency: Optional[str] = None
    contract_references: list[ProfileEntry] = Field(default_factory=list)
    important_clauses: list[ProfileEntry] = Field(default_factory=list)
    obligations: list[ProfileEntry] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    related_documents: list[ProfileRelatedDocument] = Field(default_factory=list)
    source_refs: list[ProfileSourceRef] = Field(default_factory=list)
    confidence: Optional[float] = None
    model: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class ProfileGenerateRequest(BaseModel):
    """Body for regenerating a profile.

    `instruction` lets an analyst narrow the extraction; it is passed to the
    model as the question and never overrides the system prompt.
    """

    instruction: Optional[str] = None


class ProfileGenerateOut(BaseModel):
    profile: DocumentProfileOut
    generated: bool
    message: str
    entities_recorded: int = 0
    detail: dict[str, Any] = Field(default_factory=dict)

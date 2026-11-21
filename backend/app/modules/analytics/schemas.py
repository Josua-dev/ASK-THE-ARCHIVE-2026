"""Request and response models for Analytics."""

from typing import Optional

from pydantic import BaseModel, Field


class BreakdownItem(BaseModel):
    key: str
    label: str
    count: int


class TimePoint(BaseModel):
    period: str
    documents: int = 0
    questions: int = 0


class TopDocument(BaseModel):
    document_id: str
    filename: Optional[str] = None
    citations: int = 0
    mentions: int = 0


class OverviewOut(BaseModel):
    documents_total: int = 0
    documents_indexed: int = 0
    documents_pending: int = 0
    documents_failed: int = 0
    storage_bytes: int = 0
    page_count: int = 0
    chunk_count: int = 0
    entity_count: int = 0
    entity_mention_count: int = 0
    profile_count: int = 0
    average_profile_confidence: Optional[float] = None
    conversations: int = 0
    questions_asked: int = 0
    answers_found: int = 0
    abstentions: int = 0
    abstention_rate: float = 0.0
    citation_count: int = 0
    searches: int = 0
    comparisons: int = 0
    research_reports: int = 0
    extraction_runs: int = 0
    extraction_rows: int = 0
    graph_nodes: int = 0
    graph_edges: int = 0
    generated_at: Optional[str] = None


class AnalyticsOut(BaseModel):
    overview: OverviewOut
    documents_by_type: list[BreakdownItem] = Field(default_factory=list)
    documents_by_status: list[BreakdownItem] = Field(default_factory=list)
    timeline: list[TimePoint] = Field(default_factory=list)
    top_cited: list[TopDocument] = Field(default_factory=list)
    top_entities: list[BreakdownItem] = Field(default_factory=list)

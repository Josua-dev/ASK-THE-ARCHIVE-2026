"""Request and response models for the Knowledge Graph."""

from typing import Optional

from pydantic import BaseModel, Field


class GraphNode(BaseModel):
    id: str
    kind: str
    label: str
    document_count: int = 0
    mention_count: int = 0
    attributes: dict = Field(default_factory=dict)


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    kind: str
    weight: int = 1
    label: Optional[str] = None
    document_ids: list[str] = Field(default_factory=list)
    pages: list[dict] = Field(default_factory=list)


class GraphStats(BaseModel):
    document_count: int = 0
    entity_count: int = 0
    contract_reference_count: int = 0
    edge_count: int = 0
    sources: list[str] = Field(default_factory=list)


class GraphResponse(BaseModel):
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    stats: GraphStats = Field(default_factory=GraphStats)

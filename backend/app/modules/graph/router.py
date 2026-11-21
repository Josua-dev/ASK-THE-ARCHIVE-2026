"""Routes for the Knowledge Graph."""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.core.errors import NotFoundError
from app.db.session import get_db_session
from app.modules.graph.schemas import GraphResponse
from app.modules.graph.service import build_graph, entity_detail

router = APIRouter(prefix="/api/v1/graph", tags=["knowledge-graph"])


@router.get("", response_model=GraphResponse)
async def get_graph(
    doc_type: Optional[str] = Query(default=None),
    kind: Optional[str] = Query(default=None),
    min_weight: int = Query(default=1, ge=1, le=1000),
    max_nodes: int = Query(default=400, ge=10, le=2000),
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """The knowledge graph, scoped to what the caller may read.

    `doc_type` narrows the documents the graph is built from. `kind` narrows
    the edge kinds: mentions, co_occurs, references, cites.
    """
    graph = await build_graph(
        session,
        user,
        doc_types=[doc_type] if doc_type else None,
        kinds=[kind] if kind else None,
        min_weight=min_weight,
        max_nodes=max_nodes,
    )
    return GraphResponse(**graph)


@router.get("/entities/{entity_id}")
async def get_entity(
    entity_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """One entity with the passages that mention it."""
    detail = await entity_detail(session, user, entity_id)
    if detail is None:
        raise NotFoundError("Entity not found")
    return detail

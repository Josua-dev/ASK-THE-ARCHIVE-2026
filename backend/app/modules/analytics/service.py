"""Analytics.

Every figure this module reports is a count of rows that actually exist. If a
document has not been ingested, it is not in the totals; if nobody has asked
a question, the question count is zero rather than a plausible-looking
estimate. Where a figure cannot be computed honestly — for example the
average extraction confidence when no document has been profiled — it is
returned as null rather than as zero, so that "no data" and "a value of
zero" stay distinguishable.

The archive side of the report is scoped to the documents the caller may
read. The activity side — questions asked, searches run, reports produced —
is scoped to the caller themselves.
"""

import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.citation import Citation
from app.db.models.chunk import DocumentChunk
from app.db.models.comparison import DocumentComparison
from app.db.models.conversation import Conversation
from app.db.models.document import Document
from app.db.models.document_profile import DocumentProfile
from app.db.models.extracted_entity import EntityMention, ExtractedEntity
from app.db.models.extraction_run import ExtractionRow, ExtractionRun
from app.db.models.message import Message
from app.db.models.research_report import ResearchReport
from app.db.models.search_history import SearchHistory
from app.db.models.user import User
from app.modules.documents.permissions import permitted_document_ids
from app.modules.graph.service import build_graph

# How many months of history the timeline covers.
TIMELINE_MONTHS = 12


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _count(session: AsyncSession, stmt) -> int:
    return int(await session.scalar(stmt) or 0)


async def _breakdown(
    session: AsyncSession, stmt, label_for: Optional[dict] = None
) -> list[dict]:
    rows = (await session.execute(stmt)).all()
    out = []
    for row in rows:
        key = str(row[0]) if row[0] is not None else "unknown"
        label = (label_for or {}).get(key, key.replace("_", " ").title())
        out.append({"key": key, "label": label, "count": int(row[1] or 0)})
    return out


async def compute_analytics(
    session: AsyncSession, user: User
) -> dict:
    """Assemble the whole analytics report."""
    permitted = await permitted_document_ids(session, user)
    scope = list(permitted)

    overview: dict = {
        "documents_total": 0,
        "documents_indexed": 0,
        "documents_pending": 0,
        "documents_failed": 0,
        "storage_bytes": 0,
        "page_count": 0,
        "chunk_count": 0,
        "entity_count": 0,
        "entity_mention_count": 0,
        "profile_count": 0,
        "average_profile_confidence": None,
        "conversations": 0,
        "questions_asked": 0,
        "answers_found": 0,
        "abstentions": 0,
        "abstention_rate": 0.0,
        "citation_count": 0,
        "searches": 0,
        "comparisons": 0,
        "research_reports": 0,
        "extraction_runs": 0,
        "extraction_rows": 0,
        "graph_nodes": 0,
        "graph_edges": 0,
        "generated_at": _now_iso(),
    }

    documents_by_type: list[dict] = []
    documents_by_status: list[dict] = []
    timeline: list[dict] = []
    top_cited: list[dict] = []
    top_entities: list[dict] = []

    if scope:
        # ── Documents ─────────────────────────────────────────────────────
        overview["documents_total"] = await _count(
            session,
            select(func.count()).select_from(Document).where(Document.id.in_(scope)),
        )
        overview["documents_indexed"] = await _count(
            session,
            select(func.count())
            .select_from(Document)
            .where(Document.id.in_(scope), Document.status == "ready"),
        )
        overview["documents_pending"] = await _count(
            session,
            select(func.count())
            .select_from(Document)
            .where(Document.id.in_(scope), Document.status.in_(("uploaded", "processing"))),
        )
        overview["documents_failed"] = await _count(
            session,
            select(func.count())
            .select_from(Document)
            .where(Document.id.in_(scope), Document.status == "failed"),
        )
        overview["storage_bytes"] = await _count(
            session,
            select(func.coalesce(func.sum(Document.byte_size), 0))
            .where(Document.id.in_(scope)),
        )
        overview["page_count"] = await _count(
            session,
            select(func.coalesce(func.sum(Document.page_count), 0)).where(
                Document.id.in_(scope)
            ),
        )
        overview["chunk_count"] = await _count(
            session,
            select(func.count())
            .select_from(DocumentChunk)
            .where(DocumentChunk.document_id.in_(scope)),
        )

        documents_by_type = await _breakdown(
            session,
            select(Document.doc_type, func.count())
            .where(Document.id.in_(scope))
            .group_by(Document.doc_type)
            .order_by(func.count().desc()),
        )
        documents_by_status = await _breakdown(
            session,
            select(Document.status, func.count())
            .where(Document.id.in_(scope))
            .group_by(Document.status)
            .order_by(func.count().desc()),
        )

        # ── Entities ──────────────────────────────────────────────────────
        overview["entity_count"] = await _count(
            session,
            select(func.count())
            .select_from(ExtractedEntity)
            .where(
                ExtractedEntity.id.in_(
                    select(EntityMention.entity_id)
                    .where(EntityMention.document_id.in_(scope))
                    .distinct()
                )
            ),
        )
        overview["entity_mention_count"] = await _count(
            session,
            select(func.count())
            .select_from(EntityMention)
            .where(EntityMention.document_id.in_(scope)),
        )

        top_entities = await _breakdown(
            session,
            select(ExtractedEntity.name, func.count(EntityMention.id))
            .join(EntityMention, EntityMention.entity_id == ExtractedEntity.id)
            .where(EntityMention.document_id.in_(scope))
            .group_by(ExtractedEntity.name)
            .order_by(func.count(EntityMention.id).desc())
            .limit(15),
        )

        # ── Profiles ──────────────────────────────────────────────────────
        overview["profile_count"] = await _count(
            session,
            select(func.count())
            .select_from(DocumentProfile)
            .where(DocumentProfile.document_id.in_(scope)),
        )
        average_confidence = await session.scalar(
            select(func.avg(DocumentProfile.confidence)).where(
                DocumentProfile.document_id.in_(scope),
                DocumentProfile.confidence.isnot(None),
            )
        )
        overview["average_profile_confidence"] = (
            round(float(average_confidence), 4) if average_confidence is not None else None
        )

        # ── Citations ─────────────────────────────────────────────────────
        overview["citation_count"] = await _count(
            session,
            select(func.count())
            .select_from(Citation)
            .where(Citation.document_id.in_(scope)),
        )

        top_cited_rows = (
            await session.execute(
                select(
                    Citation.document_id,
                    func.count(Citation.id),
                )
                .where(Citation.document_id.in_(scope))
                .group_by(Citation.document_id)
                .order_by(func.count(Citation.id).desc())
                .limit(10)
            )
        ).all()
        if top_cited_rows:
            doc_ids = [row[0] for row in top_cited_rows]
            names = (
                await session.execute(
                    select(Document.id, Document.filename).where(Document.id.in_(doc_ids))
                )
            ).all()
            filename_by_id = {row[0]: row[1] for row in names}
            top_cited = [
                {
                    "document_id": str(row[0]),
                    "filename": filename_by_id.get(row[0]),
                    "citations": int(row[1] or 0),
                    "mentions": 0,
                }
                for row in top_cited_rows
            ]

        # ── Timeline ──────────────────────────────────────────────────────
        timeline = await _build_timeline(session, user, scope)

    # ── The caller's own activity ─────────────────────────────────────────
    overview["conversations"] = await _count(
        session,
        select(func.count())
        .select_from(Conversation)
        .where(Conversation.user_id == user.id),
    )
    overview["questions_asked"] = await _count(
        session,
        select(func.count())
        .select_from(Message)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(Conversation.user_id == user.id, Message.role == "user"),
    )
    overview["answers_found"] = await _count(
        session,
        select(func.count())
        .select_from(Message)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(
            Conversation.user_id == user.id,
            Message.role == "assistant",
            Message.answer_found.is_(True),
        ),
    )
    overview["abstentions"] = await _count(
        session,
        select(func.count())
        .select_from(Message)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(
            Conversation.user_id == user.id,
            Message.role == "assistant",
            Message.answer_found.is_(False),
        ),
    )
    assistant_total = overview["answers_found"] + overview["abstentions"]
    overview["abstention_rate"] = (
        round(overview["abstentions"] / assistant_total, 4) if assistant_total else 0.0
    )
    overview["searches"] = await _count(
        session,
        select(func.count())
        .select_from(SearchHistory)
        .where(SearchHistory.user_id == user.id),
    )
    overview["comparisons"] = await _count(
        session,
        select(func.count())
        .select_from(DocumentComparison)
        .where(DocumentComparison.created_by == user.id),
    )
    overview["research_reports"] = await _count(
        session,
        select(func.count())
        .select_from(ResearchReport)
        .where(ResearchReport.created_by == user.id),
    )
    overview["extraction_runs"] = await _count(
        session,
        select(func.count())
        .select_from(ExtractionRun)
        .where(ExtractionRun.created_by == user.id),
    )
    overview["extraction_rows"] = await _count(
        session,
        select(func.count())
        .select_from(ExtractionRow)
        .join(ExtractionRun, ExtractionRun.id == ExtractionRow.run_id)
        .where(ExtractionRun.created_by == user.id),
    )

    # ── Graph shape ───────────────────────────────────────────────────────
    graph = await build_graph(session, user)
    overview["graph_nodes"] = len(graph["nodes"])
    overview["graph_edges"] = len(graph["edges"])

    return {
        "overview": overview,
        "documents_by_type": documents_by_type,
        "documents_by_status": documents_by_status,
        "timeline": timeline,
        "top_cited": top_cited,
        "top_entities": top_entities,
    }


async def _build_timeline(
    session: AsyncSession, user: User, scope: list[uuid.UUID]
) -> list[dict]:
    """Documents added and questions asked, month by month."""
    now = datetime.now(timezone.utc)
    start = (now.replace(day=1) - timedelta(days=31 * (TIMELINE_MONTHS - 1))).replace(
        day=1
    )

    points: dict[str, dict] = {}
    for offset in range(TIMELINE_MONTHS):
        year = start.year + ((start.month - 1 + offset) // 12)
        month = ((start.month - 1 + offset) % 12) + 1
        points[f"{year:04d}-{month:02d}"] = {
            "period": f"{year:04d}-{month:02d}",
            "documents": 0,
            "questions": 0,
        }

    document_rows = (
        await session.execute(
            select(
                func.date_trunc("month", Document.created_at).label("month"),
                func.count(),
            )
            .where(Document.id.in_(scope), Document.created_at >= start)
            .group_by("month")
        )
    ).all()
    for row in document_rows:
        key = row[0].strftime("%Y-%m") if row[0] is not None else None
        if key in points:
            points[key]["documents"] = int(row[1] or 0)

    question_rows = (
        await session.execute(
            select(
                func.date_trunc("month", Message.created_at).label("month"),
                func.count(),
            )
            .join(Conversation, Conversation.id == Message.conversation_id)
            .where(
                Conversation.user_id == user.id,
                Message.role == "user",
                Message.created_at >= start,
            )
            .group_by("month")
        )
    ).all()
    for row in question_rows:
        key = row[0].strftime("%Y-%m") if row[0] is not None else None
        if key in points:
            points[key]["questions"] = int(row[1] or 0)

    return list(points.values())

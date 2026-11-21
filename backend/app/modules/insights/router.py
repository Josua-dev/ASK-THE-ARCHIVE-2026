"""Routes for Automated Archive Insights."""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_staff
from app.core.errors import ForbiddenError, NotFoundError
from app.db.models.archive_insight import ArchiveInsight
from app.db.session import get_db_session
from app.modules.insights.schemas import (
    ArchiveInsightOut,
    InsightEvidence,
    InsightListOut,
    InsightStatusUpdate,
)
from app.modules.insights.service import (
    counts_by_kind,
    detect_insights,
    list_insights,
    persist_insights,
)
from app.shared.audit import record_audit

router = APIRouter(prefix="/api/v1/insights", tags=["archive-insights"])


def _evidence(raw) -> list[InsightEvidence]:
    out: list[InsightEvidence] = []
    if not isinstance(raw, list):
        return out
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        document_id = entry.get("document_id")
        if not document_id:
            continue
        page = entry.get("page")
        out.append(
            InsightEvidence(
                document_id=str(document_id),
                filename=entry.get("filename"),
                page=page if isinstance(page, int) else None,
                excerpt=entry.get("excerpt"),
            )
        )
    return out


def _insight_out(row: ArchiveInsight) -> ArchiveInsightOut:
    return ArchiveInsightOut(
        id=row.id,
        kind=row.kind,
        severity=row.severity,
        title=row.title,
        detail=row.detail,
        document_ids=[str(doc_id) for doc_id in (row.document_ids or [])],
        evidence=_evidence(row.evidence),
        status=row.status,
        detected_at=row.detected_at.isoformat() if row.detected_at else None,
        acknowledged_by=row.acknowledged_by,
        acknowledged_at=row.acknowledged_at.isoformat() if row.acknowledged_at else None,
    )


@router.get("", response_model=InsightListOut)
async def get_insights(
    status: Optional[str] = Query(default=None),
    kind: Optional[str] = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Archive insights the caller can see, with a count per kind."""
    rows = await list_insights(session, user, status=status, kind=kind, limit=limit)
    return InsightListOut(
        items=[_insight_out(row) for row in rows],
        total=len(rows),
        counts=counts_by_kind(rows),
    )


@router.post("/scan", response_model=InsightListOut)
async def scan_archive(
    session: AsyncSession = Depends(get_db_session),
    staff=Depends(require_staff),
):
    """Rescan the archive and refresh the stored insights.

    The scan is deterministic: it reads expiry dates, checksums, extracted
    profiles and contract references, and reports what it finds.
    """
    detections = await detect_insights(session, staff)
    stored = await persist_insights(session, staff, detections)

    await record_audit(
        session,
        actor_id=staff.id,
        action="insights.scan",
        resource_type="archive",
        metadata={"detected": len(detections)},
    )
    await session.commit()

    visible = await list_insights(session, staff)
    return InsightListOut(
        items=[_insight_out(row) for row in visible],
        total=len(visible),
        counts=counts_by_kind(visible),
    )


@router.patch("/{insight_id}", response_model=ArchiveInsightOut)
async def update_insight(
    insight_id: uuid.UUID,
    payload: InsightStatusUpdate,
    session: AsyncSession = Depends(get_db_session),
    staff=Depends(require_staff),
):
    """Acknowledge, resolve or dismiss an insight."""
    row = await session.get(ArchiveInsight, insight_id)
    if row is None:
        raise NotFoundError("Insight not found")

    row.status = payload.status
    if payload.status == "open":
        row.acknowledged_by = None
        row.acknowledged_at = None
    else:
        row.acknowledged_by = staff.id
        row.acknowledged_at = row.acknowledged_at or row.detected_at

    await record_audit(
        session,
        actor_id=staff.id,
        action="insights.update",
        resource_type="archive_insight",
        resource_id=insight_id,
        metadata={"status": payload.status},
    )
    await session.commit()

    return _insight_out(row)

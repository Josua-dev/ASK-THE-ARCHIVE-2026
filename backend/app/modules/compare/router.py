"""Routes for the document comparison feature."""

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_staff
from app.core.errors import ForbiddenError, NotFoundError, ValidationError
from app.db.models.comparison import DocumentComparison
from app.db.models.document import Document
from app.db.session import get_db_session
from app.modules.compare.schemas import (
    ComparisonCitation,
    ComparisonFindingOut,
    ComparisonListItem,
    ComparisonListOut,
    CompareRequest,
    DocumentComparisonOut,
)
from app.modules.compare.service import (
    findings_for,
    list_comparisons,
    run_comparison,
)
from app.modules.documents.permissions import (
    can_access_document,
    permitted_document_ids,
)
from app.shared.audit import record_audit

router = APIRouter(prefix="/api/v1/compare", tags=["compare"])


def _citation(raw) -> ComparisonCitation | None:
    if not isinstance(raw, dict):
        return None
    document_id = raw.get("document_id")
    if not document_id:
        return None
    page = raw.get("page")
    return ComparisonCitation(
        document_id=str(document_id),
        filename=str(raw.get("filename") or ""),
        page=page if isinstance(page, int) else None,
        excerpt=raw.get("excerpt"),
    )


def _finding_out(finding) -> ComparisonFindingOut:
    return ComparisonFindingOut(
        id=finding.id,
        kind=finding.kind,
        category=finding.category,
        title=finding.title,
        detail=finding.detail,
        severity=finding.severity,
        citation_a=_citation(finding.citation_a),
        citation_b=_citation(finding.citation_b),
        sort_order=finding.sort_order,
    )


async def _filenames(
    session: AsyncSession, comparison: DocumentComparison
) -> tuple[str | None, str | None]:
    document_a = await session.get(Document, comparison.document_a_id)
    document_b = await session.get(Document, comparison.document_b_id)
    return (
        document_a.filename if document_a else None,
        document_b.filename if document_b else None,
    )


@router.post("", response_model=DocumentComparisonOut)
async def create_comparison(
    payload: CompareRequest,
    session: AsyncSession = Depends(get_db_session),
    staff=Depends(require_staff),
):
    """Compare two documents.

    Both documents must be readable by the caller. The comparison is
    persisted so it can be reopened and audited.
    """
    if payload.document_a_id == payload.document_b_id:
        raise ValidationError("Choose two different documents to compare")

    for document_id in (payload.document_a_id, payload.document_b_id):
        if not await can_access_document(session, staff, document_id, need="view"):
            raise ForbiddenError("You do not have permission to read one of these documents")

    document_a = await session.get(Document, payload.document_a_id)
    document_b = await session.get(Document, payload.document_b_id)
    if document_a is None or document_b is None:
        raise NotFoundError("One of these documents does not exist")

    try:
        comparison, findings, usable = await run_comparison(
            session,
            staff,
            document_a,
            document_b,
            instruction=payload.instruction,
        )
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc

    await record_audit(
        session,
        actor_id=staff.id,
        action="comparison.create",
        resource_type="document_comparison",
        resource_id=comparison.id,
        metadata={
            "document_a": str(document_a.id),
            "document_b": str(document_b.id),
            "findings": len(findings),
            "usable": usable,
        },
    )
    await session.commit()

    return DocumentComparisonOut(
        id=comparison.id,
        document_a_id=comparison.document_a_id,
        document_b_id=comparison.document_b_id,
        filename_a=document_a.filename,
        filename_b=document_b.filename,
        status=comparison.status,
        summary=comparison.summary,
        model=comparison.model,
        error=comparison.error,
        created_by=comparison.created_by,
        created_at=comparison.created_at.isoformat() if comparison.created_at else None,
        completed_at=comparison.completed_at.isoformat() if comparison.completed_at else None,
        findings=[_finding_out(f) for f in findings],
    )


@router.get("", response_model=ComparisonListOut)
async def list_comparisons_route(
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Comparisons involving at least one document the caller may read."""
    permitted = await permitted_document_ids(session, user)
    rows, total = await list_comparisons(session, permitted, limit=limit, offset=offset)

    items: list[ComparisonListItem] = []
    for row in rows:
        filename_a, filename_b = await _filenames(session, row)
        findings = await findings_for(session, row.id)
        items.append(
            ComparisonListItem(
                id=row.id,
                document_a_id=row.document_a_id,
                document_b_id=row.document_b_id,
                filename_a=filename_a,
                filename_b=filename_b,
                status=row.status,
                summary=row.summary,
                created_at=row.created_at.isoformat() if row.created_at else None,
                finding_count=len(findings),
            )
        )
    return ComparisonListOut(items=items, total=total)


@router.get("/{comparison_id}", response_model=DocumentComparisonOut)
async def read_comparison(
    comparison_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """One comparison with its findings.

    The caller must be able to read both documents; otherwise the comparison
    is refused rather than filtered.
    """
    comparison = await session.get(DocumentComparison, comparison_id)
    if comparison is None:
        raise NotFoundError("Comparison not found")

    for document_id in (comparison.document_a_id, comparison.document_b_id):
        if not await can_access_document(session, user, document_id, need="view"):
            raise ForbiddenError("You do not have permission to read this comparison")

    filename_a, filename_b = await _filenames(session, comparison)
    findings = await findings_for(session, comparison_id)

    return DocumentComparisonOut(
        id=comparison.id,
        document_a_id=comparison.document_a_id,
        document_b_id=comparison.document_b_id,
        filename_a=filename_a,
        filename_b=filename_b,
        status=comparison.status,
        summary=comparison.summary,
        model=comparison.model,
        error=comparison.error,
        created_by=comparison.created_by,
        created_at=comparison.created_at.isoformat() if comparison.created_at else None,
        completed_at=comparison.completed_at.isoformat() if comparison.completed_at else None,
        findings=[_finding_out(f) for f in findings],
    )

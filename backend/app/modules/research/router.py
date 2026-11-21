"""Routes for Research Mode reports."""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.core.errors import ForbiddenError, NotFoundError, ValidationError
from app.db.models.research_report import ResearchReport
from app.db.session import get_db_session
from app.modules.conversation_share.service import (
    can_contribute,
    resolve_conversation_access,
)
from app.modules.documents.permissions import permitted_document_ids
from app.modules.research.schemas import (
    ResearchCitation,
    ResearchListOut,
    ResearchReportOut,
    ResearchReportSummary,
    ResearchRequest,
    ResearchSection,
)
from app.modules.research.service import (
    filter_report_for,
    generate_report,
    list_reports,
)
from app.shared.audit import record_audit

router = APIRouter(prefix="/api/v1/research", tags=["research"])


def _sections(raw) -> list[ResearchSection]:
    out: list[ResearchSection] = []
    if not isinstance(raw, list):
        return out
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        citations = entry.get("citations")
        out.append(
            ResearchSection(
                key=str(entry.get("key") or ""),
                title=str(entry.get("title") or ""),
                body=str(entry.get("body") or ""),
                citations=[c for c in citations if isinstance(c, int)]
                if isinstance(citations, list)
                else [],
            )
        )
    return out


def _citations(raw) -> list[ResearchCitation]:
    out: list[ResearchCitation] = []
    if not isinstance(raw, list):
        return out
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        try:
            out.append(
                ResearchCitation(
                    index=int(entry.get("index") or 0),
                    document_id=str(entry.get("document_id") or ""),
                    filename=str(entry.get("filename") or ""),
                    page_start=int(entry.get("page_start") or 0),
                    page_end=int(entry.get("page_end") or 0),
                    excerpt=str(entry.get("excerpt") or ""),
                )
            )
        except (TypeError, ValueError):
            continue
    return out


def _report_out(report: ResearchReport) -> ResearchReportOut:
    return ResearchReportOut(
        id=report.id,
        conversation_id=report.conversation_id,
        message_id=report.message_id,
        question=report.question,
        sections=_sections(report.sections),
        citations=_citations(report.citations),
        model=report.model,
        tokens_used=report.tokens_used,
        created_by=report.created_by,
        created_at=report.created_at.isoformat() if report.created_at else None,
    )


@router.post("", response_model=ResearchReportOut)
async def create_report(
    payload: ResearchRequest,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Generate a research report from the archive.

    Retrieval is permission-scoped, so the report can only ever be built from
    documents the caller is allowed to read. If the caller links the report to
    a conversation, they must be able to contribute to that conversation.
    """
    question = (payload.question or "").strip()
    if not question:
        raise ValidationError("A research question is required")

    if payload.conversation_id is not None:
        conversation, access = await resolve_conversation_access(
            session, user, payload.conversation_id
        )
        if conversation is None:
            raise NotFoundError("Conversation not found")
        if not can_contribute(access):
            raise ForbiddenError(
                "You have read access to this conversation but cannot add to it"
            )

    report, usable = await generate_report(
        session,
        user,
        question,
        conversation_id=payload.conversation_id,
        instruction=payload.instruction,
    )

    await record_audit(
        session,
        actor_id=user.id,
        action="research.generate",
        resource_type="research_report",
        resource_id=report.id,
        metadata={
            "question": question[:400],
            "citations": len(report.citations or []),
            "model": report.model,
            "usable": usable,
        },
    )
    await session.commit()

    return _report_out(report)


@router.get("", response_model=ResearchListOut)
async def list_own_reports(
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """The caller's research reports, newest first."""
    rows, total = await list_reports(session, user, limit=limit, offset=offset)
    items = [
        ResearchReportSummary(
            id=row.id,
            question=row.question,
            model=row.model,
            created_at=row.created_at.isoformat() if row.created_at else None,
            citation_count=len(row.citations or []),
        )
        for row in rows
    ]
    return ResearchListOut(items=items, total=total)


@router.get("/{report_id}", response_model=ResearchReportOut)
async def read_report(
    report_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """One research report.

    Citations pointing at documents the caller can no longer read are removed
    from the response, and the sections that depended on them are shown
    without those references.
    """
    report = await session.get(ResearchReport, report_id)
    if report is None:
        raise NotFoundError("Research report not found")

    is_owner = report.created_by == user.id
    if not is_owner and user.role != "admin":
        raise ForbiddenError("You do not have access to this research report")

    permitted = await permitted_document_ids(session, user)
    allowed = set(permitted)

    filtered = filter_report_for(report, allowed)
    return ResearchReportOut(
        id=report.id,
        conversation_id=report.conversation_id,
        message_id=report.message_id,
        question=report.question,
        sections=[ResearchSection(**section) for section in filtered["sections"]],
        citations=[ResearchCitation(**citation) for citation in filtered["citations"]],
        model=report.model,
        tokens_used=report.tokens_used,
        created_by=report.created_by,
        created_at=report.created_at.isoformat() if report.created_at else None,
    )

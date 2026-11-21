"""Routes for the Extraction Studio."""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_staff
from app.core.errors import ForbiddenError, NotFoundError, ValidationError
from app.db.models.document import Document
from app.db.models.extraction_run import ExtractionRun
from app.db.session import get_db_session
from app.modules.documents.permissions import can_access_document
from app.modules.extraction.schemas import (
    ExtractionCitation,
    ExtractionColumn,
    ExtractionCreate,
    ExtractionListItem,
    ExtractionListOut,
    ExtractionRowOut,
    ExtractionRunOut,
)
from app.modules.extraction.service import (
    MAX_DOCUMENTS,
    list_runs,
    rows_for,
    run_extraction,
)
from app.shared.audit import record_audit

router = APIRouter(prefix="/api/v1/extractions", tags=["extraction"])


def _citation(raw) -> Optional[ExtractionCitation]:
    if not isinstance(raw, dict):
        return None
    document_id = raw.get("document_id")
    if not document_id:
        return None
    page = raw.get("page")
    return ExtractionCitation(
        column=str(raw.get("column") or ""),
        document_id=str(document_id),
        filename=str(raw.get("filename") or ""),
        page=page if isinstance(page, int) else None,
        excerpt=str(raw.get("excerpt") or ""),
    )


def _columns(raw) -> list[ExtractionColumn]:
    out: list[ExtractionColumn] = []
    if not isinstance(raw, list):
        return out
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        key = entry.get("key")
        if not key:
            continue
        out.append(
            ExtractionColumn(
                key=str(key),
                label=str(entry.get("label") or key),
                type=str(entry.get("type") or "text"),
            )
        )
    return out


def _run_out(run: ExtractionRun, rows: list) -> ExtractionRunOut:
    return ExtractionRunOut(
        id=run.id,
        instruction=run.instruction,
        question=run.question,
        status=run.status,
        columns=_columns(run.columns),
        row_count=run.row_count,
        model=run.model,
        error=run.error,
        created_by=run.created_by,
        created_at=run.created_at.isoformat() if run.created_at else None,
        completed_at=run.completed_at.isoformat() if run.completed_at else None,
        rows=[
            ExtractionRowOut(
                id=row.id,
                row_index=row.row_index,
                data=row.data or {},
                document_id=str(row.document_id) if row.document_id else None,
                citations=[c for c in (_citation(raw) for raw in row.citations or []) if c],
            )
            for row in rows
        ],
    )


@router.post("", response_model=ExtractionRunOut)
async def create_extraction(
    payload: ExtractionCreate,
    session: AsyncSession = Depends(get_db_session),
    staff=Depends(require_staff),
):
    """Extract structured rows from documents.

    If no documents are named, the extraction runs across every document the
    caller may read that has been indexed.
    """
    instruction = (payload.instruction or "").strip()
    if not instruction:
        raise ValidationError("Describe what you want extracted")

    if payload.document_ids:
        documents: list[Document] = []
        for document_id in payload.document_ids[:MAX_DOCUMENTS]:
            document = await session.get(Document, document_id)
            if document is None:
                raise NotFoundError("One of these documents does not exist")
            if not await can_access_document(session, staff, document_id, need="view"):
                raise ForbiddenError(
                    "You do not have permission to read one of these documents"
                )
            documents.append(document)
    else:
        from app.modules.documents.permissions import permission_filter

        stmt = (
            select(Document)
            .where(*permission_filter(staff))
            .order_by(Document.created_at.desc())
            .limit(MAX_DOCUMENTS)
        )
        documents = list((await session.execute(stmt)).scalars().all())

    if not documents:
        raise ValidationError("There are no documents available to extract from")

    run, usable = await run_extraction(
        session,
        staff,
        documents,
        instruction=instruction,
        requested_columns=[c.model_dump() for c in payload.columns] or None,
        max_rows=payload.max_rows,
    )

    await record_audit(
        session,
        actor_id=staff.id,
        action="extraction.run",
        resource_type="extraction_run",
        resource_id=run.id,
        metadata={
            "instruction": instruction[:400],
            "documents": len(documents),
            "rows": run.row_count,
            "usable": usable,
        },
    )
    await session.commit()

    rows = await rows_for(session, run.id)
    return _run_out(run, rows)


@router.get("", response_model=ExtractionListOut)
async def list_extraction_runs(
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """The caller's extraction runs, newest first."""
    rows, total = await list_runs(session, user, limit=limit, offset=offset)
    items = [
        ExtractionListItem(
            id=row.id,
            instruction=row.instruction,
            status=row.status,
            row_count=row.row_count,
            model=row.model,
            created_at=row.created_at.isoformat() if row.created_at else None,
        )
        for row in rows
    ]
    return ExtractionListOut(items=items, total=total)


@router.get("/{run_id}", response_model=ExtractionRunOut)
async def read_extraction(
    run_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """One extraction run with its rows."""
    run = await session.get(ExtractionRun, run_id)
    if run is None:
        raise NotFoundError("Extraction run not found")
    if run.created_by != user.id and user.role != "admin":
        raise ForbiddenError("You do not have access to this extraction run")

    rows = await rows_for(session, run.id)
    return _run_out(run, rows)

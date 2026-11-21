"""Routes for document intelligence profiles."""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_staff
from app.core.errors import ForbiddenError, NotFoundError, ValidationError
from app.db.models.document import Document
from app.db.session import get_db_session
from app.modules.documents.permissions import (
    can_access_document,
    permitted_document_ids,
)
from app.modules.profiles.schemas import (
    DocumentProfileOut,
    ProfileEntry,
    ProfileGenerateOut,
    ProfileGenerateRequest,
    ProfileRelatedDocument,
    ProfileSourceRef,
)
from app.modules.profiles.service import (
    filter_related_documents,
    generate_profile,
    get_profile,
)
from app.shared.audit import record_audit

router = APIRouter(prefix="/api/v1/profiles", tags=["profiles"])


def _entry_list(values) -> list[ProfileEntry]:
    return [ProfileEntry(**value) for value in (values or []) if isinstance(value, dict)]


def _to_out(profile, filename: str | None, related: list[dict]) -> DocumentProfileOut:
    return DocumentProfileOut(
        id=profile.id,
        document_id=profile.document_id,
        filename=filename,
        doc_type=profile.doc_type,
        parties=_entry_list(profile.parties),
        organisations=_entry_list(profile.organisations),
        individuals=_entry_list(profile.individuals),
        important_dates=_entry_list(profile.important_dates),
        monetary_values=_entry_list(profile.monetary_values),
        currency=profile.currency,
        contract_references=_entry_list(profile.contract_references),
        important_clauses=_entry_list(profile.important_clauses),
        obligations=_entry_list(profile.obligations),
        keywords=[k for k in (profile.keywords or []) if isinstance(k, str)],
        related_documents=[ProfileRelatedDocument(**r) for r in related],
        source_refs=[
            ProfileSourceRef(**r)
            for r in (profile.source_refs or [])
            if isinstance(r, dict) and r.get("field")
        ],
        confidence=profile.confidence,
        model=profile.model,
        created_at=profile.created_at.isoformat() if profile.created_at else None,
        updated_at=profile.updated_at.isoformat() if profile.updated_at else None,
    )


@router.get("/{document_id}", response_model=DocumentProfileOut)
async def read_profile(
    document_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """The stored profile for a document.

    A profile is only visible to someone who may read the document it was
    derived from, and its list of related documents is filtered to what the
    caller may open.
    """
    if not await can_access_document(session, user, document_id, need="view"):
        raise ForbiddenError("You do not have permission to read this document")

    profile = await get_profile(session, document_id)
    if profile is None:
        raise NotFoundError("No profile has been generated for this document yet")

    document = await session.get(Document, document_id)
    permitted = set(await permitted_document_ids(session, user))
    related = filter_related_documents(profile, permitted)
    return _to_out(profile, document.filename if document else None, related)


@router.post("/{document_id}", response_model=ProfileGenerateOut)
async def regenerate_profile(
    document_id: uuid.UUID,
    payload: ProfileGenerateRequest | None = None,
    session: AsyncSession = Depends(get_db_session),
    staff=Depends(require_staff),
):
    """Extract (or re-extract) the profile for a document.

    Regeneration refreshes the archive's entity index for this document, so
    the knowledge graph reflects the current extraction.
    """
    if not await can_access_document(session, user=staff, document_id=document_id, need="view"):
        raise ForbiddenError("You do not have permission to read this document")

    document = await session.get(Document, document_id)
    if document is None:
        raise NotFoundError("Document not found")
    if document.status != "ready":
        raise ValidationError("This document has not finished indexing yet")

    try:
        profile, usable, message, entities = await generate_profile(
            session,
            staff,
            document,
            instruction=payload.instruction if payload else None,
        )
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc

    await record_audit(
        session,
        actor_id=staff.id,
        action="profile.generate",
        resource_type="document",
        resource_id=document.id,
        metadata={
            "filename": document.filename,
            "usable": usable,
            "entities": entities,
            "fields": {
                field: len(getattr(profile, field) or [])
                for field in (
                    "parties",
                    "organisations",
                    "individuals",
                    "important_dates",
                    "monetary_values",
                    "contract_references",
                    "important_clauses",
                    "obligations",
                    "keywords",
                )
            },
        },
    )
    await session.commit()

    permitted = set(await permitted_document_ids(session, staff))
    related = filter_related_documents(profile, permitted)
    return ProfileGenerateOut(
        profile=_to_out(profile, document.filename, related),
        generated=usable,
        message=message,
        entities_recorded=entities,
        detail={"model": profile.model, "confidence": profile.confidence},
    )

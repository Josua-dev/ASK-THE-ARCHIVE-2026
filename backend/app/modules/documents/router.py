"""Document routes — upload, list, preview, download, permissions."""

import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.deps import get_current_user
from app.core.errors import ForbiddenError, NotFoundError, ValidationError
from app.core.security import verify_signed_link
from app.db.models.document import Document
from app.db.session import get_db_session
from app.modules.documents import service
from app.modules.documents.permissions import (
    grant,
    list_permissions,
    revoke,
)
from app.ports.factory import get_job_runner, get_storage
from app.shared.audit import record_audit

router = APIRouter(prefix="/api/v1/documents", tags=["documents"])

# The warehouse map lives at its own prefix because it is a view of the
# whole archive rather than a view of one document.
warehouse_router = APIRouter(prefix="/api/v1/warehouse", tags=["warehouse"])


class DocumentOut(BaseModel):
    id: uuid.UUID
    filename: str
    title: Optional[str] = None
    content_type: str
    byte_size: int
    status: str
    doc_type: Optional[str] = None
    expiry_date: Optional[str] = None
    classification_confidence: Optional[float] = None
    page_count: Optional[int] = None
    uploaded_by: Optional[uuid.UUID] = None
    created_at: Optional[str] = None
    indexed_at: Optional[str] = None
    extracted_metadata: Optional[dict] = None
    zone: Optional[str] = None
    rack: Optional[str] = None
    shelf: Optional[str] = None
    box: Optional[str] = None

    @classmethod
    def of(cls, doc) -> "DocumentOut":
        return cls(
            id=doc.id,
            filename=doc.filename,
            title=doc.title,
            content_type=doc.content_type,
            byte_size=doc.byte_size,
            status=doc.status,
            doc_type=doc.doc_type,
            expiry_date=doc.expiry_date.isoformat() if doc.expiry_date else None,
            classification_confidence=doc.classification_confidence,
            page_count=doc.page_count,
            uploaded_by=doc.uploaded_by,
            created_at=doc.created_at.isoformat() if doc.created_at else None,
            indexed_at=doc.indexed_at.isoformat() if doc.indexed_at else None,
            extracted_metadata=doc.extracted_metadata,
            zone=doc.zone,
            rack=doc.rack,
            shelf=doc.shelf,
            box=doc.box,
        )


class DocumentListOut(BaseModel):
    items: list[DocumentOut]
    total: int


class PermissionOut(BaseModel):
    id: uuid.UUID
    grantee_type: str
    grantee_user_id: Optional[uuid.UUID] = None
    grantee_role: Optional[str] = None
    permission: str
    granted_by: Optional[uuid.UUID] = None
    granted_at: Optional[str] = None


class GrantRequest(BaseModel):
    # Constrained to the values the archive actually stores. These columns are
    # PostgreSQL enums, so an unknown value would be refused by the database —
    # and the service's own check would raise before it ever got there.
    grantee_type: Literal["user", "role"]
    permission: Literal["view", "download", "manage"]
    grantee_user_id: Optional[uuid.UUID] = None
    grantee_role: Optional[str] = None


class RevokeRequest(BaseModel):
    grantee_type: Literal["user", "role"]
    permission: Literal["view", "download", "manage"]
    grantee_user_id: Optional[uuid.UUID] = None
    grantee_role: Optional[str] = None


class DownloadOut(BaseModel):
    url: str
    expires_in: int


class LocationOut(BaseModel):
    zone: Optional[str] = None
    rack: Optional[str] = None
    shelf: Optional[str] = None
    box: Optional[str] = None
    label: Optional[str] = None

    @classmethod
    def of(cls, doc) -> "LocationOut":
        return cls(
            zone=doc.zone,
            rack=doc.rack,
            shelf=doc.shelf,
            box=doc.box,
            label=service.build_location_label(doc.zone, doc.rack, doc.shelf, doc.box),
        )


class LocationUpdate(BaseModel):
    # All four parts travel together, so every field is optional: the
    # absence of all four is what clears a location.
    zone: Optional[str] = None
    rack: Optional[str] = None
    shelf: Optional[str] = None
    box: Optional[str] = None


class WarehouseSlotOut(BaseModel):
    zone: str
    rack: str
    shelf: str
    box: str
    document_id: uuid.UUID
    filename: str
    title: Optional[str] = None
    created_at: str
    position: int
    total_in_box: int
    checkout: Optional["CheckoutOut"] = None


class CheckoutOut(BaseModel):
    """A document's open checkout, as shown on the warehouse map."""
    by: str
    dueAt: str


class WarehouseLayoutOut(BaseModel):
    zones: list[str]
    racks: list[str]
    shelves: list[str]
    boxes: list[str]
    slots: list[WarehouseSlotOut]


@router.post("", response_model=DocumentOut, status_code=201)
async def upload(
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    body = await file.read()
    document = await service.upload_document(
        session,
        user=user,
        filename=file.filename or "document",
        content_type=file.content_type or "application/octet-stream",
        body=body,
    )
    await record_audit(
        session,
        actor_id=user.id,
        action="document.upload",
        resource_type="document",
        resource_id=document.id,
        metadata={"filename": document.filename, "bytes": document.byte_size},
    )
    await session.commit()

    # Ingestion runs in the background; the document becomes searchable shortly.
    from app.modules.ingestion.pipeline import ingest_document
    from app.db.session import async_session

    async def _run() -> None:
        async with async_session() as bg:
            try:
                await ingest_document(bg, document.id)
            except Exception:  # noqa: BLE001 - failure is recorded on the job
                pass

    get_job_runner().schedule(_run)
    return DocumentOut.of(document)


@router.get("", response_model=DocumentListOut)
async def list_all(
    doc_type: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    docs, total = await service.list_documents(
        session, user, doc_type=doc_type, status=status, search=search, limit=limit, offset=offset
    )
    return DocumentListOut(items=[DocumentOut.of(d) for d in docs], total=total)


@router.get("/{document_id}", response_model=DocumentOut)
async def get_one(
    document_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    document = await service.get_document_for_read(session, user, document_id)
    return DocumentOut.of(document)


@router.get("/{document_id}/preview")
async def preview(
    document_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """The extracted text of the document, page by page."""
    document = await service.get_document_for_read(session, user, document_id)
    chunks = await service.document_chunks(session, document_id)
    return {
        "id": str(document.id),
        "filename": document.filename,
        "doc_type": document.doc_type,
        "expiry_date": document.expiry_date.isoformat() if document.expiry_date else None,
        "status": document.status,
        "pages": [
            {
                "chunk_index": c.chunk_index,
                "page_start": c.page_start,
                "page_end": c.page_end,
                "text": c.text,
            }
            for c in chunks
        ],
    }


@router.get("/{document_id}/download", response_model=DownloadOut)
async def download(
    document_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    url, expires = await service.get_download_url(session, user, document_id)
    await record_audit(
        session,
        actor_id=user.id,
        action="document.download",
        resource_type="document",
        resource_id=document_id,
    )
    await session.commit()
    return DownloadOut(url=url, expires_in=expires)


@router.get("/raw/{document_id}")
async def raw_object(
    document_id: uuid.UUID,
    token: str = Query(min_length=1),
    session: AsyncSession = Depends(get_db_session),
):
    """Serve the stored original for the local storage backend.

    The signed token is the credential. It is bound by its scope to this one
    document, and it expires in minutes, so it cannot be replayed against a
    different document or a different endpoint. The permission check that
    authorised it happened when the link was minted, and that decision is
    what the audit trail records.
    """
    if not verify_signed_link(token, f"download:{document_id}", settings.jwt_secret):
        raise ForbiddenError("This download link is invalid or has expired")

    document = await session.get(Document, document_id)
    if document is None:
        raise NotFoundError("Document not found")

    storage = get_storage()
    body = await storage.get_object(document.storage_key)
    return Response(
        content=body,
        media_type=document.content_type or "application/octet-stream",
        headers={
            "Content-Disposition": f'inline; filename="{document.filename}"',
            "Content-Length": str(len(body)),
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/{document_id}/permissions", response_model=list[PermissionOut])
async def permissions(
    document_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    await service.get_document_for_read(session, user, document_id)
    rows = await list_permissions(session, document_id)
    return [
        PermissionOut(
            id=p.id,
            grantee_type=p.grantee_type,
            grantee_user_id=p.grantee_user_id,
            grantee_role=p.grantee_role,
            permission=p.permission,
            granted_by=p.granted_by,
            granted_at=p.granted_at.isoformat() if p.granted_at else None,
        )
        for p in rows
    ]


@router.post("/{document_id}/permissions", response_model=PermissionOut, status_code=201)
async def add_permission(
    document_id: uuid.UUID,
    payload: GrantRequest,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    await service.get_document_for_read(session, user, document_id)
    try:
        perm = await grant(
            session,
            document_id,
            grantee_type=payload.grantee_type,
            permission=payload.permission,
            grantee_user_id=payload.grantee_user_id,
            grantee_role=payload.grantee_role,
            granted_by=user.id,
        )
    except ValueError as exc:
        # A grant that names no grantee — or names one in the wrong field —
        # is the caller's mistake, not a server fault.
        raise ValidationError(str(exc)) from exc
    await record_audit(
        session,
        actor_id=user.id,
        action="permission.grant",
        resource_type="document",
        resource_id=document_id,
        metadata={
            "grantee_type": payload.grantee_type,
            "grantee_user_id": str(payload.grantee_user_id) if payload.grantee_user_id else None,
            "grantee_role": payload.grantee_role,
            "permission": payload.permission,
        },
    )
    await session.commit()
    return PermissionOut(
        id=perm.id,
        grantee_type=perm.grantee_type,
        grantee_user_id=perm.grantee_user_id,
        grantee_role=perm.grantee_role,
        permission=perm.permission,
        granted_by=perm.granted_by,
        granted_at=perm.granted_at.isoformat() if perm.granted_at else None,
    )


@router.delete("/{document_id}/permissions")
async def remove_permission(
    document_id: uuid.UUID,
    payload: RevokeRequest,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    await service.get_document_for_read(session, user, document_id)
    try:
        removed = await revoke(
            session,
            document_id,
            grantee_type=payload.grantee_type,
            permission=payload.permission,
            grantee_user_id=payload.grantee_user_id,
            grantee_role=payload.grantee_role,
        )
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    await record_audit(
        session,
        actor_id=user.id,
        action="permission.revoke",
        resource_type="document",
        resource_id=document_id,
        metadata={"grantee_type": payload.grantee_type, "permission": payload.permission},
    )
    await session.commit()
    return {"removed": removed}


@router.get("/{document_id}/location", response_model=LocationOut)
async def get_location(
    document_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Where the document physically sits in the archive."""
    document = await service.get_document_for_read(session, user, document_id)
    return LocationOut.of(document)


@router.put("/{document_id}/location", response_model=LocationOut)
async def put_location(
    document_id: uuid.UUID,
    payload: LocationUpdate,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Assign or clear a document's slot. All four parts or none of them."""
    document = await service.get_document_for_manage(session, user, document_id)
    try:
        await service.set_location(
            session, document, payload.zone, payload.rack, payload.shelf, payload.box
        )
    except ValueError as exc:
        # A slot that does not exist, or is already taken, is the caller's
        # mistake — not a server fault.
        raise ValidationError(str(exc)) from exc
    clearing = payload.zone is None and payload.rack is None and payload.shelf is None and payload.box is None
    await record_audit(
        session,
        actor_id=user.id,
        action="document.location.clear" if clearing else "document.location.set",
        resource_type="document",
        resource_id=document_id,
        metadata={
            "zone": document.zone,
            "rack": document.rack,
            "shelf": document.shelf,
            "box": document.box,
        },
    )
    await session.commit()
    return LocationOut.of(document)


@router.post("/{document_id}/location/auto", response_model=LocationOut)
async def auto_location(
    document_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Put the document in the first free slot."""
    document = await service.get_document_for_manage(session, user, document_id)
    try:
        await service.auto_assign_location(session, document)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    await record_audit(
        session,
        actor_id=user.id,
        action="document.location.auto",
        resource_type="document",
        resource_id=document_id,
        metadata={
            "zone": document.zone,
            "rack": document.rack,
            "shelf": document.shelf,
            "box": document.box,
        },
    )
    await session.commit()
    return LocationOut.of(document)


class CheckoutRequest(BaseModel):
    """Request to check out a document. due_at defaults to the configured period."""
    due_at: Optional[str] = None  # ISO datetime; server adds default if omitted


class CheckoutResponse(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    checked_out_by: uuid.UUID
    checked_out_at: str
    due_at: str
    checked_in_at: Optional[str] = None
    checked_in_by: Optional[uuid.UUID] = None


class CheckinResponse(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    checked_out_by: uuid.UUID
    checked_out_at: str
    due_at: str
    checked_in_at: str
    checked_in_by: uuid.UUID


@router.post("/{document_id}/checkout", response_model=CheckoutResponse)
async def checkout_document(
    document_id: uuid.UUID,
    payload: CheckoutRequest,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Physically check a document out of the archive.

    Requires manage access. Defaults due_at to now + the configured checkout
    period. Rejects if the document is already checked out. Records an audit
    entry.
    """
    document = await service.get_document_for_manage(session, user, document_id)
    due_at = None
    if payload.due_at:
        try:
            due_at = datetime.fromisoformat(payload.due_at.replace("Z", "+00:00"))
        except ValueError:
            raise ValidationError("due_at must be an ISO datetime, e.g. 2026-12-01T12:00:00Z")
        if due_at <= datetime.now(timezone.utc):
            raise ValidationError("due_at must be in the future")
    try:
        checkout = await service.check_out_document(session, document, user, due_at)
        await session.commit()
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    return CheckoutResponse(
        id=checkout.id,
        document_id=checkout.document_id,
        checked_out_by=checkout.checked_out_by,
        checked_out_at=checkout.checked_out_at.isoformat(),
        due_at=checkout.due_at.isoformat(),
        checked_in_at=checkout.checked_in_at.isoformat() if checkout.checked_in_at else None,
        checked_in_by=checkout.checked_in_by,
    )


@router.post("/{document_id}/checkin", response_model=CheckinResponse)
async def checkin_document(
    document_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Return a checked-out document to the archive.

    Requires manage access. Rejects if the document is not checked out.
    Records an audit entry.
    """
    document = await service.get_document_for_manage(session, user, document_id)
    try:
        checkout = await service.check_in_document(session, document, user)
        await session.commit()
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    return CheckinResponse(
        id=checkout.id,
        document_id=checkout.document_id,
        checked_out_by=checkout.checked_out_by,
        checked_out_at=checkout.checked_out_at.isoformat(),
        due_at=checkout.due_at.isoformat(),
        checked_in_at=checkout.checked_in_at.isoformat(),
        checked_in_by=checkout.checked_in_by,
    )


@warehouse_router.get("/layout", response_model=WarehouseLayoutOut)
async def warehouse_layout(
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """The warehouse vocabulary and the slots the caller may see filled.

    Only occupied slots are listed, and only those whose document the caller
    may read — an occupied slot is a fact about a document, so a viewer who
    cannot read that document must not learn that it exists. Each slot also
    reports its document's open checkout (who has it out and when it is due),
    its created_at timestamp, and its position within its box (1..N by
    filed-at date). Position is stable across page loads.
    """
    documents = await service.list_occupied_slots(session, user)
    # Group by box to compute position in box (stable: sorted by created_at).
    by_box: dict[tuple[str, str, str, str], list[uuid.UUID]] = {}
    for doc in documents:
        key = (doc.zone, doc.rack, doc.shelf, doc.box)
        by_box.setdefault(key, []).append(doc.id)

    # Compute position_in_box for each document.
    positions: dict[uuid.UUID, dict[str, int]] = {}  # doc_id -> {position, total}
    for key, ids in by_box.items():
        # Fetch documents with created_at (already have them, but need sorting)
        # Re-query to get created_at efficiently - use the existing doc objects
        box_docs = [d for d in documents if (d.zone, d.rack, d.shelf, d.box) == key]
        box_docs.sort(key=lambda d: (d.created_at or "", d.id))
        for pos, doc in enumerate(box_docs, start=1):
            positions[doc.id] = {"position": pos, "total": len(box_docs)}

    checkouts = await service.open_checkouts(session, [doc.id for doc in documents])

    slots = []
    for doc in documents:
        pos_info = positions.get(doc.id, {"position": 1, "total": 1})
        slot_checkout = None
        checkout = checkouts.get(doc.id)
        if checkout is not None and checkout.checkout_user is not None:
            slot_checkout = CheckoutOut(
                by=checkout.checkout_user.display_name,
                dueAt=checkout.due_at.date().isoformat(),
            )
        slots.append(
            WarehouseSlotOut(
                zone=doc.zone,
                rack=doc.rack,
                shelf=doc.shelf,
                box=doc.box,
                document_id=doc.id,
                filename=doc.filename,
                title=doc.title,
                created_at=doc.created_at.isoformat() if doc.created_at else "",
                position=pos_info["position"],
                total_in_box=pos_info["total"],
                checkout=slot_checkout,
            )
        )
    return WarehouseLayoutOut(
        zones=list(service.ZONES),
        racks=list(service.RACKS),
        shelves=list(service.SHELVES),
        boxes=list(service.BOXES),
        slots=slots,
    )


@router.delete("/{document_id}", status_code=204)
async def delete(
    document_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    await service.delete_document(session, user, document_id)
    await record_audit(
        session,
        actor_id=user.id,
        action="document.delete",
        resource_type="document",
        resource_id=document_id,
    )
    await session.commit()

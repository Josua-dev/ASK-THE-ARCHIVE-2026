"""Document upload, listing, preview and download."""

import hashlib
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import ForbiddenError, NotFoundError, ValidationError
from app.core.security import create_signed_link
from app.db.models.chunk import DocumentChunk
from app.db.models.document import Document
from app.db.models.document_checkout import DocumentCheckout
from app.db.models.user import User
from app.modules.documents.permissions import can_access_document, permission_filter
from app.ports.factory import get_storage
from app.shared.audit import record_audit

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")

# The warehouse vocabulary. This is the single source of truth on the
# backend: the frontend reads it from GET /warehouse/layout rather than
# hardcoding it, so the two can never drift apart.
ZONES = ("A", "B", "C", "D")
RACKS = ("R1", "R2", "R3", "R4")
SHELVES = ("1", "2", "3")
BOXES = ("B1", "B2", "B3", "B4", "B5", "B6")

# The middle dot, not a hyphen: the label is read by humans as well as
# machines, and it has to survive a filename or a UI chip unchanged.
LOCATION_SEPARATOR = "·"


def build_key(document_id: uuid.UUID, filename: str) -> str:
    """Opaque but identifiable key: originals are never served by raw filename."""
    safe = _SAFE_NAME.sub("_", filename).strip("._") or "document"
    return f"documents/{document_id}/{safe}"


async def upload_document(
    session: AsyncSession,
    *,
    user: User,
    filename: str,
    content_type: str,
    body: bytes,
) -> Document:
    """Validate and store an uploaded file, returning the pending document."""
    if not filename:
        raise ValidationError("A filename is required")
    if content_type not in settings.allowed_mime_types_list:
        raise ValidationError(
            f"Unsupported file type '{content_type}'. Allowed: "
            + ", ".join(settings.allowed_mime_types_list)
        )
    max_bytes = settings.max_upload_mb * 1024 * 1024
    if len(body) == 0:
        raise ValidationError("The uploaded file is empty")
    if len(body) > max_bytes:
        raise ValidationError(f"File exceeds the {settings.max_upload_mb} MB limit")

    document_id = uuid.uuid4()
    key = build_key(document_id, filename)
    checksum = hashlib.sha256(body).hexdigest()

    storage = get_storage()
    await storage.put_object(
        key, body, content_type, metadata={"filename": filename, "uploaded_by": str(user.id)}
    )

    document = Document(
        id=document_id,
        storage_key=key,
        filename=filename,
        content_type=content_type,
        byte_size=len(body),
        checksum_sha256=checksum,
        status="uploaded",
        uploaded_by=user.id,
        created_at=datetime.now(timezone.utc),
    )
    session.add(document)
    await session.flush()
    # Every uploaded document is located, so the warehouse map is populated
    # from the first upload rather than only after someone assigns slots.
    await auto_assign_location(session, document)
    return document


async def get_document_for_read(
    session: AsyncSession, user: User, document_id: uuid.UUID
) -> Document:
    document = await session.get(Document, document_id)
    if document is None:
        raise NotFoundError("Document not found")
    if not await can_access_document(session, user, document_id, need="view"):
        raise ForbiddenError("You do not have access to this document")
    return document


async def get_document_for_manage(
    session: AsyncSession, user: User, document_id: uuid.UUID
) -> Document:
    """Fetch a document the caller is allowed to change, not just read."""
    document = await session.get(Document, document_id)
    if document is None:
        raise NotFoundError("Document not found")
    if not await can_access_document(session, user, document_id, need="manage"):
        raise ForbiddenError("You do not have permission to manage this document")
    return document


async def list_documents(
    session: AsyncSession,
    user: User,
    *,
    doc_type: Optional[str] = None,
    status: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[Document], int]:
    """List only the documents the user may read."""
    conditions = list(permission_filter(user))
    if doc_type:
        conditions.append(Document.doc_type == doc_type)
    if status:
        conditions.append(Document.status == status)
    if search:
        conditions.append(Document.filename.ilike(f"%{search}%"))

    total = await session.scalar(select(func.count()).select_from(Document).where(*conditions))
    stmt = (
        select(Document)
        .where(*conditions)
        .order_by(Document.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows), int(total or 0)


async def document_chunks(
    session: AsyncSession, document_id: uuid.UUID
) -> list[DocumentChunk]:
    stmt = (
        select(DocumentChunk)
        .where(DocumentChunk.document_id == document_id)
        .order_by(DocumentChunk.chunk_index)
    )
    return list((await session.execute(stmt)).scalars().all())


async def get_download_url(
    session: AsyncSession, user: User, document_id: uuid.UUID
) -> tuple[str, int]:
    """Permission-checked download. Returns (url, expires_in_seconds).

    The URL points at the local raw-file route and carries a short-lived HMAC
    token bound to this one document. The route re-checks the signed scope
    before it reads anything from disk, so the token cannot be replayed
    against another document or another endpoint.
    """
    document = await session.get(Document, document_id)
    if document is None:
        raise NotFoundError("Document not found")
    if not await can_access_document(session, user, document_id, need="download"):
        raise ForbiddenError("You do not have permission to download this document")
    expires = settings.signed_link_ttl_sec
    token = create_signed_link(
        scope=f"download:{document_id}", secret=settings.jwt_secret, ttl_sec=expires
    )
    url = f"/api/v1/documents/raw/{document_id}?token={token}"
    return url, expires


async def delete_document(session: AsyncSession, user: User, document_id: uuid.UUID) -> None:
    document = await session.get(Document, document_id)
    if document is None:
        raise NotFoundError("Document not found")
    if user.role != "admin" and not await can_access_document(
        session, user, document_id, need="manage"
    ):
        raise ForbiddenError("You do not have permission to delete this document")
    await session.delete(document)
    await session.flush()


def validate_location(
    zone: Optional[str], rack: Optional[str], shelf: Optional[str], box: Optional[str]
) -> None:
    """Check a location tuple against the warehouse vocabulary.

    A document is either fully located or not located at all. A partial
    location ("Zone A but which rack?") names a place that does not exist, so
    it is refused rather than stored.
    """
    parts = (zone, rack, shelf, box)
    if all(part is None for part in parts):
        return
    if any(part is None for part in parts):
        raise ValueError(
            "A location must name all four parts (zone, rack, shelf, box) or none of them"
        )
    vocabularies = (
        ("zone", zone, ZONES),
        ("rack", rack, RACKS),
        ("shelf", shelf, SHELVES),
        ("box", box, BOXES),
    )
    for name, value, allowed in vocabularies:
        if value not in allowed:
            raise ValueError(
                f"Unknown {name} '{value}'. Allowed: {', '.join(allowed)}"
            )


def build_location_label(
    zone: Optional[str], rack: Optional[str], shelf: Optional[str], box: Optional[str]
) -> Optional[str]:
    """The human-readable path to a slot, or None when there is no location."""
    if zone is None or rack is None or shelf is None or box is None:
        return None
    return f" {LOCATION_SEPARATOR} ".join(
        (f"Zone {zone}", f"Rack {rack}", f"Shelf {shelf}", f"Box {box}")
    )


async def find_first_free_slot(
    session: AsyncSession, exclude_document_id: Optional[uuid.UUID] = None
) -> tuple[str, str, str, str]:
    """The vocabulary slot that currently holds fewest documents.

    A box may hold many documents, so no slot is ever "full": this simply
    spreads uploads across the archive by picking the least-used slot, breaking
    ties by vocabulary order. Position inside a box is decided by filed-at
    date, not by the slot itself, so a box filling up is not a problem.

    ``exclude_document_id`` keeps the document being re-located from counting
    against its own slot, so it stays put when that slot is already the least
    used.
    """
    stmt = (
        select(
            Document.zone,
            Document.rack,
            Document.shelf,
            Document.box,
            func.count(Document.id),
        )
        .where(
            Document.zone.isnot(None),
            Document.rack.isnot(None),
            Document.shelf.isnot(None),
            Document.box.isnot(None),
        )
        .group_by(Document.zone, Document.rack, Document.shelf, Document.box)
    )
    if exclude_document_id is not None:
        stmt = stmt.where(Document.id != exclude_document_id)
    counts = {
        (zone, rack, shelf, box): count
        for zone, rack, shelf, box, count in (await session.execute(stmt)).all()
    }

    best: Optional[tuple[str, str, str, str]] = None
    best_count: Optional[int] = None
    for zone in ZONES:
        for rack in RACKS:
            for shelf in SHELVES:
                for box in BOXES:
                    count = counts.get((zone, rack, shelf, box), 0)
                    if best_count is None or count < best_count:
                        best = (zone, rack, shelf, box)
                        best_count = count
    assert best is not None
    return best


async def assign_slot(
    session: AsyncSession,
    document: Document,
    zone: str,
    rack: str,
    shelf: str,
    box: str,
) -> None:
    """Move a document into a specific slot.

    A box may hold any number of documents, so an occupied slot is no longer
    refused — several documents can share a zone/rack/shelf/box, and each one's
    position inside the box is decided by its filed-at date. The flush is still
    wrapped so a failure leaves the document's in-memory location untouched.
    """
    previous = (document.zone, document.rack, document.shelf, document.box)
    document.zone = zone
    document.rack = rack
    document.shelf = shelf
    document.box = box
    try:
        async with session.begin_nested():
            await session.flush()
    except Exception as exc:
        document.zone, document.rack, document.shelf, document.box = previous
        raise ValueError(
            f"Could not assign Zone {zone} · Rack {rack} · Shelf {shelf} · Box {box}"
        ) from exc


async def set_location(
    session: AsyncSession,
    document: Document,
    zone: Optional[str],
    rack: Optional[str],
    shelf: Optional[str],
    box: Optional[str],
) -> None:
    """Assign or clear a document's location. Raises ValueError on bad input."""
    validate_location(zone, rack, shelf, box)
    if zone is None:
        await clear_location(session, document)
        return
    await assign_slot(session, document, zone, rack, shelf, box)


async def clear_location(session: AsyncSession, document: Document) -> None:
    """Return a document to the unlocated state."""
    document.zone = None
    document.rack = None
    document.shelf = None
    document.box = None
    await session.flush()


async def auto_assign_location(session: AsyncSession, document: Document) -> None:
    """Give a document the first free slot, so nothing is left unlocated."""
    zone, rack, shelf, box = await find_first_free_slot(
        session, exclude_document_id=document.id
    )
    await assign_slot(session, document, zone, rack, shelf, box)


async def list_occupied_slots(
    session: AsyncSession, user: User
) -> list[Document]:
    """The located documents the caller may read.

    A viewer must never learn that a slot is occupied by a document they
    cannot read, so this goes through the same permission filter as the
    document list.
    """
    stmt = (
        select(Document)
        .where(
            Document.zone.isnot(None),
            Document.rack.isnot(None),
            Document.shelf.isnot(None),
            Document.box.isnot(None),
            *permission_filter(user),
        )
        .order_by(Document.zone, Document.rack, Document.shelf, Document.box)
    )
    return list((await session.execute(stmt)).scalars().all())


async def position_in_box(
    session: AsyncSession, document: Document
) -> tuple[int, int] | None:
    """(position, total) of the document within its box, ordered by filed-at date.

    Position is stable: filed-at (created_at) never changes, and ties break by
    document id. Returns None when the document has no location.
    """
    if document.zone is None or document.rack is None or document.shelf is None or document.box is None:
        return None
    stmt = (
        select(Document.id)
        .where(
            Document.zone == document.zone,
            Document.rack == document.rack,
            Document.shelf == document.shelf,
            Document.box == document.box,
        )
        .order_by(Document.created_at, Document.id)
    )
    ids = [row[0] for row in (await session.execute(stmt)).all()]
    try:
        position = ids.index(document.id) + 1
    except ValueError:
        return None
    return position, len(ids)


async def open_checkouts(
    session: AsyncSession, document_ids: list[uuid.UUID]
) -> dict[uuid.UUID, DocumentCheckout]:
    """Open checkouts for the given documents, keyed by document_id.

    Only returns checkouts where checked_in_at IS NULL (i.e. the document is
    still out). The caller is expected to filter by permission first, so this
    does not repeat the permission filter. The checkout_user relationship is
    eager-loaded so the router can read display_name without a lazy load.
    """
    if not document_ids:
        return {}
    from app.db.models.document_checkout import DocumentCheckout
    from sqlalchemy.orm import selectinload

    stmt = (
        select(DocumentCheckout)
        .where(
            DocumentCheckout.document_id.in_(document_ids),
            DocumentCheckout.checked_in_at.is_(None),
        )
        .options(selectinload(DocumentCheckout.checkout_user))
    )
    checkouts = (await session.execute(stmt)).scalars().all()
    return {c.document_id: c for c in checkouts}


async def check_out_document(
    session: AsyncSession,
    document: Document,
    user: User,
    due_at: datetime | None = None,
) -> DocumentCheckout:
    """Check a document out of the archive.

    Runs in a transaction with a row lock on the document. Rejects if the
    document is already checked out. Defaults due_at to now + the configured
    default due period. Records an audit entry.
    """
    from app.db.models.document_checkout import DocumentCheckout
    from datetime import timedelta

    # Row lock on the document so two concurrent check-outs cannot both succeed.
    stmt = select(Document).where(Document.id == document.id).with_for_update()
    (await session.execute(stmt)).scalar_one()

    # Check for existing open checkout.
    open_co = await session.execute(
        select(DocumentCheckout).where(
            DocumentCheckout.document_id == document.id,
            DocumentCheckout.checked_in_at.is_(None),
        )
    )
    if open_co.scalar_one_or_none() is not None:
        raise ValueError(f"Document {document.filename} is already checked out")

    if due_at is None:
        due_at = datetime.now(timezone.utc) + timedelta(days=settings.checkout_default_due_days)

    checkout = DocumentCheckout(
        document_id=document.id,
        checked_out_by=user.id,
        checked_out_at=datetime.now(timezone.utc),
        due_at=due_at,
    )
    session.add(checkout)
    await session.flush()

    await record_audit(
        session,
        actor_id=user.id,
        action="document.checkout",
        resource_type="document",
        resource_id=document.id,
        metadata={"due_at": due_at.isoformat()},
    )
    return checkout


async def check_in_document(
    session: AsyncSession,
    document: Document,
    user: User,
) -> DocumentCheckout:
    """Return a checked-out document to the archive.

    Runs in a transaction with a row lock on the document. Rejects if the
    document is not checked out. Records an audit entry.
    """
    from app.db.models.document_checkout import DocumentCheckout

    # Row lock on the document.
    stmt = select(Document).where(Document.id == document.id).with_for_update()
    (await session.execute(stmt)).scalar_one()

    stmt = select(DocumentCheckout).where(
        DocumentCheckout.document_id == document.id,
        DocumentCheckout.checked_in_at.is_(None),
    )
    checkout = (await session.execute(stmt)).scalar_one_or_none()
    if checkout is None:
        raise ValueError(f"Document {document.filename} is not checked out")

    checkout.checked_in_at = datetime.now(timezone.utc)
    checkout.checked_in_by = user.id
    await session.flush()

    await record_audit(
        session,
        actor_id=user.id,
        action="document.checkin",
        resource_type="document",
        resource_id=document.id,
        metadata={"checkout_id": str(checkout.id)},
    )
    return checkout

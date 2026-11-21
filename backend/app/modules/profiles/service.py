"""Document intelligence profiles.

A profile is a structured reading of a single document: who the parties are,
which dates matter, what the money is, which obligations exist. Every field
carries the page it was read from, so a reader can open the source page and
check it.

Generating a profile also refreshes the archive's entity index. The same
organisation named in three documents becomes one `ExtractedEntity` with three
mentions, which is what lets the Knowledge Graph show real relationships
rather than invented ones.
"""

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models.chunk import DocumentChunk
from app.db.models.document import Document
from app.db.models.document_profile import DocumentProfile
from app.db.models.extracted_entity import EntityMention, ExtractedEntity
from app.db.models.user import User
from app.ports.factory import get_llm
from app.shared.llm_json import (
    as_float,
    as_int,
    as_str,
    as_str_list,
    clamp,
    first_sentence_containing,
    parse_json_object,
)

# The list columns of a profile, in the order the model is asked for them.
LIST_FIELDS = (
    "parties",
    "organisations",
    "individuals",
    "important_dates",
    "monetary_values",
    "contract_references",
    "important_clauses",
    "obligations",
)

# Which entity kind each list contributes to the entity index.
ENTITY_KIND_BY_FIELD = {
    "parties": "organisation",
    "organisations": "organisation",
    "individuals": "person",
}

PROFILE_SYSTEM_PROMPT = """You extract structured facts from a single document.

Return ONE JSON object and nothing else. No prose before it, no prose after it.

The object must have exactly these keys:
  doc_type             string, one of: contract, lease, invoice, report, policy, nda, other
  parties              list of {"name": string, "role": string, "page": integer}
  organisations        list of {"name": string, "page": integer}
  individuals          list of {"name": string, "role": string, "page": integer}
  important_dates      list of {"label": string, "date": "YYYY-MM-DD", "page": integer}
  monetary_values      list of {"label": string, "amount": number, "currency": string, "page": integer}
  currency             string, the single dominant currency of the document, or null
  contract_references  list of {"reference": string, "page": integer}
  important_clauses    list of {"title": string, "text": string, "page": integer}
  obligations          list of {"text": string, "party": string, "due": "YYYY-MM-DD", "page": integer}
  keywords             list of strings
  related_documents    list of {"document_id": string, "reason": string}
  source_refs          list of {"field": string, "page": integer, "excerpt": string}

Rules you must not break:
- Every entry must carry the "page" number it was read from. The context is
  labelled with page ranges like [p1-3]; use the page the fact appears on.
- A field with no supporting passage MUST be an empty list, and a field with
  no supporting passage MUST be null. An empty list is always better than a
  guess.
- Never invent a party, a date, an amount, a reference or a clause. If the
  document does not state it, leave it out.
- "related_documents" may be an empty list. Only name a document_id if the
  text of this document explicitly refers to that exact identifier.
- "source_refs" must point at the field it supports and quote the passage
  briefly, in the document's own words.
- Return only the JSON object."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def load_document_chunks(
    session: AsyncSession, document_id: uuid.UUID
) -> list[DocumentChunk]:
    """The document's chunks in reading order."""
    stmt = (
        select(DocumentChunk)
        .where(DocumentChunk.document_id == document_id)
        .order_by(DocumentChunk.chunk_index)
    )
    return list((await session.execute(stmt)).scalars().all())


def build_context(chunks: list[DocumentChunk], limit: int) -> str:
    """Label each chunk with its page range so the model can cite pages."""
    blocks: list[str] = []
    used = 0
    for chunk in chunks:
        block = f"[p{chunk.page_start}-{chunk.page_end}] {chunk.text.strip()}"
        if used + len(block) > limit and blocks:
            break
        blocks.append(block)
        used += len(block) + 2
    return "\n\n".join(blocks)


def _normalise_entries(raw: Any) -> list[dict]:
    """Coerce one list column into a list of clean dictionaries.

    Model output is untrusted: entries that are not objects are dropped,
    values that are not strings become None, and page numbers must be
    integers.
    """
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        clean: dict[str, Any] = {}
        for key, value in entry.items():
            if key == "page":
                clean[key] = as_int(value)
            elif key == "amount":
                clean[key] = as_float(value)
            else:
                clean[key] = as_str(value)
        out.append(clean)
    return out


def _normalise_source_refs(raw: Any) -> list[dict]:
    refs: list[dict] = []
    for entry in _normalise_entries(raw):
        field = entry.get("field")
        if not field:
            continue
        refs.append(
            {
                "field": field,
                "page": entry.get("page"),
                "excerpt": entry.get("excerpt") or "",
            }
        )
    return refs


def _normalise_related(raw: Any) -> list[dict]:
    related: list[dict] = []
    for entry in _normalise_entries(raw):
        document_id = entry.get("document_id")
        if not document_id:
            continue
        try:
            uuid.UUID(document_id)
        except (ValueError, TypeError):
            continue
        related.append({"document_id": document_id, "reason": entry.get("reason") or ""})
    return related


async def _entity_for(
    session: AsyncSession, kind: str, name: str, role: Optional[str]
) -> ExtractedEntity:
    """Find or create the canonical entity for a name.

    Matching on (kind, normalized_name) is what links the same organisation
    across documents into one graph node.
    """
    normalized = name.strip().casefold()
    stmt = select(ExtractedEntity).where(
        ExtractedEntity.kind == kind,
        ExtractedEntity.normalized_name == normalized,
    )
    entity = (await session.execute(stmt)).scalars().first()
    if entity is None:
        entity = ExtractedEntity(
            id=uuid.uuid4(),
            kind=kind,
            name=name.strip(),
            normalized_name=normalized,
            attributes={"role": role} if role else {},
            mention_count=0,
            first_seen_at=_now(),
            last_seen_at=_now(),
        )
        session.add(entity)
        await session.flush()
    elif role and not entity.attributes.get("role"):
        entity.attributes = {**(entity.attributes or {}), "role": role}
    return entity


async def _clear_document_mentions(
    session: AsyncSession, document_id: uuid.UUID
) -> None:
    """Remove the previous mentions for a document before re-extracting.

    Counts are decremented so `mention_count` stays a true archive-wide
    number rather than a per-run tally.
    """
    existing = (
        await session.execute(
            select(EntityMention).where(EntityMention.document_id == document_id)
        )
    ).scalars().all()
    if not existing:
        return

    by_entity: dict[uuid.UUID, int] = {}
    for mention in existing:
        by_entity[mention.entity_id] = by_entity.get(mention.entity_id, 0) + 1

    entity_ids = list(by_entity)
    entities = (
        await session.execute(
            select(ExtractedEntity).where(ExtractedEntity.id.in_(entity_ids))
        )
    ).scalars().all()
    for entity in entities:
        entity.mention_count = max(0, (entity.mention_count or 0) - by_entity[entity.id])

    await session.execute(
        delete(EntityMention).where(EntityMention.document_id == document_id)
    )


async def _sync_entities(
    session: AsyncSession,
    document: Document,
    chunks: list[DocumentChunk],
    lists: dict[str, list[dict]],
) -> int:
    """Rebuild the entity index for a document from the profile's facts.

    Returns the number of distinct entities recorded.
    """
    await _clear_document_mentions(session, document.id)

    # Index chunks by page so a mention can be anchored to the passage it
    # was read from.
    by_page: dict[int, DocumentChunk] = {}
    for chunk in chunks:
        for page in range(chunk.page_start, chunk.page_end + 1):
            by_page.setdefault(page, chunk)

    recorded = 0
    seen: set[tuple[str, str]] = set()

    for field, kind in ENTITY_KIND_BY_FIELD.items():
        for entry in lists.get(field, []):
            name = entry.get("name")
            if not name:
                continue
            key = (kind, name.casefold())
            if key in seen:
                continue
            seen.add(key)

            entity = await _entity_for(session, kind, name, entry.get("role"))
            entity.mention_count = (entity.mention_count or 0) + 1
            entity.last_seen_at = _now()
            if entity.first_seen_at is None:
                entity.first_seen_at = _now()

            page = entry.get("page")
            chunk = by_page.get(page) if isinstance(page, int) else None
            excerpt = first_sentence_containing(
                chunk.text if chunk else "", name
            ) or name

            session.add(
                EntityMention(
                    id=uuid.uuid4(),
                    entity_id=entity.id,
                    document_id=document.id,
                    chunk_id=chunk.id if chunk else None,
                    page_start=chunk.page_start if chunk else (page if isinstance(page, int) else None),
                    page_end=chunk.page_end if chunk else (page if isinstance(page, int) else None),
                    excerpt=excerpt,
                    created_at=_now(),
                )
            )
            recorded += 1

    await session.flush()
    return recorded


async def generate_profile(
    session: AsyncSession,
    user: User,
    document: Document,
    *,
    instruction: Optional[str] = None,
) -> tuple[DocumentProfile, bool, str, int]:
    """Extract a profile from a document.

    Returns the profile, whether the model produced usable output, a short
    human-readable status, and the number of entities recorded.
    """
    chunks = await load_document_chunks(session, document.id)
    if not chunks:
        raise ValueError("This document has not been indexed yet")

    context = build_context(chunks, settings.max_context_chars)
    question = (instruction or "").strip() or "Produce a structured profile of this document."

    response = await get_llm().generate(PROFILE_SYSTEM_PROMPT, context, question)
    parsed = parse_json_object(response.text)

    if parsed is None:
        # The model returned something we cannot read. Record an empty
        # profile rather than inventing one.
        lists: dict[str, list[dict]] = {field: [] for field in LIST_FIELDS}
        lists["keywords"] = []
        lists["related_documents"] = []
        lists["source_refs"] = []
        doc_type = document.doc_type
        currency = None
        confidence = 0.0
        model = response.model
        usable = False
    else:
        lists = {field: _normalise_entries(parsed.get(field)) for field in LIST_FIELDS}
        lists["keywords"] = as_str_list(parsed.get("keywords"))
        lists["related_documents"] = _normalise_related(parsed.get("related_documents"))
        lists["source_refs"] = _normalise_source_refs(parsed.get("source_refs"))
        doc_type = as_str(parsed.get("doc_type")) or document.doc_type
        currency = as_str(parsed.get("currency"))
        confidence = clamp(as_float(parsed.get("confidence")), 0.0, 1.0) or 0.7
        model = response.model
        usable = True

    stored = (
        await session.execute(
            select(DocumentProfile).where(DocumentProfile.document_id == document.id)
        )
    ).scalars().first()

    if stored is None:
        stored = DocumentProfile(
            id=uuid.uuid4(),
            document_id=document.id,
            created_at=_now(),
        )
        session.add(stored)

    stored.doc_type = doc_type
    stored.parties = lists["parties"]
    stored.organisations = lists["organisations"]
    stored.individuals = lists["individuals"]
    stored.important_dates = lists["important_dates"]
    stored.monetary_values = lists["monetary_values"]
    stored.currency = currency
    stored.contract_references = lists["contract_references"]
    stored.important_clauses = lists["important_clauses"]
    stored.obligations = lists["obligations"]
    stored.keywords = lists["keywords"]
    stored.related_documents = lists["related_documents"]
    stored.source_refs = lists["source_refs"]
    stored.confidence = confidence
    stored.model = model
    stored.updated_at = _now()

    await session.flush()

    entities_recorded = await _sync_entities(session, document, chunks, lists)

    message = (
        "Profile generated."
        if usable
        else "The model output could not be parsed, so an empty profile was recorded."
    )
    return stored, usable, message, entities_recorded


async def get_profile(
    session: AsyncSession, document_id: uuid.UUID
) -> Optional[DocumentProfile]:
    """The stored profile for a document, or None."""
    stmt = select(DocumentProfile).where(DocumentProfile.document_id == document_id)
    return (await session.execute(stmt)).scalars().first()


def filter_related_documents(
    profile: DocumentProfile, permitted_ids: set[uuid.UUID]
) -> list[dict]:
    """Drop related documents the reader is not allowed to see.

    A profile may mention a document the caller cannot open. Naming it would
    leak the fact that it exists.
    """
    out: list[dict] = []
    for entry in profile.related_documents or []:
        if not isinstance(entry, dict):
            continue
        raw_id = entry.get("document_id")
        try:
            document_id = uuid.UUID(str(raw_id))
        except (ValueError, TypeError):
            continue
        if document_id in permitted_ids:
            out.append({"document_id": str(document_id), "reason": entry.get("reason") or ""})
    return out

"""Extraction Studio — pull structured rows out of documents.

The user describes what they want in plain language and optionally names the
columns. The model reads the selected documents and returns rows, each cell
carrying a provenance record.

That provenance is the point of the module. Every value the model produced is
checked back against the source text: the quoted excerpt must actually occur
on the cited page of the cited document. A cell whose evidence cannot be found
is blanked rather than kept, because a spreadsheet full of plausible numbers
with no traceable source is worse than an empty one.
"""

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models.chunk import DocumentChunk
from app.db.models.document import Document
from app.db.models.extraction_run import ExtractionRow, ExtractionRun
from app.db.models.user import User
from app.ports.factory import get_llm
from app.shared.llm_json import (
    as_float,
    as_int,
    as_str,
    contains_text,
    parse_json_object,
)

# The column types the studio understands.
COLUMN_TYPES = ("text", "number", "date", "currency", "boolean")

# How many documents one extraction pass may read.
MAX_DOCUMENTS = 12

EXTRACTION_SYSTEM_PROMPT = """You extract structured records from documents.

Return ONE JSON object and nothing else. No prose before it, no prose after it.

The object must have exactly these keys:
  columns  list of {"key": string, "label": string, "type": string}
  rows     list of {"values": {column_key: value}, "citations": [objects]}

Each citation object must have these keys:
  column    the key of the column the value came from
  document  the document number, matching the [D1], [D2] ... labels in the context
  page      the page number the value appears on
  excerpt   the text copied verbatim from that page

Rules you must not break:
- One row per record. A record that spans several documents still gets one
  row, with its citations pointing at each document it came from.
- Every value you return MUST have at least one citation in the same row.
  A value with no citation is not allowed.
- The excerpt must be copied exactly from the page. Do not paraphrase it.
- If the documents do not contain the records, return an empty rows list.
- Never invent a record, a value or a document number.
- Use only these column types: text, number, date, currency, boolean.
- Return only the JSON object."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def load_chunks(
    session: AsyncSession, document_id: uuid.UUID
) -> list[DocumentChunk]:
    stmt = (
        select(DocumentChunk)
        .where(DocumentChunk.document_id == document_id)
        .order_by(DocumentChunk.chunk_index)
    )
    return list((await session.execute(stmt)).scalars().all())


def build_context(
    documents: list[Document], chunks_by_doc: dict[uuid.UUID, list[DocumentChunk]]
) -> str:
    """Present each document with a stable [Dn] label and page ranges."""
    blocks: list[str] = []
    used = 0

    for index, document in enumerate(documents, start=1):
        header = f"=== [D{index}] {document.filename} ==="
        if used + len(header) > settings.max_context_chars:
            break
        blocks.append(header)
        used += len(header) + 2

        for chunk in chunks_by_doc.get(document.id, []):
            block = f"[D{index} p{chunk.page_start}-{chunk.page_end}] {chunk.text.strip()}"
            if used + len(block) > settings.max_context_chars:
                break
            blocks.append(block)
            used += len(block) + 2

    return "\n\n".join(blocks)


def _page_index(
    chunks_by_doc: dict[uuid.UUID, list[DocumentChunk]]
) -> dict[uuid.UUID, dict[int, DocumentChunk]]:
    """Map (document, page) to the chunk covering that page."""
    index: dict[uuid.UUID, dict[int, DocumentChunk]] = {}
    for document_id, chunks in chunks_by_doc.items():
        pages: dict[int, DocumentChunk] = {}
        for chunk in chunks:
            for page in range(chunk.page_start, chunk.page_end + 1):
                pages.setdefault(page, chunk)
        index[document_id] = pages
    return index


def _coerce(value, column_type: str):
    """Turn a model value into the type the column declares."""
    if column_type == "number" or column_type == "currency":
        number = as_float(value)
        return number
    if column_type == "date":
        return as_str(value)
    if column_type == "boolean":
        if isinstance(value, bool):
            return value
        text = (as_str(value) or "").strip().casefold()
        if text in {"true", "yes", "y", "1"}:
            return True
        if text in {"false", "no", "n", "0"}:
            return False
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return as_str(value)


def _verify_citation(
    citation,
    documents_by_index: dict[int, Document],
    page_index: dict[uuid.UUID, dict[int, DocumentChunk]],
    valid_columns: set[str],
) -> Optional[dict]:
    """Check a citation against the real document text.

    Returns the canonical provenance record when the excerpt genuinely occurs
    on the cited page, otherwise None.
    """
    if not isinstance(citation, dict):
        return None

    column = as_str(citation.get("column"))
    if not column or column not in valid_columns:
        return None

    document_number = as_int(citation.get("document"))
    if document_number is None or document_number not in documents_by_index:
        return None
    document = documents_by_index[document_number]

    excerpt = as_str(citation.get("excerpt"))
    if not excerpt:
        return None

    page = as_int(citation.get("page"))
    pages = page_index.get(document.id, {})

    candidates = []
    if page is not None and page in pages:
        candidates.append(pages[page])
    else:
        candidates.extend(pages.values())

    for chunk in candidates:
        if page is not None and not (chunk.page_start <= page <= chunk.page_end):
            continue
        if not contains_text(chunk.text, excerpt):
            continue
        return {
            "column": column,
            "document_id": str(document.id),
            "filename": document.filename,
            "page": page if page is not None else chunk.page_start,
            "excerpt": excerpt,
        }
    return None


def _normalise_columns(raw, requested: list[dict]) -> list[dict]:
    """The column set for the run: the caller's if given, else the model's."""
    if requested:
        out: list[dict] = []
        for column in requested:
            key = as_str(column.get("key"))
            label = as_str(column.get("label"))
            column_type = as_str(column.get("type")) or "text"
            if not key:
                continue
            out.append(
                {
                    "key": key,
                    "label": label or key.replace("_", " ").title(),
                    "type": column_type if column_type in COLUMN_TYPES else "text",
                }
            )
        return out

    out = []
    if isinstance(raw, list):
        for column in raw:
            if not isinstance(column, dict):
                continue
            key = as_str(column.get("key"))
            if not key:
                continue
            column_type = as_str(column.get("type")) or "text"
            out.append(
                {
                    "key": key,
                    "label": as_str(column.get("label")) or key.replace("_", " ").title(),
                    "type": column_type if column_type in COLUMN_TYPES else "text",
                }
            )
    return out


async def run_extraction(
    session: AsyncSession,
    user: User,
    documents: list[Document],
    *,
    instruction: str,
    requested_columns: Optional[list[dict]] = None,
    max_rows: int = 200,
) -> tuple[ExtractionRun, bool]:
    """Run an extraction over the given documents and persist the result."""
    run = ExtractionRun(
        id=uuid.uuid4(),
        instruction=instruction.strip(),
        status="running",
        columns=[],
        row_count=0,
        created_by=user.id,
        created_at=_now(),
    )
    session.add(run)
    await session.flush()

    chunks_by_doc: dict[uuid.UUID, list[DocumentChunk]] = {}
    for document in documents:
        chunks = await load_chunks(session, document.id)
        if chunks:
            chunks_by_doc[document.id] = chunks

    usable_documents = [d for d in documents if d.id in chunks_by_doc]
    if not usable_documents:
        run.status = "failed"
        run.error = "None of the selected documents have been indexed yet."
        run.completed_at = _now()
        await session.flush()
        return run, False

    context = build_context(usable_documents, chunks_by_doc)
    documents_by_index = {i: d for i, d in enumerate(usable_documents, start=1)}
    page_index = _page_index(chunks_by_doc)

    response = await get_llm().generate(
        EXTRACTION_SYSTEM_PROMPT, context, instruction.strip()
    )
    parsed = parse_json_object(response.text)

    columns = _normalise_columns(
        parsed.get("columns") if parsed else None, requested_columns or []
    )
    run.columns = columns
    run.model = response.model
    run.question = instruction.strip()

    if parsed is None or not columns:
        run.status = "completed" if parsed is not None else "failed"
        if parsed is None:
            run.error = "The model output could not be parsed, so no rows were extracted."
        run.completed_at = _now()
        await session.flush()
        return run, parsed is not None

    valid_columns = {column["key"] for column in columns}
    types_by_key = {column["key"]: column["type"] for column in columns}

    raw_rows = parsed.get("rows") if isinstance(parsed.get("rows"), list) else []
    kept = 0

    for index, raw_row in enumerate(raw_rows[:max_rows]):
        if not isinstance(raw_row, dict):
            continue
        values = raw_row.get("values")
        if not isinstance(values, dict):
            continue

        citations_raw = raw_row.get("citations")
        citations_raw = citations_raw if isinstance(citations_raw, list) else []

        verified: list[dict] = []
        for citation in citations_raw:
            canonical = _verify_citation(
                citation, documents_by_index, page_index, valid_columns
            )
            if canonical is not None:
                verified.append(canonical)

        # A value is only kept when a citation for that column was found in
        # the source text.
        verified_columns = {c["column"] for c in verified}
        data: dict = {}
        for key in valid_columns:
            if key not in values:
                continue
            if key not in verified_columns:
                continue
            coerced = _coerce(values[key], types_by_key.get(key, "text"))
            if coerced is None or coerced == "":
                continue
            data[key] = coerced

        if not data:
            # Nothing in this row survived verification.
            continue

        row_document_id: Optional[uuid.UUID] = None
        if verified:
            try:
                row_document_id = uuid.UUID(verified[0]["document_id"])
            except (ValueError, TypeError):
                row_document_id = None

        session.add(
            ExtractionRow(
                id=uuid.uuid4(),
                run_id=run.id,
                row_index=kept,
                data=data,
                document_id=row_document_id,
                citations=verified,
                created_at=_now(),
            )
        )
        kept += 1

    run.row_count = kept
    run.status = "completed"
    run.completed_at = _now()
    await session.flush()
    return run, True


async def list_runs(
    session: AsyncSession,
    user: User,
    *,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[ExtractionRun], int]:
    """The caller's extraction runs, newest first."""
    total = int(
        await session.scalar(
            select(func.count())
            .select_from(ExtractionRun)
            .where(ExtractionRun.created_by == user.id)
        )
        or 0
    )
    stmt = (
        select(ExtractionRun)
        .where(ExtractionRun.created_by == user.id)
        .order_by(ExtractionRun.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    rows = list((await session.execute(stmt)).scalars().all())
    return rows, total


async def rows_for(session: AsyncSession, run_id: uuid.UUID) -> list[ExtractionRow]:
    stmt = (
        select(ExtractionRow)
        .where(ExtractionRow.run_id == run_id)
        .order_by(ExtractionRow.row_index)
    )
    return list((await session.execute(stmt)).scalars().all())

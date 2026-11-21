"""AI document comparison.

Two documents are compared by giving the model both of their texts, clearly
separated, and asking for the differences. The interesting part is what
happens afterwards: every citation the model produces is checked against the
source text. A finding survives only if the quoted excerpt really appears on
the cited page of the cited document. A finding whose evidence cannot be
found is dropped, because a plausible-looking comparison with an invented
quote is worse than no comparison at all.
"""

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models.chunk import DocumentChunk
from app.db.models.comparison import ComparisonFinding, DocumentComparison
from app.db.models.document import Document
from app.db.models.user import User
from app.ports.factory import get_llm
from app.shared.llm_json import as_int, as_str, contains_text, parse_json_object

# The kinds of difference the comparison reports.
FINDING_KINDS = (
    "added",
    "removed",
    "modified",
    "changed_date",
    "changed_value",
    "different_obligation",
    "inconsistency",
)

SEVERITIES = ("info", "low", "medium", "high")

DEFAULT_INSTRUCTION = (
    "Identify the differences between these two documents: clauses, dates, monetary values, "
    "obligations, and any inconsistencies between them."
)

COMPARE_SYSTEM_PROMPT = """You compare two documents and report their differences.

Return ONE JSON object and nothing else. No prose before it, no prose after it.

The object must have exactly these keys:
  summary   string, a short prose summary of the overall difference
  findings  list of objects, each with these keys:
      kind        one of: added, removed, modified, changed_date, changed_value,
                  different_obligation, inconsistency
      category    string, the area of the document the difference sits in
      title       string, a short headline for the difference
      detail      string, one or two sentences describing it
      severity    one of: info, low, medium, high
      citation_a  object or null, {"page": integer, "excerpt": string}
      citation_b  object or null, {"page": integer, "excerpt": string}

The context contains two blocks. Document A passages are labelled [A<page>-<page>]
and document B passages are labelled [B<page>-<page>].

Rules you must not break:
- A finding must be supported by a real passage. For each side of the finding,
  give the page and quote the passage text verbatim in the excerpt.
- "added" means a clause present in B but not A (cite B). "removed" means
  present in A but not B (cite A). "modified" means the same clause with
  different wording (cite both). The other kinds are about dates, values,
  obligations and contradictions.
- The excerpt must be copied exactly from the passage. Do not paraphrase it.
- If the documents do not differ in an area, do not report a finding for it.
- Never report a difference you cannot cite. An empty findings list is a valid
  and correct answer when the documents agree."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def load_document(
    session: AsyncSession, document_id: uuid.UUID
) -> Optional[Document]:
    return await session.get(Document, document_id)


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
    chunks_a: list[DocumentChunk],
    chunks_b: list[DocumentChunk],
    filename_a: str,
    filename_b: str,
    limit: int,
) -> str:
    """Present both documents to the model, one block each."""
    blocks: list[str] = []
    used = 0

    def add(block: str) -> bool:
        nonlocal used
        if used + len(block) > limit and blocks:
            return False
        blocks.append(block)
        used += len(block) + 2
        return True

    add(f"=== DOCUMENT A: {filename_a} ===")
    for chunk in chunks_a:
        if not add(f"[A{chunk.page_start}-{chunk.page_end}] {chunk.text.strip()}"):
            break

    add(f"=== DOCUMENT B: {filename_b} ===")
    for chunk in chunks_b:
        if not add(f"[B{chunk.page_start}-{chunk.page_end}] {chunk.text.strip()}"):
            break

    return "\n\n".join(blocks)


def _validate_citation(
    citation, chunks: list[DocumentChunk], filename: str
) -> Optional[dict]:
    """Check a model citation against the real document text.

    Returns the canonical citation (document_id, filename, page, excerpt) when
    the excerpt genuinely occurs on the cited page, otherwise None.
    """
    if not isinstance(citation, dict):
        return None

    excerpt = as_str(citation.get("excerpt"))
    if not excerpt:
        return None

    page = as_int(citation.get("page"))

    for chunk in chunks:
        if page is not None and not (chunk.page_start <= page <= chunk.page_end):
            continue
        if not contains_text(chunk.text, excerpt):
            continue
        return {
            "document_id": str(chunk.document_id),
            "filename": filename,
            "page": page if page is not None else chunk.page_start,
            "excerpt": excerpt,
        }
    return None


def _normalise_finding(raw) -> Optional[dict]:
    """Coerce one model finding into a clean, validated finding."""
    if not isinstance(raw, dict):
        return None

    kind = as_str(raw.get("kind"))
    if kind not in FINDING_KINDS:
        return None

    title = as_str(raw.get("title"))
    if not title:
        return None

    severity = as_str(raw.get("severity"))
    if severity not in SEVERITIES:
        severity = "medium"

    return {
        "kind": kind,
        "category": as_str(raw.get("category")),
        "title": title,
        "detail": as_str(raw.get("detail")),
        "severity": severity,
        "citation_a": raw.get("citation_a"),
        "citation_b": raw.get("citation_b"),
    }


async def run_comparison(
    session: AsyncSession,
    user: User,
    document_a: Document,
    document_b: Document,
    *,
    instruction: Optional[str] = None,
) -> tuple[DocumentComparison, list[ComparisonFinding], bool]:
    """Compare two documents and persist the result.

    Returns the comparison, its findings, and whether the model produced
    usable output.
    """
    chunks_a = await load_chunks(session, document_a.id)
    chunks_b = await load_chunks(session, document_b.id)
    if not chunks_a or not chunks_b:
        raise ValueError("Both documents must be indexed first")

    context = build_context(
        chunks_a,
        chunks_b,
        document_a.filename,
        document_b.filename,
        settings.max_context_chars,
    )
    question = (instruction or "").strip() or DEFAULT_INSTRUCTION

    response = await get_llm().generate(COMPARE_SYSTEM_PROMPT, context, question)
    parsed = parse_json_object(response.text)

    summary: Optional[str]
    findings: list[ComparisonFinding]
    usable = parsed is not None

    if parsed is None:
        summary = (
            "The comparison could not be determined from the model output. "
            "No differences were recorded."
        )
        raw_findings: list = []
    else:
        summary = as_str(parsed.get("summary"))
        raw_findings = parsed.get("findings") if isinstance(parsed.get("findings"), list) else []

    comparison = DocumentComparison(
        id=uuid.uuid4(),
        document_a_id=document_a.id,
        document_b_id=document_b.id,
        status="completed",
        summary=summary,
        model=response.model,
        created_by=user.id,
        created_at=_now(),
        completed_at=_now(),
    )
    session.add(comparison)
    await session.flush()

    validated: list[dict] = []
    for raw in raw_findings:
        candidate = _normalise_finding(raw)
        if candidate is None:
            continue

        citation_a = _validate_citation(
            candidate["citation_a"], chunks_a, document_a.filename
        )
        citation_b = _validate_citation(
            candidate["citation_b"], chunks_b, document_b.filename
        )
        if citation_a is None and citation_b is None:
            # Nothing in this finding survives verification.
            continue

        validated.append(
            {
                "kind": candidate["kind"],
                "category": candidate["category"],
                "title": candidate["title"],
                "detail": candidate["detail"],
                "severity": candidate["severity"],
                "citation_a": citation_a,
                "citation_b": citation_b,
            }
        )

    findings = []
    for order, item in enumerate(validated):
        finding = ComparisonFinding(
            id=uuid.uuid4(),
            comparison_id=comparison.id,
            kind=item["kind"],
            category=item["category"],
            title=item["title"],
            detail=item["detail"],
            severity=item["severity"],
            citation_a=item["citation_a"],
            citation_b=item["citation_b"],
            sort_order=order,
        )
        session.add(finding)
        findings.append(finding)

    await session.flush()
    return comparison, findings, usable


async def list_comparisons(
    session: AsyncSession,
    permitted_ids: list[uuid.UUID],
    *,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[DocumentComparison], int]:
    """Comparisons involving at least one document the caller may read."""
    if not permitted_ids:
        return [], 0

    conditions = [
        DocumentComparison.document_a_id.in_(permitted_ids),
        DocumentComparison.document_b_id.in_(permitted_ids),
    ]

    total = int(
        await session.scalar(
            select(func.count())
            .select_from(DocumentComparison)
            .where(*conditions)
        )
        or 0
    )

    stmt = (
        select(DocumentComparison)
        .where(*conditions)
        .order_by(DocumentComparison.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    rows = list((await session.execute(stmt)).scalars().all())
    return rows, total


async def findings_for(
    session: AsyncSession, comparison_id: uuid.UUID
) -> list[ComparisonFinding]:
    stmt = (
        select(ComparisonFinding)
        .where(ComparisonFinding.comparison_id == comparison_id)
        .order_by(ComparisonFinding.sort_order)
    )
    return list((await session.execute(stmt)).scalars().all())

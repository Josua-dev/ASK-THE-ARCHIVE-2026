"""Research Mode.

A research report is the deepest answer the platform produces: eight ordered
sections built from a wide, permission-scoped retrieval across the whole
archive rather than one document.

Two rules shape the implementation.

First, a claim without a citation does not stand. Every item in the findings,
evidence, conflicts and observations sections must point at a passage index
that was actually supplied to the model; an item whose citations are all
invalid is removed rather than presented as fact.

Second, observations are labelled as observations. Where the archive shows a
pattern, the report says what was observed and lets the reader judge it. It
does not convert a pattern into a conclusion.
"""

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models.research_report import ResearchReport
from app.db.models.user import User
from app.modules.retrieval.service import RetrievedChunk, keyword_search, search
from app.ports.factory import get_embedder, get_llm
from app.shared.llm_json import as_int, as_str, as_str_list, parse_json_object

# The eight sections of a research report, in the order they are presented.
SECTION_SPECS: tuple[tuple[str, str], ...] = (
    ("executive_summary", "Executive summary"),
    ("key_findings", "Key findings"),
    ("supporting_evidence", "Supporting evidence"),
    ("relevant_documents", "Relevant documents"),
    ("conflicting_information", "Conflicting information"),
    ("missing_information", "Missing information"),
    ("important_observations", "Important observations"),
    ("source_citations", "Source citations"),
)

# Sections whose items must carry at least one valid citation.
CITED_SECTIONS = (
    "key_findings",
    "supporting_evidence",
    "conflicting_information",
    "important_observations",
)

# The prefix that marks an observation as an observation rather than a fact.
OBSERVATION_PREFIX = "Observation (based on the cited material): "

RESEARCH_SYSTEM_PROMPT = """You produce a structured research report from retrieved archive passages.

Return ONE JSON object and nothing else. No prose before it, no prose after it.

The object must have exactly these keys:
  executive_summary      string, a direct answer to the question in a few sentences
  key_findings           list of {"text": string, "citations": [integers]}
  supporting_evidence    list of {"text": string, "citations": [integers]}
  relevant_documents     list of {"document_id": string, "filename": string, "why": string, "citations": [integers]}
  conflicting_information list of {"text": string, "citations": [integers]}
  missing_information     list of strings
  important_observations  list of {"text": string, "citations": [integers]}
  source_citations        list of integers

The context is a list of numbered passages, each labelled "[n] filename (pages a-b)".

Rules you must not break:
- Every claim in key_findings, supporting_evidence, conflicting_information
  and important_observations must cite one or more passage numbers from the
  context. A claim with no citation is not allowed.
- Only use passage numbers that appear in the context. Never invent a number.
- "missing_information" lists what the archive does NOT contain. Base it on
  the absence of evidence in the passages, never on invented facts.
- "important_observations" is for patterns you notice across the cited
  passages. Phrase each one as an observation about the material, not as a
  proven conclusion. Do not assert intent, cause or liability.
- "relevant_documents" may be an empty list. Only name a document_id that
  appears in the context.
- If the passages do not answer the question, say so in the executive summary
  and leave the finding lists empty. That is a correct and useful answer.
- Return only the JSON object."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def gather_evidence(
    session: AsyncSession, user: User, question: str
) -> list[RetrievedChunk]:
    """Retrieve permission-scoped evidence for a research question.

    Wider than a chat answer: a research report is expected to draw on
    several documents, so both semantic and keyword retrieval run and the
    results are merged.
    """
    embedder = get_embedder()
    vector = (await embedder.embed([question]))[0]

    top_k = max(settings.top_k, 12)
    chunks = await search(
        session,
        user,
        vector,
        embedding_model=embedder.model_id,
        top_k=top_k,
        min_score=settings.min_score,
    )

    keyword_hits = await keyword_search(session, user, question, top_k=20)

    merged: dict[uuid.UUID, RetrievedChunk] = {chunk.chunk_id: chunk for chunk in chunks}
    for hit in keyword_hits:
        existing = merged.get(hit.chunk_id)
        if existing is None or hit.score > existing.score:
            merged[hit.chunk_id] = hit

    return sorted(merged.values(), key=lambda c: c.score, reverse=True)


def build_context(chunks: list[RetrievedChunk]) -> str:
    """Number the passages so the model can cite them by index."""
    blocks: list[str] = []
    used = 0
    for index, chunk in enumerate(chunks, start=1):
        block = chunk.as_context(index)
        if used + len(block) > settings.max_context_chars and blocks:
            break
        blocks.append(block)
        used += len(block) + 2
    return "\n\n".join(blocks)


def _cited_items(
    raw, chunks: list[RetrievedChunk], *, required: bool
) -> list[dict]:
    """Normalise a list of claim objects and keep only properly cited ones."""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        text = as_str(entry.get("text"))
        if not text:
            continue
        indices = _valid_indices(entry.get("citations"), len(chunks))
        if required and not indices:
            # An uncited claim is dropped rather than presented as fact.
            continue
        item: dict = {"text": text, "citations": indices}
        document_id = as_str(entry.get("document_id"))
        filename = as_str(entry.get("filename"))
        if document_id:
            item["document_id"] = document_id
        if filename:
            item["filename"] = filename
        why = as_str(entry.get("why"))
        if why:
            item["why"] = why
        out.append(item)
    return out


def _valid_indices(raw, count: int) -> list[int]:
    """Keep only passage indices that exist."""
    if not isinstance(raw, list):
        return []
    out: list[int] = []
    for value in raw:
        index = as_int(value)
        if index is None or index < 1 or index > count:
            continue
        if index not in out:
            out.append(index)
    return sorted(out)


def _empty_sections() -> list[dict]:
    return [
        {"key": key, "title": title, "body": "", "citations": []}
        for key, title in SECTION_SPECS
    ]


def _citation_payload(index: int, chunk: RetrievedChunk) -> dict:
    return {
        "index": index,
        "document_id": str(chunk.document_id),
        "filename": chunk.filename,
        "page_start": chunk.page_start,
        "page_end": chunk.page_end,
        "excerpt": " ".join(chunk.text.split())[:400],
    }


async def generate_report(
    session: AsyncSession,
    user: User,
    question: str,
    *,
    conversation_id: Optional[uuid.UUID] = None,
    instruction: Optional[str] = None,
) -> tuple[ResearchReport, bool]:
    """Generate and persist a research report.

    Returns the report and whether the model produced usable output. An
    empty report is persisted when there is no evidence — an honest "the
    archive does not contain this" is a valid result, not a failure.
    """
    question = question.strip()
    chunks = await gather_evidence(session, user, question)

    sections = _empty_sections()
    citations: list[dict] = []
    model: Optional[str] = None
    tokens_used: Optional[int] = None
    usable = False

    if chunks:
        context = build_context(chunks)
        ask = (instruction or "").strip() or question
        response = await get_llm().generate(RESEARCH_SYSTEM_PROMPT, context, ask)
        model = response.model

        if isinstance(response.usage, dict):
            total = response.usage.get("total_tokens")
            if isinstance(total, int):
                tokens_used = total

        parsed = parse_json_object(response.text)
        if parsed is not None:
            usable = True

            summary = as_str(parsed.get("executive_summary")) or ""
            key_findings = _cited_items(parsed.get("key_findings"), chunks, required=True)
            evidence = _cited_items(parsed.get("supporting_evidence"), chunks, required=True)
            documents = _cited_items(parsed.get("relevant_documents"), chunks, required=False)
            conflicts = _cited_items(
                parsed.get("conflicting_information"), chunks, required=True
            )
            missing = as_str_list(parsed.get("missing_information"))
            observations = _cited_items(
                parsed.get("important_observations"), chunks, required=True
            )

            used_indices: set[int] = set()
            for group in (key_findings, evidence, conflicts, observations):
                for item in group:
                    used_indices.update(item["citations"])
            for item in documents:
                used_indices.update(item["citations"])

            bodies = {
                "executive_summary": summary,
                "key_findings": "\n".join(item["text"] for item in key_findings),
                "supporting_evidence": "\n".join(item["text"] for item in evidence),
                "relevant_documents": "\n".join(
                    f"{item.get('filename', 'Document')} — {item.get('why') or 'referenced'}"
                    for item in documents
                ),
                "conflicting_information": "\n".join(item["text"] for item in conflicts),
                "missing_information": "\n".join(missing),
                "important_observations": "\n".join(
                    OBSERVATION_PREFIX + item["text"] for item in observations
                ),
            }

            section_citations = {
                "executive_summary": [],
                "key_findings": sorted({i for item in key_findings for i in item["citations"]}),
                "supporting_evidence": sorted({i for item in evidence for i in item["citations"]}),
                "relevant_documents": sorted({i for item in documents for i in item["citations"]}),
                "conflicting_information": sorted({i for item in conflicts for i in item["citations"]}),
                "missing_information": [],
                "important_observations": sorted(
                    {i for item in observations for i in item["citations"]}
                ),
            }

            ordered = sorted(used_indices)
            source_lines = [
                f"[{index}] {chunks[index - 1].filename} "
                f"(pages {chunks[index - 1].page_start}-{chunks[index - 1].page_end})"
                for index in ordered
            ]

            sections = []
            for key, title in SECTION_SPECS:
                if key == "source_citations":
                    body = "\n".join(source_lines)
                    cites = ordered
                else:
                    body = bodies.get(key, "")
                    cites = section_citations.get(key, [])
                sections.append({"key": key, "title": title, "body": body, "citations": cites})

            citations = [
                _citation_payload(index, chunks[index - 1]) for index in ordered
            ]
    else:
        # No permitted evidence at all. Say so plainly in the report.
        for section in sections:
            if section["key"] in ("executive_summary", "missing_information"):
                section["body"] = (
                    "The archive contains no material your account can read that "
                    "addresses this question, so no findings could be produced."
                )

    report = ResearchReport(
        id=uuid.uuid4(),
        conversation_id=conversation_id,
        question=question,
        sections=sections,
        citations=citations,
        model=model,
        tokens_used=tokens_used,
        created_by=user.id,
        created_at=_now(),
    )
    session.add(report)
    await session.flush()
    return report, usable


def report_document_ids(report: ResearchReport) -> set[uuid.UUID]:
    """The documents a report's citations point at."""
    ids: set[uuid.UUID] = set()
    for citation in report.citations or []:
        if not isinstance(citation, dict):
            continue
        try:
            ids.add(uuid.UUID(str(citation.get("document_id"))))
        except (ValueError, TypeError):
            continue
    return ids


def filter_report_for(report: ResearchReport, permitted_ids: set[uuid.UUID]) -> dict:
    """Strip citations and sections the caller is not allowed to see.

    A report is assembled from documents; if one of them has since been
    revoked, the reader sees the report without that material rather than a
    reference to a document they can no longer open.
    """
    allowed: list[dict] = []
    remap: dict[int, int] = {}
    for citation in report.citations or []:
        if not isinstance(citation, dict):
            continue
        try:
            document_id = uuid.UUID(str(citation.get("document_id")))
        except (ValueError, TypeError):
            continue
        if document_id not in permitted_ids:
            continue
        remap[int(citation.get("index", 0))] = len(allowed) + 1
        allowed.append(citation)

    sections: list[dict] = []
    for section in report.sections or []:
        if not isinstance(section, dict):
            continue
        indices = [remap[i] for i in (section.get("citations") or []) if i in remap]
        sections.append(
            {
                "key": section.get("key"),
                "title": section.get("title"),
                "body": section.get("body") or "",
                "citations": sorted(indices),
            }
        )

    citations = [
        {
            "index": remap.get(int(c.get("index", 0)), 0),
            "document_id": str(c.get("document_id")),
            "filename": str(c.get("filename") or ""),
            "page_start": int(c.get("page_start") or 0),
            "page_end": int(c.get("page_end") or 0),
            "excerpt": str(c.get("excerpt") or ""),
        }
        for c in allowed
    ]

    return {"sections": sections, "citations": citations}


async def list_reports(
    session: AsyncSession,
    user: User,
    *,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[ResearchReport], int]:
    """The caller's research reports, newest first."""
    total = int(
        await session.scalar(
            select(func.count())
            .select_from(ResearchReport)
            .where(ResearchReport.created_by == user.id)
        )
        or 0
    )
    stmt = (
        select(ResearchReport)
        .where(ResearchReport.created_by == user.id)
        .order_by(ResearchReport.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    rows = list((await session.execute(stmt)).scalars().all())
    return rows, total

"""Automated Archive Insights.

These are observations about the state of the archive, derived entirely from
data that is already there — expiry dates on documents, checksums, extracted
profiles, contract references, obligation due dates. Nothing here is a
statistic the platform made up and nothing is inferred by a model.

Every insight is scoped to what the reader may see. An insight that concerns
a document the caller cannot open is not shown to them at all, because the
insight would otherwise disclose that the document exists.

An insight is never a verified fact. It is a flag for a human to look at, and
the interface presents it that way.
"""

import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models.archive_insight import ArchiveInsight
from app.db.models.document import Document
from app.db.models.document_profile import DocumentProfile
from app.db.models.user import User
from app.modules.documents.permissions import permitted_document_ids

# The kinds of issue the scanner reports.
INSIGHT_KINDS = (
    "expiring_soon",
    "missing_metadata",
    "potential_duplicate",
    "conflicting_date",
    "inconsistent_value",
    "missing_contract_info",
    "obligation_due",
    "needs_review",
)

SEVERITIES = ("info", "low", "medium", "high")

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2, "info": 3}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_date(value) -> Optional[date]:
    """Read a date out of a profile field, tolerating the shapes models emit."""
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if not isinstance(value, str):
        return None
    text = value.strip()
    for pattern in ("%Y-%m-%d", "%d/%m/%Y", "%d %B %Y", "%B %d, %Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    return None


def _profile_refs(profile: DocumentProfile, field: str, page: Optional[int]) -> list[dict]:
    """The profile's own provenance for one field, at one page if given."""
    out: list[dict] = []
    for ref in profile.source_refs or []:
        if not isinstance(ref, dict):
            continue
        if ref.get("field") != field:
            continue
        ref_page = ref.get("page")
        if page is not None and isinstance(ref_page, int) and ref_page != page:
            continue
        out.append(ref)
    return out


async def detect_insights(
    session: AsyncSession, user: User, *, today: Optional[date] = None
) -> list[dict]:
    """Scan the caller's readable archive and return the issues found."""
    today = today or date.today()

    permitted = await permitted_document_ids(session, user)
    if not permitted:
        return []

    doc_stmt = select(Document).where(Document.id.in_(permitted))
    documents = list((await session.execute(doc_stmt)).scalars().all())
    if not documents:
        return []

    doc_by_id = {doc.id: doc for doc in documents}

    profile_stmt = select(DocumentProfile).where(
        DocumentProfile.document_id.in_(permitted)
    )
    profiles = list((await session.execute(profile_stmt)).scalars().all())
    profile_by_doc = {profile.document_id: profile for profile in profiles}

    insights: list[dict] = []

    # ── Expiring soon ─────────────────────────────────────────────────────
    horizon = today + timedelta(days=settings.insight_expiry_horizon_days)
    for doc in documents:
        if doc.expiry_date is None:
            continue
        if doc.expiry_date > horizon:
            continue
        days = (doc.expiry_date - today).days
        if days < 0:
            severity = "high"
            title = f"Expired — {doc.filename}"
            detail = (
                f"{doc.filename} expired on {doc.expiry_date.strftime('%d %B %Y')}, "
                f"{abs(days)} day{'s' if abs(days) != 1 else ''} ago."
            )
        elif days <= 14:
            severity = "high"
            title = f"Expires in {days} day{'s' if days != 1 else ''} — {doc.filename}"
            detail = (
                f"{doc.filename} expires on {doc.expiry_date.strftime('%d %B %Y')}."
            )
        elif days <= 45:
            severity = "medium"
            title = f"Expires in {days} days — {doc.filename}"
            detail = (
                f"{doc.filename} expires on {doc.expiry_date.strftime('%d %B %Y')}."
            )
        else:
            severity = "low"
            title = f"Expires in {days} days — {doc.filename}"
            detail = (
                f"{doc.filename} expires on {doc.expiry_date.strftime('%d %B %Y')}."
            )
        insights.append(
            {
                "kind": "expiring_soon",
                "severity": severity,
                "title": title,
                "detail": detail,
                "document_ids": [str(doc.id)],
                "evidence": [],
            }
        )

    # ── Missing metadata ──────────────────────────────────────────────────
    for doc in documents:
        missing = []
        if not doc.doc_type:
            missing.append("document type")
        if not doc.title:
            missing.append("title")
        if doc.page_count is None:
            missing.append("page count")
        if not missing:
            continue
        insights.append(
            {
                "kind": "missing_metadata",
                "severity": "low",
                "title": f"Incomplete metadata — {doc.filename}",
                "detail": (
                    f"{doc.filename} has no {' or '.join(missing)} recorded."
                ),
                "document_ids": [str(doc.id)],
                "evidence": [],
            }
        )

    # ── Potential duplicates ───────────────────────────────────────────────
    by_checksum: dict[str, list[Document]] = defaultdict(list)
    for doc in documents:
        if doc.checksum_sha256:
            by_checksum[doc.checksum_sha256].append(doc)
    for checksum, group in by_checksum.items():
        if len(group) < 2:
            continue
        names = ", ".join(sorted(doc.filename for doc in group))
        insights.append(
            {
                "kind": "potential_duplicate",
                "severity": "medium",
                "title": f"{len(group)} identical copies — {group[0].filename}",
                "detail": (
                    f"These files share the same content hash and may be duplicates: {names}."
                ),
                "document_ids": sorted(str(doc.id) for doc in group),
                "evidence": [],
            }
        )

    by_name: dict[str, list[Document]] = defaultdict(list)
    for doc in documents:
        by_name[doc.filename.strip().casefold()].append(doc)
    for group in by_name.values():
        if len(group) < 2:
            continue
        checksums = {doc.checksum_sha256 for doc in group}
        if len(checksums) == 1:
            # Already reported as identical content.
            continue
        names = ", ".join(sorted(doc.filename for doc in group))
        insights.append(
            {
                "kind": "potential_duplicate",
                "severity": "low",
                "title": f"Same filename, different content — {group[0].filename}",
                "detail": (
                    f"Several files share this filename but have different content: {names}."
                ),
                "document_ids": sorted(str(doc.id) for doc in group),
                "evidence": [],
            }
        )

    # ── Contract references: conflicting dates and values ─────────────────
    # Map a contract reference to the documents that cite it.
    reference_docs: dict[str, list[DocumentProfile]] = defaultdict(list)
    for profile in profiles:
        for entry in profile.contract_references or []:
            if not isinstance(entry, dict):
                continue
            reference = str(entry.get("reference") or "").strip()
            if reference:
                reference_docs[reference].append(profile)

    for reference, group in reference_docs.items():
        if len(group) < 2:
            continue

        # Conflicting dates: the same label, different values.
        dates_by_label: dict[str, list[tuple[str, DocumentProfile]]] = defaultdict(list)
        for profile in group:
            for entry in profile.important_dates or []:
                if not isinstance(entry, dict):
                    continue
                label = str(entry.get("label") or "").strip().casefold()
                value = entry.get("date")
                if label and value:
                    dates_by_label[label].append((str(value), profile))
        for label, entries in dates_by_label.items():
            values = {value for value, _ in entries}
            if len(values) < 2:
                continue
            involved = {profile.document_id for _, profile in entries}
            if len(involved) < 2:
                continue
            shown = ", ".join(sorted(values))
            evidence = []
            for value, profile in entries:
                page = None
                for ref in _profile_refs(profile, "important_dates", None):
                    page = ref.get("page") if isinstance(ref.get("page"), int) else None
                    if ref.get("excerpt"):
                        evidence.append(
                            {
                                "document_id": str(profile.document_id),
                                "filename": doc_by_id[profile.document_id].filename
                                if profile.document_id in doc_by_id
                                else None,
                                "page": page,
                                "excerpt": ref["excerpt"][:300],
                            }
                        )
                        break
            insights.append(
                {
                    "kind": "conflicting_date",
                    "severity": "high",
                    "title": f"Conflicting date for “{label}” — {reference}",
                    "detail": (
                        f"Documents citing {reference} give different dates for "
                        f"{label}: {shown}."
                    ),
                    "document_ids": sorted(str(doc_id) for doc_id in involved),
                    "evidence": evidence,
                }
            )

        # Inconsistent values: the same label, different amounts.
        values_by_label: dict[str, list[tuple[float, str, DocumentProfile]]] = defaultdict(
            list
        )
        for profile in group:
            for entry in profile.monetary_values or []:
                if not isinstance(entry, dict):
                    continue
                label = str(entry.get("label") or "").strip().casefold()
                amount = entry.get("amount")
                currency = str(entry.get("currency") or "")
                if label and isinstance(amount, (int, float)):
                    values_by_label[label].append((float(amount), currency, profile))
        for label, entries in values_by_label.items():
            amounts = {amount for amount, _, _ in entries}
            if len(amounts) < 2:
                continue
            involved = {profile.document_id for _, _, profile in entries}
            if len(involved) < 2:
                continue
            shown = ", ".join(
                sorted(
                    {
                        f"{amount:,.2f} {currency}".strip()
                        for amount, currency, _ in entries
                    }
                )
            )
            insights.append(
                {
                    "kind": "inconsistent_value",
                    "severity": "high",
                    "title": f"Conflicting value for “{label}” — {reference}",
                    "detail": (
                        f"Documents citing {reference} give different amounts for "
                        f"{label}: {shown}."
                    ),
                    "document_ids": sorted(str(doc_id) for doc_id in involved),
                    "evidence": [],
                }
            )

    # ── Missing contract information ──────────────────────────────────────
    for doc in documents:
        profile = profile_by_doc.get(doc.id)
        if profile is None:
            continue
        if doc.doc_type not in ("contract", "lease"):
            continue
        gaps = []
        if not profile.contract_references:
            gaps.append("no contract reference")
        if not profile.parties and not profile.organisations:
            gaps.append("no named parties")
        if not profile.important_dates:
            gaps.append("no important dates")
        if not profile.obligations:
            gaps.append("no recorded obligations")
        if not gaps:
            continue
        insights.append(
            {
                "kind": "missing_contract_info",
                "severity": "medium",
                "title": f"Incomplete contract information — {doc.filename}",
                "detail": (
                    f"The extracted profile for {doc.filename} has {' and '.join(gaps)}."
                ),
                "document_ids": [str(doc.id)],
                "evidence": [],
            }
        )

    # ── Obligations falling due ───────────────────────────────────────────
    obligation_horizon = today + timedelta(
        days=settings.insight_obligation_horizon_days
    )
    for doc in documents:
        profile = profile_by_doc.get(doc.id)
        if profile is None:
            continue
        for entry in profile.obligations or []:
            if not isinstance(entry, dict):
                continue
            due = _parse_date(entry.get("due"))
            if due is None:
                continue
            if due > obligation_horizon:
                continue
            days = (due - today).days
            if days < 0:
                severity = "high"
                text = f"overdue by {abs(days)} day{'s' if abs(days) != 1 else ''}"
            elif days == 0:
                severity = "high"
                text = "due today"
            elif days <= 7:
                severity = "medium"
                text = f"due in {days} day{'s' if days != 1 else ''}"
            else:
                severity = "low"
                text = f"due in {days} days"
            description = str(entry.get("text") or "Obligation")
            party = entry.get("party")
            insights.append(
                {
                    "kind": "obligation_due",
                    "severity": severity,
                    "title": f"Obligation {text} — {doc.filename}",
                    "detail": (
                        f"{description}"
                        + (f" ({party})" if party else "")
                        + f" — {text}."
                    ),
                    "document_ids": [str(doc.id)],
                    "evidence": [],
                }
            )

    # ── Extractions that need review ──────────────────────────────────────
    for doc in documents:
        profile = profile_by_doc.get(doc.id)
        if profile is None:
            continue
        confidence = profile.confidence
        if confidence is None:
            continue
        if confidence >= settings.insight_low_confidence:
            continue
        insights.append(
            {
                "kind": "needs_review",
                "severity": "medium",
                "title": f"Low extraction confidence — {doc.filename}",
                "detail": (
                    f"The extracted profile for {doc.filename} was produced with "
                    f"{confidence:.0%} confidence, which is below the review "
                    f"threshold of {settings.insight_low_confidence:.0%}."
                ),
                "document_ids": [str(doc.id)],
                "evidence": [],
            }
        )

    # Most serious first, then by title.
    insights.sort(key=lambda i: (SEVERITY_ORDER.get(i["severity"], 9), i["title"]))
    return insights


async def persist_insights(
    session: AsyncSession, user: User, detections: list[dict]
) -> list[ArchiveInsight]:
    """Store the detections, keeping any status a human already set.

    A detection is identified by its kind and title, which the scanner
    produces deterministically. Re-running the scan updates the detail and
    evidence of a known insight without resetting whether it was acknowledged,
    resolved or dismissed.
    """
    existing = list((await session.execute(select(ArchiveInsight))).scalars().all())
    by_key = {(row.kind, row.title): row for row in existing}

    stored: list[ArchiveInsight] = []
    for detection in detections:
        key = (detection["kind"], detection["title"])
        row = by_key.get(key)
        if row is None:
            row = ArchiveInsight(
                id=uuid.uuid4(),
                kind=detection["kind"],
                severity=detection["severity"],
                title=detection["title"],
                detail=detection["detail"],
                document_ids=detection["document_ids"],
                evidence=detection["evidence"],
                status="open",
                detected_at=_now(),
            )
            session.add(row)
            by_key[key] = row
        else:
            row.severity = detection["severity"]
            row.detail = detection["detail"]
            row.document_ids = detection["document_ids"]
            row.evidence = detection["evidence"]
        stored.append(row)

    await session.flush()
    return stored


async def list_insights(
    session: AsyncSession,
    user: User,
    *,
    status: Optional[str] = None,
    kind: Optional[str] = None,
    limit: int = 200,
) -> list[ArchiveInsight]:
    """Stored insights the caller is allowed to see.

    An insight is visible only when at least one of the documents it concerns
    is readable by the caller, and only the readable document ids are shown.
    """
    permitted = await permitted_document_ids(session, user)
    if not permitted:
        return []

    stmt = select(ArchiveInsight).order_by(ArchiveInsight.detected_at.desc())
    if status:
        stmt = stmt.where(ArchiveInsight.status == status)
    if kind:
        stmt = stmt.where(ArchiveInsight.kind == kind)
    rows = list((await session.execute(stmt)).scalars().all())

    permitted_set = set(permitted)
    out: list[ArchiveInsight] = []
    for row in rows:
        visible = [
            str(doc_id) for doc_id in (row.document_ids or []) if doc_id in permitted_set
        ]
        if not visible:
            continue
        row.document_ids = visible
        row.evidence = [
            evidence
            for evidence in (row.evidence or [])
            if isinstance(evidence, dict)
            and evidence.get("document_id") in permitted_set
        ]
        out.append(row)
        if len(out) >= limit:
            break
    return out


def counts_by_kind(rows: list[ArchiveInsight]) -> dict[str, int]:
    counts: dict[str, int] = {kind: 0 for kind in INSIGHT_KINDS}
    for row in rows:
        counts[row.kind] = counts.get(row.kind, 0) + 1
    return counts

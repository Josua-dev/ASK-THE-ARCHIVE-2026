"""The Knowledge Graph.

Every node and every edge in this graph comes from something that was
actually extracted from a document. There are three sources and no others:

1. The entity index (`extracted_entities` + `entity_mentions`). An
   organisation named in three documents is one node with three mentions.
2. Document profiles (`document_profiles`). A profile's `related_documents`
   gives explicit document-to-document references, and `contract_references`
   gives the contract identifiers a document cites.
3. Co-occurrence. Two entities mentioned on the same page of the same
   document are connected, and the weight of that edge is the number of
   pages they share.

Nothing is invented and nothing is guessed: if the extraction pass has not
run over a document, that document contributes no nodes.

The graph is permission-scoped. A document the caller cannot read contributes
nothing at all — not even a node that hints it exists.
"""

import uuid
from collections import defaultdict
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.document import Document
from app.db.models.document_profile import DocumentProfile
from app.db.models.extracted_entity import EntityMention, ExtractedEntity
from app.db.models.user import User
from app.modules.documents.permissions import permitted_document_ids

# Node kinds the graph understands.
NODE_DOCUMENT = "document"
NODE_ENTITY = "entity"
NODE_CONTRACT_REF = "contract_ref"

# Edge kinds the graph understands.
EDGE_MENTIONS = "mentions"
EDGE_CO_OCCURS = "co_occurs"
EDGE_REFERENCES = "references"
EDGE_CITES = "cites"

# The sources the graph is built from, surfaced in the response so a reader
# can tell what the shape of the graph reflects.
GRAPH_SOURCES = (
    "entity index (extracted entities and their mentions)",
    "document profiles (related documents and contract references)",
    "page-level co-occurrence of extracted entities",
)


def _document_node_id(document_id: uuid.UUID) -> str:
    return f"document:{document_id}"


def _entity_node_id(entity_id: uuid.UUID) -> str:
    return f"entity:{entity_id}"


def _contract_node_id(reference: str) -> str:
    return f"contract:{reference.strip().casefold()}"


def _edge_id(kind: str, source: str, target: str) -> str:
    return f"{kind}:{source}->{target}"


async def build_graph(
    session: AsyncSession,
    user: User,
    *,
    doc_types: Optional[list[str]] = None,
    kinds: Optional[list[str]] = None,
    min_weight: int = 1,
    max_nodes: int = 400,
) -> dict:
    """Assemble the graph for everything the caller is allowed to read."""
    permitted = await permitted_document_ids(session, user)
    if not permitted:
        return {
            "nodes": [],
            "edges": [],
            "stats": {
                "document_count": 0,
                "entity_count": 0,
                "contract_reference_count": 0,
                "edge_count": 0,
                "sources": list(GRAPH_SOURCES),
            },
        }

    # ── Documents in scope ────────────────────────────────────────────────
    doc_stmt = select(Document).where(Document.id.in_(permitted))
    if doc_types:
        doc_stmt = doc_stmt.where(Document.doc_type.in_(doc_types))
    documents = list((await session.execute(doc_stmt)).scalars().all())

    if not documents:
        return {
            "nodes": [],
            "edges": [],
            "stats": {
                "document_count": 0,
                "entity_count": 0,
                "contract_reference_count": 0,
                "edge_count": 0,
                "sources": list(GRAPH_SOURCES),
            },
        }

    scope_ids = {doc.id for doc in documents}
    doc_by_id = {doc.id: doc for doc in documents}

    nodes: dict[str, dict] = {}
    edges: dict[str, dict] = {}

    for doc in documents:
        nodes[_document_node_id(doc.id)] = {
            "id": _document_node_id(doc.id),
            "kind": NODE_DOCUMENT,
            "label": doc.title or doc.filename,
            "document_count": 1,
            "mention_count": 0,
            "attributes": {
                "filename": doc.filename,
                "doc_type": doc.doc_type,
                "page_count": doc.page_count,
            },
        }

    # ── The entity index ──────────────────────────────────────────────────
    mention_stmt = (
        select(EntityMention, ExtractedEntity)
        .join(ExtractedEntity, ExtractedEntity.id == EntityMention.entity_id)
        .where(EntityMention.document_id.in_(scope_ids))
    )
    rows = (await session.execute(mention_stmt)).all()

    # entity id -> {documents: set, mentions: int}
    entity_docs: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    entity_mentions: dict[uuid.UUID, int] = defaultdict(int)
    entity_by_id: dict[uuid.UUID, ExtractedEntity] = {}

    for mention, entity in rows:
        entity_by_id[entity.id] = entity
        entity_docs[entity.id].add(mention.document_id)
        entity_mentions[entity.id] += 1

        node_id = _entity_node_id(entity.id)
        node = nodes.get(node_id)
        if node is None:
            node = {
                "id": node_id,
                "kind": NODE_ENTITY,
                "label": entity.name,
                "document_count": 0,
                "mention_count": 0,
                "attributes": {
                    "entity_kind": entity.kind,
                    **{
                        k: v
                        for k, v in (entity.attributes or {}).items()
                        if k != "role"
                    },
                },
            }
            nodes[node_id] = node
        node["mention_count"] += 1

        edge_key = _edge_id(EDGE_MENTIONS, node_id, _document_node_id(mention.document_id))
        edge = edges.get(edge_key)
        if edge is None:
            edge = {
                "id": edge_key,
                "source": node_id,
                "target": _document_node_id(mention.document_id),
                "kind": EDGE_MENTIONS,
                "weight": 0,
                "label": entity.kind,
                "document_ids": [],
                "pages": [],
            }
            edges[edge_key] = edge
        edge["weight"] += 1
        if str(mention.document_id) not in edge["document_ids"]:
            edge["document_ids"].append(str(mention.document_id))
        if mention.page_start is not None:
            edge["pages"].append(
                {
                    "document_id": str(mention.document_id),
                    "page_start": mention.page_start,
                    "page_end": mention.page_end,
                    "excerpt": (mention.excerpt or "")[:220],
                }
            )

    for entity_id, docs in entity_docs.items():
        nodes[_entity_node_id(entity_id)]["document_count"] = len(docs)

    # ── Co-occurrence: two entities on the same page of the same document ─
    # (document_id, page) -> set of entity ids
    page_buckets: dict[tuple[uuid.UUID, int], set[uuid.UUID]] = defaultdict(set)
    for mention, entity in rows:
        if mention.page_start is None:
            continue
        page_buckets[(mention.document_id, mention.page_start)].add(entity.id)

    pair_pages: dict[tuple[uuid.UUID, uuid.UUID], list[tuple[uuid.UUID, int]]] = (
        defaultdict(list)
    )
    for (document_id, page), entity_ids in page_buckets.items():
        ordered = sorted(entity_ids)
        for i, left in enumerate(ordered):
            for right in ordered[i + 1 :]:
                pair_pages[(left, right)].append((document_id, page))

    for (left, right), pages in pair_pages.items():
        if left not in entity_by_id or right not in entity_by_id:
            continue
        left_id = _entity_node_id(left)
        right_id = _entity_node_id(right)
        key = (left_id, right_id) if left_id <= right_id else (right_id, left_id)
        edge_key = _edge_id(EDGE_CO_OCCURS, key[0], key[1])
        edge = edges.get(edge_key)
        if edge is None:
            edge = {
                "id": edge_key,
                "source": key[0],
                "target": key[1],
                "kind": EDGE_CO_OCCURS,
                "weight": 0,
                "label": "co-occurrence",
                "document_ids": [],
                "pages": [],
            }
            edges[edge_key] = edge
        edge["weight"] += len(pages)
        seen_docs = set(edge["document_ids"])
        for document_id, page in pages:
            if str(document_id) not in seen_docs:
                seen_docs.add(str(document_id))
                edge["document_ids"].append(str(document_id))
        for document_id, page in pages[:6]:
            edge["pages"].append(
                {"document_id": str(document_id), "page_start": page, "page_end": page}
            )

    # ── Document profiles: references and contract citations ──────────────
    profile_stmt = select(DocumentProfile).where(DocumentProfile.document_id.in_(scope_ids))
    profiles = list((await session.execute(profile_stmt)).scalars().all())

    contract_reference_count = 0
    for profile in profiles:
        source_doc_id = profile.document_id

        for entry in profile.related_documents or []:
            if not isinstance(entry, dict):
                continue
            try:
                target_id = uuid.UUID(str(entry.get("document_id")))
            except (ValueError, TypeError):
                continue
            # Only relate documents that are both in scope and readable.
            if target_id not in scope_ids:
                continue
            source_node = _document_node_id(source_doc_id)
            target_node = _document_node_id(target_id)
            key = (source_node, target_node) if source_node <= target_node else (
                target_node,
                source_node,
            )
            edge_key = _edge_id(EDGE_REFERENCES, key[0], key[1])
            if edge_key not in edges:
                edges[edge_key] = {
                    "id": edge_key,
                    "source": key[0],
                    "target": key[1],
                    "kind": EDGE_REFERENCES,
                    "weight": 1,
                    "label": entry.get("reason") or "references",
                    "document_ids": sorted([str(source_doc_id), str(target_id)]),
                    "pages": [],
                }

        for entry in profile.contract_references or []:
            if not isinstance(entry, dict):
                continue
            reference = str(entry.get("reference") or "").strip()
            if not reference:
                continue
            contract_reference_count += 1
            node_id = _contract_node_id(reference)
            if node_id not in nodes:
                nodes[node_id] = {
                    "id": node_id,
                    "kind": NODE_CONTRACT_REF,
                    "label": reference,
                    "document_count": 0,
                    "mention_count": 0,
                    "attributes": {},
                }
            nodes[node_id]["document_count"] += 1

            edge_key = _edge_id(EDGE_CITES, node_id, _document_node_id(source_doc_id))
            edge = edges.get(edge_key)
            if edge is None:
                edge = {
                    "id": edge_key,
                    "source": node_id,
                    "target": _document_node_id(source_doc_id),
                    "kind": EDGE_CITES,
                    "weight": 0,
                    "label": "cites",
                    "document_ids": [],
                    "pages": [],
                }
                edges[edge_key] = edge
            edge["weight"] += 1
            if str(source_doc_id) not in edge["document_ids"]:
                edge["document_ids"].append(str(source_doc_id))
            page = entry.get("page")
            if isinstance(page, int):
                edge["pages"].append(
                    {
                        "document_id": str(source_doc_id),
                        "page_start": page,
                        "page_end": page,
                    }
                )

    # ── Filter and trim ───────────────────────────────────────────────────
    edge_list = [
        edge for edge in edges.values() if edge["weight"] >= max(1, min_weight)
    ]

    if kinds:
        allowed_kinds = set(kinds)
        edge_list = [e for e in edge_list if e["kind"] in allowed_kinds]
        keep = {e["source"] for e in edge_list} | {e["target"] for e in edge_list}
        nodes = {nid: node for nid, node in nodes.items() if nid in keep}

    node_list = list(nodes.values())
    if len(node_list) > max_nodes:
        # Keep the most connected nodes so the graph stays legible.
        degree: dict[str, int] = defaultdict(int)
        for edge in edge_list:
            degree[edge["source"]] += edge["weight"]
            degree[edge["target"]] += edge["weight"]
        node_list.sort(key=lambda n: (-degree.get(n["id"], 0), n["id"]))
        keep = {n["id"] for n in node_list[:max_nodes]}
        node_list = node_list[:max_nodes]
        edge_list = [e for e in edge_list if e["source"] in keep and e["target"] in keep]

    entity_count = sum(1 for n in node_list if n["kind"] == NODE_ENTITY)
    document_count = sum(1 for n in node_list if n["kind"] == NODE_DOCUMENT)

    return {
        "nodes": node_list,
        "edges": edge_list,
        "stats": {
            "document_count": document_count,
            "entity_count": entity_count,
            "contract_reference_count": contract_reference_count,
            "edge_count": len(edge_list),
            "sources": list(GRAPH_SOURCES),
        },
    }


async def entity_detail(
    session: AsyncSession, user: User, entity_id: uuid.UUID
) -> Optional[dict]:
    """One entity with its mentions, limited to documents the caller may read."""
    permitted = await permitted_document_ids(session, user)
    if not permitted:
        return None

    entity = await session.get(ExtractedEntity, entity_id)
    if entity is None:
        return None

    stmt = (
        select(EntityMention)
        .where(
            EntityMention.entity_id == entity_id,
            EntityMention.document_id.in_(permitted),
        )
        .order_by(EntityMention.created_at.desc())
        .limit(200)
    )
    mentions = list((await session.execute(stmt)).scalars().all())

    if not mentions:
        return None

    document_ids = {m.document_id for m in mentions}
    doc_rows = (
        await session.execute(select(Document).where(Document.id.in_(document_ids)))
    ).scalars().all()
    doc_by_id = {doc.id: doc for doc in doc_rows}

    return {
        "id": str(entity.id),
        "kind": entity.kind,
        "name": entity.name,
        "attributes": entity.attributes or {},
        "mention_count": entity.mention_count,
        "documents": [
            {
                "document_id": str(m.document_id),
                "filename": doc_by_id[m.document_id].filename
                if m.document_id in doc_by_id
                else None,
                "page_start": m.page_start,
                "page_end": m.page_end,
                "excerpt": m.excerpt,
            }
            for m in mentions
        ],
    }

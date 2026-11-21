"""Chat routes — synchronous answers and SSE streaming."""

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import AsyncIterator, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import get_current_user
from app.core.errors import ForbiddenError, NotFoundError, ValidationError
from app.db.models.conversation import Conversation
from app.db.models.citation import Citation
from app.db.models.message import Message
from app.db.session import get_db_session
from app.modules.chat.service import (
    ABSTENTION_TEXT,
    SYSTEM_PROMPT,
    AnswerResult,
    CitationOut as ServiceCitationOut,
    answer_question,
    build_context,
    plan_greeting,
    plan_keyword,
    plan_metadata_query,
    _extract_citation_indices,
    _persist,
)
from app.modules.conversation_share.service import (
    ACCESS_CONTRIBUTE,
    ACCESS_NONE,
    ACCESS_OWNER,
    ACCESS_READ,
    can_contribute,
    list_shared_conversations,
    resolve_conversation_access,
)
from app.modules.documents.permissions import permission_filter
from app.modules.retrieval.service import search
from app.ports.factory import get_embedder, get_llm
from app.ports.llm import NO_ANSWER
from app.shared.audit import record_audit

router = APIRouter(prefix="/api/v1/chat", tags=["chat"])


class AskRequest(BaseModel):
    question: str
    conversation_id: Optional[uuid.UUID] = None


class CitationOut(BaseModel):
    index: int
    document_id: uuid.UUID
    filename: str
    page_start: int
    page_end: int
    quote: str
    score: Optional[float] = None


class AnswerOut(BaseModel):
    answer: str
    found: bool
    citations: list[CitationOut] = []
    intent: str = "semantic"
    model: str = ""
    conversation_id: Optional[uuid.UUID] = None
    message_id: Optional[uuid.UUID] = None


class MessageOut(BaseModel):
    id: uuid.UUID
    role: str
    content: str
    answer_found: Optional[bool] = None
    created_at: Optional[str] = None


class ConversationOut(BaseModel):
    id: uuid.UUID
    title: Optional[str] = None
    created_at: Optional[str] = None
    # "owner", "contribute" or "read" — what the caller may do with it.
    access: str = ACCESS_OWNER


async def _require_contribute(
    session: AsyncSession, user, conversation_id: uuid.UUID
) -> None:
    """Refuse to write to a conversation the caller may not add to.

    A conversation the caller cannot see at all is reported as missing, so a
    404 never reveals that someone else's conversation exists.
    """
    conversation, access = await resolve_conversation_access(
        session, user, conversation_id
    )
    if conversation is None or access == ACCESS_NONE:
        raise NotFoundError("Conversation not found")
    if not can_contribute(access):
        raise ForbiddenError(
            "You have read access to this conversation but cannot add to it"
        )


@router.post("/ask", response_model=AnswerOut)
async def ask(
    payload: AskRequest,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    if payload.conversation_id is not None:
        await _require_contribute(session, user, payload.conversation_id)
    try:
        result = await answer_question(
            session, user, payload.question, conversation_id=payload.conversation_id
        )
    except ValueError as exc:
        # The service refuses input it cannot answer — an empty question, a
        # conversation the caller may not write to. Those are the caller's
        # mistake, not a server fault, so they must not surface as a 500.
        raise ValidationError(str(exc)) from exc
    conversation_id = payload.conversation_id
    if conversation_id is None and result.message_id is not None:
        conversation_id = await session.scalar(
            select(Message.conversation_id).where(Message.id == result.message_id)
        )
    return AnswerOut(
        answer=result.text,
        found=result.found,
        citations=[
            CitationOut(
                index=c.index,
                document_id=c.document_id,
                filename=c.filename,
                page_start=c.page_start,
                page_end=c.page_end,
                quote=c.quote,
                score=c.score,
            )
            for c in result.citations
        ],
        intent=result.intent,
        model=result.model,
        conversation_id=conversation_id,
        message_id=result.message_id,
    )


@router.post("/stream")
async def stream(
    payload: AskRequest,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Server-sent events: evidence, answer deltas, citations, done."""
    if payload.conversation_id is not None:
        await _require_contribute(session, user, payload.conversation_id)
    # `no-transform` matters more than it looks.
    #
    # The browser reaches this endpoint through the frontend's rewrite proxy,
    # and Next runs every response through its compression middleware. The
    # middleware gzips anything whose content type is compressible — and
    # `text/event-stream` is — which means the whole stream is buffered until
    # the model has finished. The user would watch an empty panel for a minute
    # and then see the entire answer appear at once, with no streaming at all.
    #
    # `Cache-Control: no-transform` is the standard way to tell an
    # intermediary not to transform the body, and it is what makes the
    # middleware leave this response alone. `X-Accel-Buffering: no` does the
    # same job for nginx.
    return StreamingResponse(
        _event_stream(session, user, payload.question, payload.conversation_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


async def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def _event_stream(
    session: AsyncSession,
    user,
    question: str,
    conversation_id: Optional[uuid.UUID] = None,
) -> AsyncIterator[str]:
    question = (question or "").strip()
    if not question:
        yield await _sse("error", {"message": "A question is required"})
        return

    # Deterministic paths — answered without a model call.
    plan = (
        plan_greeting(question)
        or plan_metadata_query(question)
        or plan_keyword(question)
    )
    if plan:
        result = await answer_question(
            session, user, question, persist=True, conversation_id=conversation_id
        )
        yield await _sse(
            "evidence",
            {
                "intent": result.intent,
                "found": result.found,
                "passages": [
                    {
                        "index": c.index,
                        "document_id": str(c.document_id),
                        "filename": c.filename,
                        "page_start": c.page_start,
                        "page_end": c.page_end,
                        "quote": c.quote,
                    }
                    for c in result.citations
                ],
            },
        )
        yield await _sse("delta", {"text": result.text})
        yield await _sse(
            "citations",
            {
                "citations": [
                    {
                        "index": c.index,
                        "document_id": str(c.document_id),
                        "filename": c.filename,
                        "page_start": c.page_start,
                        "page_end": c.page_end,
                        "quote": c.quote,
                    }
                    for c in result.citations
                ]
            },
        )
        yield await _sse("done", {"found": result.found, "intent": result.intent})
        return

    embedder = get_embedder()
    query_vector = (await embedder.embed([question]))[0]
    chunks = await search(
        session,
        user,
        query_vector,
        embedding_model=embedder.model_id,
        top_k=settings.top_k,
        min_score=settings.min_score,
    )

    if not chunks:
        yield await _sse("evidence", {"intent": "semantic", "found": False, "passages": []})
        yield await _sse("delta", {"text": ABSTENTION_TEXT})
        yield await _sse("citations", {"citations": []})
        yield await _sse("done", {"found": False, "intent": "semantic"})
        if conversation_id is not None:
            # The turn belongs to the conversation the caller named — record it
            # the same way a non-streamed answer is recorded.
            await _persist(
                session,
                user,
                conversation_id,
                question,
                AnswerResult(text=ABSTENTION_TEXT, found=False, intent="semantic"),
            )
        await record_audit(
            session,
            actor_id=user.id,
            action="chat.answer",
            resource_type="conversation",
            metadata={"intent": "semantic", "found": False, "streamed": True},
        )
        await session.commit()
        return

    yield await _sse(
        "evidence",
        {
            "intent": "semantic",
            "found": True,
            "passages": [
                {
                    "index": i,
                    "document_id": str(c.document_id),
                    "filename": c.filename,
                    "page_start": c.page_start,
                    "page_end": c.page_end,
                    "score": round(c.score, 4),
                }
                for i, c in enumerate(chunks, start=1)
            ],
        },
    )

    llm = get_llm()
    context = build_context(chunks)
    collected: list[str] = []
    try:
        async for token in llm.generate_stream(SYSTEM_PROMPT, context, question):
            collected.append(token)
            yield await _sse("delta", {"text": token})
    except Exception as exc:  # noqa: BLE001 - stream must close cleanly
        yield await _sse("error", {"message": f"Generation failed: {exc}"})
        await session.rollback()
        return

    answer = "".join(collected).strip()
    if not answer or answer == NO_ANSWER or NO_ANSWER in answer[:20]:
        answer = ABSTENTION_TEXT
        found = False
        used: list[int] = []
    else:
        used = sorted(
            {
                i
                for i in _extract_citation_indices(answer, max_index=len(chunks))
                if 1 <= i <= len(chunks)
            }
        )
        found = bool(used)

    citation_rows = [
        ServiceCitationOut(
            index=i,
            document_id=chunks[i - 1].document_id,
            filename=chunks[i - 1].filename,
            page_start=chunks[i - 1].page_start,
            page_end=chunks[i - 1].page_end,
            quote=" ".join(chunks[i - 1].text.split())[:320],
            score=chunks[i - 1].score,
        )
        for i in used
    ]
    citations = [
        {
            "index": c.index,
            "document_id": str(c.document_id),
            "filename": c.filename,
            "page_start": c.page_start,
            "page_end": c.page_end,
            "quote": c.quote,
            "score": round(c.score, 4) if c.score is not None else None,
        }
        for c in citation_rows
    ]
    yield await _sse("citations", {"citations": citations})

    if conversation_id is not None:
        # The turn belongs to the conversation the caller named — record it the
        # same way a non-streamed answer is recorded.
        await _persist(
            session,
            user,
            conversation_id,
            question,
            AnswerResult(
                text=answer,
                found=found,
                citations=citation_rows,
                evidence=chunks,
                intent="semantic",
            ),
        )

    await record_audit(
        session,
        actor_id=user.id,
        action="chat.answer",
        resource_type="conversation",
        metadata={"intent": "semantic", "found": found, "citations": len(citations), "streamed": True},
    )
    await session.commit()
    yield await _sse("done", {"found": found, "intent": "semantic"})


@router.get("/conversations", response_model=list[ConversationOut])
async def conversations(
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """The caller's own conversations plus the ones shared with them."""
    stmt = (
        select(Conversation)
        .where(Conversation.user_id == user.id)
        .order_by(Conversation.created_at.desc())
        .limit(100)
    )
    owned = list((await session.execute(stmt)).scalars().all())
    shared = await list_shared_conversations(session, user, limit=100)

    # A conversation may be owned and shared back — keep the owner's view of it.
    merged: dict[uuid.UUID, tuple[Conversation, str]] = {
        c.id: (c, ACCESS_OWNER) for c in owned
    }
    for conversation, access in shared:
        merged.setdefault(conversation.id, (conversation, access))

    items = sorted(
        merged.values(),
        key=lambda item: item[0].created_at
        or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )[:100]
    return [
        ConversationOut(
            id=c.id,
            title=c.title,
            created_at=c.created_at.isoformat() if c.created_at else None,
            access=access,
        )
        for c, access in items
    ]


@router.get("/conversations/{conversation_id}/messages", response_model=list[MessageOut])
async def conversation_messages(
    conversation_id: uuid.UUID,
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    conversation, access = await resolve_conversation_access(
        session, user, conversation_id
    )
    if conversation is None or access not in (ACCESS_OWNER, ACCESS_CONTRIBUTE, ACCESS_READ):
        # No access at all — do not disclose that the conversation exists.
        return []
    stmt = (
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [
        MessageOut(
            id=m.id,
            role=m.role,
            content=m.content,
            answer_found=m.answer_found,
            created_at=m.created_at.isoformat() if m.created_at else None,
        )
        for m in rows
    ]

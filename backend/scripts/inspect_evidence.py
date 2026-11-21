"""Compare what retrieval returned for each recorded answer.

Reads the persisted retrieval evidence for every assistant message that
answered a question, so the chunks that were actually shown to the model can
be compared across runs — not inferred.

Usage: python -m scripts.inspect_evidence
"""

import asyncio

from sqlalchemy import select

from app.db.session import async_session
from app.db.models.chunk import DocumentChunk
from app.db.models.document import Document
from app.db.models.citation import Citation
from app.db.models.conversation import Conversation
from app.db.models.evidence import RetrievalEvidence
from app.db.models.message import Message


async def main() -> None:
    async with async_session() as session:
        rows = (
            await session.execute(
                select(Message.id, Message.conversation_id, Message.content,
                       Message.answer_found, Message.created_at)
                .where(Message.role == "assistant")
                .order_by(Message.created_at.desc())
                .limit(12)
            )
        ).all()

        for msg_id, conv_id, content, answer_found, created_at in rows:
            if not content:
                continue

            # The question that produced this answer.
            question = (
                await session.execute(
                    select(Message.content)
                    .where(Message.conversation_id == conv_id,
                           Message.role == "user")
                    .order_by(Message.created_at.asc())
                )
            ).scalars().first()

            ev = (
                await session.execute(
                    select(
                        RetrievalEvidence.rank,
                        RetrievalEvidence.score,
                        DocumentChunk.page_start,
                        DocumentChunk.chunk_index,
                        Document.filename,
                    )
                    .join(DocumentChunk, DocumentChunk.id == RetrievalEvidence.chunk_id)
                    .join(Document, Document.id == DocumentChunk.document_id)
                    .where(RetrievalEvidence.message_id == msg_id)
                    .order_by(RetrievalEvidence.rank)
                )
            ).all()

            cites = (
                await session.execute(
                    select(Citation.ordinal, Citation.quote)
                    .where(Citation.message_id == msg_id)
                    .order_by(Citation.ordinal)
                )
            ).all()

            print("=" * 78)
            print(f"message {str(msg_id)[:8]}  found={answer_found}  at {created_at}")
            print(f"  question : {(question or '')[:120]}")
            print(f"  answer   : {(content or '')[:120]}")
            print(f"  chunks {len(ev)}  citations {len(cites)}")
            for rank, score, page, idx, filename in ev:
                print(f"    rank {rank}  score {score:.4f}  {filename}  p{page} c{idx}")
            for ordinal, quote in cites:
                print(f"    cite [{ordinal}] {(quote or '')[:90]}")


if __name__ == "__main__":
    asyncio.run(main())

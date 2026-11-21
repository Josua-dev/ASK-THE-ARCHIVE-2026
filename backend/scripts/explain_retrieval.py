"""Explain a retrieval: what was ranked, what was permitted, what was cut.

Retrieval questions are the hard ones to answer by eye. When a document does
not appear in an answer it helps to know which of three things happened: the
embedder ranked it low, the permission filter removed it, or the top-k cut
dropped it. This tool separates the three.

    ./.venv/Scripts/python.exe -m scripts.explain_retrieval
    ./.venv/Scripts/python.exe -m scripts.explain_retrieval "what are the
        security obligations?" viewer

The second argument is the role to retrieve as. It defaults to admin, which
sees every document, so the permission column reads as a no-op until you pass
a different role.
"""

import asyncio
import sys

from sqlalchemy import select, text

from app.db.models.user import User
from app.db.session import get_session
from app.modules.retrieval.service import search
from app.ports.factory import get_embedder

DEFAULT_QUESTION = "What are the security and data protection obligations?"


async def _user_for_role(session, role: str) -> User:
    """The seeded account for a role, so the tool exercises the real ACL."""
    users = (
        await session.execute(
            select(User).where(User.role == role, User.is_active.is_(True))
        )
    ).scalars().all()
    if not users:
        raise SystemExit(
            f"no active account with role {role!r}. Run "
            f"'python -m scripts.seed' first."
        )
    return users[0]


async def _permitted_document_ids(session, user: User) -> set:
    """Every document the ACL permits this user to read, ranked or not.

    This is the set the permission filter works against, so a document that
    is absent from it was genuinely refused — not merely left outside the
    top-k cut.
    """
    sql = text(
        """
        WITH permitted AS (
            SELECT d.id AS document_id
            FROM documents d
            WHERE d.uploaded_by = :user_id
            UNION
            SELECT dp.document_id
            FROM document_permissions dp
            WHERE dp.permission IN ('view', 'download', 'manage')
              AND (
                (dp.grantee_type = 'user' AND dp.grantee_user_id = :user_id)
                OR (dp.grantee_type = 'role' AND dp.grantee_role = :role)
              )
        )
        SELECT document_id FROM permitted
        """
    )
    result = await session.execute(
        sql, {"user_id": str(user.id), "role": user.role}
    )
    return {r[0] for r in result.fetchall()}


async def _unfiltered_ranking(session, model: str, qvec: str, limit: int = 30):
    """Every chunk in the corpus, ranked, ignoring the ACL.

    This is the counterfactual the permission filter is measured against.
    """
    rows = (
        await session.execute(
            text(
                """
                SELECT c.document_id, d.filename, c.page_start, c.page_end,
                       1 - (c.embedding <=> CAST(:qvec AS vector)) AS score,
                       left(c.text, 120) AS excerpt
                FROM document_chunks c
                JOIN documents d ON d.id = c.document_id
                WHERE c.embedding_model = :model
                ORDER BY c.embedding <=> CAST(:qvec AS vector)
                LIMIT :limit
                """
            ),
            {"qvec": qvec, "model": model, "limit": limit},
        )
    ).fetchall()
    return rows


def main() -> None:
    question = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_QUESTION
    role = sys.argv[2] if len(sys.argv) > 2 else "admin"

    async def run() -> None:
        embedder = get_embedder()
        query_vector = (await embedder.embed([question]))[0]
        qvec = str(query_vector)

        async with get_session() as session:
            user = await _user_for_role(session, role)

            permitted = await search(
                session,
                user,
                query_vector,
                embedding_model=embedder.model_id,
                top_k=6,
                min_score=0.0,
            )
            allowed_ids = await _permitted_document_ids(session, user)
            everything = await _unfiltered_ranking(
                session, embedder.model_id, qvec, limit=30
            )

        retrieved_ids = {c.document_id for c in permitted}

        print(f"question : {question}")
        print(f"role     : {role} ({user.email})")
        print(f"embedder : {embedder.model_id}\n")

        print("-- permitted passages (the real search() result) --")
        if not permitted:
            print("  (none)")
        for i, c in enumerate(permitted, start=1):
            excerpt = " ".join(c.text.split())[:78]
            print(
                f"  {i}. {c.filename} p.{c.page_start}-{c.page_end} "
                f"score={c.score:.4f}"
            )
            print(f"     {excerpt}")

        print("\n-- corpus ranking, and what the ACL removed --")
        refused = set()
        for i, row in enumerate(everything, start=1):
            doc_id, filename, page_start, page_end, score, excerpt = row
            if doc_id in retrieved_ids:
                mark = "retrieved"
            elif doc_id in allowed_ids:
                mark = "permitted, cut by top-k"
            else:
                mark = "NOT PERMITTED"
                refused.add(filename)
            print(
                f"  {i:>3}. {filename:<40} p.{page_start}-{page_end} "
                f"{score:.4f}  {mark}"
            )
            if mark == "NOT PERMITTED":
                print(f"       {' '.join(excerpt.split())[:76]}")

        print(f"\ndocuments the ACL refused for {role}: {len(refused)}")
        for name in sorted(refused):
            print(f"  - {name}")

    asyncio.run(run())


if __name__ == "__main__":
    main()

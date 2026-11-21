"""One-off restore: recreate the meridian-park-lease document row + grants.

Used after the permission-ACL audit deleted the row while proving the
viewer->manage privilege escalation. Re-ingests the original file from the
local storage folder so the document is searchable again.
"""

import asyncio
import uuid
from pathlib import Path

from sqlalchemy import select

from app.db.models.document import Document
from app.db.models.permission import DocumentPermission
from app.db.models.user import User
from app.db.session import async_session, engine
from app.modules.documents.permissions import grant
from app.modules.ingestion.pipeline import ingest_document

DOC_ID = uuid.UUID("ca1f85a5-9fff-47e4-85e0-2f2d44f52ed6")
STORAGE_KEY = f"documents/{DOC_ID}/meridian-park-lease.pdf"


async def restore() -> None:
    async with async_session() as session:
        existing = await session.get(Document, DOC_ID)
        if existing is not None:
            print("already present — nothing to do")
            return

        admin = (
            await session.execute(
                select(User).where(User.email == "admin@archivedemo.example.com")
            )
        ).scalar_one_or_none()
        if admin is None:
            raise SystemExit("admin account missing — run the seed first")

        path = Path("uploads") / STORAGE_KEY
        body = path.read_bytes()

        import hashlib

        document = Document(
            id=DOC_ID,
            storage_key=STORAGE_KEY,
            filename="meridian-park-lease.pdf",
            content_type="application/pdf",
            byte_size=len(body),
            checksum_sha256=hashlib.sha256(body).hexdigest(),
            status="uploaded",
            uploaded_by=admin.id,
        )
        session.add(document)
        await session.flush()

        await ingest_document(session, DOC_ID)

        for role in ("viewer", "analyst"):
            await grant(
                session,
                DOC_ID,
                grantee_type="role",
                permission="download",
                grantee_role=role,
                granted_by=admin.id,
            )
        await session.commit()
        print(f"restored {document.filename} id={document.id} status={document.status}")


if __name__ == "__main__":
    asyncio.run(restore())
    asyncio.run(engine.dispose())

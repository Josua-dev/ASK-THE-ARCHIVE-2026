"""Seed the archive: users, corpus, ingestion and the permission matrix.

The permission matrix is what makes demo TEST 4 work — the analyst can read
the leases and the contracts, the viewer can only read the two policies, and
the NDA is restricted to admins. So the same question returns different
answers depending on who asks.

Usage:
    python -m scripts.seed                    # reset and reseed
    python -m scripts.seed --if-empty         # seed only when the archive is empty
    python -m scripts.seed --backfill-locations  # locate the documents already in the archive
"""

import asyncio
import hashlib
import sys
import uuid
from datetime import datetime, timezone
from itertools import product
from pathlib import Path

from sqlalchemy import delete, func, select

from app.core.config import settings
from app.core.security import hash_password
from app.db.models.document import Document
from app.db.models.permission import DocumentPermission
from app.db.models.user import User
from app.db.session import async_session, engine
from app.modules.auth.service import create_user
from app.modules.documents.permissions import grant
from app.modules.documents.service import BOXES, RACKS, SHELVES, ZONES
from app.modules.ingestion.pipeline import ingest_document
from app.ports.factory import get_storage

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts.seed_corpus import BUILDERS, build_corpus  # noqa: E402

# The demo accounts come from the application settings, so the credentials
# the README and the compose file advertise are the credentials the accounts
# actually have. A second hard-coded copy is a second thing to forget.
ADMIN_EMAIL = settings.seed_admin_email
ANALYST_EMAIL = settings.seed_analyst_email
VIEWER_EMAIL = settings.seed_viewer_email

ADMIN_PASSWORD = settings.seed_admin_password
DEMO_PASSWORD = settings.seed_demo_password

# Filename -> the roles that may read it. Anything not listed is admin-only.
ROLE_VISIBILITY = {
    "harbour-street-lease.pdf": ("analyst", "viewer"),
    "meridian-park-lease.pdf": ("analyst", "viewer"),
    "northgate-warehouse-lease.pdf": ("analyst",),
    "kestrel-facilities-contract.pdf": ("analyst",),
    "ridgeline-supply-agreement.pdf": ("analyst",),
    "data-retention-policy.pdf": ("viewer",),
    "information-security-policy.pdf": ("viewer",),
    "infrastructure-survey-2026.pdf": ("analyst", "viewer"),
    "transit-authority-mou.pdf": ("analyst",),
    "kestrel-q4-invoice.pdf": ("analyst",),
    # aurora-mutual-nda.pdf intentionally absent — admin only.
}

# The slot count is 4 zones x 4 racks x 3 shelves x 6 boxes = 288. A stride
# coprime with that count visits every slot exactly once, so no two seeded
# documents can land on the same one. The stride is also deliberately not a
# multiple of the zone size (72), so consecutive documents land in different
# zones rather than filling one zone first.
_SEED_STRIDE = 43


def seed_slot(index: int) -> tuple[str, str, str, str]:
    """A distinct warehouse slot for the document at `index`.

    The slots are walked in a stride that is coprime with the slot count, so
    consecutive documents land in different zones, racks and shelves rather
    than filling one box in order. Because the stride is coprime, the mapping
    from document index to slot is injective for as many documents as the
    vocabulary holds — no two seeded documents ever claim the same slot.
    """
    slots = list(product(ZONES, RACKS, SHELVES, BOXES))
    return slots[(index * _SEED_STRIDE) % len(slots)]


async def ensure_user(
    session, email: str, display_name: str, role: str, password: str
) -> User:
    existing = (
        await session.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if existing is not None:
        existing.role = role
        existing.is_active = True
        existing.display_name = display_name
        # Re-hash the password so the documented demo credentials always work
        # after a reseed — even if the password was changed, or the account
        # was provisioned under an older address scheme.
        existing.password_hash = hash_password(password)
        await session.flush()
        return existing
    return await create_user(
        session,
        email=email,
        display_name=display_name,
        password=password,
        role=role,
        actor_id=None,
    )


async def _already_seeded() -> bool:
    """True when the archive already holds both documents and users.

    The container seeds on first boot. On a restart it must not re-ingest the
    whole corpus — that takes minutes and would discard anything the user has
    done since.
    """
    async with async_session() as session:
        documents = (
            await session.execute(select(func.count()).select_from(Document))
        ).scalar_one()
        users = (
            await session.execute(select(func.count()).select_from(User))
        ).scalar_one()
    return documents > 0 and users > 0


async def seed(only_if_empty: bool = False) -> None:
    if only_if_empty and await _already_seeded():
        print("archive already seeded — skipping (run without --if-empty to reset)")
        return

    paths = build_corpus()
    print(f"generated {len(paths)} documents")

    async with async_session() as session:
        admin = await ensure_user(
            session, ADMIN_EMAIL, "Avery Chen", "admin", ADMIN_PASSWORD
        )
        analyst = await ensure_user(
            session, ANALYST_EMAIL, "Noor Haddad", "analyst", DEMO_PASSWORD
        )
        viewer = await ensure_user(
            session, VIEWER_EMAIL, "Sam Okafor", "viewer", DEMO_PASSWORD
        )
        await session.commit()
        print(f"users: {admin.email}, {analyst.email}, {viewer.email}")

    storage = get_storage()

    async with async_session() as session:
        # Clear previous corpus documents and their permissions.
        existing = (await session.execute(select(Document))).scalars().all()
        for doc in existing:
            await session.execute(
                delete(DocumentPermission).where(DocumentPermission.document_id == doc.id)
            )
            await session.delete(doc)
        await session.commit()

        for index, path in enumerate(paths):
            body = path.read_bytes()
            document_id = uuid.uuid4()
            key = f"documents/{document_id}/{path.name}"
            await storage.put_object(key, body, "application/pdf", {"filename": path.name})
            # Spread the corpus across the map so the demo warehouse shows
            # occupancy in several zones, not a single shelf. The slot is
            # derived from the index rather than taken from the first free
            # one, so the corpus stays legible as the archive grows.
            zone, rack, shelf, box = seed_slot(index)
            document = Document(
                id=document_id,
                storage_key=key,
                filename=path.name,
                content_type="application/pdf",
                byte_size=len(body),
                checksum_sha256=hashlib.sha256(body).hexdigest(),
                status="uploaded",
                uploaded_by=admin.id,
                zone=zone,
                rack=rack,
                shelf=shelf,
                box=box,
            )
            session.add(document)
            await session.flush()

            await ingest_document(session, document.id)

            # "download" implies "view", and it also lets the reader fetch the
            # original file from the document view — which is what a reviewer
            # actually needs to do with a document they are allowed to read.
            # Admins bypass the ACL entirely, so they need no grant at all.
            for role in ROLE_VISIBILITY.get(path.name, ()):
                await grant(
                    session,
                    document.id,
                    grantee_type="role",
                    permission="download",
                    grantee_role=role,
                    granted_by=admin.id,
                )
            await session.commit()
            print(f"  {path.name:38s} -> {document.doc_type:8s} expiry={document.expiry_date}")

        # Remove demo accounts left behind by an earlier email scheme. The
        # login form validates addresses strictly, so an address the
        # validator rejects is an account nobody can sign into — dead weight
        # in the admin panel. This runs after the documents are cleared,
        # because those rows reference their uploader.
        stale = (
            await session.execute(
                select(User).where(
                    User.email.notin_([ADMIN_EMAIL, ANALYST_EMAIL, VIEWER_EMAIL]),
                    User.email.like("%@archive.test")
                    | User.email.like("%@askthearchive.local"),
                )
            )
        ).scalars().all()
        for user in stale:
            await session.delete(user)
        if stale:
            await session.commit()
            print(f"removed {len(stale)} stale demo account(s)")

    await engine.dispose()
    print("\nseed complete.")
    print(f"admin:   {ADMIN_EMAIL} / {ADMIN_PASSWORD}")
    print(f"analyst: {ANALYST_EMAIL} / {DEMO_PASSWORD}")
    print(f"viewer:  {VIEWER_EMAIL} / {DEMO_PASSWORD}")


async def backfill_locations() -> None:
    """Give every document that has none a slot, leaving everything else alone.

    An archive seeded before the warehouse feature existed has no locations.
    Uploads are located from now on, but the documents already in the archive
    would stay off the map — so this fills them in. The corpus is placed
    first, in the order the seed uses, so a backfilled archive and a freshly
    seeded one look the same on the map.
    """
    async with async_session() as session:
        docs = list(
            (
                await session.execute(
                    select(Document).order_by(Document.created_at, Document.filename)
                )
            ).scalars().all()
        )
        corpus_order = {name: index for index, (name, _) in enumerate(BUILDERS)}
        corpus_docs = sorted(
            (d for d in docs if d.filename in corpus_order),
            key=lambda d: corpus_order[d.filename],
        )
        other_docs = sorted(
            (d for d in docs if d.filename not in corpus_order),
            key=lambda d: (d.created_at or datetime.min.replace(tzinfo=timezone.utc), d.filename),
        )

        occupied = {
            (d.zone, d.rack, d.shelf, d.box)
            for d in docs
            if d.zone is not None
        }
        counter = 0
        for doc in corpus_docs + other_docs:
            if doc.zone is not None:
                # Already located: the archive knows where it is.
                continue
            while True:
                if counter >= len(ZONES) * len(RACKS) * len(SHELVES) * len(BOXES):
                    raise RuntimeError("the warehouse has no free slot left")
                slot = seed_slot(counter)
                counter += 1
                if slot not in occupied:
                    break
            occupied.add(slot)
            doc.zone, doc.rack, doc.shelf, doc.box = slot
            zone, rack, shelf, box = slot
            print(f"  {doc.filename:38s} -> Zone {zone} · Rack {rack} · Shelf {shelf} · Box {box}")
        await session.commit()
    print("\nbackfill complete.")


if __name__ == "__main__":
    if "--backfill-locations" in sys.argv:
        asyncio.run(backfill_locations())
    else:
        asyncio.run(seed(only_if_empty="--if-empty" in sys.argv))

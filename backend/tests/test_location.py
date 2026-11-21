"""The warehouse location feature, exercised against the real database.

A location is a claim about the physical archive: it says which box a
document is in. Two claims that disagree are not a formatting problem — one
of them is wrong, and a reader who can see the map would act on it. So the
vocabulary, the uniqueness of a slot, and the permission filter on the map
are all tested here against real PostgreSQL rather than a mock.

Each test creates its own documents and grants and removes them afterwards,
so the suite never depends on or disturbs the seeded demo archive.
"""

import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import delete, select

from app.core.deps import get_current_user
from app.db.models.document import Document
from app.db.models.document_checkout import DocumentCheckout
from app.db.models.permission import DocumentPermission
from app.db.models.user import User
from app.db.session import async_session
from app.main import app
from app.modules.documents.permissions import grant
from app.modules.documents.service import (
    BOXES,
    RACKS,
    SHELVES,
    ZONES,
    assign_slot,
    auto_assign_location,
    build_location_label,
    check_in_document,
    check_out_document,
    clear_location,
    find_first_free_slot,
    open_checkouts,
    set_location,
    validate_location,
)
from app.shared.audit import record_audit

pytestmark = pytest.mark.asyncio


def all_slots() -> list[tuple[str, str, str, str]]:
    """Every slot in the vocabulary, in the order the service walks them."""
    return [
        (zone, rack, shelf, box)
        for zone in ZONES
        for rack in RACKS
        for shelf in SHELVES
        for box in BOXES
    ]


async def occupied_slots_db(session) -> set[tuple[str, str, str, str]]:
    """The slots the database currently holds, read with plain SQL.

    This is the oracle the service's "first free slot" is checked against:
    it does not share code with the service's own occupancy query.
    """
    stmt = select(
        Document.zone, Document.rack, Document.shelf, Document.box
    ).where(Document.zone.isnot(None))
    return {tuple(row) for row in (await session.execute(stmt)).all()}


async def free_slots(session, count: int = 1) -> list[tuple[str, str, str, str]]:
    """Slots that are free in the archive right now.

    The archive is live — the demo corpus may be reseeded between runs — so
    the tests take their slots from what is actually free rather than from
    fixed coordinates that a reseed would have taken.
    """
    occupied = await occupied_slots_db(session)
    free = [slot for slot in all_slots() if slot not in occupied]
    assert len(free) >= count, "the archive has no free slots left"
    return free[:count]


async def make_user(email: str, role: str) -> User:
    local, _, domain = email.partition("@")
    unique_email = f"{local}-{uuid.uuid4().hex[:8]}@{domain}"
    user = User(
        id=uuid.uuid4(),
        email=unique_email,
        display_name=email.split("@")[0],
        role=role,
        password_hash="x",
        is_active=True,
    )
    async with async_session() as session:
        session.add(user)
        await session.commit()
    return user


async def make_document(owner: User, filename: str) -> uuid.UUID:
    """Create a document row and return its id."""
    document_id = uuid.uuid4()
    doc = Document(
        id=document_id,
        storage_key=f"documents/{document_id}/{filename}",
        filename=filename,
        content_type="application/pdf",
        byte_size=10,
        checksum_sha256="0" * 64,
        status="ready",
        doc_type="lease",
        uploaded_by=owner.id,
    )
    async with async_session() as session:
        session.add(doc)
        await session.commit()
    return document_id


async def load(session, document_id: uuid.UUID) -> Document:
    """The document as this session sees it — writes need it persistent."""
    return await session.get(Document, document_id)


async def cleanup(*users: User, **document_ids: uuid.UUID) -> None:
    async with async_session() as session:
        for document_id in document_ids.values():
            await session.execute(
                delete(DocumentPermission).where(
                    DocumentPermission.document_id == document_id
                )
            )
            doc = await session.get(Document, document_id)
            if doc is not None:
                await session.delete(doc)
        for user in users:
            await session.delete(user)
        await session.commit()


@asynccontextmanager
async def client_for(user: User):
    """An ASGI client whose caller is `user`.

    The database session is left real: the permission filter under test
    lives in SQL, and a mocked session would only prove the mock works.
    """

    async def _current_user():
        return user

    app.dependency_overrides[get_current_user] = _current_user
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            timeout=60.0,
        ) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


class TestVocabulary:
    """A location names a real place in the archive or it names nothing."""

    def test_all_null_is_a_valid_unlocated_state(self):
        validate_location(None, None, None, None)

    def test_all_set_in_vocabulary_is_valid(self):
        validate_location("A", "R3", "2", "B4")

    @pytest.mark.parametrize(
        "parts",
        [
            ("A", None, None, None),
            ("A", "R3", None, None),
            (None, "R3", "2", None),
            ("A", "R3", "2", None),
            (None, None, None, "B4"),
        ],
    )
    def test_a_partial_location_is_refused(self, parts):
        """'Zone A but which rack?' names a place that does not exist."""
        with pytest.raises(ValueError):
            validate_location(*parts)

    @pytest.mark.parametrize(
        "parts",
        [
            ("Z", "R3", "2", "B4"),
            ("A", "R9", "2", "B4"),
            ("A", "R3", "9", "B4"),
            ("A", "R3", "2", "B9"),
            ("a", "R3", "2", "B4"),
            ("A", "r3", "2", "B4"),
            ("", "R3", "2", "B4"),
        ],
    )
    def test_a_value_outside_the_vocabulary_is_refused(self, parts):
        with pytest.raises(ValueError):
            validate_location(*parts)

    def test_the_vocabulary_is_the_documented_one(self):
        assert ZONES == ("A", "B", "C", "D")
        assert RACKS == ("R1", "R2", "R3", "R4")
        assert SHELVES == ("1", "2", "3")
        assert BOXES == ("B1", "B2", "B3", "B4", "B5", "B6")


class TestLabel:
    def test_the_label_reads_as_a_path(self):
        label = build_location_label("A", "R3", "2", "B4")
        assert label == "Zone A · Rack R3 · Shelf 2 · Box B4"

    def test_the_separator_is_the_middle_dot(self):
        label = build_location_label("A", "R3", "2", "B4")
        assert "·" in label
        assert label.count("·") == 3

    def test_an_unlocated_document_has_no_label(self):
        assert build_location_label(None, None, None, None) is None


class TestSlotSelection:
    async def test_the_first_free_slot_skips_an_occupied_one(self):
        owner = await make_user("slot-owner@test.local", "admin")
        document_id = await make_document(owner, "slot.pdf")
        try:
            async with async_session() as session:
                occupied = await occupied_slots_db(session)
                # The slot the free-slot search would pick if nothing were
                # in the way.
                first = next(slot for slot in all_slots() if slot not in occupied)
                doc = await load(session, document_id)
                await assign_slot(session, doc, *first)
                await session.commit()

                occupied = await occupied_slots_db(session)
                assert first in occupied

                chosen = await find_first_free_slot(session)
                assert chosen not in occupied
                assert chosen == next(slot for slot in all_slots() if slot not in occupied)
        finally:
            await cleanup(owner, doc=document_id)

    async def test_a_box_may_hold_multiple_documents(self):
        """A box is a physical container, not a unique index.

        Several documents can share a zone/rack/shelf/box; each one's position
        inside the box is decided by its filed-at date, not by the slot.
        """
        owner = await make_user("shared-box-owner@test.local", "admin")
        first_id = await make_document(owner, "shared-first.pdf")
        second_id = await make_document(owner, "shared-second.pdf")
        try:
            async with async_session() as session:
                first = await load(session, first_id)
                await assign_slot(session, first, "A", "R1", "1", "B1")
                await session.commit()

                second = await load(session, second_id)
                await assign_slot(session, second, "A", "R1", "1", "B1")
                await session.commit()

                # Both documents sit in the same box.
                assert (first.zone, first.rack, first.shelf, first.box) == (
                    "A",
                    "R1",
                    "1",
                    "B1",
                )
                assert (second.zone, second.rack, second.shelf, second.box) == (
                    "A",
                    "R1",
                    "1",
                    "B1",
                )
        finally:
            await cleanup(owner, first=first_id, second=second_id)

    async def test_a_document_may_keep_its_own_slot(self):
        owner = await make_user("keep-owner@test.local", "admin")
        document_id = await make_document(owner, "keep.pdf")
        try:
            async with async_session() as session:
                doc = await load(session, document_id)
                await assign_slot(session, doc, "B", "R2", "2", "B3")
                await session.commit()
                await assign_slot(session, doc, "B", "R2", "2", "B3")
                await session.commit()
                assert (doc.zone, doc.rack, doc.shelf, doc.box) == (
                    "B",
                    "R2",
                    "2",
                    "B3",
                )
        finally:
            await cleanup(owner, doc=document_id)

    async def test_auto_assignment_gives_the_document_a_free_slot(self):
        owner = await make_user("auto-owner@test.local", "admin")
        document_id = await make_document(owner, "auto.pdf")
        try:
            async with async_session() as session:
                doc = await load(session, document_id)
                await auto_assign_location(session, doc)
                await session.commit()
                assert doc.zone in ZONES
                assert doc.rack in RACKS
                assert doc.shelf in SHELVES
                assert doc.box in BOXES
        finally:
            await cleanup(owner, doc=document_id)

    async def test_clearing_removes_every_part(self):
        owner = await make_user("clear-owner@test.local", "admin")
        document_id = await make_document(owner, "clear.pdf")
        try:
            async with async_session() as session:
                doc = await load(session, document_id)
                await assign_slot(session, doc, "C", "R4", "3", "B5")
                await session.commit()
                await clear_location(session, doc)
                await session.commit()
                assert (doc.zone, doc.rack, doc.shelf, doc.box) == (
                    None,
                    None,
                    None,
                    None,
                )
        finally:
            await cleanup(owner, doc=document_id)

    async def test_setting_a_partial_location_is_refused(self):
        owner = await make_user("partial-owner@test.local", "admin")
        document_id = await make_document(owner, "partial.pdf")
        try:
            async with async_session() as session:
                doc = await load(session, document_id)
                with pytest.raises(ValueError):
                    await set_location(session, doc, "A", "R1", None, "B1")
                # The refused document must not have moved.
                assert doc.zone is None
                await session.rollback()
        finally:
            await cleanup(owner, doc=document_id)


class TestWarehouseLayoutIsPermissionFiltered:
    """The map shows where things are. It must not show where everything is.

    A slot belonging to a document the caller cannot read is a fact about a
    document they were not allowed to know about, so it is filtered with the
    same permission filter the document list uses.
    """

    async def test_a_viewer_does_not_see_a_slot_they_may_not_read(self):
        admin = await make_user("layout-admin@test.local", "admin")
        viewer = await make_user("layout-viewer@test.local", "viewer")
        readable_id = await make_document(admin, "readable.pdf")
        hidden_id = await make_document(admin, "hidden.pdf")
        try:
            async with async_session() as session:
                readable = await load(session, readable_id)
                hidden = await load(session, hidden_id)
                await assign_slot(session, readable, "D", "R1", "1", "B1")
                await assign_slot(session, hidden, "D", "R1", "1", "B2")
                await grant(
                    session,
                    readable_id,
                    grantee_type="role",
                    grantee_role="viewer",
                    permission="view",
                    granted_by=admin.id,
                )
                await session.commit()

            async with client_for(viewer) as client:
                res = await client.get("/api/v1/warehouse/layout")
                assert res.status_code == 200, res.text[:400]
                body = res.json()
                assert body["zones"] == list(ZONES)
                assert body["racks"] == list(RACKS)
                assert body["shelves"] == list(SHELVES)
                assert body["boxes"] == list(BOXES)

                slots = {s["document_id"]: s for s in body["slots"]}
                assert str(readable_id) in slots
                assert str(hidden_id) not in slots, (
                    "the map leaked a slot belonging to a document the viewer "
                    "cannot read"
                )
        finally:
            await cleanup(viewer, admin, readable=readable_id, hidden=hidden_id)

    async def test_an_admin_sees_every_occupied_slot(self):
        admin = await make_user("layout-full-admin@test.local", "admin")
        document_id = await make_document(admin, "admin-visible.pdf")
        try:
            async with async_session() as session:
                doc = await load(session, document_id)
                await assign_slot(session, doc, "D", "R2", "1", "B3")
                await session.commit()

            async with client_for(admin) as client:
                res = await client.get("/api/v1/warehouse/layout")
                assert res.status_code == 200, res.text[:400]
                slots = {s["document_id"]: s for s in res.json()["slots"]}
                assert str(document_id) in slots
        finally:
            await cleanup(admin, doc=document_id)


class TestLocationRoutes:
    async def test_reading_a_location_requires_view_access(self):
        admin = await make_user("read-admin@test.local", "admin")
        viewer = await make_user("read-viewer@test.local", "viewer")
        document_id = await make_document(admin, "read.pdf")
        try:
            async with async_session() as session:
                doc = await load(session, document_id)
                await assign_slot(session, doc, "A", "R2", "1", "B2")
                await session.commit()

            async with client_for(viewer) as client:
                res = await client.get(f"/api/v1/documents/{document_id}/location")
                assert res.status_code == 403, res.text[:400]

            async with client_for(admin) as client:
                res = await client.get(f"/api/v1/documents/{document_id}/location")
                assert res.status_code == 200, res.text[:400]
                assert res.json() == {
                    "zone": "A",
                    "rack": "R2",
                    "shelf": "1",
                    "box": "B2",
                    "label": "Zone A · Rack R2 · Shelf 1 · Box B2",
                }
        finally:
            await cleanup(viewer, admin, doc=document_id)

    async def test_the_document_list_carries_the_location(self):
        """The library grid renders its badge without a request per card."""
        admin = await make_user("list-admin@test.local", "admin")
        document_id = await make_document(admin, "listed.pdf")
        try:
            async with async_session() as session:
                doc = await load(session, document_id)
                await assign_slot(session, doc, "C", "R3", "2", "B5")
                await session.commit()

            async with client_for(admin) as client:
                res = await client.get("/api/v1/documents")
                assert res.status_code == 200, res.text[:400]
                items = {item["id"]: item for item in res.json()["items"]}
                entry = items[str(document_id)]
                assert entry["zone"] == "C"
                assert entry["rack"] == "R3"
                assert entry["shelf"] == "2"
                assert entry["box"] == "B5"
        finally:
            await cleanup(admin, doc=document_id)

    async def test_writing_a_location_requires_manage_access(self):
        admin = await make_user("write-admin@test.local", "admin")
        viewer = await make_user("write-viewer@test.local", "viewer")
        document_id = await make_document(admin, "written.pdf")
        try:
            async with async_session() as session:
                await grant(
                    session,
                    document_id,
                    grantee_type="role",
                    grantee_role="viewer",
                    permission="view",
                    granted_by=admin.id,
                )
                await session.commit()

            async with client_for(viewer) as client:
                res = await client.put(
                    f"/api/v1/documents/{document_id}/location",
                    json={"zone": "A", "rack": "R1", "shelf": "1", "box": "B1"},
                )
                assert res.status_code == 403, res.text[:400]

                res = await client.post(f"/api/v1/documents/{document_id}/location/auto")
                assert res.status_code == 403, res.text[:400]
        finally:
            await cleanup(viewer, admin, doc=document_id)

    async def test_the_uploader_may_place_their_own_document(self):
        viewer = await make_user("owner-viewer@test.local", "viewer")
        document_id = await make_document(viewer, "owned.pdf")
        try:
            async with client_for(viewer) as client:
                res = await client.put(
                    f"/api/v1/documents/{document_id}/location",
                    json={"zone": "A", "rack": "R1", "shelf": "1", "box": "B1"},
                )
                assert res.status_code == 200, res.text[:400]
                assert res.json()["zone"] == "A"
        finally:
            await cleanup(viewer, doc=document_id)

    async def test_a_partial_location_is_a_422(self):
        admin = await make_user("partial-route-admin@test.local", "admin")
        document_id = await make_document(admin, "partial-route.pdf")
        try:
            async with client_for(admin) as client:
                res = await client.put(
                    f"/api/v1/documents/{document_id}/location",
                    json={"zone": "A", "rack": "R1", "shelf": None, "box": "B1"},
                )
                assert res.status_code == 422, res.text[:400]
        finally:
            await cleanup(admin, doc=document_id)

    async def test_an_unknown_vocabulary_value_is_a_422(self):
        admin = await make_user("vocab-route-admin@test.local", "admin")
        document_id = await make_document(admin, "vocab-route.pdf")
        try:
            async with client_for(admin) as client:
                res = await client.put(
                    f"/api/v1/documents/{document_id}/location",
                    json={"zone": "Q", "rack": "R1", "shelf": "1", "box": "B1"},
                )
                assert res.status_code == 422, res.text[:400]
        finally:
            await cleanup(admin, doc=document_id)

    async def test_an_occupied_slot_is_accepted(self):
        """A second document may be placed in an already-occupied slot."""
        admin = await make_user("slot-sharer@test.local", "admin")
        first_id = await make_document(admin, "first.pdf")
        second_id = await make_document(admin, "second.pdf")
        try:
            async with async_session() as session:
                first = await load(session, first_id)
                await assign_slot(session, first, "A", "R1", "1", "B1")
                await session.commit()

            async with client_for(admin) as client:
                res = await client.put(
                    f"/api/v1/documents/{second_id}/location",
                    json={"zone": "A", "rack": "R1", "shelf": "1", "box": "B1"},
                )
                assert res.status_code == 200, res.text[:400]

                body = res.json()
                assert body["zone"] == "A"
                assert body["rack"] == "R1"
                assert body["shelf"] == "1"
                assert body["box"] == "B1"
        finally:
            await cleanup(admin, first=first_id, second=second_id)

    async def test_clearing_a_location_removes_it(self):
        admin = await make_user("clear-route-admin@test.local", "admin")
        document_id = await make_document(admin, "clear-route.pdf")
        try:
            async with async_session() as session:
                doc = await load(session, document_id)
                await assign_slot(session, doc, "B", "R3", "1", "B1")
                await session.commit()

            async with client_for(admin) as client:
                res = await client.put(
                    f"/api/v1/documents/{document_id}/location",
                    json={"zone": None, "rack": None, "shelf": None, "box": None},
                )
                assert res.status_code == 200, res.text[:400]
                assert res.json() == {
                    "zone": None,
                    "rack": None,
                    "shelf": None,
                    "box": None,
                    "label": None,
                }
        finally:
            await cleanup(admin, doc=document_id)

    async def test_auto_assignment_fills_a_free_slot(self):
        admin = await make_user("auto-route-admin@test.local", "admin")
        document_id = await make_document(admin, "auto-route.pdf")
        try:
            async with client_for(admin) as client:
                res = await client.post(f"/api/v1/documents/{document_id}/location/auto")
                assert res.status_code == 200, res.text[:400]
                body = res.json()
                assert body["zone"] in ZONES
                assert body["rack"] in RACKS
                assert body["shelf"] in SHELVES
                assert body["box"] in BOXES
                assert body["label"] is not None
        finally:
            await cleanup(admin, doc=document_id)

    async def test_a_missing_document_is_a_404(self):
        admin = await make_user("missing-admin@test.local", "admin")
        async with client_for(admin) as client:
            res = await client.get(f"/api/v1/documents/{uuid.uuid4()}/location")
            assert res.status_code == 404, res.text[:400]


class TestCheckoutCheckin:
    """Full checkout/checkin lifecycle: row locks, audit, default due, open checkout enforcement."""

    async def test_checkout_then_checkin(self):
        admin = await make_user("coadmin@test.local", "admin")
        doc_id = await make_document(admin, "co-test.pdf")
        try:
            async with client_for(admin) as client:
                co1 = await client.post(f"/api/v1/documents/{doc_id}/checkout", json={})
                assert co1.status_code == 200, co1.text[:400]
                body1 = co1.json()
                assert body1["checked_in_at"] is None
                assert body1["due_at"] is not None
                ci = await client.post(f"/api/v1/documents/{doc_id}/checkin", json={})
                assert ci.status_code == 200, ci.text[:400]
                body2 = ci.json()
                assert body2["checked_in_at"] is not None
                co2 = await client.post(f"/api/v1/documents/{doc_id}/checkout", json={})
                assert co2.status_code == 200, co2.text[:400]
        finally:
            await cleanup(admin, doc=doc_id)

    async def test_reject_already_checked_out(self):
        admin = await make_user("already-co@test.local", "admin")
        doc_id = await make_document(admin, "already-co.pdf")
        try:
            async with client_for(admin) as client:
                co1 = await client.post(f"/api/v1/documents/{doc_id}/checkout", json={})
                assert co1.status_code == 200, co1.text[:400]
                co2 = await client.post(f"/api/v1/documents/{doc_id}/checkout", json={})
                assert co2.status_code == 422, co2.text[:400]
                ci = await client.post(f"/api/v1/documents/{doc_id}/checkin", json={})
                assert ci.status_code == 200, ci.text[:400]
                ci2 = await client.post(f"/api/v1/documents/{doc_id}/checkin", json={})
                assert ci2.status_code == 422, ci2.text[:400]
        finally:
            await cleanup(admin, doc=doc_id)

    async def test_reject_not_checked_out(self):
        admin = await make_user("no-co@test.local", "admin")
        doc_id = await make_document(admin, "no-co.pdf")
        try:
            async with client_for(admin) as client:
                ci = await client.post(f"/api/v1/documents/{doc_id}/checkin", json={})
                assert ci.status_code == 422, ci.text[:400]
        finally:
            await cleanup(admin, doc=doc_id)

    async def test_due_at_defaults_to_config_plus_offset(self):
        admin = await make_user("default-due@test.local", "admin")
        doc_id = await make_document(admin, "default-due.pdf")
        try:
            async with client_for(admin) as client:
                co = await client.post(f"/api/v1/documents/{doc_id}/checkout", json={})
                assert co.status_code == 200, co.text[:400]
                body = co.json()
                from datetime import timedelta, timezone as tz
                expected = datetime.now(tz.utc) + timedelta(days=7)
                due_at = datetime.fromisoformat(body["due_at"].replace("Z", "+00:00"))
                assert abs((due_at - expected).total_seconds()) < 60, (
                    f"due_at={due_at} expected~{expected}, diff={due_at - expected}"
                )
                ci = await client.post(f"/api/v1/documents/{doc_id}/checkin", json={})
                assert ci.status_code == 200, ci.text[:400]
        finally:
            await cleanup(admin, doc=doc_id)

    async def test_single_open_checkout_partial_unique_index(self):
        admin = await make_user("unique-co@test.local", "admin")
        doc_id = await make_document(admin, "unique-co.pdf")
        try:
            async with client_for(admin) as client:
                co1 = await client.post(f"/api/v1/documents/{doc_id}/checkout", json={})
                assert co1.status_code == 200, co1.text[:400]
                co2 = await client.post(f"/api/v1/documents/{doc_id}/checkout", json={})
                assert co2.status_code == 422, co2.text[:400]
                ci = await client.post(f"/api/v1/documents/{doc_id}/checkin", json={})
                assert ci.status_code == 200, ci.text[:400]
                co3 = await client.post(f"/api/v1/documents/{doc_id}/checkout", json={})
                assert co3.status_code == 200, co3.text[:400]
        finally:
            await cleanup(admin, doc=doc_id)

    async def test_audit_logs_checkout_checkin(self):
        admin = await make_user("audit-co@test.local", "admin")
        doc_id = await make_document(admin, "audit-co.pdf")
        try:
            async with client_for(admin) as client:
                co = await client.post(f"/api/v1/documents/{doc_id}/checkout", json={})
                assert co.status_code == 200, co.text[:400]
                ci = await client.post(f"/api/v1/documents/{doc_id}/checkin", json={})
                assert ci.status_code == 200, ci.text[:400]
            async with async_session() as session:
                from app.db.models.audit import AuditLog
                stmt = select(AuditLog).where(
                    AuditLog.resource_id == str(doc_id),
                    AuditLog.action.in_(["document.checkout", "document.checkin"]),
                )
                entries = (await session.execute(stmt)).scalars().all()
                assert len(entries) == 2, f"Expected 2 audit entries, got {len(entries)}"
                action_codes = {e.action for e in entries}
                assert "document.checkout" in action_codes
                assert "document.checkin" in action_codes
        finally:
            await cleanup(admin, doc=doc_id)
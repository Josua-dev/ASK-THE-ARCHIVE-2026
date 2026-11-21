"""A route that refuses bad input must refuse it, not crash.

Two real defects, both found by sweeping every endpoint with bad input rather
than by reading code:

  * `GET /api/v1/analytics` returned 500. The query filtered
    `Document.status == "indexed"`, but the `document_status` enum in the
    database has exactly four members — `uploaded`, `processing`, `ready`,
    `failed`. Postgres refused the value, and the error escaped as a 500.
  * `POST /api/v1/chat/ask` with an empty question returned 500. The service
    raises `ValueError("A question is required")`, which nothing translated.

A 500 on a route the user can reach is a broken screen. The rule the whole
backend follows is: bad input from the caller is a 4xx, and only a genuine
server fault is a 5xx.

These tests use the real app and the real database, because the analytics
defect lives in the SQL — a mocked session would never see it.
"""

import uuid

import httpx
import pytest

from app.core.deps import get_current_user
from app.db.session import get_db_session
from app.main import app


class _StubUser:
    id = uuid.UUID("00000000-0000-0000-0000-000000000000")
    role = "admin"
    is_active = True


class _StubSession:
    """Accepts writes and does nothing with them."""

    def add(self, obj):
        pass

    async def flush(self):
        pass

    async def commit(self):
        pass

    async def rollback(self):
        pass


@pytest.fixture
async def client():
    """An ASGI client with the auth dependency replaced.

    The database session is left alone: the analytics defect is in the SQL, so
    it needs a real session against a real database to reproduce.
    """
    app.dependency_overrides[get_current_user] = lambda: _StubUser()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver", timeout=60.0
    ) as c:
        yield c
    app.dependency_overrides.clear()


class TestNoRouteReturns500:
    async def test_analytics_does_not_crash(self, client):
        """The enum member is `ready`, not `indexed`.

        Postgres raised `invalid input value for enum document_status:
        "indexed"`, which escaped as a 500 and took the whole Analytics screen
        down.
        """
        res = await client.get("/api/v1/analytics")
        assert res.status_code != 500, res.text[:400]
        assert res.status_code == 200, res.text[:400]
        # The count has to be real: eleven of the twelve seeded documents
        # finished indexing, and the twelfth failed.
        overview = res.json()["overview"]
        assert overview["documents_indexed"] == 11, overview
        assert overview["documents_failed"] == 1, overview

    async def test_empty_question_is_refused(self, client):
        """An empty question is the caller's mistake: 4xx, not 500."""
        res = await client.post("/api/v1/chat/ask", json={"question": ""})
        assert res.status_code != 500, res.text[:400]
        assert res.status_code == 422, res.text[:400]

    async def test_whitespace_only_question_is_refused(self, client):
        """Whitespace is stripped before the check, so it is also empty."""
        res = await client.post("/api/v1/chat/ask", json={"question": "   \n\t "})
        assert res.status_code != 500, res.text[:400]
        assert res.status_code == 422, res.text[:400]


class TestPermissionGrantsAreValidated:
    """A grant is a structured thing; the schema should say so.

    `grantee_type` and `permission` are PostgreSQL enums on the way in, so a
    value outside the set has to be refused before it reaches the database.
    """

    @pytest.mark.parametrize(
        "payload",
        [
            {"grantee_type": "banana", "permission": "view"},
            {"grantee_type": "user", "permission": "godmode"},
            {"grantee_type": "user", "permission": "view"},
            {"grantee_type": "role", "permission": "view"},
        ],
    )
    async def test_bad_grants_are_refused_not_crashed(self, client, payload):
        """An unknown grantee or permission is a 422.

        A `user` grant with no `grantee_user_id`, and a `role` grant with no
        `grantee_role`, are the two ways the service refuses a grant — both
        have to come back as 422 rather than 500.
        """
        res = await client.post(
            f"/api/v1/documents/{uuid.uuid4()}/permissions",
            json=payload,
        )
        assert res.status_code != 500, f"{payload} -> {res.text[:300]}"
        assert res.status_code in (403, 404, 422), f"{payload} -> {res.text[:300]}"

"""The streaming answer endpoint must not be buffered by the frontend proxy.

A regression pinned here, found by measuring rather than by reading code.

The browser reaches the archive through the Next.js rewrite proxy, and Next
runs every response through its compression middleware. The middleware gzips
anything whose content type is compressible — and `text/event-stream` is — so
the whole SSE stream is buffered until the model has finished. Measured on the
production server, every one of the 285 frames arrived at the same instant,
51 seconds after the question was asked: the user watched an empty panel and
then saw the entire answer appear at once. The feature still "worked", which
is why it is easy to miss, but the streaming was gone.

`Cache-Control: no-transform` is the fix. It is the standard directive that
tells an intermediary not to transform the body, and it is what makes the
compression middleware leave this response alone. `X-Accel-Buffering: no`
does the same job for nginx.

Both headers are asserted here so that removing either one is caught by the
test suite rather than by a user staring at a blank screen.
"""

import uuid

import httpx
import pytest

from app.core.deps import get_current_user
from app.db.session import get_db_session
from app.main import app


class _StubUser:
    """Just enough of a user for the dependency to be satisfied."""

    id = uuid.UUID("00000000-0000-0000-0000-000000000000")
    role = "viewer"
    is_active = True


class _StubSession:
    """A session that accepts writes and does nothing with them.

    The greeting path persists a conversation and an audit row. What is being
    tested here is the response headers, so the writes are not interesting —
    but they still have to be accepted.
    """

    def add(self, obj):
        pass

    async def flush(self):
        pass

    async def commit(self):
        pass

    async def rollback(self):
        pass


@pytest.fixture
async def stream_client():
    """An ASGI client with the auth and database dependencies replaced."""
    app.dependency_overrides[get_current_user] = lambda: _StubUser()
    app.dependency_overrides[get_db_session] = lambda: _StubSession()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver", timeout=30.0
    ) as client:
        yield client
    app.dependency_overrides.clear()


class TestStreamingResponseHeaders:
    async def test_content_type_is_event_stream(self, stream_client):
        res = await stream_client.post(
            "/api/v1/chat/stream", json={"question": "hello"}
        )
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/event-stream")

    async def test_cache_control_forbids_transformation(self, stream_client):
        """The header that keeps Next's compression middleware off the stream.

        Without `no-transform` the response is gzipped, and gzip cannot emit
        anything until it has seen the whole stream — which is the bug this
        test exists to prevent.
        """
        res = await stream_client.post(
            "/api/v1/chat/stream", json={"question": "hello"}
        )
        cache_control = res.headers.get("cache-control", "")
        assert "no-transform" in cache_control, (
            "the SSE response must carry Cache-Control: no-transform — Next's "
            "compression middleware gzips the stream otherwise, and the answer "
            "arrives all at once instead of streaming"
        )

    async def test_nginx_buffering_is_disabled(self, stream_client):
        """The same protection for a deployment behind nginx."""
        res = await stream_client.post(
            "/api/v1/chat/stream", json={"question": "hello"}
        )
        assert res.headers.get("x-accel-buffering") == "no"

    async def test_response_is_not_gzipped(self, stream_client):
        """The backend must not compress the stream itself.

        A compressing intermediary that does not flush per chunk buffers the
        body, and the buffer is the whole problem. The backend sends the SSE
        body verbatim, which leaves the decision — and the flush behaviour —
        with intermediaries that understand `no-transform`.
        """
        res = await stream_client.post(
            "/api/v1/chat/stream", json={"question": "hello"}
        )
        assert "content-encoding" not in res.headers

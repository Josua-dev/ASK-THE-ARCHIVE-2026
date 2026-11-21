"""The frontend must only call endpoints the backend actually serves.

A screen that calls an endpoint the backend does not serve is a decorative
screen: it renders, it looks plausible, and it shows nothing. `scripts/
check_frontend_api.py` walks the frontend's API client and matches every path
it requests against the backend's real routes.

Those two things have to be tested here, because a check that cannot fail is
not a check. The matcher's rules are pinned in both directions — a path that
should match does, and a path that should not does not — and the call
extraction is pinned against the real client, so a new call written in a style
the extractor does not recognise is caught here rather than silently skipped.
"""

from pathlib import Path

import pytest

from scripts.check_frontend_api import (
    backend_paths,
    frontend_paths,
    matches,
)

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
API_FILE = FRONTEND / "src" / "lib" / "api.ts"


class TestMatcher:
    """The rules for deciding that a frontend path is a backend route.

    Each case is a real ambiguity that the matcher has to get right. The
    placeholder rules matter most: a lenient matcher that lets a placeholder
    stand in for a literal segment will happily match `/documents/${id}/
    download` against `/documents/raw/{document_id}`, and then a frontend call
    that genuinely has no backend route looks covered.
    """

    @pytest.mark.parametrize(
        "frontend_path, backend_path",
        [
            ("/chat/ask", "/api/v1/chat/ask"),
            ("/chat/stream", "/api/v1/chat/stream"),
            ("/documents", "/api/v1/documents"),
            # A path parameter on both sides is the same route.
            (
                "/documents/${id}/download",
                "/api/v1/documents/{document_id}/download",
            ),
            (
                "/chat/conversations/${id}/messages",
                "/api/v1/chat/conversations/{conversation_id}/messages",
            ),
        ],
    )
    def test_matching_paths_match(self, frontend_path, backend_path):
        assert matches(frontend_path, backend_path) is True

    @pytest.mark.parametrize(
        "frontend_path, backend_path",
        [
            # A placeholder cannot stand in for a literal segment. This is the
            # false positive that a lenient matcher produces.
            (
                "/documents/${id}/download",
                "/api/v1/documents/raw/{document_id}",
            ),
            ("/insights/${id}", "/api/v1/insights/scan"),
            # A literal cannot stand in for a placeholder either.
            ("/insights/scan", "/api/v1/insights/{insight_id}"),
            # Different lengths are different routes.
            ("/documents/${id}", "/api/v1/documents/{document_id}/permissions"),
            # Same shape, different route.
            ("/chat/ask", "/api/v1/chat/stream"),
            # A path that does not exist at all.
            ("/nope/thing", "/api/v1/chat/ask"),
        ],
    )
    def test_non_matching_paths_do_not_match(self, frontend_path, backend_path):
        assert matches(frontend_path, backend_path) is False


@pytest.mark.skipif(
    not API_FILE.exists(), reason="the frontend is not present in this checkout"
)
class TestAgainstTheRealClient:
    """The check, run against the real client and the real route table."""

    def test_every_frontend_call_has_a_backend_route(self):
        routes = backend_paths()
        paths = frontend_paths(API_FILE)

        # A handful of routes exist without the frontend calling them — the
        # health check, the signed-link target — so the counts need not be
        # equal. But the client must never call something the backend does
        # not serve.
        missing = [
            path
            for path in paths
            if not any(matches(path, route) for route in routes)
        ]
        assert missing == [], f"frontend calls with no backend route: {missing}"

    def test_the_extraction_finds_the_calls(self):
        """The extractor has to see the calls in the styles they are written.

        The client makes some requests through the typed `rawRequest` helper
        and some directly with `fetch` — the SSE stream among them. If the
        extractor misses one of those styles, the call is invisible to the
        check above and the screen behind it could go dead unnoticed.
        """
        paths = frontend_paths(API_FILE)

        assert "/chat/ask" in paths
        assert "/chat/stream" in paths
        assert "/documents/${id}/download" in paths
        assert "/insights/scan" in paths

    def test_query_strings_are_stripped(self):
        """`/documents${qs(query)}` is the path `/documents`.

        The client appends a query string with a helper, and the helper's
        call signature would otherwise leave a fragment like `documents${qs(`
        on the end of the path, which matches nothing.
        """
        paths = frontend_paths(API_FILE)

        assert "/documents" in paths
        assert not any("${qs(" in path for path in paths)

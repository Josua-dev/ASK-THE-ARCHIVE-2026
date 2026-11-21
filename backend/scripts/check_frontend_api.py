"""Check that every API the frontend calls actually exists in the backend.

A screen that calls an endpoint the backend does not serve is a decorative
screen: it renders, it looks plausible, and it shows nothing. This walks the
frontend's API client, extracts every path it requests, and matches each one
against the backend's real routes.

Paths are matched on their literal segments, with `{id}` standing for any
single segment. The backend's OpenAPI schema is the source of truth.

    python -m scripts.check_frontend_api [path_to_frontend]
"""

import re
import sys
from pathlib import Path

from app.main import app

DEFAULT_FRONTEND = Path(__file__).resolve().parents[2] / "frontend"

# Every request the API client makes. The patterns below are what the client
# actually contains — a path that is not matched by any of them is a new call
# and needs to be added here, so this check cannot silently go stale.
#
# `rawRequest` covers the typed API calls; `fetch` covers the two calls the
# client makes directly, the SSE stream and the signed-link download.
CALL_PATTERN = re.compile(
    r"""rawRequest(?:<[^>]*>)?\(\s*[`"]([^`"]+)[`"]|"""
    r"""fetch\(\s*[`"]\$\{BASE\}([^`"]+)[`"]""",
    re.S,
)

# A literal `{id}` in the frontend path matches any one backend path segment.
# The client appends a query string with a helper — `/documents${qs(query)}` —
# and uses `${id}` for a path parameter; both are placeholders when compared
# against the backend's `{document_id}`.
SEGMENT = re.compile(r"\{[^}]+\}")


def is_placeholder(segment: str) -> bool:
    """Is this segment a path parameter?

    The frontend writes `${id}`, the backend writes `{document_id}` — both are
    a value in braces, so both count.
    """
    return SEGMENT.search(segment) is not None


# The browser's base path. The frontend calls the API relative to this, and
# the backend's routes carry it.
API_PREFIX = "/api/v1"


def frontend_paths(api_file: Path) -> list[str]:
    """Every path the API client requests, with the query string removed.

    The client builds query strings with a helper — ``/documents${qs(query)}``
    — so the `${qs(...)}` suffix has to be stripped before the path can be
    compared with a backend route.
    """
    source = api_file.read_text(encoding="utf-8")
    found = []
    for match in CALL_PATTERN.finditer(source):
        path = match.group(1) or match.group(2)
        if not path:
            continue
        # The client appends a query string with a helper — `/documents${qs(q)}` —
        # so everything from that `${` onwards is dropped. A path parameter
        # such as `${id}` is kept: it is part of the path.
        cut = path.find("${qs(")
        if cut != -1:
            path = path[:cut]
        path = path.strip()
        path = path.split("?")[0].strip()
        if path.startswith("/"):
            found.append(path)
    return sorted(set(found))


def backend_paths() -> set[str]:
    """Every route the backend serves, as literal paths with {placeholders}.

    The routes are read from the OpenAPI schema rather than `app.routes`:
    FastAPI wraps an included router in an `_IncludedRouter`, so the router's
    own endpoints never appear in `app.routes` — the schema is the only place
    the full route table shows up.
    """
    return set(app.openapi()["paths"].keys())


def matches(frontend_path: str, backend_path: str) -> bool:
    """Does a frontend path correspond to this backend path?

    The frontend calls the API relative to `/api/v1`, and the backend's routes
    carry that prefix, so it is added before comparing. Both are then split
    into segments: a placeholder on either side matches any single segment,
    and anything else has to be equal.

    The frontend writes a path parameter as `${id}` (a template literal) and
    the backend as `{document_id}`, so a segment counts as a placeholder when
    it is wrapped in braces in either form.
    """
    front = [s for s in f"{API_PREFIX}{frontend_path}".strip("/").split("/") if s]
    back = [s for s in backend_path.strip("/").split("/") if s]
    if len(front) != len(back):
        return False
    for f, b in zip(front, back):
        f_ph, b_ph = is_placeholder(f), is_placeholder(b)
        if f_ph and b_ph:
            # Both sides are a value that will be substituted.
            continue
        if f_ph != b_ph:
            # One side is a literal and the other a value: they cannot be the
            # same path. `/documents/${id}/download` is not `/documents/raw/{id}`.
            return False
        if f != b:
            return False
    return True


def main() -> None:
    frontend = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_FRONTEND
    api_file = frontend / "src" / "lib" / "api.ts"

    if not api_file.exists():
        print(f"could not find {api_file}")
        sys.exit(2)

    routes = backend_paths()
    print(f"backend serves {len(routes)} paths")
    print(f"frontend requests {len(frontend_paths(api_file))} distinct paths\n")

    missing = []
    for path in frontend_paths(api_file):
        hit = next((r for r in routes if matches(path, r)), None)
        if hit:
            print(f"  ok      {path}  ->  {hit}")
        else:
            print(f"  MISSING {path}")
            missing.append(path)

    print()
    if missing:
        print(f"\033[31m{len(missing)} frontend call(s) have no backend route\033[0m")
        for path in missing:
            print(f"  - {path}")
        sys.exit(1)
    print("\033[32mEvery frontend API call maps to a real backend route\033[0m")


if __name__ == "__main__":
    main()

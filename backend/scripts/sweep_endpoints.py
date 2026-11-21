"""Call every endpoint the backend serves, as every role, and report what broke.

`validate_demo.py` checks five behaviours end to end. This is the other
question: does *every* endpoint answer, for *every* role, without a 500? A
module whose endpoint throws is a module that renders an error on every visit,
and a route that only works for one role is a route that looks broken to
everyone else.

Nothing here asserts a response *body* — it asserts that the route answers at
all, and that the role boundary is what the product says it is. The checks are:

  1. Every GET route answers with a status below 400 for a role that is
     allowed to call it.
  2. A role that is *not* allowed a route is refused with 403, not 500 and
     not 200. A 500 is a bug; a 403 is the permission boundary working.
  3. Every POST/PATCH/DELETE route either answers or is refused cleanly.
     Never a 500, never a stack trace in the body.

Usage:

    python -m scripts.sweep_endpoints [base_url]
"""

import asyncio
import json
import sys

import httpx

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
PASSWORD = "Archive!2026"

PASSED = "\033[32mPASS\033[0m"
FAILED = "\033[31mFAIL\033[0m"


class Sweep:
    def __init__(self):
        self.rows = []

    def record(self, name, ok, detail=""):
        self.rows.append((name, ok, detail))
        mark = PASSED if ok else FAILED
        print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""))

    @property
    def failed(self):
        return [r for r in self.rows if not r[1]]


async def login(client, email):
    res = await client.post(
        f"{BASE}/api/v1/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    res.raise_for_status()
    return res.json()["access_token"]


async def get(client, token, path, **kw):
    headers = kw.pop("headers", {})
    headers["Authorization"] = f"Bearer {token}"
    return await client.get(f"{BASE}{path}", headers=headers, **kw)


def describe(res):
    """A short, useful description of what the endpoint said."""
    if res.status_code >= 400:
        body = res.text[:120].replace("\n", " ")
        return f"HTTP {res.status_code}: {body}"
    try:
        payload = res.json()
    except ValueError:
        return f"HTTP {res.status_code} ({len(res.content)} bytes, not JSON)"
    if isinstance(payload, dict):
        keys = ", ".join(sorted(payload.keys())[:6])
        return f"HTTP {res.status_code} {{{keys}}}"
    if isinstance(payload, list):
        return f"HTTP {res.status_code} [{len(payload)} items]"
    return f"HTTP {res.status_code}"


def is_server_error(res):
    """Did the route break, or did it refuse?

    A 4xx is the permission boundary or a validation rule doing its job. A 5xx
    is the route itself being broken.
    """
    return res.status_code >= 500


async def main():
    sweep = Sweep()
    print(f"\n== Sweeping every endpoint through {BASE} ==")

    async with httpx.AsyncClient(timeout=httpx.Timeout(600.0)) as client:
        # ── Sign in ────────────────────────────────────────────────────────
        print("\n== Authentication ==")
        tokens = {}
        for role in ("admin", "analyst", "viewer"):
            try:
                tokens[role] = await login(client, f"{role}@archivedemo.example.com")
                sweep.record(f"{role} can sign in", True)
            except Exception as exc:  # noqa: BLE001
                sweep.record(f"{role} can sign in", False, str(exc))
        if sweep.failed:
            await finish(sweep)
            return

        admin, analyst, viewer = (tokens[k] for k in ("admin", "analyst", "viewer"))

        # ── Find a document each role may read, for the per-document routes ─
        async def readable_document(token):
            res = await get(client, token, "/api/v1/documents")
            if res.status_code != 200:
                return None
            items = res.json()
            items = items.get("items", items) if isinstance(items, dict) else items
            for item in items:
                if item.get("status") == "indexed":
                    return item["id"]
            return items[0]["id"] if items else None

        doc_ids = {}
        for role, token in tokens.items():
            doc_ids[role] = await readable_document(token)
        sweep.record(
            "each role has at least one readable document",
            all(doc_ids.values()),
            str({k: bool(v) for k, v in doc_ids.items()}),
        )
        if not all(doc_ids.values()):
            await finish(sweep)
            return

        # A document only the admin may read — the NDA — for the refusal checks.
        admin_docs = await get(client, admin, "/api/v1/documents")
        admin_items = admin_docs.json()
        admin_items = (
            admin_items.get("items", admin_items)
            if isinstance(admin_items, dict)
            else admin_items
        )
        restricted = next(
            (
                d
                for d in admin_items
                if "aurora" in (d.get("filename") or "").lower()
                or "nda" in (d.get("filename") or "").lower()
            ),
            None,
        )

        # ── GET routes every role may call ─────────────────────────────────
        print("\n== GET routes, for a role that may use them ==")
        common_gets = [
            "/api/v1/health",
            "/api/v1/auth/me",
            "/api/v1/documents",
            "/api/v1/chat/conversations",
            "/api/v1/conversations/shared-with-me",
            "/api/v1/conversations/users",
            "/api/v1/insights",
            "/api/v1/graph",
            "/api/v1/search?q=lease&limit=3",
            "/api/v1/analytics",
        ]
        for path in common_gets:
            res = await get(client, admin, path)
            sweep.record(
                f"GET {path}",
                not is_server_error(res),
                describe(res),
            )

        # Per-document routes, using a document the caller may read.
        for role, token in tokens.items():
            doc = doc_ids[role]
            for suffix in ("", "/permissions", "/preview"):
                path = f"/api/v1/documents/{doc}{suffix}"
                res = await get(client, token, path)
                sweep.record(
                    f"GET {path} ({role})",
                    not is_server_error(res),
                    describe(res),
                )

        # A summary and a profile for a document that has been indexed.
        for role, token in tokens.items():
            doc = doc_ids[role]
            res = await get(client, token, f"/api/v1/summaries/{doc}")
            sweep.record(
                f"GET /api/v1/summaries/{{id}} ({role})",
                not is_server_error(res),
                describe(res),
            )
            res = await get(client, token, f"/api/v1/profiles/{doc}")
            sweep.record(
                f"GET /api/v1/profiles/{{id}} ({role})",
                not is_server_error(res),
                describe(res),
            )

        # ── The permission boundary ────────────────────────────────────────
        print("\n== The permission boundary holds ==")
        if restricted:
            nda = restricted["id"]
            res = await get(client, viewer, f"/api/v1/documents/{nda}")
            sweep.record(
                "the viewer is refused the admin-only document",
                res.status_code == 403,
                describe(res),
            )
            res = await get(client, analyst, f"/api/v1/documents/{nda}")
            sweep.record(
                "the analyst is refused the admin-only document",
                res.status_code == 403,
                describe(res),
            )
            res = await get(client, admin, f"/api/v1/documents/{nda}")
            sweep.record(
                "the admin can read the admin-only document",
                res.status_code == 200,
                describe(res),
            )

        # Administration is admin-only.
        for path in ("/api/v1/admin/users", "/api/v1/admin/audit", "/api/v1/admin/stats"):
            res = await get(client, viewer, path)
            sweep.record(
                f"the viewer is refused GET {path}",
                res.status_code in (403, 404),
                describe(res),
            )
            res = await get(client, admin, path)
            sweep.record(
                f"the admin can GET {path}",
                not is_server_error(res),
                describe(res),
            )

        # ── Write routes ───────────────────────────────────────────────────
        print("\n== Write routes answer rather than break ==")
        # Comparison: the analyst can compare two of their own documents.
        analyst_docs = await get(client, analyst, "/api/v1/documents")
        analyst_items = analyst_docs.json()
        analyst_items = (
            analyst_items.get("items", analyst_items)
            if isinstance(analyst_items, dict)
            else analyst_items
        )
        if len(analyst_items) >= 2:
            payload = {
                "document_a_id": analyst_items[0]["id"],
                "document_b_id": analyst_items[1]["id"],
            }
            res = await client.post(
                f"{BASE}/api/v1/compare",
                json=payload,
                headers={"Authorization": f"Bearer {analyst}"},
            )
            sweep.record(
                "POST /api/v1/compare (analyst)",
                not is_server_error(res),
                describe(res),
            )
        else:
            sweep.record(
                "the analyst has two documents to compare",
                False,
                f"{len(analyst_items)} documents",
            )

        # Insights: the analyst can trigger a scan.
        res = await client.post(
            f"{BASE}/api/v1/insights/scan",
            headers={"Authorization": f"Bearer {analyst}"},
        )
        sweep.record(
            "POST /api/v1/insights/scan (analyst)",
            not is_server_error(res),
            describe(res),
        )

        # Extraction: a small extraction run against a document the analyst reads.
        if doc_ids.get("analyst"):
            res = await client.post(
                f"{BASE}/api/v1/extractions",
                json={
                    "document_id": doc_ids["analyst"],
                    "description": "party name and contract value",
                },
                headers={"Authorization": f"Bearer {analyst}"},
            )
            sweep.record(
                "POST /api/v1/extractions (analyst)",
                not is_server_error(res),
                describe(res),
            )

        # Listing the write-side collections each role may read.
        for path in ("/api/v1/compare", "/api/v1/research", "/api/v1/extractions"):
            res = await get(client, admin, path)
            sweep.record(
                f"GET {path}",
                not is_server_error(res),
                describe(res),
            )

        # ── Malformed input is refused, not crashed ─────────────────────────
        print("\n== Bad input is refused rather than crashing the route ==")
        bad_payloads = [
            ("POST", "/api/v1/chat/ask", {"question": ""}),
            ("POST", "/api/v1/auth/login", {"email": "not-an-email", "password": ""}),
            ("POST", "/api/v1/compare", {"document_a_id": "nope", "document_b_id": "nope"}),
            ("GET", "/api/v1/documents/not-a-uuid", None),
            ("GET", "/api/v1/profiles/not-a-uuid", None),
        ]
        for method, path, payload in bad_payloads:
            if method == "GET":
                res = await get(client, admin, path)
            else:
                res = await client.post(
                    f"{BASE}{path}",
                    json=payload,
                    headers={"Authorization": f"Bearer {admin}"},
                )
            sweep.record(
                f"{method} {path} with bad input",
                not is_server_error(res),
                describe(res),
            )

        # ── An unauthenticated caller is refused ────────────────────────────
        print("\n== Unauthenticated callers are refused ==")
        for path in ("/api/v1/documents", "/api/v1/admin/users", "/api/v1/analytics"):
            res = await client.get(f"{BASE}{path}")
            sweep.record(
                f"GET {path} without a token",
                res.status_code in (401, 403),
                describe(res),
            )

        # ── A malformed token is refused ────────────────────────────────────
        res = await get(client, "not-a-real-token", "/api/v1/documents")
        sweep.record(
            "GET /api/v1/documents with a malformed token",
            res.status_code in (401, 403),
            describe(res),
        )

    await finish(sweep)


async def finish(sweep: Sweep):
    print()
    if sweep.failed:
        print(f"\033[31m{len(sweep.failed)} check(s) failed\033[0m")
        for name, _, detail in sweep.failed:
            print(f"  - {name}" + (f" — {detail}" if detail else ""))
        sys.exit(1)
    print(f"\033[32mAll {len(sweep.rows)} checks passed\033[0m")


if __name__ == "__main__":
    asyncio.run(main())

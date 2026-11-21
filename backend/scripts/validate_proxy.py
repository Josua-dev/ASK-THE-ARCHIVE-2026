"""Validate the archive through the frontend's rewrite proxy.

`validate_demo.py` talks to the backend directly. That proves the backend is
correct, but the browser never talks to the backend directly: it goes through
the Next.js rewrite proxy, and that proxy has its own failure modes — most
notably a 30-second abort that returns its own 500 before the backend is even
reached.

This script runs the same role-based checks through the proxy, so it exercises
the path the browser actually uses:

    python -m scripts.validate_proxy [base_url]

The default base URL is the local Next.js server on port 3000. Pass the
frontend's URL to validate a running Docker stack.

How long each answer takes is reported rather than asserted. A short answer
is a good outcome, and the model's speed on CPU varies by several seconds
between runs. The deterministic guard on the proxy's timeout lives in
`frontend/tests/proxy-timeout.test.mjs`, which asserts the configured timeout
outlasts the backend's own; what matters here is that a long answer is
delivered whole rather than cut off.
"""

import asyncio
import sys
import time

import httpx

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000").rstrip("/")
PASSWORD = "Archive!2026"

PASSED = "\033[32mPASS\033[0m"
FAILED = "\033[31mFAIL\033[0m"


class Result:
    def __init__(self):
        self.rows = []

    def check(self, name, condition, detail=""):
        self.rows.append((name, bool(condition), detail))
        mark = PASSED if condition else FAILED
        print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""))
        return bool(condition)

    def note(self, message):
        print(f"       {message}")

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


async def ask(client, token, question):
    """Ask a question and report how long the proxy took to answer.

    A proxy that aborts raises instead of returning an answer, so the failure
    is captured here rather than propagated: a broken proxy should be reported
    as a failed check, not as a traceback.
    """
    started = time.monotonic()
    try:
        res = await client.post(
            f"{BASE}/api/v1/chat/ask",
            json={"question": question},
            headers={"Authorization": f"Bearer {token}"},
        )
    except httpx.HTTPError as exc:
        return {"_error": f"{type(exc).__name__}: {exc}"}, time.monotonic() - started

    elapsed = time.monotonic() - started
    if res.status_code >= 400:
        return {"_error": f"HTTP {res.status_code}: {res.text[:200]}"}, elapsed
    return res.json(), elapsed


def cited_filenames(answer):
    return {c["filename"] for c in answer.get("citations", [])}


def failed(answer):
    """The error text if the proxy did not deliver an answer, else None."""
    return answer.get("_error")


async def main():
    r = Result()
    print(f"\n== Validating the archive through {BASE} ==")

    async with httpx.AsyncClient(timeout=httpx.Timeout(600.0)) as client:
        # ── Authentication ────────────────────────────────────────────────
        print("\n== Authentication through the proxy ==")
        tokens = {}
        for role in ("admin", "analyst", "viewer"):
            try:
                tokens[role] = await login(client, f"{role}@archivedemo.example.com")
                r.check(f"{role} can log in through the proxy", True)
            except Exception as exc:  # noqa: BLE001
                r.check(f"{role} can log in through the proxy", False, str(exc))
        if r.failed:
            await finish(r)
            return

        admin, analyst, viewer = (tokens[k] for k in ("admin", "analyst", "viewer"))

        # ── A real answer survives the proxy ───────────────────────────────
        # The viewer can read both policies, so this question has an answer in
        # the viewer's permitted set. It is the same question the analyst
        # cannot answer — see the ACL check below.
        print("\n== A real answer completes through the proxy ==")
        q_viewer = "What are the security and data protection obligations?"
        answer, elapsed = await ask(client, viewer, q_viewer)
        names = cited_filenames(answer)

        r.check(
            "the proxy delivers the answer instead of aborting",
            failed(answer) is None,
            failed(answer) or f"answered in {elapsed:.1f}s",
        )
        r.check("the viewer gets an answer", answer.get("found") is True,
                (answer.get("answer") or "")[:90])
        r.check(
            "the answer cites the two policies the viewer may read",
            {"information-security-policy.pdf", "data-retention-policy.pdf"} <= names,
            str(sorted(names)),
        )
        r.note(f"the viewer took {elapsed:.1f}s")

        # ── The analyst's own documents ────────────────────────────────────
        print("\n== The analyst answers from their own permitted set ==")
        q_analyst = (
            "What is the annual rent under the Northgate Warehouse lease, "
            "and when does the lease expire?"
        )
        answer_a, elapsed_a = await ask(client, analyst, q_analyst)
        names_a = cited_filenames(answer_a)
        r.check(
            "the proxy delivers the analyst's answer",
            failed(answer_a) is None,
            failed(answer_a) or f"answered in {elapsed_a:.1f}s",
        )
        r.check("the analyst gets an answer", answer_a.get("found") is True,
                (answer_a.get("answer") or "")[:90])
        r.check(
            "the answer cites the analyst's warehouse lease",
            "northgate-warehouse-lease.pdf" in names_a,
            str(sorted(names_a)),
        )
        r.note(f"the analyst took {elapsed_a:.1f}s")

        # ── The ACL holds across the proxy ─────────────────────────────────
        # The analyst cannot read the policies or the NDA. Asking the analyst
        # the viewer's question must not leak either document: the archive
        # answers from what the analyst may read, and abstains if that is not
        # enough. The check is on the citations, which are the only thing that
        # would expose a document the analyst may not read.
        print("\n== Document permissions hold across the proxy ==")
        answer_leak, _ = await ask(client, analyst, q_viewer)
        leaked = cited_filenames(answer_leak) & {
            "information-security-policy.pdf",
            "data-retention-policy.pdf",
            "aurora-mutual-nda.pdf",
        }
        r.check(
            "the analyst is never cited a document they may not read",
            not leaked,
            f"leaked={sorted(leaked)} cited={sorted(cited_filenames(answer_leak))}",
        )

        answer_admin, elapsed_admin = await ask(
            client,
            admin,
            "Under the mutual non-disclosure agreement with Aurora Biotech Ltd, "
            "what must the recipient keep secret and when does the agreement expire?",
        )
        names_admin = cited_filenames(answer_admin)
        r.check(
            "the admin can cite the admin-only NDA",
            "aurora-mutual-nda.pdf" in names_admin,
            str(sorted(names_admin)),
        )
        r.note(f"the admin took {elapsed_admin:.1f}s")

    await finish(r)


async def finish(r: Result):
    print()
    if r.failed:
        print(f"\033[31m{len(r.failed)} check(s) failed\033[0m")
        for name, _, detail in r.failed:
            print(f"  - {name}" + (f" — {detail}" if detail else ""))
        sys.exit(1)
    print(f"\033[32mAll {len(r.rows)} checks passed\033[0m")


if __name__ == "__main__":
    asyncio.run(main())

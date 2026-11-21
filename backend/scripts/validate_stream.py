"""Verify that SSE answers stream through the frontend's rewrite proxy.

Two things have to hold for the Ask page to work in the Docker stack:

1. The proxy must not abort the request at its 30-second default, or the
   stream dies before the local model has finished.
2. The proxy must not buffer the response. If Next buffers it, every event
   arrives at once when the model finishes and the answer appears all at
   once instead of typing itself in.

The second one is the subtle one. Next runs every response through its
compression middleware, and `text/event-stream` is a compressible content
type, so the stream was gzipped — and gzip cannot emit anything until it has
seen the whole body. The response carried `Cache-Control: no-transform`
specifically to keep that middleware away from it.

This script records the arrival time of every SSE frame so both can be
checked from the output:

    python -m scripts.validate_stream [base_url]
"""

import asyncio
import json
import sys
import time

import httpx

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000").rstrip("/")
PASSWORD = "Archive!2026"

PASSED = "\033[32mPASS\033[0m"
FAILED = "\033[31mFAIL\033[0m"


async def main():
    failures = []

    def check(name, condition, detail=""):
        mark = PASSED if condition else FAILED
        print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""))
        if not condition:
            failures.append(name)

    async with httpx.AsyncClient(timeout=httpx.Timeout(600.0)) as client:
        res = await client.post(
            f"{BASE}/api/v1/auth/login",
            json={"email": "viewer@archivedemo.example.com", "password": PASSWORD},
        )
        res.raise_for_status()
        token = res.json()["access_token"]

        print(f"\n== Streaming an answer through {BASE} ==")
        started = time.monotonic()
        frames = []

        try:
            async with client.stream(
                "POST",
                f"{BASE}/api/v1/chat/stream",
                json={
                    "question": "What are the security and data protection obligations?"
                },
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "text/event-stream",
                },
            ) as response:
                response.raise_for_status()

                # A compressing intermediary is the root cause of a buffered
                # stream: gzip cannot emit anything until it has seen the whole
                # body. Report the encoding so a failure says why.
                encoding = response.headers.get("content-encoding", "(none)")
                check(
                    "the response is not compressed by an intermediary",
                    encoding in ("", "(none)", "identity"),
                    f"content-encoding={encoding}",
                )

                event = ""
                async for line in response.aiter_lines():
                    now = time.monotonic() - started
                    if line.startswith("event:"):
                        event = line.split("event:", 1)[1].strip()
                    elif line.startswith("data:"):
                        frames.append((now, event, line.split("data:", 1)[1].strip()))
                        print(f"    +{now:6.1f}s  {event}")
        except httpx.HTTPError as exc:
            check("the proxy does not abort the stream", False, str(exc))
            print()
            print(f"\033[31m{len(failures)} check(s) failed\033[0m")
            sys.exit(1)

        total = time.monotonic() - started
        print(f"\n  total {total:.1f}s over {len(frames)} frames")

        events = [f[1] for f in frames]
        check("the stream completes", "done" in events, f"events={len(events)} frames")

        # The decisive check. The first frame should arrive well before the
        # last one: the evidence panel is populated while the model is still
        # writing. If the proxy buffered the response, every frame lands in
        # the same instant at the end.
        if len(frames) >= 2:
            spread = frames[-1][0] - frames[0][0]
            check(
                "frames arrive incrementally rather than in one buffered burst",
                spread > 1.0,
                f"first frame at {frames[0][0]:.1f}s, last at {frames[-1][0]:.1f}s",
            )
            check(
                "the connection stayed open for the whole generation",
                frames[-1][0] >= total - 1.0,
                f"last frame at {frames[-1][0]:.1f}s of {total:.1f}s",
            )
        else:
            check("the stream produced frames", False, f"{len(frames)} frames")

        citations = []
        done_payload = None
        for _, event, data in frames:
            if event == "citations":
                try:
                    citations = json.loads(data).get("citations", [])
                except json.JSONDecodeError:
                    pass
            if event == "done":
                try:
                    done_payload = json.loads(data)
                except json.JSONDecodeError:
                    pass

        names = {c.get("filename") for c in citations}
        check(
            "the streamed answer cites the viewer's two policies",
            {"information-security-policy.pdf", "data-retention-policy.pdf"} <= names,
            str(sorted(n for n in names if n)),
        )
        check(
            "the stream reports found=true",
            bool(done_payload and done_payload.get("found")),
            str(done_payload),
        )

    print()
    if failures:
        print(f"\033[31m{len(failures)} check(s) failed\033[0m")
        sys.exit(1)
    print("\033[32mAll checks passed\033[0m")


if __name__ == "__main__":
    asyncio.run(main())

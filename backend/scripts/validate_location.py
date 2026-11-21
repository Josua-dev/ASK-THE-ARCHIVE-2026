"""End-to-end validation of the warehouse location feature.

Runs the real ASGI application against the real database, as each of the three
seeded users, and asserts the behaviours the location feature promises:

  1. Every document is located (auto-assigned on upload/seed).
  2. The location round-trips: read it back and it matches.
  3. A partial location is refused with 422, never a 500.
  4. A slot already held by another document is refused with 422.
  5. An out-of-vocabulary value is refused with 422.
  6. A viewer cannot write a location (403).
  7. A viewer cannot read the location of a document they may not read (403).
  8. The warehouse layout lists only slots the caller may read — the
     admin-only NDA must never appear in a viewer's slot list.
  9. Clearing a location works and the document falls back to unlocated.

Nothing is stubbed: the requests travel the same code path the browser uses.

    ./.venv/Scripts/python -m scripts.validate_location
"""

import asyncio
import sys

import httpx

from app.main import app

BASE = "http://testserver"
PASSWORD = "Archive!2026"

ADMIN = "admin@archivedemo.example.com"
ANALYST = "analyst@archivedemo.example.com"
VIEWER = "viewer@archivedemo.example.com"

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

    @property
    def failed(self):
        return [r for r in self.rows if not r[1]]


async def login(client, email):
    res = await client.post(
        f"{BASE}/api/v1/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    res.raise_for_status()
    body = res.json()
    return body["access_token"]


def auth(token):
    return {"Authorization": f"Bearer {token}"}


async def get(client, token, path):
    return await client.get(f"{BASE}{path}", headers=auth(token))


async def put(client, token, path, payload):
    return await client.put(f"{BASE}{path}", json=payload, headers=auth(token))


async def list_documents(client, token):
    res = await get(client, token, "/api/v1/documents")
    res.raise_for_status()
    body = res.json()
    return body["items"] if isinstance(body, dict) else body


async def run() -> int:
    result = Result()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(
        transport=transport, base_url=BASE, timeout=60.0
    ) as client:
        admin = await login(client, ADMIN)
        analyst = await login(client, ANALYST)
        viewer = await login(client, VIEWER)

        print("\n== The warehouse layout ==")
        layout_res = await get(client, admin, "/api/v1/warehouse/layout")
        result.check(
            "the admin can read the warehouse layout",
            layout_res.status_code == 200,
            f"HTTP {layout_res.status_code}",
        )
        layout = layout_res.json() if layout_res.status_code == 200 else {}
        for key in ("zones", "racks", "shelves", "boxes", "slots"):
            result.check(
                f"the layout carries {key}",
                key in layout,
                f"{len(layout.get(key, [])) if isinstance(layout.get(key), list) else layout.get(key)}",
            )

        print("\n== Every document is located ==")
        admin_docs = await list_documents(client, admin)
        located = [
            d
            for d in admin_docs
            if d.get("zone") and d.get("rack") and d.get("shelf") and d.get("box")
        ]
        result.check(
            "the archive has documents to locate",
            len(admin_docs) > 0,
            f"{len(admin_docs)} documents",
        )
        result.check(
            "every document carries a complete location",
            len(located) == len(admin_docs),
            f"{len(located)}/{len(admin_docs)} located",
        )

        if not located:
            return 1

        target = located[0]

        print("\n== Reading a location ==")
        loc_res = await get(client, admin, f"/api/v1/documents/{target['id']}/location")
        result.check(
            "the location is readable",
            loc_res.status_code == 200,
            f"HTTP {loc_res.status_code}",
        )
        loc = loc_res.json() if loc_res.status_code == 200 else {}
        result.check(
            "the location matches the document row",
            loc.get("zone") == target["zone"]
            and loc.get("rack") == target["rack"]
            and loc.get("shelf") == target["shelf"]
            and loc.get("box") == target["box"],
            f"{loc.get('zone')}/{loc.get('rack')}/{loc.get('shelf')}/{loc.get('box')}",
        )
        result.check(
            "the location carries a human-readable label",
            bool(loc.get("label")),
            str(loc.get("label")),
        )

        print("\n== Writing a location ==")
        occupied = loc_res.json()
        taken = {
            "zone": occupied["zone"],
            "rack": occupied["rack"],
            "shelf": occupied["shelf"],
            "box": occupied["box"],
        }

        # A different document's slot must be refused.
        other = next((d for d in located if d["id"] != target["id"]), None)
        if other:
            clash_res = await put(
                client,
                admin,
                f"/api/v1/documents/{target['id']}/location",
                {
                    "zone": other["zone"],
                    "rack": other["rack"],
                    "shelf": other["shelf"],
                    "box": other["box"],
                },
            )
            result.check(
                "a slot held by another document is refused",
                clash_res.status_code == 422,
                f"HTTP {clash_res.status_code}",
            )

        # A partial location must be refused.
        partial_res = await put(
            client,
            admin,
            f"/api/v1/documents/{target['id']}/location",
            {"zone": occupied["zone"], "rack": None, "shelf": None, "box": None},
        )
        result.check(
            "a partial location is refused",
            partial_res.status_code == 422,
            f"HTTP {partial_res.status_code}",
        )

        # An out-of-vocabulary value must be refused.
        bad_res = await put(
            client,
            admin,
            f"/api/v1/documents/{target['id']}/location",
            {"zone": "ZZ", "rack": "R1", "shelf": "1", "box": "B1"},
        )
        result.check(
            "an out-of-vocabulary value is refused",
            bad_res.status_code == 422,
            f"HTTP {bad_res.status_code}",
        )

        # A free slot must be accepted.
        free = None
        for zone in layout.get("zones", []):
            for rack in layout.get("racks", []):
                for shelf in layout.get("shelves", []):
                    for box in layout.get("boxes", []):
                        candidate = {
                            "zone": zone,
                            "rack": rack,
                            "shelf": shelf,
                            "box": box,
                        }
                        if candidate != taken and not any(
                            s["zone"] == zone
                            and s["rack"] == rack
                            and s["shelf"] == shelf
                            and s["box"] == box
                            for s in layout.get("slots", [])
                        ):
                            free = candidate
                            break
                    if free:
                        break
                if free:
                    break
            if free:
                break

        if free:
            free_res = await put(
                client,
                admin,
                f"/api/v1/documents/{target['id']}/location",
                free,
            )
            result.check(
                "a free slot is accepted",
                free_res.status_code == 200,
                f"HTTP {free_res.status_code}",
            )
            if free_res.status_code == 200:
                moved = free_res.json()
                result.check(
                    "the new location is echoed back",
                    moved.get("zone") == free["zone"]
                    and moved.get("box") == free["box"],
                    f"{moved.get('zone')}/{moved.get('rack')}/{moved.get('shelf')}/{moved.get('box')}",
                )

        # Put it back where it started.
        await put(client, admin, f"/api/v1/documents/{target['id']}/location", taken)

        print("\n== Auto-assignment ==")
        auto_res = await client.post(
            f"{BASE}/api/v1/documents/{target['id']}/location/auto",
            headers=auth(admin),
        )
        result.check(
            "auto-assignment succeeds",
            auto_res.status_code == 200,
            f"HTTP {auto_res.status_code}",
        )

        print("\n== The permission boundary ==")
        viewer_write = await put(
            client,
            viewer,
            f"/api/v1/documents/{target['id']}/location",
            taken,
        )
        result.check(
            "a viewer cannot write a location",
            viewer_write.status_code == 403,
            f"HTTP {viewer_write.status_code}",
        )

        viewer_layout = await get(client, viewer, "/api/v1/warehouse/layout")
        result.check(
            "a viewer can read the warehouse layout",
            viewer_layout.status_code == 200,
            f"HTTP {viewer_layout.status_code}",
        )
        viewer_slots = (
            viewer_layout.json().get("slots", [])
            if viewer_layout.status_code == 200
            else []
        )
        viewer_doc_ids = {s.get("document_id") for s in viewer_slots}

        admin_layout = await get(client, admin, "/api/v1/warehouse/layout")
        admin_slots = (
            admin_layout.json().get("slots", []) if admin_layout.status_code == 200 else []
        )
        admin_doc_ids = {s.get("document_id") for s in admin_slots}

        # The NDA is admin-only in the seeded corpus; it must never surface in a
        # viewer's slot list.
        nda = next((d for d in admin_docs if "nda" in d["filename"].lower()), None)
        if nda:
            result.check(
                "the admin-only NDA occupies a slot the admin can see",
                nda["id"] in admin_doc_ids,
                nda["filename"],
            )
            result.check(
                "the admin-only NDA never appears in a viewer's slot list",
                nda["id"] not in viewer_doc_ids,
                f"{nda['filename']} leaked={nda['id'] in viewer_doc_ids}",
            )

        # Every slot a viewer sees must correspond to a document the viewer may
        # read — checked directly against the document list.
        viewer_docs = await list_documents(client, viewer)
        viewer_readable = {d["id"] for d in viewer_docs}
        leaked = viewer_doc_ids - viewer_readable
        result.check(
            "every slot a viewer sees belongs to a document they may read",
            not leaked,
            f"leaked={[s for s in leaked]}",
        )
        result.check(
            "the viewer's slot list is a subset of the admin's",
            viewer_doc_ids.issubset(admin_doc_ids),
            f"viewer={len(viewer_doc_ids)} admin={len(admin_doc_ids)}",
        )

        # A document the viewer may not read must not expose its location.
        if nda:
            nda_loc = await get(client, viewer, f"/api/v1/documents/{nda['id']}/location")
            result.check(
                "a viewer cannot read the location of a document they may not read",
                nda_loc.status_code == 403,
                f"HTTP {nda_loc.status_code}",
            )

        print("\n== Clearing a location ==")
        clear_res = await put(
            client,
            admin,
            f"/api/v1/documents/{target['id']}/location",
            {"zone": None, "rack": None, "shelf": None, "box": None},
        )
        result.check(
            "a location can be cleared",
            clear_res.status_code == 200,
            f"HTTP {clear_res.status_code}",
        )
        if clear_res.status_code == 200:
            cleared = clear_res.json()
            result.check(
                "the cleared document reports no location",
                cleared.get("zone") is None and cleared.get("label") is None,
                f"label={cleared.get('label')}",
            )

        # Put it back so the demo archive stays coherent.
        await put(client, admin, f"/api/v1/documents/{target['id']}/location", taken)

    print("\n" + "=" * 62)
    if result.failed:
        print(f"\033[31mFAIL\033[0m {len(result.failed)} of {len(result.rows)} checks failed.")
        for name, _, detail in result.failed:
            print(f"  - {name} {detail}")
        return 1
    print(f"\033[32mPASS\033[0m all {len(result.rows)} checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))

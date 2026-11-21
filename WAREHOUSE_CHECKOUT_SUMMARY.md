# Warehouse Location + Checkout/Checkin Feature Summary

## Overview
Implemented physical warehouse location tracking for Ask the Archive with document check-out tracking. Users can assign documents to warehouse slots (zone/rack/shelf/box), check documents out, and track due dates.

## Backend Changes

### 1. Config (`backend/app/core/config.py`)
- Added `checkout_default_due_days = 7` — configurable default due period for document checkouts

### 2. Document Model (`backend/app/db/models/document.py`)
- Added `checkouts` relationship (`one-to-many` to `DocumentCheckout`) so documents can track their checkout history

### 3. New Model: `DocumentCheckout` (`backend/app/db/models/document_checkout.py`)
- Tracks checkout state: `checked_out_by`, `checked_out_at`, `due_at`, `checked_in_at`, `checked_in_by`
- Partial unique index `uq_document_checkouts_open` on `(document_id, WHERE checked_in_at IS NULL)` ensures only one open checkout per document
- Migration `004_document_checkouts.py` drops the old `uq_documents_location_slot` unique constraint and creates the new table — enabling multiple documents per slot/box

### 4. Service Functions (`backend/app/modules/documents/service.py`)
- `find_first_free_slot()` — finds the least-occupied slot (min-occupancy strategy), now allows multiple documents per box
- `assign_slot()` — moves document into a specific slot; wraps in `session.begin_nested()` for safety
- `set_location()` / `clear_location()` — assignment/clearance API
- `auto_assign_location()` — auto-assigns on upload
- `position_in_box()` — computes (position, total) within a box, ordered by `created_at` then `id`
- `open_checkouts()` — returns open checkouts keyed by document_id, with `selectinload(checkout_user)` for eager loading
- `check_out_document()` — row-locked checkout with audit logging; defaults `due_at` to now + configured period; rejects if already checked out
- `check_in_document()` — row-locked check-in with audit logging; rejects if not checked out

### 5. API Routes (`backend/app/modules/documents/router.py`)
- `POST /api/v1/documents/{document_id}/checkout` — checks out a document; returns `CheckoutResponse`; defaults `due_at`; rejects with 422 if already checked out
- `POST /api/v1/documents/{document_id}/checkin` — returns a document to the archive; returns `CheckinResponse`; rejects with 422 if not checked out
- Both routes catch `ValueError` from service layer and convert to `ValidationError` (422) — consistent with all other routes in the file
- `GET /api/v1/warehouse/layout` — returns vocabulary + slots with open checkout info (who has it out, due date)

### 6. Alembic Migration (`backend/alembic/versions/004_document_checkouts.py`)
- Drops `uq_documents_location_slot` partial unique index
- Creates `document_checkouts` table with partial unique index `uq_document_checkouts_open` (WHERE checked_in_at IS NULL)
- Enables multiple documents per physical box while ensuring at most one open checkout per document at any time

### 7. Test Infrastructure (`backend/conftest.py`)
- Added conftest.py that inserts the backend root into `sys.path` so `import app` works when running pytest (pytest's default import mode doesn't add the rootdir for flat test directories)

### 8. Updated Tests (`backend/tests/test_location.py`)
- Replaced obsolete `test_an_occupied_slot_is_a_422` (expected 422) with `test_a_box_may_hold_multiple_documents` (expects 200 — multiple docs can share a box)
- Added `TestCheckoutCheckin` class with 6 tests:
  - `test_checkout_then_checkin` — full lifecycle: checkout → checkin → re-checkout
  - `test_reject_already_checked_out` — 422 when attempting second checkout
  - `test_reject_not_checked_out` — 422 when attempting checkin on unchecked document
  - `test_due_at_defaults_to_config_plus_offset` — verifies due_at = now + 7 days
  - `test_single_open_checkout_partial_unique_index` — ensures only one open checkout per document; re-checkout after checkin works
  - `test_audit_logs_checkout_checkin` — verifies audit entries are created for both checkout and checkin

## Frontend Changes

### 1. Type Definitions (`frontend/src/lib/types.ts`)
- Added `WarehouseSlot` interface with `zone`, `rack`, `shelf`, `box`, `position`, `total_in_box`, `checkout`
- Added `CheckoutInfo` interface with `by` and `dueAt`
- Added `CheckoutResponse` and `CheckinResponse` interfaces
- Added `WarehouseLayout` interface with `zones`, `racks`, `shelves`, `boxes`, `slots`

### 2. Warehouse Document Page (`frontend/src/app/(workspace)/warehouse/[id]/page.tsx`)
- Updated `picked` state to hold `occupants` array with `position`, `totalInBox`, `checkout` per document
- `onBoxClick` passes full payload `{zone, rack, shelf, box, occupants[]}`
- Pinned panel lists all documents in box with position ("3 of 14"), title, checkout status ("Checked out by X · due YYYY-MM-DD"), and "Open" link per doc
- Location breadcrumb shows full path

### 3. Warehouse Locator (`frontend/src/components/warehouse/warehouse-locator.tsx`)
- `buildWarehouse` function groups slots by box key, computes box-level checkout status
- Uses `boxColor` for material color based on accent HSL token
- Stores `occupants` array in `userData` with `position/totalInBox/checkout`
- Pin label uses `boxLabel` showing "Box X · N of M" for target document
- `onBoxClick` passes `{zone, rack, shelf, box, occupants[]}`
- Added `documentId` prop

## Data Flow
1. **Upload** → backend auto-assigns next free `zone/rack/shelf/box` slot → document gets location
2. **Admin view** → detail page shows location badge + "Edit location" button → form to adjust
3. **Library list** → each card shows `LocationBadge` (colored copper + pin icon, or "— not located" muted)
4. **Warehouse page** → `GET /api/v1/documents/{id}/location` returns the four fields; UI renders isometric grid + pulsing box
5. **Checkout** → `POST /api/v1/documents/{id}/checkout` (row-locked, defaults due_at = now + 7 days, audit log)
6. **Checkin** → `POST /api/v1/documents/{id}/checkin` (row-locked, audit log)
7. **Layout** → `GET /api/v1/warehouse/layout` reports open checkout info per slot

## Key Design Decisions
- **Multiple documents per box**: Box is a physical container, not a unique index. Several docs can share zone/rack/shelf/box; position decided by `created_at` then `id`
- **Partial unique index**: Only one open checkout per document at a time (not per slot); allows multiple open checkouts across different documents
- **Row locks + savepoints**: `with_for_update()` prevents concurrent check-outs; `begin_nested()` ensures failure leaves in-memory state untouched
- **Config-driven due date**: `checkout_default_due_days = 7` from `settings`; overridable per-checkout via `due_at` payload parameter
- **Audit logging**: Both checkout and checkin record audit entries with `actor_id`, `action`, `resource_type`, `resource_id`, and metadata

## Verification
- `alembic upgrade head` — migration 004 applied successfully
- `pytest tests/test_location.py` — 42 tests pass (all location + checkout/checkin tests)
- `npm run typecheck` — frontend TypeScript passes with no errors
- Server running at `http://localhost:8000` with all routes functional

## Files Modified
| Layer | File | Change Type |
|-------|------|-------------|
| Backend config | `backend/app/core/config.py` | +`checkout_default_due_days = 7` |
| Backend model | `backend/app/db/models/document.py` | +`checkouts` relationship |
| Backend model (new) | `backend/app/db/models/document_checkout.py` | New — checkout history table |
| Backend migration (new) | `backend/alembic/versions/004_document_checkouts.py` | New — drops uq, creates document_checkouts |
| Backend service | `backend/app/modules/documents/service.py` | +checkout/checkin functions + DocumentCheckout import |
| Backend router | `backend/app/modules/documents/router.py` | +checkout/checkin routes + ValueError→422 handling |
| Backend test config | `backend/conftest.py` | New — pytest path setup |
| Backend tests | `backend/tests/test_location.py` | +TestCheckoutCheckin (6 tests) + replaced obsolete test |
| Frontend types | `frontend/src/lib/types.ts` | +WarehouseSlot, CheckoutInfo, etc. |
| Frontend warehouse page | `frontend/src/app/(workspace)/warehouse/[id]/page.tsx` | New — isometric grid + pulsing box |
| Frontend locator | `frontend/src/components/warehouse/warehouse-locator.tsx` | Complete rewrite — buildWarehouse function |
| Frontend library page | `frontend/src/app/(workspace)/library/page.tsx` | +LocationBadge on DocCard; link to warehouse |

## How to Test Manually (on running server at http://localhost:8000)
1. Log in as `admin@archivedemo.example.com`
2. Go to Library page → hover any document badge → if location is set, badge shows zone-rack-shelf-box; if not, shows "— not located"
3. Click a badge → navigates to `/warehouse/{docId}` → isometric grid loads → the correct box pulses
4. Click "Edit location" on document detail → adjust zone/rack/shelf/box selects → Submit → grid updates pulse to new box
5. Click "Clear location" → badge reverts to "— not located", pulse stops
6. Select a document → POST /checkout → 200, document shows as checked out with due date
7. POST /checkin → 200, document returns to archive
8. View warehouse layout → see open checkout info (who has it out, due date) on the map

## Summary of Test Results
- 42 tests pass in `test_location.py`
- All location vocabulary tests pass
- All label/validation tests pass
- All warehouse layout + permission filter tests pass
- All 6 checkout/checkin lifecycle tests pass
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-device web POS for a one-day pop-up bar at a university reunion (45th PRE
Anniversary Reunion). Staff take drink orders on a tablet, show a PromptPay QR,
confirm payment, and every paid order is appended to a Google Sheet for accounting.

It runs for **one evening**. Bias every decision toward "cannot fail on the night"
over elegance: no new runtime dependencies without a strong reason, degrade to a
working fallback rather than erroring out, and make misconfiguration loud in the
logs at boot instead of silent at the till.

## Commands

```bash
npm start                      # run the server (port 3000)
npm run dev                    # same, with --watch
node scripts/import-guests.js  # re-import the seating xlsx -> data/guests.json
node scripts/check-sheets.js   # diagnose the Google Sheets connection (--write to test-append)
docker compose up -d --build   # full deploy (app + Caddy HTTPS)
```

There is **no test suite, linter, or build step** in this project. The frontend is
plain HTML/CSS/JS served straight from `public/`. Verify changes by running the
server and exercising the real endpoints (see Verifying below).

## Architecture

Node + Express + SQLite (`better-sqlite3`, synchronous — no `await` on DB calls).
CommonJS throughout.

### Two payment modes — this is the main axis of the codebase

`config/mode.js` exposes `isStaticQrMode()` and `isDemoMode()`; both gate behavior
across the backend *and* the checkout screen. Understand this before touching
payment code.

| | `PAYMENT_MODE=static_qr` (current) | `PAYMENT_MODE=gateway` |
|---|---|---|
| QR | one fixed image, `public/images/promptpay-qr.jpg` | per-order, from GBPrimePay `/v3/qrcode` |
| Amount | **not encoded** — customer types it | encoded exactly |
| Confirmation | slip photo only | webhook + polling, slip as fallback |

A static PromptPay QR carries no amount and no per-order reference, so **nothing
can auto-confirm**: there is no transaction for the gateway to report on. That
single fact is why `routes/orders.js` skips `checkStatus` polling, `/recheck`
returns 409, and the frontend promotes slip capture to the primary button and
hides "Check now". If you find yourself adding gateway logic to the static path,
you have misunderstood the mode.

`DEMO_MODE` is **independent**: it skips Google Sheets writes (logging what *would*
be written) and mocks the gateway. `DEMO_MODE=true` + `PAYMENT_MODE=static_qr` is
the current setup — real QR, real slips on disk, no Sheets.

### Payment confirmation is idempotent by contract

`store.markPaid()` / `markPaidBySlip()` return `{ order, transitioned }`, where
`transitioned` is true only for the call that actually did the `pending → paid`
flip. `services/paymentConfirmation.js` writes the accounting row **only when
`transitioned`**, so a redelivered webhook racing a manual recheck can never
double-log a payment. Preserve this contract in any new confirmation path.

In `gateway` mode three independent paths converge on `confirmOrderPaid()`:
the webhook (`routes/webhooks.js`), the poll inside `GET /api/orders/:id`, and the
`/recheck` button. **None of them trust the webhook body** — each re-asks
GBPrimePay's secret-key-authenticated `check_status_txn`, so a spoofed callback
can't fake a payment.

If a Sheets write fails after retries, the order stays paid and the app logs a
grep-able `UNLOGGED_PAID_ORDER` line — a payment is never lost silently.

### Guest seating list

Staff need to know *who paid for a table*, but never pick a guest in the app
(too slow at the till). Instead:

```
seating .xlsx  →  scripts/import-guests.js  →  data/guests.json (committed)
               →  seeded into the `guests` table at boot (data/store.js)
               →  snapshotted onto every order (guests_json, table_group)
               →  "Guests at table" column beside the slip link in the Sheet
```

The payer is identified afterwards by matching the slip photo against the table's
names. Key points:

- `data/guests.json` is **committed** because `orders.sqlite` is gitignored and
  rebuilt empty on deploy. The JSON is the durable source; the DB is a cache.
- Re-seeding is idempotent — it only re-runs when `importedAt` in the JSON changes.
- The order snapshot is a **copy, not a join**: re-importing an updated seating
  file must never rewrite the history of orders already taken.
- `scripts/import-guests.js` reads the `.xlsx` (a ZIP of XML) with Node stdlib
  only — `zlib` plus a small central-directory parse. Deliberately no spreadsheet
  dependency. Keep it that way.
- `config/tables.js` builds the floor-plan grid from this data, so the grid always
  matches the room (currently 45 tables). `TABLE_COUNT` is only a fallback for
  when nothing has been imported.

### Other things worth knowing

- **Schema migrations**: `data/store.js` has an `addColumns` array applied via
  `ALTER TABLE` when a column is missing. Add new columns there — never assume a
  fresh DB, and never edit the original `CREATE TABLE`.
- **Coupons**: `config/coupons.js` defines only what a code is *worth*; single-use
  enforcement lives in the `coupon_redemptions` table. Lifecycle is reserve (at
  order creation, atomic via PRIMARY KEY) → release (cancel/expire) → finalize
  (paid). Frontend `couponDiscount()` mirrors `computeDiscount()` for live preview
  only; the server always recomputes authoritatively.
- **Sheet columns** are driven by the `HEADER` array in `services/sheets.js`, which
  derives `LAST_COLUMN`. It includes one quantity column per menu item (from
  `config/menu.js`) rather than a combined "Beer x1, Regency x1" string. If you
  change it, update `GOOGLE_SHEET_RANGE` in `.env` and `.env.example` to match
  (currently `A:N`).
- **Slips** are written next to the DB (`dirname(DB_PATH)/slips`, bind-mounted
  to `./runtime-data` on the host, see `docker-compose.yml`) and served
  read-only at `/slips`. The Sheet renders the slip as an inline
  `=HYPERLINK(...)`-wrapped `=IMAGE(...)` formula built from a `PUBLIC_BASE_URL/slips/...`
  URL, so `PUBLIC_BASE_URL` must be correct or the thumbnail fails to load.
- **Camera capture** (`public/app.js`) needs a secure context. It uses
  `getUserMedia` on HTTPS/localhost and silently falls back to the native file
  picker (`<input capture>`) on plain-HTTP LAN. Both paths must keep working.
- **Frontend** is one IIFE in `public/app.js`; screens and checkout states are
  toggled by `hidden` class via `showScreen()` / `showCheckoutState()`. No
  framework, no build.

## Verifying

Run the server and drive the real API — that is the only check available:

```bash
npm start
curl -s localhost:3000/api/orders/tables            # grid from seating data
curl -s -X POST localhost:3000/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"table":"17","items":[{"id":"beer","qty":2}]}'
# then POST /api/orders/:id/slip with a base64 data URL to confirm payment
```

With `DEMO_MODE=true` the accounting row is printed to the log as
`[demo] would log to Sheet: ...` — check the guest names and totals land there.
Screenshots of the tablet UI can be taken headlessly with
`google-chrome --headless --screenshot=... http://localhost:3000/`.

Delete any test orders you create from `orders.sqlite` afterwards.

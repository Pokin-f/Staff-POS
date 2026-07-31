# Project status

Staff Operator POS — one-evening pop-up bar till for the 45th PRE Anniversary
Reunion. Last updated 2026-07-31.

## Where it stands

The full order → QR → slip → accounting-row path works end to end, running in
**static QR mode** against the real PromptPay account, with the event's seating
list imported. It is **not yet connected to a Google Sheet**, which is the one
thing standing between the current state and being event-ready.

## Configuration right now

| Setting | Value | Note |
|---|---|---|
| `PAYMENT_MODE` | `static_qr` | Real fixed PromptPay QR; gateway bypassed |
| `DEMO_MODE` | `true` | Sheets writes are logged, not sent |
| `PUBLIC_BASE_URL` | `https://your-app.example.com` | **Placeholder** — slip links in the Sheet will be dead until fixed |
| `GOOGLE_SHEET_ID` | *(empty)* | Sheet not created yet |
| `service-account.json` | *missing* | Needed for Sheets auth |
| `ORDER_EXPIRY_MINUTES` | `5` | Sized for auto-confirming QR; likely too short now (see below) |
| Prices | Beer ฿80, Regency ฿150 | |
| Tables | 45, from the seating list | `TABLE_COUNT=30` is now fallback-only |

## Verified

- **Static QR checkout** — order created, real QR served (HTTP 200, 80KB JPEG),
  amount displayed for the customer to type, slip captured, order marked
  `paid_slip`, accounting row emitted with the slip URL.
- **Guest import** — 413 guests across tables 1–45 parsed from the seating
  `.xlsx`; cross-checked against an independent parse of the same file, identical
  result. Thai names intact end to end (import → DB → order snapshot → Sheet row).
- **Table grid** — all 45 tables render with their group labels; the 23 tables
  seating more than one group show a `+`. Confirmed by screenshot of the real page.
- **Guest snapshot on orders** — an order at table 17 stored all 9 guests and
  carried them into the accounting row.
- **Idempotent guest reseed** — second boot does not reload; only a changed
  `importedAt` triggers a re-seed.
- **Config warnings at boot** — static-QR and demo-mode banners both print.

## Not yet verified

- **A real Google Sheets write.** Everything so far is the `[demo] would log to
  Sheet: ...` path. The header row, column layout (`A:M`), and service-account
  permissions are untested against a live spreadsheet.
- **The tablet, over HTTPS.** The in-page camera needs a secure context. On
  `localhost` it works; over plain-HTTP LAN it silently falls back to the native
  camera picker. The deployed HTTPS path has not been exercised on real hardware.
- **The GBPrimePay gateway path.** No keys are configured. Unused in static QR
  mode, but it means `gateway` mode is currently untested and unavailable.
- **Two staff devices at once.** Only ever driven single-client.

## Before the event

1. **Create the Google Sheet** and wire it up — this is the blocker for accounting.
   - Create the spreadsheet, note its ID from the URL.
   - Create a service account + JSON key, save as `service-account.json` in the
     project root (the filename matters — `docker-compose.yml` mounts it by name).
   - **Share the sheet (Editor) with the service account's email**, or writes 403.
   - Set `GOOGLE_SHEET_ID`, then run **`node scripts/check-sheets.js --write`** —
     it verifies each step and names the exact fix for whatever is wrong.
   - Set `DEMO_MODE=false`.
   - Place one test order and confirm the row lands with the header
     `Timestamp | Order ID | Table | Table Group | Items | Subtotal | Discount | Coupon | Total | Reference | Status | Slip | Guests at table`.
2. **Set `PUBLIC_BASE_URL`** to the real HTTPS URL. Slip links in the Sheet are
   built from it; a placeholder means every slip link in the accounting log is dead.
3. **Deploy behind HTTPS** (`docker compose up -d --build`) so the tablet gets the
   in-page camera rather than the file-picker fallback. Needs `DOMAIN` set in
   `.env` — it is currently absent — plus a DNS A record and ports 80/443 free.
4. **Replace the demo coupon codes** in `config/coupons.js`. `PRE45`, `STAFF`,
   `VIP50`, `FREEBEER` are placeholders with made-up values.
5. **Clear the test orders** — `orders.sqlite` currently holds 3 from development
   (2 expired, 1 paid-by-slip). They would otherwise appear in the event's records.
6. **Re-run the seating import** if the guest list changes:
   `node scripts/import-guests.js`.
7. **Rehearse the till flow** with a real phone: scan the QR, transfer ฿1, capture
   the slip, confirm the row appears in the Sheet with the table's guest names.

## Open questions / judgement calls

- **`ORDER_EXPIRY_MINUTES=5` is probably too short.** It was sized for a QR that
  auto-confirms. A customer now has to read the amount, open their banking app,
  type it, transfer, and show the slip. 10–15 minutes is more realistic. Orders
  that expire are recoverable — slip capture still works from the expired screen —
  but staff will hit that screen often at 5 minutes.
- **Every order depends on staff capturing a slip.** Nothing marks an order paid on
  its own in static QR mode. If staff forget, the order silently expires and the
  payment is never recorded. Worth covering explicitly in the staff briefing.
- **Mixed tables.** 23 of 45 tables seat more than one group, so the grid label
  shows only the dominant one (with a `+`). The Sheet's `Table Group` column lists
  all of them, so nothing is lost in the record.
- **The QR image shows the payee's name and partial account number** and lives in
  `public/images/`. Fine for a private repo; worth a thought before making the
  repo public.
- **`orders.sqlite-wal` / `-shm` are tracked in git** but `*.sqlite` is ignored.
  The `-wal`/`-shm` siblings probably should be ignored too — they churn on every
  run and hold no durable state.

## Recent work

- Switched from GBPrimePay dynamic QR to the real static PromptPay QR, with slip
  capture promoted to the primary confirmation action.
- Added the guest seating list: stdlib-only `.xlsx` importer, committed
  `data/guests.json`, a `guests` table seeded at boot, a per-order guest snapshot,
  and `Table Group` / `Guests at table` columns in the accounting sheet.
- Table grid now derives from the seating data — this raised it from 30 to 45
  tables. Roughly 140 guests sit at tables 31–45 and were previously unreachable:
  staff could not have rung up those tables at all.

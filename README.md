# Staff Operator POS

A single-device web POS for a one-day pop-up bar. Staff take drink orders (Beer &
Regency), the app shows a PromptPay QR for the total, staff confirm the payment,
and every paid order is logged to a Google Sheet for accounting.

Two payment modes (see [Payment modes](#payment-modes)): a **static** real
PromptPay QR confirmed by photographing the customer's slip, or a **GBPrimePay**
per-order QR that confirms itself automatically.

- **Frontend:** plain HTML/CSS/JS served by the app (no build step)
- **Backend:** Node.js + Express
- **Storage:** SQLite (survives restarts mid-event)
- **Payments:** GBPrimePay QR (`/v3/qrcode`) + status verification (`/v1/check_status_txn`)
- **Accounting:** Google Sheets API via a service account

---

## Payment modes

Set by `PAYMENT_MODE` in `.env`.

| Mode | QR shown | Amount | Confirmation |
|---|---|---|---|
| `static_qr` | The fixed real PromptPay QR at `public/images/promptpay-qr.jpg` | **Not encoded** — the customer types it | Slip photo only |
| `gateway` | Per-order QR from GBPrimePay `/v3/qrcode` | Encoded exactly | Automatic (webhook + polling), slip as fallback |

### `static_qr` (no GBPrimePay account needed)

A static PromptPay QR is one printed image of a bank account. It carries no
amount and no per-order reference, so **the gateway has nothing to poll and no
webhook will ever fire**. That changes the operating procedure:

- The checkout screen calls out the amount the customer must type themselves.
- **"Customer paid — capture slip" is the primary action** — staff photograph
  the customer's transfer slip with the tablet camera and confirm.
- The "Check now" button is hidden, and `POST /:id/recheck` refuses with 409.
- Nothing marks an order paid on its own. An unattended order simply expires
  (the slip capture still works after expiry, from the expired screen).
- The accounting row lands with status `paid (slip)` and a link to the photo.

The QR image is served from `public/images/`; swap in a different account by
replacing that file or pointing `STATIC_QR_IMAGE` elsewhere.

This mode is independent of `DEMO_MODE` — leaving `DEMO_MODE=true` shows the
real QR and stores slips locally while still skipping Google Sheets, which is
the right setup until the accounting sheet exists.

## Guest seating list

Staff need to know **who paid for a table**, but they don't pick a guest in the
app — it would slow every order down. Instead the app records the whole table's
guest list with the order, and the payer is identified afterwards by matching
the transfer slip against those names.

The event's seating spreadsheet is the source of truth:

```bash
node scripts/import-guests.js [path/to/seating.xlsx]
```

Defaults to `รายชื่อผู้เข้าร่วมนั่งแต่ละโต๊ะ_จัดกลุ่ม.xlsx` in the project root,
and expects columns `โต๊ะ | ชื่อ | กลุ่ม/รุ่น | ประเภท` (table, name, group/class,
ticket type). It writes **`data/guests.json`**, which is committed — so a fresh
deploy keeps the guest list even though `orders.sqlite` is rebuilt empty. The
importer uses only Node's stdlib (no spreadsheet dependency), so it can't break
the app on event day. Re-run it whenever the seating file changes.

What that buys you:

- **The table grid is built from the seating data** — exactly the tables that
  have guests, each labelled with the group sitting there (`12` / `PE16`). About
  half the tables seat more than one group; those show a `+` after the dominant
  one. `TABLE_COUNT` is now only a fallback for when nothing has been imported.
- **Every order stores a snapshot** of that table's guests (`guests_json` on the
  `orders` row). A snapshot, not a live join, so re-importing an updated seating
  file never rewrites the history of orders already taken.
- **The accounting sheet gets `Table Group` and `Guests at table` columns**,
  the latter right beside the slip link.

Guest data is also queryable directly:

```sql
sqlite3 orders.sqlite "SELECT name, group_name, guest_type FROM guests WHERE table_no='17';"
```

## Who collected the order

Every order starts with **"Who's collecting this order?"** — staff tap their own
name before they pick the table, and that name is written to the sheet's
`Collected By` column. It's how the takings get reconciled per person at the end
of the night.

The roster is just `STAFF_NAMES` in `.env` (comma-separated) — no import step,
because the crew list changes right up to the evening:

```bash
STAFF_NAMES=Ping,Nok,Bee,Golf
```

Leave it unset and the picker falls back to `Staff 1..4` and says so loudly in
the boot log. The last person to take an order stays highlighted on the picker,
so a staff member working a run of orders confirms with one tap. The name is
recorded on the order, not on the device, so two people can share a tablet.

## How payment confirmation works (`gateway` mode)

An order flips from `pending_payment` → `paid` the moment GBPrimePay confirms it,
via **three** independent paths so it never gets stuck:

1. **Webhook** — GBPrimePay POSTs to `/api/webhooks/gbprimepay` on payment.
2. **Poll** — while the QR is on screen, the app polls its own backend, which
   opportunistically re-checks with GBPrimePay (throttled). Works even if the
   webhook is blocked or delayed.
3. **"Check now" button** — manual fallback for staff.

All three verify against GBPrimePay's authenticated `check_status_txn` before
marking anything paid, so a spoofed webhook can't fake a payment. Only the call
that actually does the flip writes the accounting row — a payment is never
double-logged.

---

## Prerequisites (set these up first — some take days)

### 1. GBPrimePay merchant account
- Sign up and complete KYC/business verification **now** — approval can take days.
- You'll need: **Token** (a.k.a. customer key), **Public Key**, **Secret Key**.
- Sandbox keys work immediately for testing; live keys require verification.
- GBPrimePay's verification review expects your site reachable at a public
  **HTTPS** URL — that's what the Docker + Caddy setup below gives you.

### 2. Google Sheets logging
- In Google Cloud Console: create a project, **enable the Google Sheets API**.
- **Enable the Google Sheets API** for the project (APIs & Services → Library).
- Create a **service account**, create a **JSON key**, download it.
- Create the target spreadsheet. **Share it** (Editor) with the service account's
  email (looks like `name@project.iam.gserviceaccount.com`).
- Note the spreadsheet ID from its URL:
  `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.
- No need to add a header row — the app writes one automatically on the first
  paid order and won't duplicate it if one already exists. Columns (A:O):

  `Timestamp | Order ID | Table | Table Group | Collected By | Beer | Regency | Subtotal (THB) | Discount (THB) | Coupon | Total (THB) | Reference | Status | Slip | Guests at table`

  One quantity column per menu item (from `config/menu.js`), so accounting can
  sum/filter per drink instead of parsing a combined string. Slip is a
  `=HYPERLINK(url, IMAGE(url))` formula — shows a thumbnail inline and opens
  the full photo in a new tab when clicked.

  **Slip** and **Guests at table** sit next to each other on purpose: that pair
  is how staff work out which guest paid (see [Guest seating list](#guest-seating-list)).
- Verify the whole connection with:

  ```bash
  node scripts/check-sheets.js           # check auth, API, sheet, tab
  node scripts/check-sheets.js --write   # also append a real test row
  ```

  It checks each step in order and prints the specific fix for whatever fails
  (API not enabled, sheet not shared, wrong ID, viewer instead of editor).

### 3. A server + domain
- A Linux server (VPS) with Docker + Docker Compose installed.
- A domain name with a **DNS A record pointing at the server's IP**.
- Ports **80** and **443** open and free on the server (Caddy needs both for
  automatic HTTPS).

---

## Configuration

Copy the template and fill it in:

```bash
cp .env.example .env
```

| Variable | What to put |
|---|---|
| `DOMAIN` | Your domain, e.g. `pos.yourdomain.com` (no `https://`) |
| `PUBLIC_BASE_URL` | `https://` + your domain — the URL you give GBPrimePay, and the base for slip links in the Sheet |
| `PAYMENT_MODE` | `static_qr` (fixed real PromptPay QR + slip) or `gateway` (GBPrimePay) |
| `STATIC_QR_IMAGE` | Path to the QR image, default `/images/promptpay-qr.jpg` (`static_qr` only) |
| `GBPRIMEPAY_ENV` | `sandbox` for testing, `production` for the event (`gateway` only) |
| `GBPRIMEPAY_TOKEN` / `GBPRIMEPAY_PUBLIC_KEY` / `GBPRIMEPAY_SECRET_KEY` | From your GBPrimePay dashboard |
| `ORDER_EXPIRY_MINUTES` | How long an unpaid QR stays valid (default `5`) |
| `PRICE_BEER` / `PRICE_REGENCY` | Prices in THB |
| `STAFF_NAMES` | Comma-separated crew on the till, e.g. `Ping,Nok,Bee` — the "who's collecting?" picker |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Leave as `/app/service-account.json` for Docker |
| `GOOGLE_SHEET_ID` | The spreadsheet ID from step 2 |
| `GOOGLE_SHEET_RANGE` | Default `Sheet1!A:O` |
| `TABLE_COUNT` | Fallback only — the grid comes from the imported seating list |

Then put your Google key file next to `docker-compose.yml`:

```bash
# The filename MUST be service-account.json (docker-compose mounts it by name)
cp /path/to/downloaded-key.json ./service-account.json
```

> ⚠️ **Create `service-account.json` before running `docker compose up`.** If the
> file doesn't exist, Docker creates a *directory* by that name and Sheets auth
> fails with a confusing error.

---

## Run locally (for development)

```bash
npm install
npm start
```

Open **http://localhost:3000** in a real browser tab — **not** by double-clicking
`index.html` and **not** VS Code's preview. The app fetches data from the server;
opening the file directly breaks every API call and shows a blank/unstyled page.

---

## Deploy on your server

```bash
# 1. Copy the project to the server (git clone, scp, rsync — your choice)
# 2. Create .env and service-account.json as described above
# 3. Build and start:
docker compose up -d --build

# 4. Check both containers are healthy:
docker compose ps

# 5. Confirm it's serving over HTTPS (Caddy auto-provisions the cert):
curl https://pos.yourdomain.com/api/orders/menu
```

Point the counter tablet's browser at `https://pos.yourdomain.com`.

**Logs / troubleshooting:**
```bash
docker compose logs -f pos     # app logs (payment + webhook + config warnings)
docker compose logs -f caddy   # HTTPS / cert issues
```
On startup the app prints `[config] ...` warnings for anything missing — check
these first if payments or logging don't work.

---

## GBPrimePay test sequence (do this in SANDBOX before the event)

This is the critical verification. The payment-confirmation logic uses field
names for `check_status_txn` that must be confirmed against the real API.

1. Set `GBPRIMEPAY_ENV=sandbox` and your **sandbox** keys in `.env`, redeploy.
2. On the tablet, add a Beer, tap **Checkout** — a QR should render.
   - *If no QR appears:* check `docker compose logs -f pos` for the GBPrimePay
     error response.
3. Pay the QR using GBPrimePay's sandbox test method.
4. **Within a few seconds the screen should flip to "Paid" on its own.**
   - *If it does NOT:* the `check_status_txn` response format differs from what
     the parser expects. Grab the raw response — the app logs it as
     `[gbprimepay webhook] check_status_txn for ...:` and
     `[poll] status check ...`. Send me that JSON and it's a one-line fix in
     `services/gbprimepay.js` (`isPaidResponse`).
5. Confirm a new row appeared in your Google Sheet.
   - *If not:* look for `UNLOGGED_PAID_ORDER` in the logs — that means payment
     confirmed but the Sheets write failed (bad key / sheet not shared / wrong ID).
6. Let an order sit unpaid past `ORDER_EXPIRY_MINUTES` and confirm it flips to
   "expired" and the UI recovers.

Once all six pass in sandbox, switch `GBPRIMEPAY_ENV=production` with your **live**
keys, redeploy, and run one small real transaction end-to-end before the event.

---

## Menu changes

Prices come from `.env` (`PRICE_BEER`, `PRICE_REGENCY`). The two items and their
photos live in `config/menu.js` and `public/images/`. Product images are
`public/images/beer.png` and `public/images/regency.png` (transparent PNGs).

---

## Project layout

```
server.js               Express entrypoint + startup config check
config/menu.js          The 2 menu items + prices
routes/orders.js        Create order, poll status (auto-confirm), cancel, recheck
routes/webhooks.js      GBPrimePay payment callback
services/gbprimepay.js  QR creation + payment status verification
services/sheets.js      Append paid order to Google Sheets
services/paymentConfirmation.js  Idempotent paid-flip + retried sheet logging
data/store.js           SQLite order persistence
data/expiry.js          Background sweep: unpaid orders -> expired
public/                 Frontend (index.html, style.css, app.js, images/)
Dockerfile              Multi-stage build
docker-compose.yml      App + Caddy (HTTPS) + persistent volumes
Caddyfile               Reverse proxy + auto TLS
```

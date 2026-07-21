# Staff Operator POS

A single-device web POS for a one-day pop-up bar. Staff take drink orders (Beer &
Regency), the app generates a GBPrimePay PromptPay QR for the exact total, payment
is confirmed automatically (no e-slip photos), and every paid order is logged to a
Google Sheet for accounting.

- **Frontend:** plain HTML/CSS/JS served by the app (no build step)
- **Backend:** Node.js + Express
- **Storage:** SQLite (survives restarts mid-event)
- **Payments:** GBPrimePay QR (`/v3/qrcode`) + status verification (`/v1/check_status_txn`)
- **Accounting:** Google Sheets API via a service account

---

## How payment confirmation works

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
- Create a **service account**, create a **JSON key**, download it.
- Create the target spreadsheet. **Share it** (Editor) with the service account's
  email (looks like `name@project.iam.gserviceaccount.com`).
- Note the spreadsheet ID from its URL:
  `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.
- No need to add a header row — the app writes one automatically on the first
  paid order (`Timestamp | Order ID | Items | Total (THB) | GBPrimePay Ref | Status`)
  and won't duplicate it if one already exists.

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
| `PUBLIC_BASE_URL` | `https://` + your domain — the URL you give GBPrimePay |
| `GBPRIMEPAY_ENV` | `sandbox` for testing, `production` for the event |
| `GBPRIMEPAY_TOKEN` / `GBPRIMEPAY_PUBLIC_KEY` / `GBPRIMEPAY_SECRET_KEY` | From your GBPrimePay dashboard |
| `ORDER_EXPIRY_MINUTES` | How long an unpaid QR stays valid (default `5`) |
| `PRICE_BEER` / `PRICE_REGENCY` | Prices in THB |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Leave as `/app/service-account.json` for Docker |
| `GOOGLE_SHEET_ID` | The spreadsheet ID from step 2 |
| `GOOGLE_SHEET_RANGE` | Default `Sheet1!A:F` |

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

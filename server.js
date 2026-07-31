require('dotenv').config();

const path = require('path');
const express = require('express');

const ordersRouter = require('./routes/orders');
const webhooksRouter = require('./routes/webhooks');
const { startExpirySweep } = require('./data/expiry');
const { SLIPS_DIR } = require('./services/slipStore');
const { isDemoMode, isStaticQrMode } = require('./config/mode');

// Fail-fast config check: surface misconfiguration at deploy time, not in
// front of a paying customer. Warns (doesn't exit) so you can still boot the
// UI, but the missing pieces are impossible to miss in the logs.
function checkConfig() {
  // Static QR mode doesn't touch GBPrimePay at all, so its keys aren't
  // required — but every order now depends on staff capturing a slip, and the
  // slip link written to the sheet is built from PUBLIC_BASE_URL. Reported
  // before the demo check because it applies in both modes: the real QR is
  // shown even while DEMO_MODE is still skipping Sheets.
  if (isStaticQrMode()) {
    console.warn('[static-qr] STATIC QR MODE ON — showing the fixed PromptPay QR. The gateway is bypassed: no auto-confirmation, no webhook. EVERY order must be confirmed by capturing the customer\'s slip.');
  }

  if (isDemoMode()) {
    const qrNote = isStaticQrMode() ? 'the real static QR is still shown' : 'gateway is mocked (placeholder QR, never auto-confirms)';
    console.warn(`[demo] DEMO MODE ON — ${qrNote} and Sheets logging is skipped. Do NOT use for the live event; set DEMO_MODE=false and configure real keys.`);
    return;
  }

  if (isStaticQrMode()) {
    const missing = ['PUBLIC_BASE_URL', 'GOOGLE_SHEET_ID'].filter((k) => !process.env[k]);
    if (missing.length) {
      console.warn(`[config] MISSING env vars: ${missing.join(', ')} — slip links and/or Sheets logging will fail until these are set.`);
    }
    return;
  }

  const required = [
    'PUBLIC_BASE_URL',
    'GBPRIMEPAY_TOKEN',
    'GBPRIMEPAY_SECRET_KEY',
    'GOOGLE_SHEET_ID'
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn(`[config] MISSING required env vars: ${missing.join(', ')} — payments/logging will fail until these are set.`);
  }
  if (process.env.PUBLIC_BASE_URL && !process.env.PUBLIC_BASE_URL.startsWith('https://')) {
    console.warn('[config] PUBLIC_BASE_URL is not https:// — GBPrimePay verification and webhooks require a public HTTPS URL.');
  }
  if ((process.env.GBPRIMEPAY_ENV || 'sandbox') !== 'production') {
    console.warn('[config] GBPRIMEPAY_ENV is sandbox — switch to "production" for the live event.');
  }
}
checkConfig();

const app = express();

// Limit is generous enough for a downscaled slip photo (data URL); the frontend
// compresses to ~1280px JPEG before upload, so this is never approached in
// normal use.
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/orders', ordersRouter);
app.use('/api/webhooks', webhooksRouter);

// Payment-slip images, saved by the slip fallback and linked from the Sheet.
app.use('/slips', express.static(SLIPS_DIR));

app.use(express.static(path.join(__dirname, 'public')));

startExpirySweep();

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Staff Operator POS listening on port ${port}`);
});

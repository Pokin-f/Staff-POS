require('dotenv').config();

const path = require('path');
const express = require('express');

const ordersRouter = require('./routes/orders');
const webhooksRouter = require('./routes/webhooks');
const { startExpirySweep } = require('./data/expiry');

// Fail-fast config check: surface misconfiguration at deploy time, not in
// front of a paying customer. Warns (doesn't exit) so you can still boot the
// UI, but the missing pieces are impossible to miss in the logs.
function checkConfig() {
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/orders', ordersRouter);
app.use('/api/webhooks', webhooksRouter);

app.use(express.static(path.join(__dirname, 'public')));

startExpirySweep();

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Staff Operator POS listening on port ${port}`);
});

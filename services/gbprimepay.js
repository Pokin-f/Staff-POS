// GBPrimePay QR_CASH integration.
//
// Endpoints and field names below are taken directly from GBPrimePay's own
// SDK source (github.com/maythiwat/node-gbprimepay) and a working reference
// integration (github.com/anoochit/flutter_gbprimepay_qrcode) — GBPrimePay's
// public docs site is a JS app that doesn't expose raw content to fetch.
//
// POST /v3/qrcode returns the QR as raw PNG image bytes (confirmed by the
// Flutter reference implementation reading response.bodyBytes directly).
// There's also a POST /v1/check_status_txn status endpoint, secret-key
// authenticated. GBPrimePay's webhook (backgroundUrl) payload isn't publicly
// documented beyond it including `referenceNo`, so instead of trusting the
// webhook body's own result fields, the webhook handler treats the callback
// only as a "go check now" signal and calls check_status_txn for the
// authoritative answer. Confirm the check_status_txn response shape against
// the real sandbox before going live (see PLAN verification section) — the
// resultCode/status field names below are GBPrimePay's general convention,
// not confirmed for this specific endpoint.

const ENV_URLS = {
  sandbox: 'https://api.globalprimepay.com',
  production: 'https://api.gbprimepay.com'
};

function baseUrl() {
  const env = process.env.GBPRIMEPAY_ENV === 'production' ? 'production' : 'sandbox';
  return ENV_URLS[env];
}

async function createQrCharge({ referenceNo, amount, detail, backgroundUrl }) {
  const token = process.env.GBPRIMEPAY_TOKEN;
  if (!token) {
    throw new Error('GBPRIMEPAY_TOKEN is not set');
  }

  const body = new URLSearchParams({
    token,
    referenceNo,
    amount: amount.toFixed(2),
    backgroundUrl,
    detail: detail || ''
  });

  const res = await fetch(`${baseUrl()}/v3/qrcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const contentType = res.headers.get('content-type') || '';

  if (!res.ok || !contentType.startsWith('image/')) {
    const text = await res.text();
    throw new Error(`GBPrimePay QR creation failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

async function checkStatus(referenceNo) {
  const secretKey = process.env.GBPRIMEPAY_SECRET_KEY;
  if (!secretKey) {
    throw new Error('GBPRIMEPAY_SECRET_KEY is not set');
  }

  const res = await fetch(`${baseUrl()}/v1/check_status_txn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`
    },
    body: JSON.stringify({ referenceNo })
  });

  const data = await res.json().catch(() => null);
  return {
    raw: data,
    paid: isPaidResponse(data)
  };
}

function isPaidResponse(data) {
  if (!data) return false;
  const successValues = ['00', 'success', 'successful', 'paid', 'approved', 'complete', 'completed'];
  const candidates = [data.resultCode, data.status, data.paymentStatus, data.result];
  return candidates.some(
    (v) => typeof v === 'string' && successValues.includes(v.toLowerCase())
  );
}

module.exports = { createQrCharge, checkStatus };

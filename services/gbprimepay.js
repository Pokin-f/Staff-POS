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

const { isDemoMode } = require('../config/mode');

const ENV_URLS = {
  sandbox: 'https://api.globalprimepay.com',
  production: 'https://api.gbprimepay.com'
};

function baseUrl() {
  const env = process.env.GBPRIMEPAY_ENV === 'production' ? 'production' : 'sandbox';
  return ENV_URLS[env];
}

// A self-contained SVG "QR" placeholder (finder squares + pseudo-random
// modules + a DEMO badge) so the checkout screen renders without a real
// gateway. Deterministic, no dependencies, embeds as a data URL like the real
// PNG does.
function demoQrImage() {
  const M = 10;
  const N = 21;
  const pad = 12;
  const size = N * M + pad * 2;
  const rects = [];
  const black = '#0B0D0F';
  function finder(cx, cy) {
    rects.push(`<rect x="${pad + cx * M}" y="${pad + cy * M}" width="${7 * M}" height="${7 * M}" fill="${black}"/>`);
    rects.push(`<rect x="${pad + (cx + 1) * M}" y="${pad + (cy + 1) * M}" width="${5 * M}" height="${5 * M}" fill="#fff"/>`);
    rects.push(`<rect x="${pad + (cx + 2) * M}" y="${pad + (cy + 2) * M}" width="${3 * M}" height="${3 * M}" fill="${black}"/>`);
  }
  finder(0, 0);
  finder(N - 7, 0);
  finder(0, N - 7);
  let seed = 7;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if ((x < 8 && y < 8) || (x > N - 8 && y < 8) || (x < 8 && y > N - 8)) continue;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if ((seed >> 8) & 1) {
        rects.push(`<rect x="${pad + x * M}" y="${pad + y * M}" width="${M}" height="${M}" fill="${black}"/>`);
      }
    }
  }
  const cx = size / 2;
  const cy = size / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>${rects.join('')}` +
    `<rect x="${cx - 38}" y="${cy - 14}" width="76" height="28" rx="6" fill="#E2542E"/>` +
    `<text x="${cx}" y="${cy + 5}" font-family="monospace" font-size="15" font-weight="bold" fill="#fff" text-anchor="middle">DEMO</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

async function createQrCharge({ referenceNo, amount, detail, backgroundUrl }) {
  if (isDemoMode()) {
    return demoQrImage();
  }

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
  if (isDemoMode()) {
    // Never auto-confirms in demo — the point is to exercise the slip fallback.
    return { raw: { demo: true }, paid: false };
  }

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

const crypto = require('crypto');
const express = require('express');

const store = require('../data/store');
const menu = require('../config/menu');
const tables = require('../config/tables');
const coupons = require('../config/coupons');
const staff = require('../config/staff');
const gbprimepay = require('../services/gbprimepay');
const slipStore = require('../services/slipStore');
const { confirmOrderPaid, confirmOrderBySlip } = require('../services/paymentConfirmation');
const { isStaticQrMode, staticQrImage } = require('../config/mode');

const MAX_SLIP_BYTES = 5 * 1024 * 1024;

const router = express.Router();

function generateOrderId() {
  return `ord_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function buildOrderLines(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Basket is empty');
  }

  const lines = [];
  let total = 0;

  for (const line of items) {
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error(`Invalid quantity for ${line.id}`);
    }
    const price = menu.priceOf(line.id);
    const name = menu.nameOf(line.id);
    total += price * qty;
    lines.push({ id: line.id, name, price, qty });
  }

  return { lines, total };
}

// Table label the staff picks before ordering. Kept as a short free-form string
// so it flows straight through to the order and the accounting log.
function normalizeTable(raw) {
  const table = String(raw == null ? '' : raw).trim();
  if (!table) {
    throw new Error('Table is required');
  }
  if (table.length > 32) {
    throw new Error('Invalid table');
  }
  return table;
}

function publicOrderView(order) {
  return {
    id: order.id,
    table: order.table,
    collectedBy: order.collectedBy,
    // Seating snapshot, for the hand-off docket on the paid screen: the runner
    // carrying the drinks needs the table's names to find who ordered.
    tableGroup: order.tableGroup,
    guests: (order.guests || []).map((g) => g.name),
    items: order.items,
    subtotal: order.subtotal,
    discount: order.discount,
    coupon: order.coupon,
    total: order.total,
    status: order.status,
    qrImage: order.qrImage,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    servedAt: order.servedAt,
    // Tells the checkout screen which payment model it's rendering. With
    // 'static_qr' there is no gateway confirmation, so the UI promotes slip
    // capture and drops the "Check now" button.
    paymentMode: isStaticQrMode() ? 'static_qr' : 'gateway'
  };
}

router.get('/menu', (req, res) => {
  res.json(menu.getMenu());
});

router.get('/tables', (req, res) => {
  res.json(tables.getTables());
});

// Roster for the "who's collecting?" picker shown before the table grid.
router.get('/staff', (req, res) => {
  res.json(staff.getStaff());
});

// Paid orders still waiting to be carried out — the tray behind the "To serve"
// button. Must be declared before '/:id' or the literal path is swallowed by
// the wildcard.
router.get('/open', (req, res) => {
  res.json(store.getOpenOrders().map(publicOrderView));
});

// Pre-checkout coupon check for the order page. Soft only — does NOT reserve
// the code (that happens authoritatively at order creation). Returns the
// discount for the current basket so the UI can preview the new total.
router.post('/validate-coupon', (req, res) => {
  let subtotal;
  try {
    ({ total: subtotal } = buildOrderLines(req.body.items));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const coupon = coupons.getCoupon(req.body.code);
  if (!coupon) {
    return res.json({ valid: false, reason: 'Invalid coupon code' });
  }
  if (store.isCouponClaimed(coupon.code)) {
    return res.json({ valid: false, reason: 'Coupon already used' });
  }

  const discount = coupons.computeDiscount(coupon, subtotal);
  res.json({ valid: true, code: coupon.code, type: coupon.type, value: coupon.value, discount });
});

router.post('/', async (req, res) => {
  let lines, subtotal, table, coupon = null;
  // Never rejected — see config/staff.js normalizeCollector. A blank cell in
  // the Sheet is fixable after the event; a refused order at the till is not.
  const collectedBy = staff.normalizeCollector(req.body.collectedBy);
  try {
    table = normalizeTable(req.body.table);
    ({ lines, total: subtotal } = buildOrderLines(req.body.items));
    if (req.body.couponCode) {
      coupon = coupons.getCoupon(req.body.couponCode);
      if (!coupon) throw new Error('Invalid coupon code');
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const id = generateOrderId();

  // Reserve the single-use code up front (atomic). Released below if the QR
  // fails, or on cancel/expire; finalized once the order is paid.
  let discount = 0;
  if (coupon) {
    if (!store.reserveCoupon(coupon.code, id)) {
      return res.status(409).json({ error: 'Coupon already used' });
    }
    discount = coupons.computeDiscount(coupon, subtotal);
  }
  const total = subtotal - discount;

  const referenceNo = id;
  const expiryMinutes = Number(process.env.ORDER_EXPIRY_MINUTES || 5);
  const expiresAt = Date.now() + expiryMinutes * 60_000;
  const backgroundUrl = `${process.env.PUBLIC_BASE_URL}/api/webhooks/gbprimepay`;

  // Static QR: one fixed image for every order, so there's no gateway call to
  // make and no way for checkout to fail on the payment side.
  let qrImage;
  if (isStaticQrMode()) {
    qrImage = staticQrImage();
  } else {
    try {
      qrImage = await gbprimepay.createQrCharge({
        referenceNo,
        amount: total,
        detail: lines.map((l) => `${l.name} x${l.qty}`).join(', '),
        backgroundUrl
      });
    } catch (err) {
      if (coupon) store.releaseCoupon(id);
      return res.status(502).json({ error: `Could not create payment QR: ${err.message}` });
    }
  }

  const order = store.createOrder({
    id,
    referenceNo,
    table,
    collectedBy,
    items: lines,
    subtotal,
    discount,
    couponCode: coupon ? coupon.code : null,
    total,
    expiresAt,
    qrImage
  });
  res.status(201).json(publicOrderView(order));
});

// Per-order throttle so the frontend's ~2.5s poll doesn't hammer GBPrimePay:
// at most one status check per order per POLL_CHECK_INTERVAL_MS.
const lastPollCheck = new Map();
const POLL_CHECK_INTERVAL_MS = 4000;

router.get('/:id', async (req, res) => {
  let order = store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // Poll-driven confirmation: don't rely on the webhook alone. If the order is
  // still pending, opportunistically ask GBPrimePay (throttled). This makes
  // "Paid" appear automatically even if the webhook is delayed or never fires.
  // Skipped for the static QR, which has no gateway transaction to ask about —
  // the frontend still polls this route to pick up expiry/cancellation.
  if (order.status === 'pending_payment' && !isStaticQrMode()) {
    const last = lastPollCheck.get(order.id) || 0;
    if (Date.now() - last >= POLL_CHECK_INTERVAL_MS) {
      lastPollCheck.set(order.id, Date.now());
      try {
        const result = await gbprimepay.checkStatus(order.referenceNo);
        if (result.paid) {
          await confirmOrderPaid(order.id);
          order = store.getOrder(order.id);
        }
      } catch (err) {
        // Non-fatal: still return current DB state so the screen keeps working.
        console.warn(`[poll] status check failed for ${order.referenceNo}: ${err.message}`);
      }
    }
  }

  res.json(publicOrderView(order));
});

// "Served" — the drinks reached the table, so drop the order off the tray.
// Idempotent: a second tap (or a second tablet) just returns the order.
router.post('/:id/serve', (req, res) => {
  const { order } = store.markServed(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['paid', 'paid_slip'].includes(order.status)) {
    return res.status(409).json({ error: `Order is ${order.status}, not paid` });
  }
  res.json(publicOrderView(order));
});

router.post('/:id/cancel', (req, res) => {
  const order = store.markCancelled(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(publicOrderView(order));
});

// Resilience net: lets staff force a fresh check against GBPrimePay if the
// webhook is slow to arrive. Still no slip photo involved — just re-asks
// the gateway directly.
router.post('/:id/recheck', async (req, res) => {
  const order = store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // Nothing to re-check against a static QR (the UI hides the button, but the
  // route must not pretend otherwise if it's called anyway).
  if (isStaticQrMode()) {
    return res.status(409).json({ error: 'Static QR mode: payment is confirmed from the slip photo, not the gateway' });
  }

  if (order.status === 'pending_payment') {
    try {
      const result = await gbprimepay.checkStatus(order.referenceNo);
      if (result.paid) {
        await confirmOrderPaid(order.id);
      }
    } catch (err) {
      return res.status(502).json({ error: `Could not check payment status: ${err.message}` });
    }
  }

  res.json(publicOrderView(store.getOrder(order.id)));
});

// Slip fallback: staff uploads a photo of the customer's transfer slip when the
// gateway hasn't confirmed in time. Accepts a base64 data URL, saves the image
// locally, marks the order paid-by-slip, and logs it (with the slip link) to
// the sheet. Allowed while pending OR after it expired.
router.post('/:id/slip', async (req, res) => {
  const order = store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['pending_payment', 'expired'].includes(order.status)) {
    return res.status(409).json({ error: `Order is already ${order.status}` });
  }

  const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(req.body.image || '');
  if (!match) {
    return res.status(400).json({ error: 'Invalid image' });
  }
  const mime = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0 || buffer.length > MAX_SLIP_BYTES) {
    return res.status(413).json({ error: 'Image too large or empty' });
  }

  try {
    const filename = slipStore.saveSlip(order.id, buffer, mime);
    await confirmOrderBySlip(order.id, filename);
  } catch (err) {
    return res.status(500).json({ error: `Could not record slip: ${err.message}` });
  }

  res.json(publicOrderView(store.getOrder(order.id)));
});

module.exports = router;

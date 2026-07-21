const crypto = require('crypto');
const express = require('express');

const store = require('../data/store');
const menu = require('../config/menu');
const gbprimepay = require('../services/gbprimepay');
const { confirmOrderPaid } = require('../services/paymentConfirmation');

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

function publicOrderView(order) {
  return {
    id: order.id,
    items: order.items,
    total: order.total,
    status: order.status,
    qrImage: order.qrImage,
    expiresAt: order.expiresAt
  };
}

router.get('/menu', (req, res) => {
  res.json(menu.getMenu());
});

router.post('/', async (req, res) => {
  let lines, total;
  try {
    ({ lines, total } = buildOrderLines(req.body.items));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const id = generateOrderId();
  const referenceNo = id;
  const expiryMinutes = Number(process.env.ORDER_EXPIRY_MINUTES || 5);
  const expiresAt = Date.now() + expiryMinutes * 60_000;
  const backgroundUrl = `${process.env.PUBLIC_BASE_URL}/api/webhooks/gbprimepay`;

  let qrImage;
  try {
    qrImage = await gbprimepay.createQrCharge({
      referenceNo,
      amount: total,
      detail: lines.map((l) => `${l.name} x${l.qty}`).join(', '),
      backgroundUrl
    });
  } catch (err) {
    return res.status(502).json({ error: `Could not create payment QR: ${err.message}` });
  }

  const order = store.createOrder({ id, referenceNo, items: lines, total, expiresAt, qrImage });
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
  if (order.status === 'pending_payment') {
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

module.exports = router;

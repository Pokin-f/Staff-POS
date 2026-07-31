const store = require('../data/store');
const sheets = require('./sheets');

// Idempotent: safe to call multiple times for the same order (webhook
// redelivery, manual recheck racing the webhook, etc). Only the call that
// actually flips pending -> paid logs to the accounting sheet, so a payment
// is never written twice.
async function confirmOrderPaid(orderId) {
  const { order, transitioned } = store.markPaid(orderId);
  if (!transitioned) {
    return order;
  }
  store.finalizeCoupon(orderId);
  await logPaidOrder(order);
  return order;
}

// Manual slip fallback: the gateway didn't confirm in time, so staff recorded
// the customer's transfer slip. slipPath is the saved image filename. Mirrors
// confirmOrderPaid's idempotency + logging, but the row lands with a "paid
// (slip)" status and a link to the slip image.
async function confirmOrderBySlip(orderId, slipPath) {
  const { order, transitioned } = store.markPaidBySlip(orderId, slipPath);
  if (!transitioned) {
    return order;
  }
  store.finalizeCoupon(orderId);
  await logPaidOrder(order);
  return order;
}

// The customer has paid and the order is already marked paid in the DB. If the
// sheet write fails we must NOT lose the record silently — retry a few times,
// then log a loud, grep-able marker so an operator watching the logs can add
// the row by hand. (See UNLOGGED_PAID_ORDER below.)
async function logPaidOrder(order) {
  try {
    await appendWithRetry(order);
  } catch (err) {
    console.error(
      `UNLOGGED_PAID_ORDER order=${order.id} ref=${order.referenceNo} ` +
      `status=${order.status} total=${order.total} ` +
      `items="${order.items.map((l) => `${l.name} x${l.qty}`).join(', ')}" ` +
      `-- paid but NOT written to Google Sheets: ${err.message}`
    );
  }
}

async function appendWithRetry(order, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await sheets.appendPaidOrderRow(order);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

module.exports = { confirmOrderPaid, confirmOrderBySlip };

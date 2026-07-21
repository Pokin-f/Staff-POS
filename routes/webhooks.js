const express = require('express');

const store = require('../data/store');
const gbprimepay = require('../services/gbprimepay');
const { confirmOrderPaid } = require('../services/paymentConfirmation');

const router = express.Router();

// GBPrimePay's exact webhook payload/signature scheme isn't in the public
// docs we could reach, so this handler treats any callback hit as a "go
// verify now" trigger rather than trusting its body: it re-asks GBPrimePay's
// own check_status_txn (secret-key authenticated) for the authoritative
// answer before marking anything paid. Always responds 200 so GBPrimePay
// doesn't retry-storm us, even if the referenceNo is unrecognized.
router.post('/gbprimepay', async (req, res) => {
  const referenceNo = req.body.referenceNo || req.body.referenceNo_;
  console.log('[gbprimepay webhook] received', req.body);

  if (!referenceNo) {
    console.warn('[gbprimepay webhook] missing referenceNo in payload');
    return res.sendStatus(200);
  }

  const order = store.getOrderByReferenceNo(referenceNo);
  if (!order) {
    console.warn(`[gbprimepay webhook] no order found for referenceNo=${referenceNo}`);
    return res.sendStatus(200);
  }

  try {
    const result = await gbprimepay.checkStatus(referenceNo);
    console.log(`[gbprimepay webhook] check_status_txn for ${referenceNo}:`, result.raw);
    if (result.paid) {
      await confirmOrderPaid(order.id);
    }
  } catch (err) {
    console.error(`[gbprimepay webhook] status check failed for ${referenceNo}:`, err.message);
  }

  res.sendStatus(200);
});

module.exports = router;

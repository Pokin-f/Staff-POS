// Demo / "Plan B" mode. When on, the app runs the whole order -> QR -> slip
// flow WITHOUT real GBPrimePay or Google Sheets credentials: the gateway is
// mocked (placeholder QR, never auto-confirms) and Sheets logging is skipped.
// Meant for demos and rehearsals — never for the live event.
function isDemoMode() {
  return process.env.DEMO_MODE === 'true' || process.env.GBPRIMEPAY_ENV === 'mock';
}

// Static PromptPay QR mode: show one fixed QR image of a real PromptPay
// account instead of asking GBPrimePay for a per-order QR.
//
// A static QR carries NO amount and NO per-order reference, which changes the
// whole payment model: there is nothing for the gateway to poll and no webhook
// will ever fire, so the customer types the amount into their banking app by
// hand and the ONLY confirmation is the staff-captured slip photo. The order
// screen is adjusted accordingly (amount called out, slip capture promoted to
// the primary action, "Check now" hidden).
//
// Independent of DEMO_MODE — you can run the real QR while DEMO_MODE=true is
// still skipping Google Sheets, which is the right setup before the accounting
// sheet exists.
const STATIC_QR_DEFAULT_IMAGE = '/images/promptpay-qr.jpg';

function isStaticQrMode() {
  return process.env.PAYMENT_MODE === 'static_qr';
}

function staticQrImage() {
  return process.env.STATIC_QR_IMAGE || STATIC_QR_DEFAULT_IMAGE;
}

module.exports = { isDemoMode, isStaticQrMode, staticQrImage };

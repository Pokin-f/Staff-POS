// Discount coupon codes for the order page.
//
// This file only defines what each code is WORTH. Single-use enforcement lives
// in the DB (see coupon_redemptions in data/store.js): a code is reserved when
// an order is created, released if that order is cancelled/expires, and
// finalized once it's paid. Edit the map below for the real event.
//
//   type: 'percent' -> value is a percentage   (10  => 10% off the order)
//         'amount'  -> value is a flat THB cut  (50  => ฿50 off the order)
const COUPONS = {
  PRE45: { type: 'percent', value: 10 }, // demo: 10% off — reunion code
  STAFF: { type: 'percent', value: 20 }, // demo: 20% off — staff drinks
  VIP50: { type: 'amount', value: 50 }, // demo: ฿50 off
  FREEBEER: { type: 'amount', value: 80 } // demo: ฿80 off (one free beer)
};

function getCoupon(code) {
  const key = String(code == null ? '' : code).trim().toUpperCase();
  if (!key) return null;
  const coupon = COUPONS[key];
  return coupon ? { code: key, type: coupon.type, value: coupon.value } : null;
}

// Discount in THB for a subtotal, clamped so the total never drops below zero.
// Rounded to whole baht (menu prices are whole-baht).
function computeDiscount(coupon, subtotal) {
  if (!coupon) return 0;
  const raw = coupon.type === 'percent'
    ? (subtotal * coupon.value) / 100
    : coupon.value;
  return Math.max(0, Math.min(Math.round(raw), subtotal));
}

module.exports = { getCoupon, computeDiscount };

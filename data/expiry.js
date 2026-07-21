const store = require('./store');

const SWEEP_INTERVAL_MS = 15_000;

function startExpirySweep() {
  const timer = setInterval(() => {
    store.sweepExpiredOrders();
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = { startExpirySweep };

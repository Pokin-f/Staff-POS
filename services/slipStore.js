// Local filesystem storage for payment-slip photos. Slips live next to the
// SQLite DB (under the same data dir, which is a persistent volume in Docker),
// and are served read-only at /slips by server.js. The accounting sheet stores
// a ${PUBLIC_BASE_URL}/slips/<file> link so the image is reviewable later.
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'orders.sqlite');
const SLIPS_DIR = path.join(path.dirname(dbPath), 'slips');
fs.mkdirSync(SLIPS_DIR, { recursive: true });

function extFor(mime) {
  if (mime === 'png') return 'png';
  if (mime === 'webp') return 'webp';
  return 'jpg';
}

// Writes the slip and returns its filename (relative to /slips). One file per
// order id, so a re-upload for the same order overwrites rather than piling up.
function saveSlip(orderId, buffer, mime) {
  const filename = `${orderId}.${extFor(mime)}`;
  fs.writeFileSync(path.join(SLIPS_DIR, filename), buffer);
  return filename;
}

module.exports = { SLIPS_DIR, saveSlip };

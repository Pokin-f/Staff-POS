const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'orders.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    reference_no TEXT NOT NULL,
    items_json TEXT NOT NULL,
    total REAL NOT NULL,
    status TEXT NOT NULL,
    qr_image TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    paid_at INTEGER
  )
`);

// Migration: add table_no to DBs created before table selection existed, so an
// upgrade never crashes on a missing column.
const orderCols = db.prepare('PRAGMA table_info(orders)').all();
if (!orderCols.some((c) => c.name === 'table_no')) {
  db.exec('ALTER TABLE orders ADD COLUMN table_no TEXT');
}

function rowToOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    referenceNo: row.reference_no,
    table: row.table_no,
    items: JSON.parse(row.items_json),
    total: row.total,
    status: row.status,
    qrImage: row.qr_image,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at
  };
}

function createOrder({ id, referenceNo, table, items, total, expiresAt, qrImage }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO orders (id, reference_no, table_no, items_json, total, status, qr_image, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?)
  `).run(id, referenceNo, table || null, JSON.stringify(items), total, qrImage, now, expiresAt);
  return getOrder(id);
}

function getOrder(id) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  return rowToOrder(row);
}

function getOrderByReferenceNo(referenceNo) {
  const row = db.prepare('SELECT * FROM orders WHERE reference_no = ?').get(referenceNo);
  return rowToOrder(row);
}

// Returns { order, transitioned } so callers can tell whether THIS call did
// the pending -> paid flip (vs. a duplicate webhook/recheck that arrived after
// it was already paid). Only the transitioning caller should log to Sheets,
// so a payment is never double-counted in the accounting log.
function markPaid(id) {
  const info = db.prepare(`
    UPDATE orders SET status = 'paid', paid_at = ?
    WHERE id = ? AND status = 'pending_payment'
  `).run(Date.now(), id);
  return { order: getOrder(id), transitioned: info.changes > 0 };
}

function markExpired(id) {
  db.prepare(`
    UPDATE orders SET status = 'expired'
    WHERE id = ? AND status = 'pending_payment'
  `).run(id);
  return getOrder(id);
}

function markCancelled(id) {
  db.prepare(`
    UPDATE orders SET status = 'cancelled'
    WHERE id = ? AND status = 'pending_payment'
  `).run(id);
  return getOrder(id);
}

function sweepExpiredOrders() {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT id FROM orders WHERE status = 'pending_payment' AND expires_at < ?
  `).all(now);
  const expireStmt = db.prepare(`UPDATE orders SET status = 'expired' WHERE id = ?`);
  for (const row of rows) {
    expireStmt.run(row.id);
  }
  return rows.length;
}

module.exports = {
  createOrder,
  getOrder,
  getOrderByReferenceNo,
  markPaid,
  markExpired,
  markCancelled,
  sweepExpiredOrders
};

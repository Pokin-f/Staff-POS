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

// Migrations: add columns to DBs created before a feature existed, so an
// upgrade never crashes on a missing column. Snapshot the schema once; every
// column below is only ever added here, so the snapshot stays accurate.
const orderCols = db.prepare('PRAGMA table_info(orders)').all();
const addColumns = [
  'table_no TEXT',
  'subtotal REAL',
  'discount REAL',
  'coupon_code TEXT',
  'slip_path TEXT',
  // Snapshot of who was seated at the table when the order was placed, so the
  // accounting record stays correct even if the seating file is re-imported
  // later. This is what staff match the payment slip against.
  'guests_json TEXT',
  'table_group TEXT',
  // Which staff member took the money for this order. Picked on the tablet
  // before the table, and written to the accounting sheet.
  'collected_by TEXT',
  // When the drinks actually reached the table. Paid-but-unserved orders are
  // what the "to serve" tray lists; this is the flag that clears them off it.
  // Deliberately separate from `status`: serving is a floor concern and must
  // never be confused with whether the money arrived.
  'served_at INTEGER'
];
for (const col of addColumns) {
  const name = col.split(' ')[0];
  if (!orderCols.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE orders ADD COLUMN ${col}`);
  }
}

// Single-use coupon tracking. One row per code (PRIMARY KEY) so a concurrent
// second reservation of the same code fails atomically on the INSERT.
db.exec(`
  CREATE TABLE IF NOT EXISTS coupon_redemptions (
    code TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

// ---- Guest seating -------------------------------------------------------
//
// Who sits at which table, imported from the event's seating spreadsheet by
// scripts/import-guests.js. Staff never pick a guest in the app; this exists so
// that every order carries the list of people at that table, and the payer can
// be identified afterwards by matching the slip against those names.

db.exec(`
  CREATE TABLE IF NOT EXISTS guests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_no TEXT NOT NULL,
    name TEXT NOT NULL,
    group_name TEXT,
    guest_type TEXT
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_guests_table ON guests(table_no)');
db.exec(`
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

// Re-seeds from data/guests.json whenever that file's importedAt differs from
// what's already loaded, so re-running the importer picks up automatically on
// the next boot. A missing file is not an error — the app still runs, it just
// falls back to a plain numbered table grid.
function seedGuests() {
  const guestsFile = path.join(__dirname, 'guests.json');
  if (!fs.existsSync(guestsFile)) {
    console.warn('[guests] data/guests.json not found — run `node scripts/import-guests.js` to load the seating list.');
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(guestsFile, 'utf8'));
  } catch (err) {
    console.error(`[guests] could not read data/guests.json: ${err.message}`);
    return;
  }

  const version = data.importedAt || '';
  const current = db.prepare(`SELECT value FROM app_meta WHERE key = 'guests_version'`).get();
  if (current && current.value === version && db.prepare('SELECT COUNT(*) c FROM guests').get().c > 0) {
    return;
  }

  const insert = db.prepare(`
    INSERT INTO guests (table_no, name, group_name, guest_type) VALUES (?, ?, ?, ?)
  `);
  const reseed = db.transaction(() => {
    db.prepare('DELETE FROM guests').run();
    for (const t of data.tables || []) {
      for (const g of t.guests || []) {
        insert.run(String(t.table), g.name, g.group || null, g.type || null);
      }
    }
    db.prepare(`
      INSERT INTO app_meta (key, value) VALUES ('guests_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(version);
  });
  reseed();

  const count = db.prepare('SELECT COUNT(*) c FROM guests').get().c;
  console.log(`[guests] loaded ${count} guests across ${(data.tables || []).length} tables from ${data.source || 'guests.json'}`);
}
seedGuests();

// Every guest at a table, in spreadsheet order.
function getGuestsForTable(tableNo) {
  if (!tableNo) return [];
  return db.prepare(`
    SELECT name, group_name AS "group", guest_type AS type
    FROM guests WHERE table_no = ? ORDER BY id
  `).all(String(tableNo));
}

// The tables that actually have guests, with the dominant group for each — used
// to build the floor-plan grid so it always matches the seating file.
function getGuestTables() {
  const rows = db.prepare(`
    SELECT table_no, name, group_name FROM guests ORDER BY id
  `).all();

  const byTable = new Map();
  for (const row of rows) {
    if (!byTable.has(row.table_no)) byTable.set(row.table_no, { seats: 0, groups: new Map() });
    const entry = byTable.get(row.table_no);
    entry.seats += 1;
    if (row.group_name) entry.groups.set(row.group_name, (entry.groups.get(row.group_name) || 0) + 1);
  }

  return [...byTable.entries()]
    .sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0))
    .map(([label, entry]) => {
      const ranked = [...entry.groups.entries()].sort((a, b) => b[1] - a[1]);
      return {
        label,
        group: ranked.length ? ranked[0][0] : '',
        mixed: ranked.length > 1,
        seats: entry.seats
      };
    });
}

function rowToOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    referenceNo: row.reference_no,
    table: row.table_no,
    collectedBy: row.collected_by,
    items: JSON.parse(row.items_json),
    subtotal: row.subtotal,
    discount: row.discount,
    coupon: row.coupon_code,
    total: row.total,
    status: row.status,
    qrImage: row.qr_image,
    slipPath: row.slip_path,
    tableGroup: row.table_group,
    guests: row.guests_json ? JSON.parse(row.guests_json) : [],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    servedAt: row.served_at
  };
}

// Guests are looked up here rather than passed in, so every order gets the
// seating snapshot automatically — there is no way to create one without it.
function createOrder({ id, referenceNo, table, collectedBy, items, subtotal, discount, couponCode, total, expiresAt, qrImage }) {
  const now = Date.now();
  const guests = getGuestsForTable(table);
  const groups = [...new Set(guests.map((g) => g.group).filter(Boolean))];
  db.prepare(`
    INSERT INTO orders (id, reference_no, table_no, collected_by, items_json, subtotal, discount, coupon_code, total, status, qr_image, created_at, expires_at, guests_json, table_group)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, ?)
  `).run(
    id, referenceNo, table || null, collectedBy || null, JSON.stringify(items), subtotal, discount || 0,
    couponCode || null, total, qrImage, now, expiresAt,
    guests.length ? JSON.stringify(guests) : null,
    groups.join(', ') || null
  );
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

// Manual slip fallback: staff confirmed payment from a transfer slip when the
// gateway didn't confirm in time. Allowed from 'expired' too, since "not on
// time" often means the countdown already ran out. Same { order, transitioned }
// contract as markPaid so only the transitioning caller logs to Sheets.
function markPaidBySlip(id, slipPath) {
  const info = db.prepare(`
    UPDATE orders SET status = 'paid_slip', paid_at = ?, slip_path = ?
    WHERE id = ? AND status IN ('pending_payment', 'expired')
  `).run(Date.now(), slipPath, id);
  return { order: getOrder(id), transitioned: info.changes > 0 };
}

// Paid orders whose drinks haven't been carried out yet, oldest first — the
// backlog the staff work through. Survives a tablet reload or a second device,
// because it lives in the DB rather than in the page.
function getOpenOrders() {
  return db.prepare(`
    SELECT * FROM orders
    WHERE status IN ('paid', 'paid_slip') AND served_at IS NULL
    ORDER BY paid_at ASC
  `).all().map(rowToOrder);
}

// Same { order, transitioned } contract as markPaid: only the call that
// actually clears the order off the tray reports true, so two staff tapping
// "served" on two tablets can't double-handle it.
function markServed(id) {
  const info = db.prepare(`
    UPDATE orders SET served_at = ?
    WHERE id = ? AND served_at IS NULL AND status IN ('paid', 'paid_slip')
  `).run(Date.now(), id);
  return { order: getOrder(id), transitioned: info.changes > 0 };
}

function markExpired(id) {
  db.prepare(`
    UPDATE orders SET status = 'expired'
    WHERE id = ? AND status = 'pending_payment'
  `).run(id);
  releaseCoupon(id);
  return getOrder(id);
}

function markCancelled(id) {
  db.prepare(`
    UPDATE orders SET status = 'cancelled'
    WHERE id = ? AND status = 'pending_payment'
  `).run(id);
  releaseCoupon(id);
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
    releaseCoupon(row.id);
  }
  return rows.length;
}

// ---- Single-use coupon redemptions ----

// Atomically claim a code for an order. Returns false if another order already
// holds it (UNIQUE violation on the primary key), which is the race guard.
function reserveCoupon(code, orderId) {
  try {
    db.prepare(`
      INSERT INTO coupon_redemptions (code, order_id, status, created_at)
      VALUES (?, ?, 'reserved', ?)
    `).run(code, orderId, Date.now());
    return true;
  } catch (err) {
    return false;
  }
}

// Burn the reservation permanently once the order is paid.
function finalizeCoupon(orderId) {
  db.prepare(`UPDATE coupon_redemptions SET status = 'used' WHERE order_id = ?`).run(orderId);
}

// Free a code so it can be used again. Only touches 'reserved' rows, so a code
// already 'used' by a paid order is never released.
function releaseCoupon(orderId) {
  db.prepare(`DELETE FROM coupon_redemptions WHERE order_id = ? AND status = 'reserved'`).run(orderId);
}

// Soft check for the pre-checkout validate endpoint (reserved OR used counts as
// unavailable). The authoritative claim is reserveCoupon at order creation.
function isCouponClaimed(code) {
  return !!db.prepare('SELECT 1 FROM coupon_redemptions WHERE code = ?').get(code);
}

module.exports = {
  createOrder,
  getOrder,
  getOrderByReferenceNo,
  markPaid,
  markPaidBySlip,
  getOpenOrders,
  markServed,
  markExpired,
  markCancelled,
  sweepExpiredOrders,
  reserveCoupon,
  finalizeCoupon,
  releaseCoupon,
  isCouponClaimed,
  getGuestsForTable,
  getGuestTables
};

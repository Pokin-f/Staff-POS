const path = require('path');
const { google } = require('googleapis');
const { isDemoMode } = require('../config/mode');
const { getMenu } = require('../config/menu');

// One quantity column per menu item, so accounting can sum/filter per drink
// instead of parsing a combined "Beer x1, Regency x1" string.
const MENU = getMenu();
const HEADER = [
  'Timestamp', 'Order ID', 'Table', 'Table Group', 'Collected By', ...MENU.map((m) => m.name),
  'Subtotal (THB)', 'Discount (THB)', 'Coupon',
  'Total (THB)', 'Reference', 'Status', 'Slip', 'Guests at table'
];

// Column letter of the last header field — the header is written to A1:<LAST>1.
const LAST_COLUMN = String.fromCharCode('A'.charCodeAt(0) + HEADER.length - 1);

// Who was seated at the table when the order was placed. Staff read this next
// to the slip photo to work out which guest actually paid.
function guestList(order) {
  if (!Array.isArray(order.guests) || order.guests.length === 0) return '';
  return order.guests.map((g) => g.name).join(', ');
}

function statusLabel(status) {
  return status === 'paid_slip' ? 'paid (slip)' : 'paid';
}

function slipUrl(order) {
  if (!order.slipPath) return '';
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/slips/${order.slipPath}`;
}

// Thumbnail inline in the cell, wrapped in HYPERLINK so clicking it opens the
// full photo in a new tab instead of just selecting the cell.
function slipCell(order) {
  const url = slipUrl(order);
  return url ? `=HYPERLINK("${url}", IMAGE("${url}"))` : '';
}

// Total quantity of one menu item across an order's line items.
function qtyOf(items, itemId) {
  return items
    .filter((line) => line.id === itemId)
    .reduce((sum, line) => sum + (line.qty || 0), 0);
}

let sheetsClientPromise = null;
let headerEnsured = false;

function getSheetsClient() {
  if (!sheetsClientPromise) {
    const keyFile = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || './service-account.json');
    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsClientPromise = auth.getClient().then((authClient) => google.sheets({ version: 'v4', auth: authClient }));
  }
  return sheetsClientPromise;
}

function summarizeItems(items) {
  return items.map((line) => `${line.name} x${line.qty}`).join(', ');
}

// Tab name from a range like "Sheet1!A:F" -> "Sheet1".
function sheetNameFromRange(range) {
  const bang = range.indexOf('!');
  return bang === -1 ? range : range.slice(0, bang);
}

// Writes the header row once, only if row 1 is empty. Uses `update` on the
// fixed A1:<last>1 range (not append), so it's idempotent and never produces a
// duplicate header even if two payments land at the same time.
async function ensureHeaderRow(sheets, spreadsheetId, range) {
  if (headerEnsured) return;
  const headerRange = `${sheetNameFromRange(range)}!A1:${LAST_COLUMN}1`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: headerRange });
  const firstRow = res.data.values && res.data.values[0];
  if (!firstRow || firstRow.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: headerRange,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] }
    });
  }
  headerEnsured = true;
}

async function appendPaidOrderRow(order) {
  if (isDemoMode()) {
    // No Google creds needed in demo — just show what WOULD be logged.
    console.log(
      `[demo] would log to Sheet: order=${order.id} table=${order.table || '-'} ` +
      `collectedBy=${order.collectedBy || '-'} ` +
      `items="${summarizeItems(order.items)}" subtotal=${order.subtotal} ` +
      `discount=${order.discount || 0} coupon=${order.coupon || '-'} total=${order.total} ` +
      `status=${statusLabel(order.status)} slip=${slipUrl(order) || '-'} ` +
      `group=${order.tableGroup || '-'} guests="${guestList(order) || '-'}"`
    );
    return;
  }

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const range = process.env.GOOGLE_SHEET_RANGE || `Sheet1!A:${LAST_COLUMN}`;
  if (!spreadsheetId) {
    throw new Error('GOOGLE_SHEET_ID is not set');
  }

  const subtotal = order.subtotal != null ? order.subtotal : order.total;
  const sheets = await getSheetsClient();
  await ensureHeaderRow(sheets, spreadsheetId, range);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        new Date(order.paidAt || Date.now()).toISOString(),
        order.id,
        order.table || '',
        order.tableGroup || '',
        order.collectedBy || '',
        ...MENU.map((m) => qtyOf(order.items, m.id)),
        subtotal,
        order.discount || 0,
        order.coupon || '',
        order.total,
        order.referenceNo,
        statusLabel(order.status),
        slipCell(order),
        guestList(order)
      ]]
    }
  });
}

module.exports = { appendPaidOrderRow };

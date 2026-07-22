const path = require('path');
const { google } = require('googleapis');

const HEADER = ['Timestamp', 'Order ID', 'Table', 'Items', 'Total (THB)', 'GBPrimePay Ref', 'Status'];

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
// fixed A1:F1 range (not append), so it's idempotent and never produces a
// duplicate header even if two payments land at the same time.
async function ensureHeaderRow(sheets, spreadsheetId, range) {
  if (headerEnsured) return;
  const headerRange = `${sheetNameFromRange(range)}!A1:G1`;
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
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const range = process.env.GOOGLE_SHEET_RANGE || 'Sheet1!A:G';
  if (!spreadsheetId) {
    throw new Error('GOOGLE_SHEET_ID is not set');
  }

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
        summarizeItems(order.items),
        order.total,
        order.referenceNo,
        'paid'
      ]]
    }
  });
}

module.exports = { appendPaidOrderRow };

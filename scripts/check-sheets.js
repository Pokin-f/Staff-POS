#!/usr/bin/env node
//
// Verifies the Google Sheets connection before the event, and turns the usual
// opaque API errors into the specific thing you have to go fix.
//
//   node scripts/check-sheets.js           # read-only check
//   node scripts/check-sheets.js --write   # also append a real test row
//
// Run this after creating the sheet and the service account. It checks, in
// order: key file present and parseable, Sheets API reachable, spreadsheet
// found, service account has write access, and (with --write) that a row
// actually lands with the right column layout.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const KEY_FILE = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || './service-account.json');
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const RANGE = process.env.GOOGLE_SHEET_RANGE || 'Sheet1!A:O';

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);

function fail(message, fixLines) {
  bad(message);
  if (fixLines) {
    console.log('');
    console.log('  How to fix:');
    for (const line of [].concat(fixLines)) console.log(`    ${line}`);
  }
  console.log('');
  process.exit(1);
}

function sheetNameFromRange(range) {
  const bang = range.indexOf('!');
  return bang === -1 ? range : range.slice(0, bang);
}

async function main() {
  console.log('');
  console.log('Google Sheets connection check');
  console.log('------------------------------');

  // 1. Sheet ID configured?
  if (!SHEET_ID) {
    fail('GOOGLE_SHEET_ID is not set in .env', [
      'Open your spreadsheet. The URL looks like:',
      '  https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_ID/edit',
      'Copy that middle part into .env as GOOGLE_SHEET_ID=...'
    ]);
  }
  ok(`GOOGLE_SHEET_ID is set (${SHEET_ID.slice(0, 12)}…)`);

  // 2. Key file present and readable?
  if (!fs.existsSync(KEY_FILE)) {
    fail(`Service account key file not found: ${KEY_FILE}`, [
      'Download the JSON key from Google Cloud (IAM & Admin -> Service Accounts',
      '  -> your account -> Keys -> Add key -> Create new key -> JSON) and save it as:',
      `  ${KEY_FILE}`,
      'The filename matters for Docker: docker-compose.yml mounts service-account.json by name.'
    ]);
  }

  let key;
  try {
    key = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  } catch (err) {
    fail(`Key file is not valid JSON: ${err.message}`, 'Re-download the key from Google Cloud.');
  }
  if (!key.client_email) {
    fail('Key file has no client_email — that is not a service account key.', [
      'Make sure you created a SERVICE ACCOUNT key, not an OAuth client ID.'
    ]);
  }
  ok(`Key file loaded: ${path.basename(KEY_FILE)}`);
  info(`service account: ${key.client_email}`);

  // 3. Auth + reach the spreadsheet.
  let sheets;
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: KEY_FILE,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  } catch (err) {
    fail(`Could not authenticate: ${err.message}`);
  }

  let meta;
  try {
    meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  } catch (err) {
    const status = err.code || (err.response && err.response.status);
    const detail = (err.errors && err.errors[0] && err.errors[0].message) || err.message;

    if (status === 403 && /has not been used|disabled/i.test(detail)) {
      fail(`Sheets API is not enabled for this project: ${detail}`, [
        'In Google Cloud console -> APIs & Services -> Library,',
        '  search "Google Sheets API" and click Enable.',
        'Then wait a minute and re-run this check.'
      ]);
    }
    if (status === 403) {
      fail(`Access denied to the spreadsheet: ${detail}`, [
        'The sheet is not shared with the service account. Open the spreadsheet,',
        '  click Share, and add this address as an EDITOR:',
        `    ${key.client_email}`,
        'Untick "Notify people" — it is not a real mailbox.'
      ]);
    }
    if (status === 404) {
      fail(`No spreadsheet found with that ID: ${detail}`, [
        'GOOGLE_SHEET_ID is wrong. It is only the middle part of the URL:',
        '  https://docs.google.com/spreadsheets/d/THIS_PART/edit',
        'Not the whole URL, and not the "#gid=" number at the end.'
      ]);
    }
    fail(`Could not open the spreadsheet: ${detail}`);
  }

  ok(`Spreadsheet found: "${meta.data.properties.title}"`);
  const tabs = meta.data.sheets.map((s) => s.properties.title);
  info(`tabs: ${tabs.join(', ')}`);

  // 4. Does the tab named in GOOGLE_SHEET_RANGE exist?
  const wantTab = sheetNameFromRange(RANGE);
  if (!tabs.includes(wantTab)) {
    fail(`GOOGLE_SHEET_RANGE points at a tab named "${wantTab}", which does not exist.`, [
      `Either rename a tab to "${wantTab}", or change GOOGLE_SHEET_RANGE in .env`,
      `  to use one of: ${tabs.join(', ')}`,
      `  e.g. GOOGLE_SHEET_RANGE=${tabs[0]}!A:M`
    ]);
  }
  ok(`Target tab "${wantTab}" exists (range ${RANGE})`);

  // 5. Write access — the failure people hit most often is read-granted-only.
  if (process.argv.includes('--write')) {
    // Thailand has no DST, so a fixed +7h offset is exact.
    const bkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${bkk.getUTCFullYear()}-${pad(bkk.getUTCMonth() + 1)}-${pad(bkk.getUTCDate())}T` +
      `${pad(bkk.getUTCHours())}:${pad(bkk.getUTCMinutes())}:${pad(bkk.getUTCSeconds())}+07:00`;
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: RANGE,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[stamp, 'CONNECTION TEST', '—', '—', '—', 0, 0, 0, 0, '', 0, '—', 'test', '', '']]
        }
      });
    } catch (err) {
      const detail = (err.errors && err.errors[0] && err.errors[0].message) || err.message;
      fail(`Could not write to the sheet: ${detail}`, [
        'The service account can read but not write. Re-share the sheet with',
        `  ${key.client_email}`,
        '  and make sure the role is EDITOR, not Viewer or Commenter.'
      ]);
    }
    ok('Test row appended — open the sheet, confirm it is there, then delete it');
  } else {
    info('(read-only check — re-run with --write to append a real test row)');
  }

  console.log('');
  console.log('  Sheets connection is good.');
  if (process.env.DEMO_MODE === 'true') {
    console.log('  NOTE: DEMO_MODE=true, so the app is still only logging rows to the');
    console.log('        console instead of sending them. Set DEMO_MODE=false to go live.');
  }
  if (!process.env.PUBLIC_BASE_URL || /example\.com|yourdomain/.test(process.env.PUBLIC_BASE_URL)) {
    console.log('  NOTE: PUBLIC_BASE_URL is still a placeholder, so the "Slip" links');
    console.log('        written to the sheet will not open. Set it to the real URL.');
  }
  console.log('');
}

main().catch((err) => {
  console.error('');
  console.error(`  Unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});

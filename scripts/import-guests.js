#!/usr/bin/env node
//
// One-time (re-runnable) importer: seating spreadsheet -> data/guests.json
//
//   node scripts/import-guests.js [path/to/seating.xlsx]
//
// Run this again whenever the seating file changes; the app reads the JSON, not
// the .xlsx. The JSON is committed, so a fresh deploy still has the guest list
// even though orders.sqlite is gitignored and rebuilt empty.
//
// An .xlsx is a ZIP of XML. Rather than add a spreadsheet dependency to a
// project that must not break on event day, this reads the archive with
// zlib + a ~40-line central-directory parse. Only the two parts we need are
// decoded: xl/sharedStrings.xml (all cell text) and xl/worksheets/sheet1.xml.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_SOURCE = 'รายชื่อผู้เข้าร่วมนั่งแต่ละโต๊ะ_จัดกลุ่ม.xlsx';
const OUT_FILE = path.join(__dirname, '..', 'data', 'guests.json');

// Column headers in the source file (Thai). Matched loosely so a re-exported
// file with extra spacing still imports.
const COL = { table: 'A', name: 'B', group: 'C', type: 'D' };

// ---- minimal ZIP reader ----------------------------------------------------

// Locates the End Of Central Directory record, walks the central directory,
// and returns { filename -> Buffer } for the entries we ask for.
function readZipEntries(buf, wanted) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a ZIP archive (no end-of-central-directory record)');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = {};

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('Corrupt central directory');
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    if (wanted.includes(name)) {
      // The local header repeats the name/extra with its OWN lengths — the
      // central directory's extra field length is often different, so these
      // must be read from the local header or the data offset is wrong.
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compressedSize);
      out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---- minimal XML helpers ---------------------------------------------------

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// Concatenates every <t> in a fragment. Rich text splits one string across
// several runs (<r><t>ก</t></r><r><t>ข</t></r>), which must join back together.
function textOf(fragment) {
  let out = '';
  const re = /<t[^>]*\/>|<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(fragment)) !== null) out += unescapeXml(m[1] || '');
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(textOf(m[1] || ''));
  return out;
}

// Returns [{ A: 'value', B: 'value', ... }] — one object per row, keyed by
// column letter, values already resolved to text.
function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>|<row[^>]*\/>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const body = rowMatch[1] || '';
    const cells = {};
    const cellRe = /<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(body)) !== null) {
      const attrs = cellMatch[1] || '';
      const inner = cellMatch[2] || '';
      const ref = (/r="([A-Z]+)\d+"/.exec(attrs) || [])[1];
      if (!ref) continue;
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1];
      let value = '';
      if (type === 's') {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        value = v != null ? (shared[Number(v)] || '') : '';
      } else if (type === 'inlineStr') {
        value = textOf(inner);
      } else {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        value = v != null ? unescapeXml(v) : '';
      }
      cells[ref] = value.trim();
    }
    rows.push(cells);
  }
  return rows;
}

// ---- import ----------------------------------------------------------------

// Excel stores the table number as a float ("12.0"); the app's table labels are
// plain strings ("12"), and they have to match exactly for the lookup to work.
function normalizeTableLabel(raw) {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return String(Math.round(n));
  return String(raw || '').trim();
}

function main() {
  const source = process.argv[2] || path.join(__dirname, '..', DEFAULT_SOURCE);
  if (!fs.existsSync(source)) {
    console.error(`Seating file not found: ${source}`);
    console.error(`Usage: node scripts/import-guests.js [path/to/seating.xlsx]`);
    process.exit(1);
  }

  const zip = readZipEntries(fs.readFileSync(source), [
    'xl/sharedStrings.xml',
    'xl/worksheets/sheet1.xml'
  ]);
  if (!zip['xl/worksheets/sheet1.xml']) {
    console.error('No xl/worksheets/sheet1.xml in the workbook — is the data on the first sheet?');
    process.exit(1);
  }

  const shared = parseSharedStrings(zip['xl/sharedStrings.xml'] && zip['xl/sharedStrings.xml'].toString('utf8'));
  const rows = parseSheet(zip['xl/worksheets/sheet1.xml'].toString('utf8'), shared);

  // Row 1 is the header (โต๊ะ | ชื่อ | กลุ่ม/รุ่น | ประเภท); skip it and any
  // trailing blank rows Excel leaves behind.
  const byTable = new Map();
  let guestCount = 0;
  let skipped = 0;

  for (const row of rows.slice(1)) {
    const name = row[COL.name];
    const table = normalizeTableLabel(row[COL.table]);
    if (!name) continue;
    if (!table) { skipped++; continue; }
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push({
      name,
      group: row[COL.group] || '',
      type: row[COL.type] || ''
    });
    guestCount++;
  }

  // Half the tables seat more than one group, so the grid label shows the
  // dominant one and flags the rest rather than pretending a table is uniform.
  const tables = [...byTable.entries()]
    .sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0))
    .map(([table, guests]) => {
      const counts = new Map();
      for (const g of guests) {
        if (g.group) counts.set(g.group, (counts.get(g.group) || 0) + 1);
      }
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      return {
        table,
        group: ranked.length ? ranked[0][0] : '',
        otherGroups: ranked.slice(1).map(([g]) => g),
        guests
      };
    });

  const payload = {
    source: path.basename(source),
    importedAt: new Date().toISOString(),
    guestCount,
    tableCount: tables.length,
    tables
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`Imported ${guestCount} guests across ${tables.length} tables -> ${path.relative(process.cwd(), OUT_FILE)}`);
  if (skipped) console.log(`  (${skipped} row(s) skipped: a name with no table number)`);
  const mixed = tables.filter((t) => t.otherGroups.length);
  console.log(`  tables: ${tables[0].table}–${tables[tables.length - 1].table}, ${mixed.length} with more than one group`);
}

main();

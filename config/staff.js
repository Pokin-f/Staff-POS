// Who is working the till.
//
// Staff pick themselves before the table on every order, so the accounting log
// records who collected the money. The roster is a comma-separated STAFF_NAMES
// env var — no import step, because the crew list is short and changes right up
// to the evening. Anything unset falls back to generic placeholders and shouts
// about it at boot rather than leaving the picker empty at the till.

const FALLBACK = ['Staff 1', 'Staff 2', 'Staff 3', 'Staff 4'];
const MAX_NAME_LENGTH = 40;

function parseRoster() {
  const raw = process.env.STAFF_NAMES || '';
  const names = raw
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
    .filter((n) => n.length <= MAX_NAME_LENGTH);

  // De-duplicate: the name is the identity, and two identical buttons on the
  // picker would make the Sheet ambiguous about who actually collected.
  return [...new Set(names)];
}

let roster = parseRoster();
if (roster.length === 0) {
  console.warn(
    '[staff] STAFF_NAMES is not set — falling back to ' +
    `${FALLBACK.join(', ')}. Set STAFF_NAMES in .env to the real crew list.`
  );
  roster = FALLBACK;
} else {
  console.log(`[staff] ${roster.length} on the roster: ${roster.join(', ')}`);
}

function getStaff() {
  return roster.slice();
}

// The name that goes on the order. Trimmed and length-capped, but NOT rejected
// for being off-roster: the picker only ever offers roster names, and refusing
// an order at the till because the crew list was edited mid-evening would cost
// a sale. An empty pick is allowed through too — the Sheet cell just stays
// blank, which is recoverable; a failed checkout is not.
function normalizeCollector(raw) {
  const name = String(raw == null ? '' : raw).trim();
  return name.slice(0, MAX_NAME_LENGTH);
}

module.exports = { getStaff, normalizeCollector };

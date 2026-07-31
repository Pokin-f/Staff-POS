// Tables the staff can operate on.
//
// Derived from the imported seating list (data/guests.json -> the guests table)
// so the floor plan always matches who is actually in the room — including the
// group sitting at each table, which is how staff find the right one. Falls
// back to a plain 1..TABLE_COUNT grid when no seating data has been imported.
//
// Each entry is { label, group, mixed, seats }. `label` is the plain string
// that flows through to the order and the accounting log.
const store = require('../data/store');

const DEFAULT_COUNT = 20;

function getTables() {
  const seated = store.getGuestTables();
  if (seated.length) return seated;

  const count = Number(process.env.TABLE_COUNT || DEFAULT_COUNT);
  const tables = [];
  for (let i = 1; i <= count; i += 1) {
    tables.push({ label: String(i), group: '', mixed: false, seats: 0 });
  }
  return tables;
}

module.exports = { getTables };

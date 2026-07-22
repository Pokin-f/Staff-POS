// Tables the staff can operate on. Count is configurable via TABLE_COUNT so you
// can match the room layout without touching code. Labels are plain strings so
// they flow straight through to the order and the accounting log.
const DEFAULT_COUNT = 20;

function getTables() {
  const count = Number(process.env.TABLE_COUNT || DEFAULT_COUNT);
  const tables = [];
  for (let i = 1; i <= count; i += 1) {
    tables.push(String(i));
  }
  return tables;
}

module.exports = { getTables };

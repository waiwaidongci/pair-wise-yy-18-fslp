// 巡演装箱 · 记录存储层
// 只负责落库与查询：装箱单、偶头/配件占用、事件履历、幂等键、旧稿留档。
const { randomUUID } = require('crypto');
const { sqlValue, runSql, select, now, toRecord } = require('../lib/db');

const COLLECTION = 'tourBoxes';
const REVISION_COLLECTION = 'tourBoxRevisions';

function listRecords(collection) {
  return select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' ORDER BY updated_at DESC;'
  ).map(toRecord);
}

function getRecord(collection, id) {
  const rows = select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ' LIMIT 1;'
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

function insertEventSql({ recordId, collection, action, status, actor, note, data }) {
  return (
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(recordId),
      sqlValue(collection),
      sqlValue(action || '记录'),
      sqlValue(status || ''),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(data || {})),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

function insertRecordSql({ id, collection, status, title, data, createdAt }) {
  return (
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(collection),
      sqlValue(status),
      sqlValue(title),
      sqlValue(JSON.stringify(data)),
      sqlValue(createdAt),
      sqlValue(createdAt)
    ].join(', ') +
    ');'
  );
}

function updateRecordSql({ id, collection, status, title, data }) {
  return (
    'UPDATE records SET status = ' + sqlValue(status) +
    ', title = ' + sqlValue(title) +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ';'
  );
}

function transaction(statements) {
  const sql = ['BEGIN IMMEDIATE;', ...statements, 'COMMIT;'].join('\n');
  try {
    runSql(sql);
  } catch (error) {
    try { runSql('ROLLBACK;'); } catch (_) { /* 连接已随子进程结束 */ }
    throw error;
  }
}

// 未结束的装箱单：草稿/已装箱/巡演中/待复核/返场清点中
const OPEN_STATUSES = ['草稿', '已装箱', '巡演中', '待复核', '返场清点中'];

function listOpenBoxes() {
  return listRecords(COLLECTION).filter((box) => OPEN_STATUSES.includes(box.status));
}

function listHeads() {
  return listRecords('puppetHeads');
}

function listAccessories() {
  return listRecords('accessories');
}

function getBox(id) {
  return getRecord(COLLECTION, id);
}

function getHead(id) {
  return getRecord('puppetHeads', id);
}

function getAccessory(id) {
  return getRecord('accessories', id);
}

function eventsOf(recordId) {
  return select(
    'SELECT * FROM events WHERE record_id = ' + sqlValue(recordId) + ' ORDER BY created_at ASC;'
  ).map((event) => ({
    id: event.id,
    action: event.action,
    status: event.status,
    actor: event.actor,
    note: event.note,
    data: JSON.parse(event.data || '{}'),
    createdAt: event.created_at
  }));
}

// 幂等记录：同一 scope + key 只保留首次结果，重放直接取用
function getIdempotent(scope, key) {
  const rows = select(
    'SELECT * FROM idempotency WHERE scope = ' + sqlValue(scope) + ' AND key = ' + sqlValue(key) + ' LIMIT 1;'
  );
  if (!rows[0]) return null;
  return { status: rows[0].status, body: JSON.parse(rows[0].body), replayed: true };
}

function putIdempotent(scope, key, status, body) {
  runSql(
    'INSERT OR IGNORE INTO idempotency (scope, key, status, body, created_at) VALUES (' +
    [
      sqlValue(scope),
      sqlValue(key),
      sqlValue(status),
      sqlValue(JSON.stringify(body)),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

module.exports = {
  COLLECTION,
  REVISION_COLLECTION,
  OPEN_STATUSES,
  listRecords,
  getRecord,
  listOpenBoxes,
  listHeads,
  listAccessories,
  getBox,
  getHead,
  getAccessory,
  eventsOf,
  insertEventSql,
  insertRecordSql,
  updateRecordSql,
  transaction,
  getIdempotent,
  putIdempotent
};

// 存储基础设施：SQLite 连接、建表与通用记录/履历读写
// 业务路由不直接碰 SQL，统一经由本模块和 tour/tourStore.js 完成。
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { randomUUID } = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const rawDb = new sqlite3.Database(DB_FILE);
rawDb.run('PRAGMA foreign_keys = ON;');
rawDb.run('PRAGMA journal_mode = WAL;');

// 统一转 Promise，参数一律走占位符，避免手工拼 SQL。
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    rawDb.run(sql, params, function done(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    rawDb.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    rawDb.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

// 事务块：fn 内全部走 tx（同一连接），抛错自动回滚。
async function tx(fn) {
  await run('BEGIN IMMEDIATE;');
  try {
    const result = await fn({ run, all, get });
    await run('COMMIT;');
    return result;
  } catch (error) {
    await run('ROLLBACK;');
    throw error;
  }
}

function now() {
  return new Date().toISOString();
}

function uuid() {
  return randomUUID();
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

// 通用集合的标题生成规则（与 project.config.js 的 titleFields 对应）
function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

async function insertEvent(database, { recordId, collection, action, status, actor, note, data }) {
  await database.run(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      uuid(),
      recordId,
      collection,
      action || '记录',
      status || '',
      actor || '',
      note || '',
      JSON.stringify(data || {}),
      now()
    ]
  );
}

async function loadRecord(database, collection, id) {
  const row = await database.get(
    'SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1;',
    [collection, id]
  );
  return row ? toRecord(row) : null;
}

async function saveRecord(database, collection, id, data, status, collectionConfig) {
  await database.run(
    'UPDATE records SET status = ?, title = ?, data = ?, updated_at = ? WHERE collection = ? AND id = ?;',
    [status, titleFor(collectionConfig, data), JSON.stringify(data), now(), collection, id]
  );
}

async function listByCollection(collection) {
  const rows = await all(
    'SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC;',
    [collection]
  );
  return rows.map(toRecord);
}

async function eventsFor(recordId) {
  const rows = await all(
    'SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC, rowid ASC;',
    [recordId]
  );
  return rows.map((event) => ({
    id: event.id,
    action: event.action,
    status: event.status,
    actor: event.actor,
    note: event.note,
    data: JSON.parse(event.data || '{}'),
    createdAt: event.created_at
  }));
}

async function initDb() {
  await run(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`);
  await run('CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);');
  await run('CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);');
  await run(`
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);`);
  await run('CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);');
  // 装箱登记提交台账：保证同 key 重放沿用首次判定结果（含被整单拒绝的提交）
  await run(`
CREATE TABLE IF NOT EXISTS packing_submissions (
  submit_key TEXT PRIMARY KEY,
  box_id TEXT,
  accepted INTEGER NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);`);
}

module.exports = {
  DB_FILE,
  run,
  all,
  get,
  tx,
  now,
  uuid,
  toRecord,
  titleFor,
  insertEvent,
  loadRecord,
  saveRecord,
  listByCollection,
  eventsFor,
  initDb
};

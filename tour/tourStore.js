// 巡演装箱记录存储：装箱单、提交台账、偶头/配件占用、修补流转与数量统计。
// 判定逻辑在 tourRules.js，HTTP 编排在 tourRoutes.js；本模块只负责落库与一致性。
const crypto = require('crypto');
const db = require('../lib/db');
const config = require('../project.config');

const BOX_COLLECTION = 'tourBoxes';
const HEAD_COLLECTION = 'puppetHeads';
const ACCESSORY_COLLECTION = 'accessories';
const REPAIR_COLLECTION = 'repairRecords';
const LOSS_COLLECTION = 'lossReports';

function boxConfig() {
  return config.collections[BOX_COLLECTION];
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

// 提交指纹：未显式给 submitKey 时，由箱单要素+明细稳定生成，保证重放命中首次结果
function fingerprint(body) {
  return crypto
    .createHash('sha256')
    .update(stableStringify({
      showName: body.showName,
      venue: body.venue,
      play: body.play,
      packedBy: body.packedBy,
      sealCode: body.sealCode || '',
      items: (body.items || []).map((i) => ({
        itemType: i.itemType,
        itemId: i.itemId,
        boxNo: i.boxNo,
        layer: i.layer,
        weightGrams: i.weightGrams
      }))
    }))
    .digest('hex');
}

async function getBox(database, id) {
  return db.loadRecord(database, BOX_COLLECTION, id);
}

async function listBoxes() {
  return db.listByCollection(BOX_COLLECTION);
}

// 快照：当前偶头/配件档案与全部未结束装箱单的占用情况，供判定模块使用。
// 事务内必须传入该事务连接，保证读到的是同一事务视图。
async function buildContext(database, selfBoxId) {
  const rowsByCollection = (name) =>
    database.all('SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC;', [name]).then((rows) => rows.map(db.toRecord));
  const [heads, accessories, boxes, repairs] = await Promise.all([
    rowsByCollection(HEAD_COLLECTION),
    rowsByCollection(ACCESSORY_COLLECTION),
    rowsByCollection(BOX_COLLECTION),
    rowsByCollection(REPAIR_COLLECTION)
  ]);
  const itemsById = { head: {}, accessory: {} };
  for (const head of heads) {
    itemsById.head[head.id] = {
      id: head.id,
      name: [head.role, head.play].filter(Boolean).join('/'),
      status: head.status,
      weightGrams: head.weightGrams
    };
  }
  for (const accessory of accessories) {
    itemsById.accessory[accessory.id] = {
      id: accessory.id,
      name: accessory.name,
      status: accessory.status,
      fragile: accessory.fragile === true
    };
  }
  const occupancy = {};
  for (const box of boxes) {
    if (box.id === selfBoxId) continue;
    if (!require('./tourRules').ACTIVE_BOX_STATUSES.includes(box.status)) continue;
    for (const item of box.items || []) {
      if (item.kind === 'head') {
        occupancy[item.itemId] = { boxId: box.id, showName: box.showName, status: box.status };
      }
    }
  }
  return {
    itemsById,
    occupancy,
    activeBoxes: boxes.filter((box) => require('./tourRules').ACTIVE_BOX_STATUSES.includes(box.status)),
    openRepairs: repairs
  };
}

async function findSubmission(database, submitKey) {
  return database.get('SELECT * FROM packing_submissions WHERE submit_key = ? LIMIT 1;', [submitKey]);
}

async function rememberSubmission(database, { submitKey, boxId, accepted, status, response }) {
  await database.run(
    'INSERT OR REPLACE INTO packing_submissions (submit_key, box_id, accepted, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?);',
    [submitKey, boxId, accepted ? 1 : 0, status, JSON.stringify(response), db.now()]
  );
}

// 装箱单落库（含 headIds/accessoryIds 冗余字段，保持与既有集合字段一致）
async function insertBox(database, payload) {
  const id = db.uuid();
  const now = db.now();
  const headIds = payload.items.filter((i) => i.kind === 'head').map((i) => i.itemId);
  const accessoryIds = payload.items.filter((i) => i.kind === 'accessory').map((i) => i.itemId);
  const data = {
    showName: payload.showName,
    venue: payload.venue,
    play: payload.play,
    status: '已装箱',
    items: payload.items,
    headIds,
    accessoryIds,
    packedBy: payload.packedBy || '',
    sealCode: payload.sealCode || null,
    boxWeightLimits: payload.limitsByBox || {},
    qualification: payload.qualification,
    findings: [],
    returnConfirmations: [],
    positionRestored: false,
    releasedAt: null,
    revisionHistory: [],
    createdAtBy: payload.packedBy || ''
  };
  await database.run(
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
    [id, BOX_COLLECTION, '已装箱', db.titleFor(boxConfig(), data), JSON.stringify(data), now, now]
  );
  await db.insertEvent(database, {
    recordId: id,
    collection: BOX_COLLECTION,
    action: '装箱登记',
    status: '已装箱',
    actor: payload.packedBy || '',
    note: payload.note || '登记箱号、层位与单件克重，校验通过',
    data: {
      itemCount: payload.items.length,
      submitKey: payload.submitKey,
      totalGramsByBox: payload.items.reduce((acc, item) => {
        acc[item.boxNo] = (acc[item.boxNo] || 0) + item.weightGrams;
        return acc;
      }, {})
    }
  });
  // 占用：偶头/配件物理状态同步为已装箱
  for (const itemId of headIds) {
    const head = await db.loadRecord(database, HEAD_COLLECTION, itemId);
    if (head) {
      const next = { ...head, status: '已装箱', currentUsable: false };
      deleteMeta(next);
      await db.saveRecord(database, HEAD_COLLECTION, itemId, next, '已装箱', config.collections[HEAD_COLLECTION]);
    }
  }
  for (const itemId of accessoryIds) {
    const accessory = await db.loadRecord(database, ACCESSORY_COLLECTION, itemId);
    if (accessory) {
      const next = { ...accessory, status: '已装箱' };
      deleteMeta(next);
      await db.saveRecord(database, ACCESSORY_COLLECTION, itemId, next, '已装箱', config.collections[ACCESSORY_COLLECTION]);
    }
  }
  return id;
}

function deleteMeta(record) {
  delete record.id;
  delete record.collection;
  delete record.createdAt;
  delete record.updatedAt;
}

async function updateBoxData(database, id, mutator, event) {
  const box = await getBox(database, id);
  if (!box) return null;
  const nextData = { ...box };
  deleteMeta(nextData);
  await mutator(nextData, box);
  const status = nextData.status;
  await db.saveRecord(database, BOX_COLLECTION, id, nextData, status, boxConfig());
  if (event) {
    await db.insertEvent(database, {
      recordId: id,
      collection: BOX_COLLECTION,
      action: event.action,
      status,
      actor: event.actor || '',
      note: event.note || '',
      data: event.data || {}
    });
  }
  return getBox(database, id);
}

// 解封：解除占用，偶头回可演出、配件回在库，装箱单闭环
async function releaseBox(database, id, actor, note) {
  const box = await getBox(database, id);
  const headIds = (box.items || []).filter((i) => i.kind === 'head').map((i) => i.itemId);
  const accessoryIds = (box.items || []).filter((i) => i.kind === 'accessory').map((i) => i.itemId);
  for (const itemId of headIds) {
    const head = await db.loadRecord(database, HEAD_COLLECTION, itemId);
    if (head) {
      const next = { ...head, status: '可演出', currentUsable: true };
      deleteMeta(next);
      await db.saveRecord(database, HEAD_COLLECTION, itemId, next, '可演出', config.collections[HEAD_COLLECTION]);
    }
  }
  for (const itemId of accessoryIds) {
    const accessory = await db.loadRecord(database, ACCESSORY_COLLECTION, itemId);
    if (accessory && accessory.status === '已装箱') {
      const next = { ...accessory, status: '在库' };
      deleteMeta(next);
      await db.saveRecord(database, ACCESSORY_COLLECTION, itemId, next, '在库', config.collections[ACCESSORY_COLLECTION]);
    }
  }
  const released = await updateBoxData(database, id, (data) => {
    data.status = '已闭环';
    data.releasedAt = db.now();
  }, { action: '解封闭环', actor, note: note || '修补完成且位置复位，解除占用', data: { headIds, accessoryIds } });
  return released;
}

async function addRepair(database, { boxId, puppetHeadId, repairType, handler, note, actor, status }) {
  const id = db.uuid();
  const now = db.now();
  const recordStatus = status || '待处理';
  const data = { puppetHeadId, repairType, handler, note: note || '', tourBoxId: boxId || null, status: recordStatus };
  await database.run(
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
    [id, REPAIR_COLLECTION, recordStatus, db.titleFor(config.collections[REPAIR_COLLECTION], data), JSON.stringify(data), now, now]
  );
  await db.insertEvent(database, {
    recordId: id,
    collection: REPAIR_COLLECTION,
    action: '登记修补',
    status: recordStatus,
    actor: actor || handler || '',
    note: note || '',
    data: { tourBoxId: boxId || null }
  });
  // 箱内偶头进入修补：档案同步为待修补
  if (boxId) {
    const head = await db.loadRecord(database, HEAD_COLLECTION, puppetHeadId);
    if (head) {
      const next = { ...head, status: '待修补', currentUsable: false };
      deleteMeta(next);
      await db.saveRecord(database, HEAD_COLLECTION, puppetHeadId, next, '待修补', config.collections[HEAD_COLLECTION]);
    }
    await db.insertEvent(database, {
      recordId: boxId,
      collection: BOX_COLLECTION,
      action: '转修补',
      actor: actor || handler || '',
      note: '偶头 ' + puppetHeadId + ' 登记修补（' + repairType + '）',
      data: { repairId: id, puppetHeadId, repairType }
    });
  }
  return db.loadRecord(database, REPAIR_COLLECTION, id);
}

// 修补状态推进；已完成时偶头恢复可演出（是否解封仍由装箱单闸门决定）
async function updateRepair(database, id, { status, handler, actor, note, fields }) {
  const repair = await db.loadRecord(database, REPAIR_COLLECTION, id);
  if (!repair) return null;
  const next = { ...repair, ...(fields || {}), status: status || repair.status };
  if (handler !== undefined) next.handler = handler;
  deleteMeta(next);
  await db.saveRecord(database, REPAIR_COLLECTION, id, next, next.status, config.collections[REPAIR_COLLECTION]);
  await db.insertEvent(database, {
    recordId: id,
    collection: REPAIR_COLLECTION,
    action: '修补进度',
    status: next.status,
    actor: actor || '',
    note: note || '',
    data: { status: next.status }
  });
  if (next.status === '已完成' && next.puppetHeadId) {
    const head = await db.loadRecord(database, HEAD_COLLECTION, next.puppetHeadId);
    if (head && head.status === '待修补') {
      const headNext = { ...head, status: '可演出', currentUsable: true };
      deleteMeta(headNext);
      await db.saveRecord(database, HEAD_COLLECTION, next.puppetHeadId, headNext, '可演出', config.collections[HEAD_COLLECTION]);
    }
  }
  return db.loadRecord(database, REPAIR_COLLECTION, id);
}

// 数量刷新：装箱、履历与本统计同源同事务，刷新后一致
async function refreshCounts(database) {
  const collections = [HEAD_COLLECTION, ACCESSORY_COLLECTION, REPAIR_COLLECTION, BOX_COLLECTION, LOSS_COLLECTION];
  const counts = {};
  for (const name of collections) {
    const rows = await database.all('SELECT status, COUNT(*) AS count FROM records WHERE collection = ? GROUP BY status;', [name]);
    counts[name] = { total: rows.reduce((sum, row) => sum + row.count, 0), byStatus: {} };
    for (const row of rows) counts[name].byStatus[row.status] = row.count;
  }
  const heads = await db.listByCollection(HEAD_COLLECTION);
  const accessories = await db.listByCollection(ACCESSORY_COLLECTION);
  const boxes = await db.listByCollection(BOX_COLLECTION);
  const occupiedHeadIds = new Set();
  const occupiedAccessoryIds = new Set();
  for (const box of boxes) {
    if (!require('./tourRules').ACTIVE_BOX_STATUSES.includes(box.status)) continue;
    for (const item of box.items || []) {
      if (item.kind === 'head') occupiedHeadIds.add(item.itemId);
      else occupiedAccessoryIds.add(item.itemId);
    }
  }
  counts.tour = {
    activeBoxes: boxes.filter((b) => require('./tourRules').ACTIVE_BOX_STATUSES.includes(b.status)).length,
    closedBoxes: counts[BOX_COLLECTION].byStatus['已闭环'] || 0,
    occupiedHeads: occupiedHeadIds.size,
    occupiedAccessories: occupiedAccessoryIds.size,
    freeHeads: heads.filter((h) => h.status === '可演出').length,
    fragileInBox: accessories.filter((a) => a.fragile === true && occupiedAccessoryIds.has(a.id)).length
  };
  return { refreshedAt: db.now(), counts };
}

module.exports = {
  BOX_COLLECTION,
  HEAD_COLLECTION,
  ACCESSORY_COLLECTION,
  REPAIR_COLLECTION,
  fingerprint,
  getBox,
  listBoxes,
  buildContext,
  findSubmission,
  rememberSubmission,
  insertBox,
  updateBoxData,
  releaseBox,
  addRepair,
  updateRepair,
  refreshCounts
};

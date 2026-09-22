const express = require('express');
const config = require('./project.config');
const db = require('./lib/db');
const tourRouter = require('./tour/tourRoutes');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function seedDatabase() {
  const row = await db.get('SELECT COUNT(*) AS count FROM records;');
  if (row.count > 0) return;

  for (const seedItem of config.seed || []) {
    const collectionConfig = findCollection(seedItem.collection);
    const id = seedItem.id || db.uuid();
    const createdAt = seedItem.createdAt || db.now();
    const status = seedItem.status || collectionConfig.defaultStatus || '';
    const data = { ...seedItem.data, status };
    await db.run(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
      [
        id,
        seedItem.collection,
        status,
        db.titleFor(collectionConfig, data),
        JSON.stringify(data),
        createdAt,
        seedItem.updatedAt || createdAt
      ]
    );
    await db.insertEvent(db, {
      recordId: id,
      collection: seedItem.collection,
      action: seedItem.eventAction || '创建',
      status,
      actor: seedItem.actor || 'system',
      note: seedItem.note || '',
      data
    });
  }
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

async function start() {
  await db.initDb();
  await seedDatabase();

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: config.title, port: PORT });
  });

  app.get('/api/meta', (req, res) => {
    res.json({
      title: config.title,
      description: config.description,
      collections: config.collections,
      tourRules: config.tourRules,
      examples: config.examples || []
    });
  });

  // 巡演业务：配重分层登记 + 到场待复核 + 返场解封台
  // 路由（tourRoutes）、判定（tourRules）、记录存储（tourStore）三层拆分
  app.use('/api/tour', tourRouter);

  app.get('/api/:collection', asyncHandler(async (req, res) => {
    findCollection(req.params.collection);
    const records = await db.listByCollection(req.params.collection);
    const filtered = applyQuery(records, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  }));

  app.post('/api/:collection', asyncHandler(async (req, res) => {
    const collectionConfig = findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);
    const id = db.uuid();
    const createdAt = db.now();
    await db.run(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
      [
        id,
        req.params.collection,
        status,
        db.titleFor(collectionConfig, data),
        JSON.stringify(data),
        createdAt,
        createdAt
      ]
    );
    await db.insertEvent(db, {
      recordId: id,
      collection: req.params.collection,
      action: req.body.action || '创建',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data
    });
    res.status(201).json(await db.loadRecord(db, req.params.collection, id));
  }));

  app.get('/api/:collection/:id', asyncHandler(async (req, res) => {
    findCollection(req.params.collection);
    const record = await db.loadRecord(db, req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  }));

  app.patch('/api/:collection/:id', asyncHandler(async (req, res) => {
    const collectionConfig = findCollection(req.params.collection);
    const record = await db.loadRecord(db, req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    await db.saveRecord(db, req.params.collection, req.params.id, nextData, status, collectionConfig);
    await db.insertEvent(db, {
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || '更新',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(await db.loadRecord(db, req.params.collection, req.params.id));
  }));

  app.post('/api/:collection/:id/events', asyncHandler(async (req, res) => {
    const collectionConfig = findCollection(req.params.collection);
    const record = await db.loadRecord(db, req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    await db.saveRecord(db, req.params.collection, req.params.id, nextData, status, collectionConfig);
    await db.insertEvent(db, {
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || status || '记录',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(await db.loadRecord(db, req.params.collection, req.params.id));
  }));

  app.get('/api/:collection/:id/timeline', asyncHandler(async (req, res) => {
    findCollection(req.params.collection);
    const record = await db.loadRecord(db, req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = await db.eventsFor(req.params.id);
    res.json({ record, events });
  }));

  app.delete('/api/:collection/:id', asyncHandler(async (req, res) => {
    findCollection(req.params.collection);
    await db.tx(async (database) => {
      await database.run('DELETE FROM records WHERE collection = ? AND id = ?;', [req.params.collection, req.params.id]);
      await database.run('DELETE FROM events WHERE record_id = ?;', [req.params.id]);
    });
    res.status(204).end();
  }));

  app.use((error, req, res, next) => {
    const status = error.status || error.code || 500;
    const body = { error: error.message || 'server error' };
    if (error.codeText) body.code = error.codeText;
    if (error.detail !== undefined) body.detail = error.detail;
    res.status(status).json(body);
  });

  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
}

start().catch((error) => {
  console.error('failed to start service:', error);
  process.exit(1);
});

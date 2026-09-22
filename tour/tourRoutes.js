// 巡演装箱路由层：偶头配重分层 + 返场解封台。
// 只做 HTTP 编排与状态码映射；规则判定见 tourRules.js，落库见 tourStore.js。
const express = require('express');
const db = require('../lib/db');
const config = require('../project.config');
const rules = require('./tourRules');
const store = require('./tourStore');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireActor(body) {
  if (!body.actor || String(body.actor).trim() === '') {
    throw rules.ruleError(400, 'MISSING_ACTOR', '该操作必须提供操作人 actor');
  }
  return String(body.actor).trim();
}

function assertBoxStatus(box, allowed, hint) {
  if (!allowed.includes(box.status)) {
    throw rules.ruleError(409, 'BAD_BOX_STATUS', (hint || '当前装箱单状态不允许该操作') + '：' + box.status, {
      status: box.status,
      allowed
    });
  }
}

// 达到两次确认后尝试解封；闸门不过则保持返场清点中并回执原因
async function tryRelease(database, box, actor, note) {
  const context = await store.buildContext(database, box.id);
  const verdict = rules.evaluateRelease(box, context);
  if (!verdict.releasable) return { released: false, blockers: verdict.blockers };
  const released = await store.releaseBox(database, box.id, actor, note);
  return { released: true, box: released };
}

// 登记装箱：箱号、层位、单件克重；超重或重压脆整单拒绝；重放沿用首次结果
router.post('/packing', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const actor = requireActor(body);
  for (const field of ['showName', 'venue', 'play']) {
    if (!body[field]) throw rules.ruleError(400, 'MISSING_FIELD', '缺少必填字段：' + field);
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw rules.ruleError(400, 'MISSING_ITEMS', 'items 必须是非空明细数组（itemType/itemId/boxNo/layer/weightGrams）');
  }
  const submitKey = body.submitKey ? String(body.submitKey) : 'fp:' + store.fingerprint(body);

  // 重放：同一提交键直接沿用首次结果（无论首次通过还是整单拒绝），不再产生任何写入
  const existing = await db.get('SELECT * FROM packing_submissions WHERE submit_key = ? LIMIT 1;', [submitKey]);
  if (existing) {
    const payload = JSON.parse(existing.response);
    return res.status(existing.status).json({ replayed: true, ...payload });
  }

  let result;
  try {
    result = await db.tx(async (database) => {
      const context = await store.buildContext(database, null);
      const { items, qualification } = rules.evaluatePacking(body.items, context.itemsById, { occupancy: context.occupancy });
      if (!qualification.packingEligible) {
        const conflict = qualification.errors.find((e) => e.code === 409);
        const first = conflict || qualification.errors[0];
        await store.rememberSubmission(database, {
          submitKey,
          boxId: null,
          accepted: false,
          status: first.code,
          response: {
            error: first.message,
            code: first.codeText,
            rejected: true,
            reasons: qualification.reasons,
            violations: qualification.errors.map((e) => ({ code: e.codeText, message: e.message, detail: e.detail }))
          }
        });
        return { rejected: true, status: first.code, body: { error: first.message, code: first.codeText, reasons: qualification.reasons } };
      }
      const limitsByBox = {};
      for (const item of body.items) {
        const boxNo = String(item.boxNo).trim();
        if (item.boxWeightLimitGrams !== undefined && item.boxWeightLimitGrams !== null && item.boxWeightLimitGrams !== '') {
          limitsByBox[boxNo] = Number(item.boxWeightLimitGrams);
        }
      }
      const boxId = await store.insertBox(database, {
        showName: body.showName,
        venue: body.venue,
        play: body.play,
        items,
        limitsByBox,
        packedBy: actor,
        sealCode: body.sealCode || null,
        qualification,
        submitKey,
        note: body.note
      });
      await store.rememberSubmission(database, {
        submitKey,
        boxId,
        accepted: true,
        status: 201,
        response: { accepted: true, boxId }
      });
      return { rejected: false, boxId };
    });
  } catch (error) {
    // 字段级 400 不进入拒绝台账，允许修正报文后重试；事务已整体回滚，无半成品
    if (error.code === 400) return res.status(400).json({ error: error.message, code: error.codeText, detail: error.detail });
    throw error;
  }

  if (result.rejected) {
    return res.status(result.status).json(result.body);
  }
  const box = await store.getBox(db, result.boxId);
  return res.status(201).json({ accepted: true, boxId: result.boxId, box });
}));

// 装箱单列表
router.get('/boxes', asyncHandler(async (req, res) => {
  res.json(await store.listBoxes());
}));

router.get('/boxes/:id', asyncHandler(async (req, res) => {
  const box = await store.getBox(db, req.params.id);
  if (!box) return res.status(404).json({ error: '装箱单不存在' });
  res.json(box);
}));

// 分层布局：按箱号、层位（自下而上）查看
router.get('/boxes/:id/layout', asyncHandler(async (req, res) => {
  const box = await store.getBox(db, req.params.id);
  if (!box) return res.status(404).json({ error: '装箱单不存在' });
  const byBox = {};
  for (const item of box.items || []) {
    if (!byBox[item.boxNo]) byBox[item.boxNo] = [];
    byBox[item.boxNo].push({
      boxNo: item.boxNo,
      itemType: item.kind,
      itemId: item.itemId,
      name: item.name,
      layer: item.layer,
      weightGrams: item.weightGrams,
      heavy: rules.isHeavyHead(item),
      fragile: rules.isFragile(item)
    });
  }
  for (const boxNo of Object.keys(byBox)) {
    byBox[boxNo].sort((a, b) => a.layer - b.layer);
  }
  res.json({ boxId: box.id, showName: box.showName, status: box.status, byBox });
}));

// 到场核验：错层或封签不符“只转待复核”，不做任何占用/资格变动
router.post('/boxes/:id/arrival', asyncHandler(async (req, res) => {
  const actor = requireActor(req.body);
  const box = await store.getBox(db, req.params.id);
  if (!box) return res.status(404).json({ error: '装箱单不存在' });
  assertBoxStatus(box, ['已装箱', '巡演中', '待复核'], '到场核验仅在到场阶段进行');
  const verdict = rules.evaluateArrival(box, req.body || {});
  const updated = await db.tx((database) =>
    store.updateBoxData(database, box.id, (data) => {
      data.findings = verdict.findings;
      data.lastArrivalAt = db.now();
      if (verdict.needsReview) {
        data.status = '待复核';
      } else if (data.status === '已装箱' || data.status === '待复核') {
        // 复检通过：无论首次到场还是待复核后的重新核验，都恢复巡演
        data.status = '巡演中';
      }
    }, {
      action: verdict.needsReview ? '到场转待复核' : '到场核验无误',
      actor,
      note: verdict.needsReview ? verdict.findings.map((f) => f.message).join('；') : '层位与封签均相符',
      data: { findings: verdict.findings }
    })
  );
  res.json({ needsReview: verdict.needsReview, findings: verdict.findings, box: updated });
}));

// 解封台：核验解封资格（配重/层位更正后须重算通过），通过后进入返场清点
router.post('/boxes/:id/unseal', asyncHandler(async (req, res) => {
  const actor = requireActor(req.body);
  const box = await store.getBox(db, req.params.id);
  if (!box) return res.status(404).json({ error: '装箱单不存在' });
  assertBoxStatus(box, ['已装箱', '巡演中', '待复核', '返场清点中'], '当前状态不能申请解封');
  if (!box.qualification || box.qualification.unsealEligible !== true) {
    throw rules.ruleError(409, 'UNSEAL_QUALIFICATION_INVALID', '解封资格已失效：配重或层位更正后未按新值重算通过', {
      reasons: box.qualification ? box.qualification.reasons : []
    });
  }
  const updated = await db.tx((database) =>
    store.updateBoxData(database, box.id, (data) => {
      if (data.status !== '返场清点中') data.status = '返场清点中';
      data.unsealedAt = db.now();
    }, { action: '解封入返场清点', actor, note: '解封资格有效，开箱进入返场清点', data: {} })
  );
  res.json({ unsealEligible: true, box: updated });
}));

// 返场清点：装箱人之外的另一人连续两次确认；换人则从头计
router.post('/boxes/:id/return-confirm', asyncHandler(async (req, res) => {
  const actor = requireActor(req.body);
  const box = await store.getBox(db, req.params.id);
  if (!box) return res.status(404).json({ error: '装箱单不存在' });
  assertBoxStatus(box, ['返场清点中'], '须先解封进入返场清点才能做返场确认');
  const verdict = rules.evaluateReturnConfirm(box, actor);

  const outcome = await db.tx(async (database) => {
    let resetNote = '';
    const updated = await store.updateBoxData(database, box.id, (data) => {
      data.returnConfirmations = Array.isArray(data.returnConfirmations) ? data.returnConfirmations : [];
      if (verdict.resetByOther) {
        data.returnConfirmations = [];
        resetNote = '确认人变更，此前连续确认作废，重新计数';
      }
      data.returnConfirmations.push({ actor, at: db.now(), note: (req.body && req.body.note) || '' });
    }, {
      action: verdict.resetByOther ? '返场确认换人重置' : '返场清点确认',
      actor,
      note: resetNote || ((req.body && req.body.note) || ''),
      data: { resetByOther: verdict.resetByOther }
    });
    if (updated.returnConfirmations.length >= 2) {
      const release = await tryRelease(database, updated, actor, '返场两次连续确认完成');
      return { box: release.released ? release.box : updated, release };
    }
    const remaining = 2 - updated.returnConfirmations.length;
    return { box: updated, release: { released: false, blockers: [{ code: 'CONFIRMATION_INCOMPLETE', message: '还需同一人再确认 ' + remaining + ' 次' }] } };
  });
  res.json({
    confirmations: outcome.box.returnConfirmations.length,
    released: outcome.release.released,
    blockers: outcome.release.released ? [] : outcome.release.blockers,
    box: outcome.box
  });
}));

// 修补登记：箱内偶头返场发现问题时流转到修补记录
router.post('/boxes/:id/repairs', asyncHandler(async (req, res) => {
  const actor = requireActor(req.body);
  const box = await store.getBox(db, req.params.id);
  if (!box) return res.status(404).json({ error: '装箱单不存在' });
  assertBoxStatus(box, ['待复核', '返场清点中'], '仅到场待复核或返场清点阶段可登记修补');
  const headId = req.body.puppetHeadId;
  const inBox = (box.items || []).some((item) => item.kind === 'head' && item.itemId === headId);
  if (!inBox) throw rules.ruleError(409, 'HEAD_NOT_IN_BOX', '该偶头不在本装箱单内：' + headId);
  if (!req.body.repairType) throw rules.ruleError(400, 'MISSING_FIELD', '缺少 repairType');
  if (req.body.status && !config.collections[store.REPAIR_COLLECTION].statuses.includes(req.body.status)) {
    throw rules.ruleError(400, 'INVALID_REPAIR_STATUS', '非法修补状态：' + req.body.status);
  }
  const repair = await db.tx((database) =>
    store.addRepair(database, {
      boxId: box.id,
      puppetHeadId: headId,
      repairType: req.body.repairType,
      handler: req.body.handler || actor,
      note: req.body.note,
      actor,
      status: req.body.status
    })
  );
  res.status(201).json(repair);
}));

// 修补进度（完成时偶头恢复可演出，并尝试解封原箱）
router.patch('/repairs/:id', asyncHandler(async (req, res) => {
  const actor = requireActor(req.body);
  if (req.body.status && !config.collections[store.REPAIR_COLLECTION].statuses.includes(req.body.status)) {
    throw rules.ruleError(400, 'INVALID_REPAIR_STATUS', '非法修补状态：' + req.body.status);
  }
  const repair = await db.tx(async (database) => {
    const updated = await store.updateRepair(database, req.params.id, {
      status: req.body.status,
      handler: req.body.handler,
      actor,
      note: req.body.note,
      fields: req.body.fields
    });
    return updated;
  });
  if (!repair) return res.status(404).json({ error: '修补记录不存在' });
  let release = null;
  if (repair.status === '已完成' && repair.tourBoxId) {
    const outcome = await db.tx(async (database) => {
      const box = await store.getBox(database, repair.tourBoxId);
      if (!box || box.status !== '返场清点中') return { skipped: true };
      return tryRelease(database, box, actor, '修补完成触发解封检查');
    });
    release = outcome;
  }
  res.json({ repair, release });
}));

// 箱内位置复位：可随报实际位置逐件核对，核对通过才置位
router.post('/boxes/:id/restore', asyncHandler(async (req, res) => {
  const actor = requireActor(req.body);
  const box = await store.getBox(db, req.params.id);
  if (!box) return res.status(404).json({ error: '装箱单不存在' });
  assertBoxStatus(box, ['返场清点中'], '仅返场清点阶段可复位箱内位置');
  const positions = Array.isArray(req.body.positions) ? req.body.positions : null;
  if (positions) {
    const registered = new Map((box.items || []).map((item) => [item.kind + ':' + item.itemId, item]));
    const mismatches = [];
    for (const pos of positions) {
      const kind = pos.itemType === 'head' ? 'head' : pos.itemType === 'accessory' ? 'accessory' : null;
      const item = kind && registered.get(kind + ':' + pos.itemId);
      if (!item) {
        mismatches.push({ itemId: pos.itemId, message: '不在本装箱单内' });
        continue;
      }
      if (Number(pos.layer) !== item.layer || String(pos.boxNo) !== String(item.boxNo)) {
        mismatches.push({
          itemId: pos.itemId,
          message: '位置未复位：应为 箱' + item.boxNo + '/层' + item.layer + '，实为 箱' + pos.boxNo + '/层' + pos.layer
        });
      }
    }
    if (mismatches.length) {
      throw rules.ruleError(422, 'POSITION_MISMATCH', '箱内位置尚未复位，不能解除占用', { mismatches });
    }
  }
  const outcome = await db.tx(async (database) => {
    const updated = await store.updateBoxData(database, box.id, (data) => {
      data.positionRestored = true;
      data.restoredAt = db.now();
    }, { action: '箱内位置复位', actor, note: (req.body && req.body.note) || '逐件核对，位置复位', data: {} });
    const release = await tryRelease(database, updated, actor, '位置复位触发解封检查');
    return { box: release.released ? release.box : updated, release };
  });
  res.json({ positionRestored: true, released: outcome.release.released, blockers: outcome.release.released ? [] : outcome.release.blockers, box: outcome.box });
}));

// 更正配重或层位：解封与装箱资格失效并按新值重算，旧稿留档，返场确认与复位一并作废
router.post('/boxes/:id/correct', asyncHandler(async (req, res) => {
  const actor = requireActor(req.body);
  const box = await store.getBox(db, req.params.id);
  if (!box) return res.status(404).json({ error: '装箱单不存在' });
  assertBoxStatus(box, ['已装箱', '巡演中', '待复核', '返场清点中'], '已闭环装箱单不能更正');
  if (!Array.isArray(req.body.items) || req.body.items.length === 0) {
    throw rules.ruleError(400, 'MISSING_ITEMS', '更正须提供 items（至少含 itemType/itemId 与新的 weightGrams 或 layer 或 boxNo）');
  }
  const outcome = await db.tx(async (database) => {
    const context = await store.buildContext(database, box.id);
    // 以旧明细为底，用更正项覆盖，保持全量重算
    const merged = new Map((box.items || []).map((item) => [item.kind + ':' + item.itemId, {
      itemType: item.kind,
      itemId: item.itemId,
      boxNo: item.boxNo,
      layer: item.layer,
      weightGrams: item.weightGrams
    }]));
    for (const patch of req.body.items) {
      const kind = patch.itemType === 'head' ? 'head' : patch.itemType === 'accessory' ? 'accessory' : null;
      if (!kind) throw rules.ruleError(400, 'BAD_ITEM_TYPE', 'itemType 必须是 head 或 accessory', patch);
      const key = kind + ':' + patch.itemId;
      const base = merged.get(key);
      if (!base) throw rules.ruleError(404, 'ITEM_NOT_IN_BOX', '该物件不在本装箱单内，不可随单更正：' + patch.itemId);
      merged.set(key, {
        itemType: kind,
        itemId: patch.itemId,
        boxNo: patch.boxNo !== undefined ? patch.boxNo : base.boxNo,
        layer: patch.layer !== undefined ? patch.layer : base.layer,
        weightGrams: patch.weightGrams !== undefined ? patch.weightGrams : base.weightGrams
      });
    }
    const { items, qualification } = rules.evaluateCorrection(box, Array.from(merged.values()), context.itemsById, {
      occupancy: context.occupancy,
      // 保留此前各箱上限，再叠加本次提交的覆盖值
      limitsByBox: { ...(box.boxWeightLimits || {}), ...(req.body.boxWeightLimits || {}) }
    });
    const updated = await store.updateBoxData(database, box.id, (data) => {
      // 旧稿留档：更正前的明细与资格完整快照
      data.revisionHistory = Array.isArray(data.revisionHistory) ? data.revisionHistory : [];
      data.revisionHistory.push({
        revisedAt: db.now(),
        actor,
        reason: req.body.reason || '更正配重或层位',
        items: data.items,
        qualification: data.qualification,
        findings: data.findings
      });
      data.items = items;
      data.headIds = items.filter((i) => i.kind === 'head').map((i) => i.itemId);
      data.accessoryIds = items.filter((i) => i.kind === 'accessory').map((i) => i.itemId);
      if (req.body.boxWeightLimits && typeof req.body.boxWeightLimits === 'object') {
        data.boxWeightLimits = { ...(data.boxWeightLimits || {}), ...req.body.boxWeightLimits };
      }
      // 资格失效后按新值重算的结论直接生效；解封须重新满足
      data.qualification = qualification;
      data.returnConfirmations = [];
      data.positionRestored = false;
      data.restoredAt = null;
      if (!qualification.unsealEligible && data.status !== '待复核') data.status = '待复核';
    }, {
      action: '更正配重/层位并重算',
      actor,
      note: '旧稿已留档（revision ' + ((box.qualification && box.qualification.revision) || 0) + '），资格按新值重算：' +
        (qualification.packingEligible ? '通过' : '不通过'),
      data: {
        packingEligible: qualification.packingEligible,
        unsealEligible: qualification.unsealEligible,
        revision: qualification.revision,
        reasons: qualification.reasons
      }
    });
    return { box: updated, qualification };
  });
  res.json({
    revision: outcome.qualification.revision,
    packingEligible: outcome.qualification.packingEligible,
    unsealEligible: outcome.qualification.unsealEligible,
    reasons: outcome.qualification.reasons,
    archivedRevisions: (outcome.box.revisionHistory || []).length,
    box: outcome.box
  });
}));

// 数量刷新：装箱/履历/数量一致视图（与记录同库实时聚合）
router.get('/overview', asyncHandler(async (req, res) => {
  const result = await db.tx((database) => store.refreshCounts(database));
  res.json(result);
}));

module.exports = router;

// 巡演装箱 · 路由层
// 只做 HTTP 编排：参数解析 → 调用判定层 → 调用存储层落库。
const express = require('express');
const { randomUUID } = require('crypto');
const {
  COLLECTION,
  REVISION_COLLECTION,
  OPEN_STATUSES,
  listOpenBoxes,
  listHeads,
  listAccessories,
  listRecords,
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
} = require('./store');
const {
  httpError,
  withSummary,
  normalizeItems,
  evaluatePacking,
  findHeadConflicts,
  inspectArrival,
  applyReturnConfirm,
  releaseBlockers,
  checkPositionReset,
  applyCorrection
} = require('./rules');

function buildRouter(config) {
  const tourConfig = config.tour;
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  function idempotencyKey(req, scope) {
    const key = req.header('Idempotency-Key') || req.header('X-Idempotency-Key') ||
      (req.body && (req.body.requestId || req.body.idempotencyKey));
    return key ? { scope, key: String(key) } : null;
  }

  function requireActor(body) {
    const actor = String((body && body.actor) || '').trim();
    if (!actor) throw httpError(400, 'ACTOR_REQUIRED', 'actor（操作人）必填');
    return actor;
  }

  function loadBoxOr404(id) {
    const box = getBox(id);
    if (!box) throw httpError(404, 'NOT_FOUND', '装箱单不存在: ' + id);
    return box;
  }

  function assertStatus(box, allowed, code) {
    if (!allowed.includes(box.status)) {
      throw httpError(409, code || 'INVALID_STATUS', '当前状态「' + box.status + '」不允许此操作，允许状态：' + allowed.join('、'), {
        currentStatus: box.status,
        allowedStatuses: allowed
      });
    }
  }

  function headMap() {
    return Object.fromEntries(listHeads().map((head) => [head.id, head]));
  }

  function accessoryMap() {
    return Object.fromEntries(listAccessories().map((accessory) => [accessory.id, accessory]));
  }

  function saveBoxMutations(statements, box, event) {
    statements.push(updateRecordSql({
      id: box.id,
      collection: COLLECTION,
      status: box.status,
      title: [box.showName, box.play].filter(Boolean).join(' / '),
      data: box
    }));
    statements.push(insertEventSql({
      recordId: box.id,
      collection: COLLECTION,
      action: event.action,
      status: box.status,
      actor: event.actor,
      note: event.note || '',
      data: event.data || {}
    }));
  }

  function errorBody(error) {
    return { error: error.message || 'server error', code: error.code };
  }

  // 业务路由包装：首次最终响应（2xx/409/422 等）按幂等键记忆；重放沿用首次状态码与响应体。
  // 400（请求格式问题）不记忆，允许客户端改正后用同键重试。
  function businessRoute(scope, handler) {
    return (req, res, next) => {
      try {
        const idem = idempotencyKey(req, scope.includes(':') ? scope.replace(':id', req.params.id) : scope);
        if (idem) {
          const seen = getIdempotent(idem.scope, idem.key);
          if (seen) {
            res.setHeader('Idempotency-Replayed', 'true');
            return res.status(seen.status).json(seen.body);
          }
        }
        const reply = (status, body) => {
          if (idem && status !== 400) putIdempotent(idem.scope, idem.key, status, body);
          res.status(status).json(body);
        };
        const ctx = { reply, params: req.params, body: req.body || {}, headers: req.headers };
        const result = handler(ctx);
        if (result !== undefined) reply(200, result);
      } catch (error) {
        // 首次业务拒绝（4xx，除 400 参数错误）同样按幂等键记忆，重放沿用首次结果
        const idem = idempotencyKey(req, scope.includes(':') ? scope.replace(':id', req.params.id) : scope);
        const status = error.status || 500;
        if (idem && status >= 401 && status < 500) {
          putIdempotent(idem.scope, idem.key, status, errorBody(error));
        }
        next(error);
      }
    };
  }

  // 1. 装箱登记：箱号、层位、单件克重；超限或重压脆整单拒绝；偶头唯一冲突 409
  router.post('/tourBoxes/pack', businessRoute('pack', ({ body, reply }) => {
    const actor = requireActor(body);
    const showName = String(body.showName || '').trim();
    const venue = String(body.venue || '').trim();
    const play = String(body.play || '').trim();
    if (!showName || !venue || !play) {
      throw httpError(400, 'MISSING_FIELDS', 'showName、venue、play 必填');
    }

    const items = normalizeItems(body.items, tourConfig);
    const heads = headMap();
    const accessories = accessoryMap();

    // 偶头在未结束装箱单中只能出现一次 —— 409，且不产生半成品
    const conflicts = findHeadConflicts(items, listOpenBoxes(), null);
    if (conflicts.length) {
      return reply(409, { error: '偶头占用冲突', code: 'HEAD_CONFLICT', conflicts });
    }

    // 同箱总重超限 / 重偶头压脆配件 —— 整单拒绝
    const violations = evaluatePacking(items, heads, accessories, tourConfig);
    if (violations.length) {
      return reply(422, { error: '装箱判定未通过，整单拒绝', code: 'PACKING_REJECTED', violations });
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const box = withSummary({
      status: '已装箱',
      showName, venue, play, items,
      packedBy: actor,
      packedAt: createdAt,
      packingQualified: true,
      qualificationViolations: [],
      sealed: false,
      seals: {},
      sealedAt: null,
      arrivalInspection: null,
      returnConfirms: [],
      returnStreak: 0,
      doubleConfirmed: false,
      positionReset: false,
      positionResetAt: null,
      revisionNo: 0
    });

    // 单事务：装箱单 + 偶头/配件占用 + 履历，要么全成要么全无
    const statements = [
      insertRecordSql({
        id,
        collection: COLLECTION,
        status: box.status,
        title: showName + ' / ' + play,
        data: box,
        createdAt
      }),
      insertEventSql({
        recordId: id,
        collection: COLLECTION,
        action: '装箱登记',
        status: box.status,
        actor,
        note: '登记箱号、层位、单件克重',
        data: { items }
      })
    ];
    for (const item of items) {
      const occupied = item.itemType === 'head' ? heads[item.itemId] : accessories[item.itemId];
      const cleanOccupied = {
        ...occupied,
        status: '已装箱',
        currentUsable: item.itemType === 'head' ? false : occupied.currentUsable,
        packedInBoxId: id
      };
      statements.push(updateRecordSql({
        id: item.itemId,
        collection: item.itemType === 'head' ? 'puppetHeads' : 'accessories',
        status: '已装箱',
        title: item.itemType === 'head'
          ? [cleanOccupied.role, cleanOccupied.play].filter(Boolean).join(' / ')
          : [cleanOccupied.name, cleanOccupied.role].filter(Boolean).join(' / '),
        data: cleanOccupied
      }));
      statements.push(insertEventSql({
        recordId: item.itemId,
        collection: item.itemType === 'head' ? 'puppetHeads' : 'accessories',
        action: '装箱占用',
        status: '已装箱',
        actor,
        note: '入箱 ' + item.boxNo + ' 第 ' + item.layer + ' 层',
        data: { tourBoxId: id, boxNo: item.boxNo, layer: item.layer, weightGrams: item.weightGrams }
      }));
    }
    transaction(statements);

    reply(201, getBox(id));
  }));

  // 2. 出发封签：封箱后才能到场核验
  router.post('/tourBoxes/:id/seal', businessRoute('seal::id', ({ params, body, reply }) => {
    const box = loadBoxOr404(params.id);
    assertStatus(box, ['已装箱'], 'SEAL_INVALID_STATUS');
    const actor = requireActor(body);
    if (box.sealed) throw httpError(409, 'ALREADY_SEALED', '装箱单已封签，如需重封请先经更正作废旧封签');
    if (box.packingQualified === false) {
      throw httpError(409, 'PACKING_QUALIFICATION_LOST', '装箱资格已失效，请更正后重算通过再封箱', {
        violations: box.qualificationViolations || []
      });
    }
    const seals = body.seals || {};
    const boxNos = [...new Set((box.items || []).map((item) => item.boxNo))];
    const missing = boxNos.filter((boxNo) => !seals[boxNo]);
    if (missing.length) {
      throw httpError(400, 'SEAL_INCOMPLETE', '以下箱号缺少封签：' + missing.join('、'), { missing });
    }
    const cleanSeals = {};
    for (const boxNo of boxNos) cleanSeals[boxNo] = String(seals[boxNo]);

    const nextBox = withSummary({ ...box, sealed: true, seals: cleanSeals, sealedAt: new Date().toISOString(), sealedBy: actor });
    const statements = [];
    saveBoxMutations(statements, nextBox, {
      action: '出发封签',
      actor,
      note: '封签 ' + boxNos.join('、'),
      data: { seals: cleanSeals }
    });
    transaction(statements);
    reply(200, getBox(box.id));
  }));

  // 3. 到场核验：错层或封签不符只转待复核，不整单拒绝
  router.post('/tourBoxes/:id/arrival', businessRoute('arrival::id', ({ params, body, reply }) => {
    const box = loadBoxOr404(params.id);
    assertStatus(box, ['已装箱', '巡演中', '待复核'], 'ARRIVAL_INVALID_STATUS');
    if (!box.sealed) throw httpError(409, 'NOT_SEALED', '装箱单尚未封签，无法到场核验');
    const actor = requireActor(body);

    const inspection = inspectArrival(box, body.observedLayers || [], body.observedSeals || {});
    const nextBox = withSummary({
      ...box,
      status: inspection.nextStatus,
      arrivalInspection: {
        at: new Date().toISOString(),
        by: actor,
        passed: inspection.passed,
        layerMismatches: inspection.layerMismatches,
        sealMismatches: inspection.sealMismatches
      }
    });
    const statements = [];
    saveBoxMutations(statements, nextBox, {
      action: inspection.passed ? '到场核验通过' : '到场转待复核',
      actor,
      note: inspection.passed ? '层位与封签一致' : ('发现 ' + (inspection.layerMismatches.length + inspection.sealMismatches.length) + ' 处不符'),
      data: inspection
    });
    transaction(statements);
    reply(200, getBox(box.id));
  }));

  // 4. 返场清点确认：须另一人连续两次
  router.post('/tourBoxes/:id/return-check', businessRoute('return-check::id', ({ params, body, reply }) => {
    const box = loadBoxOr404(params.id);
    assertStatus(box, ['巡演中', '返场清点中'], 'RETURN_CHECK_INVALID_STATUS');
    const actor = requireActor(body);

    const confirmation = applyReturnConfirm(box, actor);
    const nextBox = withSummary({
      ...box,
      status: confirmation.nextStatus,
      returnConfirms: confirmation.returnConfirms,
      returnStreak: confirmation.returnStreak,
      doubleConfirmed: confirmation.doubleConfirmed
    });
    const statements = [];
    saveBoxMutations(statements, nextBox, {
      action: '返场清点确认',
      actor,
      note: '第 ' + confirmation.returnStreak + ' 次连续确认' + (confirmation.doubleConfirmed ? '，双人确认完成' : ''),
      data: { streak: confirmation.returnStreak, doubleConfirmed: confirmation.doubleConfirmed }
    });
    transaction(statements);
    reply(200, getBox(box.id));
  }));

  // 5. 箱内位置复位：逐层逐件核对，复位通过才允许解封
  router.post('/tourBoxes/:id/reset-position', businessRoute('reset-position::id', ({ params, body, reply }) => {
    const box = loadBoxOr404(params.id);
    assertStatus(box, ['巡演中', '返场清点中'], 'RESET_INVALID_STATUS');
    const actor = requireActor(body);

    const check = checkPositionReset(box, body.observedPositions || []);
    const nextBox = withSummary({
      ...box,
      positionReset: check.reset,
      positionResetAt: check.reset ? new Date().toISOString() : null,
      positionResetBy: check.reset ? actor : box.positionResetBy || null,
      lastPositionCheck: { at: new Date().toISOString(), by: actor, ...check }
    });
    const statements = [];
    saveBoxMutations(statements, nextBox, {
      action: check.reset ? '箱内位置复位' : '位置复位未通过',
      actor,
      note: check.reset ? '逐件逐层复位一致' : (check.mismatches.length + ' 处位置不符'),
      data: check
    });
    transaction(statements);
    reply(200, getBox(box.id));
  }));

  // 6. 解封台：修补完成 + 双人确认 + 位置复位后解除占用
  router.post('/tourBoxes/:id/release', businessRoute('release::id', ({ params, body, reply }) => {
    const box = loadBoxOr404(params.id);
    assertStatus(box, ['返场清点中', '巡演中'], 'RELEASE_INVALID_STATUS');
    const actor = requireActor(body);

    const openRepairs = listRecords('repairRecords').filter((repair) =>
      repair.tourBoxId === box.id && repair.status !== '已完成'
    );
    const blockers = releaseBlockers(box, { openRepairCount: openRepairs.length });
    if (blockers.length) {
      return reply(409, {
        error: '解封条件未满足，占用未解除',
        code: 'RELEASE_BLOCKED',
        blockers,
        openRepairIds: openRepairs.map((repair) => repair.id)
      });
    }

    const heads = headMap();
    const accessories = accessoryMap();
    const releasedAt = new Date().toISOString();
    const nextBox = withSummary({ ...box, status: '已闭环', released: true, releasedAt, releasedBy: actor });
    const statements = [];
    saveBoxMutations(statements, nextBox, {
      action: '返场解封',
      actor,
      note: '修补完成、双人确认、位置复位，解除占用',
      data: { releasedAt }
    });
    for (const item of box.items || []) {
      const occupied = item.itemType === 'head' ? heads[item.itemId] : accessories[item.itemId];
      if (!occupied) continue;
      const cleanOccupied = {
        ...occupied,
        status: item.itemType === 'head' ? '可演出' : '在库',
        currentUsable: item.itemType === 'head' ? true : occupied.currentUsable,
        packedInBoxId: null,
        releasedAt
      };
      statements.push(updateRecordSql({
        id: item.itemId,
        collection: item.itemType === 'head' ? 'puppetHeads' : 'accessories',
        status: cleanOccupied.status,
        title: item.itemType === 'head'
          ? [cleanOccupied.role, cleanOccupied.play].filter(Boolean).join(' / ')
          : [cleanOccupied.name, cleanOccupied.role].filter(Boolean).join(' / '),
        data: cleanOccupied
      }));
      statements.push(insertEventSql({
        recordId: item.itemId,
        collection: item.itemType === 'head' ? 'puppetHeads' : 'accessories',
        action: '返场解封',
        status: cleanOccupied.status,
        actor,
        note: '装箱单 ' + box.id + ' 闭环',
        data: { tourBoxId: box.id, releasedAt }
      }));
    }
    transaction(statements);
    reply(200, getBox(box.id));
  }));

  // 7. 更正配重/层位：旧稿留档，资格失效，按新值重算
  router.post('/tourBoxes/:id/corrections', businessRoute('correction::id', ({ params, body, reply }) => {
    const box = loadBoxOr404(params.id);
    if (box.status === '已闭环') throw httpError(409, 'BOX_CLOSED', '已闭环装箱单不可更正');
    const actor = requireActor(body);
    const reason = String(body.reason || '').trim();

    const result = applyCorrection(box, body.corrections || [], headMap(), accessoryMap(), tourConfig);
    const revisionId = randomUUID();
    const revisionNo = (box.revisionNo || 0) + 1;
    const createdAt = new Date().toISOString();
    const nextBox = withSummary({ ...result.nextBox, revisionNo });
    const revision = {
      tourBoxId: box.id,
      revisionNo,
      archivedAt: createdAt,
      archivedBy: actor,
      reason,
      changed: result.changed,
      snapshot: box
    };

    const statements = [
      insertRecordSql({
        id: revisionId,
        collection: REVISION_COLLECTION,
        status: '已留档',
        title: box.showName + ' / ' + box.play + ' / 旧稿v' + revisionNo,
        data: revision,
        createdAt
      }),
      insertEventSql({
        recordId: revisionId,
        collection: REVISION_COLLECTION,
        action: '旧稿留档',
        status: '已留档',
        actor,
        note: reason || ('更正配重/层位 v' + revisionNo),
        data: { changed: result.changed }
      })
    ];
    saveBoxMutations(statements, nextBox, {
      action: '更正配重层位',
      actor,
      note: reason || ('v' + revisionNo + '：旧稿留档，解封与装箱资格按新值重算'),
      data: {
        changed: result.changed,
        violations: result.violations,
        packingQualified: nextBox.packingQualified,
        releaseInvalidated: result.releaseInvalidated,
        revisionId,
        revisionNo
      }
    });
    transaction(statements);
    reply(200, { box: getBox(box.id), revision: { id: revisionId, ...revision } });
  }));

  // 8. 解封台视图：门禁状态一览
  router.get('/tourBoxes/:id/release-status', (req, res, next) => {
    try {
      const box = loadBoxOr404(req.params.id);
      const openRepairs = listRecords('repairRecords').filter((repair) =>
        repair.tourBoxId === box.id && repair.status !== '已完成'
      );
      const blockers = releaseBlockers(box, { openRepairCount: openRepairs.length });
      res.json({
        boxId: box.id,
        status: box.status,
        gates: {
          doubleConfirmed: (box.returnStreak || 0) >= 2,
          returnStreak: box.returnStreak || 0,
          repairsDone: openRepairs.length === 0,
          positionReset: box.positionReset === true,
          notUnderReview: box.status !== '待复核'
        },
        openRepairIds: openRepairs.map((repair) => repair.id),
        canRelease: blockers.length === 0 && (box.status === '返场清点中' || box.status === '巡演中'),
        blockers
      });
    } catch (error) {
      next(error);
    }
  });

  // 9. 履历：装箱事件链 + 旧稿
  router.get('/tourBoxes/:id/history', (req, res, next) => {
    try {
      const box = loadBoxOr404(req.params.id);
      res.json({
        box,
        events: eventsOf(box.id),
        revisions: listRecords(REVISION_COLLECTION).filter((r) => r.tourBoxId === box.id)
      });
    } catch (error) {
      next(error);
    }
  });

  // 10. 汇总：装箱、履历、数量刷新后一致
  router.get('/tour-overview', (req, res, next) => {
    try {
      const boxes = listRecords(COLLECTION).map(withSummary);
      const heads = listHeads();
      const accessories = listAccessories();
      const openBoxes = boxes.filter((box) => OPEN_STATUSES.includes(box.status));
      const occupiedHeadIds = new Set();
      const occupiedAccessoryIds = new Set();
      for (const box of openBoxes) {
        for (const item of box.items || []) {
          (item.itemType === 'head' ? occupiedHeadIds : occupiedAccessoryIds).add(item.itemId);
        }
      }
      const revisions = listRecords(REVISION_COLLECTION);
      const byStatus = boxes.reduce((acc, box) => {
        acc[box.status] = (acc[box.status] || 0) + 1;
        return acc;
      }, {});
      res.json({
        generatedAt: new Date().toISOString(),
        boxes: {
          total: boxes.length,
          byStatus,
          open: openBoxes.length,
          closed: boxes.filter((box) => box.status === '已闭环').length,
          totalWeightGrams: boxes.reduce((sum, box) => sum + (box.totalWeightGrams || 0), 0)
        },
        heads: {
          total: heads.length,
          occupied: occupiedHeadIds.size,
          usable: heads.filter((head) => head.status === '可演出').length
        },
        accessories: {
          total: accessories.length,
          occupied: occupiedAccessoryIds.size,
          inStock: accessories.filter((accessory) => accessory.status === '在库').length
        },
        revisions: { total: revisions.length },
        consistencyCheck: {
          occupiedHeadsAllMarkedPacked: [...occupiedHeadIds].every((id) => (getHead(id) || {}).status === '已装箱'),
          occupiedAccessoriesAllMarkedPacked: [...occupiedAccessoryIds].every((id) => (getAccessory(id) || {}).status === '已装箱')
        }
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { buildRouter };

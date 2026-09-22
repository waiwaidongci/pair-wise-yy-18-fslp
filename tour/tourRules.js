// 巡演装箱判定模块：配重分层、冲突、到场、返场解封与更正重算的全部规则。
// 本文件为纯函数，不读写数据库，输入快照、输出判定结论，便于单独推演与重放。
const config = require('../project.config');

const RULES = config.tourRules;

// 已闭环之外的装箱单都算“未结束”，偶头在其中只能被占用一次
const ACTIVE_BOX_STATUSES = ['草稿', '已装箱', '巡演中', '待复核', '返场清点中'];
const OPEN_REPAIR_STATUSES = ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中'];

// 统一构造判定错误：code 映射 HTTP 状态（409 冲突 / 422 业务拒绝 / 400 报文错误）
function ruleError(code, codeText, message, detail) {
  const error = new Error(message);
  error.code = code;
  error.codeText = codeText;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function isHeavyHead(item) {
  return item.kind === 'head' && Number(item.weightGrams) >= RULES.heavyHeadGrams;
}

function isFragile(item) {
  return item.kind === 'accessory' && item.fragile === true;
}

// 规范化一条登记明细，顺带校验字段本身；不合法直接报 400
function normalizeItem(raw, contextItemsById) {
  const itemType = raw.itemType === 'head' ? 'head' : raw.itemType === 'accessory' ? 'accessory' : null;
  if (!itemType) {
    throw ruleError(400, 'BAD_ITEM_TYPE', 'itemType 必须是 head 或 accessory', raw);
  }
  if (!raw.itemId) {
    throw ruleError(400, 'MISSING_ITEM_ID', '每条明细必须提供 itemId', raw);
  }
  const ref = contextItemsById[itemType][raw.itemId];
  if (!ref) {
    throw ruleError(400, 'ITEM_NOT_FOUND', (itemType === 'head' ? '偶头不存在：' : '配件不存在：') + raw.itemId, raw);
  }
  const weightGrams = Number(raw.weightGrams);
  if (!Number.isFinite(weightGrams) || weightGrams < 0) {
    throw ruleError(400, 'BAD_WEIGHT', '单件克重必须是非负数字：' + raw.itemId, raw);
  }
  const layer = Number(raw.layer);
  if (!Number.isInteger(layer) || layer < RULES.bottomLayer) {
    throw ruleError(400, 'BAD_LAYER', '层位必须是不小于 ' + RULES.bottomLayer + ' 的整数（数字越小越靠箱底）：' + raw.itemId, raw);
  }
  if (!raw.boxNo || String(raw.boxNo).trim() === '') {
    throw ruleError(400, 'MISSING_BOX_NO', '每条明细必须登记箱号：' + raw.itemId, raw);
  }
  return {
    kind: itemType,
    itemId: raw.itemId,
    name: ref.name,
    boxNo: String(raw.boxNo).trim(),
    layer,
    weightGrams,
    fragile: itemType === 'accessory' ? ref.fragile === true : false,
    status: ref.status
  };
}

// 初始装箱资格（首次登记 / 更正后重算都走这里）
function buildQualification(items, limitsByBox, options = {}) {
  const errors = [];
  const reasons = [];

  // 1) 偶头在同一提交中只能出现一次（冲突，409，且不产生半成品）
  const seenHeads = new Set();
  for (const item of items) {
    if (item.kind !== 'head') continue;
    if (seenHeads.has(item.itemId)) {
      errors.push(ruleError(409, 'DUPLICATE_HEAD_IN_ORDER', '同一偶头在本装箱单中出现超过一次：' + item.itemId, { itemId: item.itemId }));
    }
    seenHeads.add(item.itemId);
  }

  // 2) 偶头不能已被其它未结束装箱单占用（409）
  for (const item of items) {
    if (item.kind !== 'head') continue;
    const occupiedIn = options.occupancy && options.occupancy[item.itemId];
    if (occupiedIn && occupiedIn.boxId !== options.selfBoxId) {
      errors.push(ruleError(409, 'HEAD_OCCUPIED', '偶头已在未结束装箱单中，只能出现一次：' + item.itemId, {
        itemId: item.itemId,
        boxId: occupiedIn.boxId,
        boxStatus: occupiedIn.status
      }));
    }
  }

  // 3) 单件可装箱资格：偶头须可演出，配件须在库（非脆配件也按在库判定）
  // 更正重算时，本箱自身已占用物件的物理状态已是“已装箱”，属正常占用而非不可装
  for (const item of items) {
    const selfOccupied = options.ignoreSelfPhysicalStatus && item.status === '已装箱';
    if (item.kind === 'head' && item.status !== '可演出' && !selfOccupied) {
      errors.push(ruleError(422, 'HEAD_NOT_USABLE', '偶头当前不是可演出状态，不能装箱：' + item.itemId + '（' + item.status + '）', {
        itemId: item.itemId,
        status: item.status
      }));
    }
    if (item.kind === 'accessory' && item.status !== '在库' && !selfOccupied) {
      errors.push(ruleError(422, 'ACCESSORY_NOT_AVAILABLE', '配件当前不在库，不能装箱：' + item.itemId + '（' + item.status + '）', {
        itemId: item.itemId,
        status: item.status
      }));
    }
  }

  // 4) 同箱总重超限 → 整单拒绝（422）
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.boxNo)) groups.set(item.boxNo, []);
    groups.get(item.boxNo).push(item);
  }
  for (const [boxNo, boxItems] of groups) {
    const total = boxItems.reduce((sum, item) => sum + item.weightGrams, 0);
    const limit = limitsByBox[boxNo] !== undefined ? limitsByBox[boxNo] : RULES.defaultBoxWeightLimitGrams;
    if (total > limit) {
      errors.push(ruleError(422, 'BOX_WEIGHT_EXCEEDED', '箱 ' + boxNo + ' 同箱总重 ' + total + ' 克超过上限 ' + limit + ' 克，整单拒绝', {
        boxNo,
        totalGrams: total,
        limitGrams: limit
      }));
    }
  }

  // 5) 重偶头压在脆配件上 → 整单拒绝（层位数字大者压在上方，422）
  for (const [boxNo, boxItems] of groups) {
    const heavy = boxItems.filter(isHeavyHead);
    const fragile = boxItems.filter(isFragile);
    for (const h of heavy) {
      for (const f of fragile) {
        if (h.layer > f.layer) {
          errors.push(ruleError(422, 'HEAVY_ON_FRAGILE', '重偶头 ' + h.itemId + ' 压在脆配件 ' + f.itemId + ' 之上（箱 ' + boxNo + '），整单拒绝', {
            boxNo,
            headId: h.itemId,
            accessoryId: f.itemId,
            headLayer: h.layer,
            fragileLayer: f.layer
          }));
        }
      }
    }
  }

  const packingEligible = errors.length === 0;
  if (!packingEligible) reasons.push(...errors.map((e) => e.message));
  return {
    revision: (options.baseRevision || 0) + 1,
    packingEligible,
    // 首次登记时装箱资格即解封资格；更正后两者先失效，再以本结论按新值重算
    unsealEligible: packingEligible,
    reasons,
    errors,
    limitsByBox,
    recalculatedAt: new Date().toISOString()
  };
}

// 首次登记判定：返回规范化明细与资格结论
function evaluatePacking(rawItems, contextItemsById, options = {}) {
  const items = rawItems.map((raw) => normalizeItem(raw, contextItemsById));
  const limitsByBox = {};
  for (const raw of rawItems) {
    const boxNo = String(raw.boxNo).trim();
    if (raw.boxWeightLimitGrams !== undefined && raw.boxWeightLimitGrams !== null && raw.boxWeightLimitGrams !== '') {
      const limit = Number(raw.boxWeightLimitGrams);
      if (!Number.isFinite(limit) || limit < 0) {
        throw ruleError(400, 'BAD_BOX_LIMIT', '箱重上限必须是非负数字：' + boxNo, { boxNo });
      }
      limitsByBox[boxNo] = limit;
    }
  }
  const qualification = buildQualification(items, limitsByBox, options);
  return { items, qualification };
}

// 到场核验：错层或封签不符只转待复核，不改变任何占用与资格
function evaluateArrival(box, body) {
  const findings = [];
  const registeredByKey = new Map();
  for (const item of box.items || []) {
    registeredByKey.set(item.kind + ':' + item.itemId, item);
  }
  for (const observed of body.observedItems || []) {
    const key = (observed.itemType === 'head' ? 'head' : 'accessory') + ':' + observed.itemId;
    const registered = registeredByKey.get(key);
    if (!registered) {
      findings.push({ type: 'ITEM_NOT_IN_ORDER', itemId: observed.itemId, message: '到场出现装箱单外的物件：' + observed.itemId });
      continue;
    }
    const observedLayer = Number(observed.layer);
    if (Number.isInteger(observedLayer) && observedLayer !== registered.layer) {
      findings.push({
        type: 'WRONG_LAYER',
        itemId: observed.itemId,
        expectedLayer: registered.layer,
        actualLayer: observedLayer,
        message: '错层：' + observed.itemId + ' 登记层位 ' + registered.layer + '，到场层位 ' + observedLayer
      });
    }
  }
  if (body.sealCode !== undefined && body.sealCode !== (box.sealCode || null)) {
    findings.push({
      type: 'SEAL_MISMATCH',
      expectedSealCode: box.sealCode || null,
      actualSealCode: body.sealCode,
      message: '封签不符：登记封签 ' + box.sealCode + '，到场封签 ' + body.sealCode
    });
  }
  // 规则要求：错层或封签不符“只”转待复核
  return { needsReview: findings.length > 0, findings };
}

// 返场清点：必须是装箱人之外的“另一人”，且同一人连续两次确认
function evaluateReturnConfirm(box, actor) {
  if (!actor) {
    throw ruleError(400, 'MISSING_ACTOR', '返场确认必须提供操作人 actor');
  }
  if (box.packedBy && actor === box.packedBy) {
    throw ruleError(409, 'CONFIRMER_MUST_BE_OTHER', '返场清点须由装箱人之外的另一人确认，装箱人：' + box.packedBy, {
      packedBy: box.packedBy,
      actor
    });
  }
  const streak = Array.isArray(box.returnConfirmations) ? box.returnConfirmations : [];
  if (streak.length >= 2) {
    throw ruleError(409, 'ALREADY_CONFIRMED', '返场清点已完成两次确认', {
      confirmer: streak[0] && streak[0].actor,
      count: streak.length
    });
  }
  // 不同人插进来 → 连续计数中断，由新人从头计起
  let resetByOther = false;
  if (streak.length === 1 && streak[0].actor !== actor) {
    resetByOther = true;
  }
  return { resetByOther, remaining: resetByOther ? 1 : 2 - (streak.length + 1) };
}

// 解除占用（解封）闸门：修补完成 + 箱内位置复位 + 两人两次确认 + 解封资格仍有效
function evaluateRelease(box, context) {
  const blockers = [];
  const streak = Array.isArray(box.returnConfirmations) ? box.returnConfirmations : [];
  const confirmer = streak[0] ? streak[0].actor : null;
  if (streak.length < 2 || streak.some((c) => c.actor !== confirmer)) {
    blockers.push({ code: 'CONFIRMATION_INCOMPLETE', message: '返场清点须另一人连续两次确认' });
  }
  if (box.packedBy && confirmer && box.packedBy === confirmer) {
    blockers.push({ code: 'CONFIRMER_IS_PACKER', message: '确认人不能是装箱人本人' });
  }
  const openRepairs = (context.openRepairs || []).filter((repair) => {
    const headIds = (box.items || []).filter((i) => i.kind === 'head').map((i) => i.itemId);
    return headIds.includes(repair.puppetHeadId) && OPEN_REPAIR_STATUSES.includes(repair.status);
  });
  if (openRepairs.length) {
    blockers.push({
      code: 'REPAIR_NOT_FINISHED',
      message: '箱内偶头尚有未完成修补：' + openRepairs.map((r) => r.id).join('、'),
      repairIds: openRepairs.map((r) => r.id)
    });
  }
  if (!box.positionRestored) {
    blockers.push({ code: 'POSITION_NOT_RESTORED', message: '箱内位置尚未复位' });
  }
  if (!box.qualification || box.qualification.unsealEligible !== true) {
    blockers.push({ code: 'UNSEAL_QUALIFICATION_INVALID', message: '解封资格已失效（配重或层位更正后未通过重算）' });
  }
  return { releasable: blockers.length === 0, blockers };
}

// 更正配重/层位：旧资格全部失效，再按新值重算；旧稿由存储层留档
function evaluateCorrection(box, rawItems, contextItemsById, options = {}) {
  const correctedItems = rawItems.map((raw) => normalizeItem(raw, contextItemsById));
  const qualification = buildQualification(correctedItems, options.limitsByBox || {}, {
    ...options,
    selfBoxId: box.id,
    ignoreSelfPhysicalStatus: true,
    baseRevision: (box.qualification && box.qualification.revision) || 0
  });
  return { items: correctedItems, qualification };
}

module.exports = {
  RULES,
  ACTIVE_BOX_STATUSES,
  OPEN_REPAIR_STATUSES,
  ruleError,
  isHeavyHead,
  isFragile,
  normalizeItem,
  buildQualification,
  evaluatePacking,
  evaluateArrival,
  evaluateReturnConfirm,
  evaluateRelease,
  evaluateCorrection
};

// 巡演装箱 · 判定层
// 纯函数，不碰数据库：重量分层校验、偶头唯一冲突、到场核验、双人确认、解封门禁、更正重算。

function httpError(status, code, message, extra) {
  return Object.assign(new Error(message), { status, code }, extra || {});
}

function isFragile(accessory, config) {
  if (accessory && accessory.fragile === true) return true;
  const keywords = (config && config.fragileKeywords) || [];
  const text = [accessory && accessory.name, accessory && accessory.category, accessory && accessory.material]
    .filter(Boolean)
    .join(' ');
  return keywords.some((keyword) => text.includes(keyword));
}

// 同箱总重（克），按箱号汇总
function weightByBox(items) {
  return items.reduce((acc, item) => {
    acc[item.boxNo] = (acc[item.boxNo] || 0) + item.weightGrams;
    return acc;
  }, {});
}

function withSummary(box) {
  const items = box.items || [];
  const headItems = items.filter((item) => item.itemType === 'head');
  const accessoryItems = items.filter((item) => item.itemType === 'accessory');
  const perBox = weightByBox(items);
  return {
    ...box,
    headCount: headItems.length,
    accessoryCount: accessoryItems.length,
    itemCount: items.length,
    totalWeightGrams: Object.values(perBox).reduce((sum, value) => sum + value, 0),
    weightByBox: perBox
  };
}

function normalizeItems(input, config) {
  if (!Array.isArray(input) || input.length === 0) {
    throw httpError(400, 'INVALID_ITEMS', 'items 必须为非空数组');
  }
  const maxLayer = config.maxLayer;
  return input.map((raw, index) => {
    const prefix = 'items[' + index + ']';
    if (!raw || typeof raw !== 'object') {
      throw httpError(400, 'INVALID_ITEM', prefix + ' 必须为对象');
    }
    const itemType = raw.itemType === 'accessory' ? 'accessory' : 'head';
    const itemId = String(raw.itemId || '').trim();
    const boxNo = String(raw.boxNo || '').trim();
    const layer = Number(raw.layer);
    const weightGrams = Number(raw.weightGrams);
    if (!itemId) throw httpError(400, 'INVALID_ITEM', prefix + ' 缺少 itemId');
    if (!boxNo) throw httpError(400, 'INVALID_ITEM', prefix + ' 缺少 boxNo（箱号）');
    if (!Number.isInteger(layer) || layer < 1) {
      throw httpError(400, 'INVALID_ITEM', prefix + ' layer（层位）必须是不小于 1 的整数，数字越大越靠上');
    }
    if (maxLayer && layer > maxLayer) {
      throw httpError(400, 'INVALID_ITEM', prefix + ' layer 超出最大层位 ' + maxLayer);
    }
    if (!Number.isFinite(weightGrams) || weightGrams <= 0) {
      throw httpError(400, 'INVALID_ITEM', prefix + ' weightGrams（单件克重）必须为正数');
    }
    return { itemType, itemId, boxNo, layer, weightGrams };
  });
}

// 装箱资格判定：存在性/状态、同箱总重、重偶头压脆配件
// headMap / accessoryMap: id -> record；selfBoxId 用于更正重算：被本单占用的物件视为可重算
// 返回 violations，空数组表示通过
function evaluatePacking(items, headMap, accessoryMap, config, selfBoxId) {
  const violations = [];

  for (const item of items) {
    if (item.itemType === 'head') {
      const head = headMap[item.itemId];
      if (!head) {
        violations.push({ code: 'HEAD_NOT_FOUND', itemId: item.itemId, message: '偶头不存在: ' + item.itemId });
      } else if (head.status !== '可演出' && !(selfBoxId && head.packedInBoxId === selfBoxId)) {
        violations.push({
          code: 'HEAD_NOT_PACKABLE',
          itemId: item.itemId,
          status: head.status,
          message: '偶头当前状态不可装箱: ' + head.status
        });
      }
    } else {
      const accessory = accessoryMap[item.itemId];
      if (!accessory) {
        violations.push({ code: 'ACCESSORY_NOT_FOUND', itemId: item.itemId, message: '配件不存在: ' + item.itemId });
      } else if (accessory.status !== '在库' && !(selfBoxId && accessory.packedInBoxId === selfBoxId)) {
        violations.push({
          code: 'ACCESSORY_NOT_PACKABLE',
          itemId: item.itemId,
          status: accessory.status,
          message: '配件当前状态不可装箱: ' + accessory.status
        });
      }
    }
  }
  if (violations.length) return violations;

  const limitPerBox = config.boxWeightLimitGrams;
  for (const [boxNo, total] of Object.entries(weightByBox(items))) {
    if (total > limitPerBox) {
      violations.push({
        code: 'BOX_OVERWEIGHT',
        boxNo,
        totalGrams: total,
        limitGrams: limitPerBox,
        message: '箱 ' + boxNo + ' 总重 ' + total + ' 克超限（上限 ' + limitPerBox + ' 克）'
      });
    }
  }

  // 重偶头压在脆配件上：同箱、重偶头层位严格高于脆配件（层位数字越大越靠上）
  const heavyThreshold = config.heavyHeadGrams;
  const headItems = items.filter((item) => item.itemType === 'head' && item.weightGrams >= heavyThreshold);
  for (const heavy of headItems) {
    for (const other of items) {
      if (other.itemType !== 'accessory' || other.boxNo !== heavy.boxNo || other.layer >= heavy.layer) continue;
      const accessory = accessoryMap[other.itemId];
      if (isFragile(accessory, config)) {
        violations.push({
          code: 'HEAVY_OVER_FRAGILE',
          boxNo: heavy.boxNo,
          headItemId: heavy.itemId,
          accessoryItemId: other.itemId,
          headLayer: heavy.layer,
          accessoryLayer: other.layer,
          message: '重偶头 ' + heavy.itemId + '（' + heavy.layer + ' 层）压在脆配件 ' + other.itemId +
            '（' + other.layer + ' 层）之上'
        });
      }
    }
  }

  return violations;
}

// 偶头在未结束装箱单中只能出现一次；本单内重复也算冲突
function findHeadConflicts(items, openBoxes, currentBoxId) {
  const seen = new Set();
  const conflicts = [];
  for (const item of items.filter((entry) => entry.itemType === 'head')) {
    if (seen.has(item.itemId)) {
      conflicts.push({
        code: 'HEAD_DUPLICATE_IN_ORDER',
        headId: item.itemId,
        boxId: currentBoxId || null,
        message: '偶头 ' + item.itemId + ' 在本单中重复登记'
      });
    }
    seen.add(item.itemId);
  }
  for (const box of openBoxes) {
    if (box.id === currentBoxId) continue;
    const occupied = new Set((box.items || []).filter((entry) => entry.itemType === 'head').map((entry) => entry.itemId));
    for (const headId of seen) {
      if (occupied.has(headId)) {
        conflicts.push({
          code: 'HEAD_ALREADY_PACKED',
          headId,
          boxId: box.id,
          boxTitle: box.title,
          boxStatus: box.status,
          message: '偶头 ' + headId + ' 已在未结束装箱单 ' + box.id + '（' + box.status + '）中'
        });
      }
    }
  }
  return conflicts;
}

// 到场核验：只判错层与封签不符，不整单拒绝
// observed: [{ itemId, layer }], observedSeals: { boxNo: seal }
function inspectArrival(box, observed, observedSeals) {
  const expectedByItem = new Map((box.items || []).map((item) => [item.itemId, item]));
  const layerMismatches = [];

  for (const entry of observed || []) {
    const expected = expectedByItem.get(String(entry.itemId));
    if (!expected) {
      layerMismatches.push({ code: 'ITEM_NOT_IN_ORDER', itemId: String(entry.itemId), message: '该件不在本装箱单' });
      continue;
    }
    if (Number(entry.layer) !== expected.layer) {
      layerMismatches.push({
        code: 'LAYER_MISMATCH',
        itemId: expected.itemId,
        itemType: expected.itemType,
        expectedLayer: expected.layer,
        observedLayer: Number(entry.layer),
        boxNo: expected.boxNo,
        message: expected.itemId + ' 错层：应为 ' + expected.layer + ' 层，实为 ' + Number(entry.layer) + ' 层'
      });
    }
  }
  for (const [itemId, expected] of expectedByItem.entries()) {
    if (!(observed || []).some((entry) => String(entry.itemId) === itemId)) {
      layerMismatches.push({
        code: 'ITEM_MISSING_AT_ARRIVAL',
        itemId,
        itemType: expected.itemType,
        expectedLayer: expected.layer,
        boxNo: expected.boxNo,
        message: itemId + ' 到场未见，无法核对层位'
      });
    }
  }

  const sealMismatches = [];
  const seals = box.seals || {};
  for (const boxNo of Object.keys(seals)) {
    const observedSeal = (observedSeals || {})[boxNo];
    if (!observedSeal) {
      sealMismatches.push({ code: 'SEAL_MISSING', boxNo, expectedSeal: seals[boxNo], message: '箱 ' + boxNo + ' 未读到封签' });
    } else if (String(observedSeal) !== String(seals[boxNo])) {
      sealMismatches.push({
        code: 'SEAL_MISMATCH',
        boxNo,
        expectedSeal: seals[boxNo],
        observedSeal: String(observedSeal),
        message: '箱 ' + boxNo + ' 封签不符：应为 ' + seals[boxNo] + '，实为 ' + observedSeal
      });
    }
  }

  const mismatches = layerMismatches.concat(sealMismatches);
  return {
    passed: mismatches.length === 0,
    layerMismatches,
    sealMismatches,
    nextStatus: mismatches.length === 0 ? '巡演中' : '待复核'
  };
}

// 返场清点确认：须另一人（非装箱人）连续两次
// 返回确认后的状态描述；不满足者抛出 409
function applyReturnConfirm(box, actor) {
  const packedBy = box.packedBy || '';
  if (packedBy && actor === packedBy) {
    throw httpError(409, 'CONFIRM_SAME_AS_PACKER', '返场清点须由装箱人之外的另一人确认', { packedBy });
  }
  const confirms = Array.isArray(box.returnConfirms) ? box.returnConfirms : [];
  const last = confirms[confirms.length - 1] || null;
  let streak = 1;
  if (last && last.actor === actor) {
    streak = (box.returnStreak || 0) + 1;
  }
  const history = confirms.concat([{ actor, at: new Date().toISOString(), streak }]);
  const nextStreak = streak;
  const doubleConfirmed = nextStreak >= 2;
  return {
    returnConfirms: history,
    returnStreak: nextStreak,
    doubleConfirmed,
    nextStatus: doubleConfirmed ? '返场清点中' : box.status
  };
}

// 解封门禁：双人确认 + 关联修补完成 + 箱内位置复位
function releaseBlockers(box, options) {
  const blockers = [];
  if (!box.returnStreak || box.returnStreak < 2) {
    blockers.push({ code: 'RETURN_NOT_DOUBLE_CONFIRMED', message: '返场清点尚未由另一人连续两次确认' });
  }
  if (options && options.openRepairCount > 0) {
    blockers.push({ code: 'REPAIR_NOT_DONE', count: options.openRepairCount, message: '尚有 ' + options.openRepairCount + ' 条修补未完成' });
  }
  if (!box.positionReset) {
    blockers.push({ code: 'POSITION_NOT_RESET', message: '箱内位置尚未复位' });
  }
  if (box.status === '待复核') {
    blockers.push({ code: 'UNDER_REVIEW', message: '到场问题仍待复核，不能解封' });
  }
  return blockers;
}

// 箱内位置复位核对：observed 与装箱登记逐层逐件比对
function checkPositionReset(box, observed) {
  const expected = (box.items || []).map((item) => ({ itemId: item.itemId, layer: item.layer, boxNo: item.boxNo }));
  const mismatches = [];
  const observedMap = new Map((observed || []).map((entry) => [String(entry.itemId), entry]));
  for (const item of expected) {
    const entry = observedMap.get(item.itemId);
    if (!entry) {
      mismatches.push({ code: 'ITEM_NOT_RESET', itemId: item.itemId, boxNo: item.boxNo, expectedLayer: item.layer, message: item.itemId + ' 未复位到箱内' });
    } else if (Number(entry.layer) !== item.layer || (entry.boxNo && String(entry.boxNo) !== item.boxNo)) {
      mismatches.push({
        code: 'RESET_POSITION_MISMATCH',
        itemId: item.itemId,
        boxNo: item.boxNo,
        expectedLayer: item.layer,
        observedLayer: Number(entry.layer),
        observedBoxNo: entry.boxNo ? String(entry.boxNo) : item.boxNo,
        message: item.itemId + ' 复位位置不符'
      });
    }
  }
  for (const [itemId, entry] of observedMap.entries()) {
    if (!expected.some((item) => item.itemId === itemId)) {
      mismatches.push({ code: 'RESET_EXTRA_ITEM', itemId, message: itemId + ' 不属于本装箱单' });
    }
  }
  return { reset: mismatches.length === 0, mismatches };
}

// 更正配重或层位：资格/解封失效并按新值重算
// patch: [{ itemId, weightGrams?, layer? }]
function applyCorrection(box, patch, headMap, accessoryMap, config) {
  if (!Array.isArray(patch) || patch.length === 0) {
    throw httpError(400, 'INVALID_CORRECTION', 'corrections 必须为非空数组');
  }
  const indexByItem = new Map((box.items || []).map((item, index) => [item.itemId, index]));
  const nextItems = (box.items || []).map((item) => ({ ...item }));
  const changed = [];

  for (const change of patch) {
    const index = indexByItem.get(String(change.itemId));
    if (index === undefined) {
      throw httpError(400, 'ITEM_NOT_IN_ORDER', '更正对象不在本装箱单: ' + change.itemId);
    }
    const before = { ...nextItems[index] };
    if (change.weightGrams !== undefined) {
      const weightGrams = Number(change.weightGrams);
      if (!Number.isFinite(weightGrams) || weightGrams <= 0) {
        throw httpError(400, 'INVALID_ITEM', 'weightGrams（单件克重）必须为正数');
      }
      nextItems[index].weightGrams = weightGrams;
    }
    if (change.layer !== undefined) {
      const layer = Number(change.layer);
      const maxLayer = config.maxLayer;
      if (!Number.isInteger(layer) || layer < 1 || (maxLayer && layer > maxLayer)) {
        throw httpError(400, 'INVALID_ITEM', 'layer（层位）必须在 1..' + (maxLayer || '') + ' 之间');
      }
      nextItems[index].layer = layer;
    }
    if (nextItems[index].weightGrams !== before.weightGrams || nextItems[index].layer !== before.layer) {
      changed.push({ itemId: before.itemId, before, after: { ...nextItems[index] } });
    }
  }
  if (changed.length === 0) {
    throw httpError(400, 'NO_CHANGE', '更正内容与现值一致，无变更');
  }

  // 按新值重算装箱资格（本单自身占用不算占用冲突）
  const violations = evaluatePacking(nextItems, headMap, accessoryMap, config, box.id);

  // 解封与装箱资格失效：清解封进度；状态按新值重算（不过转待复核，待复核单更正通过则回到巡演中）
  const wasQualified = box.packingQualified !== false;
  const wasReleasedProgress = (box.returnStreak || 0) > 0 || box.positionReset === true;
  let nextStatus = box.status;
  if (violations.length) {
    nextStatus = '待复核';
  } else if (box.status === '待复核') {
    nextStatus = '巡演中';
  }

  const nextBox = withSummary({
    ...box,
    items: nextItems,
    status: nextStatus,
    packingQualified: violations.length === 0,
    qualificationViolations: violations,
    sealed: false,
    seals: {},
    sealedAt: null,
    returnConfirms: [],
    returnStreak: 0,
    doubleConfirmed: false,
    positionReset: false,
    positionResetAt: null,
    correctedFromRevision: (box.revisionNo || 0) + 1
  });

  return {
    nextBox,
    changed,
    violations,
    qualificationInvalidated: wasQualified || wasReleasedProgress,
    releaseInvalidated: wasReleasedProgress
  };
}

module.exports = {
  httpError,
  isFragile,
  weightByBox,
  withSummary,
  normalizeItems,
  evaluatePacking,
  findHeadConflicts,
  inspectArrival,
  applyReturnConfirm,
  releaseBlockers,
  checkPositionReset,
  applyCorrection
};

// 端到端验证：配重分层、整单拒绝、重放、409 占用、到场待复核、返场解封台、更正重算、一致性
const http = require('http');

const BASE = { host: 'localhost', port: 3914 };
let pass = 0;
let fail = 0;

function call(method, path, data) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? null : Buffer.from(JSON.stringify(data));
    const req = http.request({ ...BASE, path, method, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {} }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let json = null;
        try { json = chunks ? JSON.parse(chunks) : null; } catch { json = { _raw: chunks }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let counter = 0;
function check(desc, expected, actual) {
  const same = JSON.stringify(expected) === JSON.stringify(actual);
  if (same) { pass++; console.log('PASS:', desc, '(' + JSON.stringify(actual) + ')'); }
  else { fail++; console.log('FAIL:', desc, '\n   expected =', JSON.stringify(expected), '\n   actual   =', JSON.stringify(actual)); }
}

async function main() {
  console.log('== 0. 种子与通用接口 ==');
  check('health 200', 200, (await call('GET', '/health')).status);
  let r = await call('GET', '/api/puppetHeads?status=' + encodeURIComponent('可演出'));
  check('可演出偶头数量=2', 2, r.body.length);

  console.log('== 1. 正常装箱登记（箱号/层位/单件克重，重头不压脆） ==');
  r = await call('POST', '/api/tour/packing', {
    showName: '火焰山·苏州站', venue: '苏州开明', play: '火焰山',
    actor: '装箱师阿福', sealCode: '封签-A-17', submitKey: 'k-ok-1',
    items: [
      { itemType: 'accessory', itemId: 'accessory-seed-2', boxNo: '箱1', layer: 1, weightGrams: 300 },
      { itemType: 'head', itemId: 'head-seed-2', boxNo: '箱1', layer: 2, weightGrams: 1200 }
    ]
  });
  check('正常装箱 201', 201, r.status);
  const box1 = r.body.boxId;
  r = await call('GET', '/api/puppetHeads/head-seed-2');
  check('偶头占用后=已装箱', '已装箱', r.body.status);
  r = await call('GET', '/api/accessories/accessory-seed-2');
  check('脆配件占用后=已装箱', '已装箱', r.body.status);

  console.log('== 2. 同箱总重超限 → 422 整单拒绝，无半成品 ==');
  r = await call('POST', '/api/tour/packing', {
    showName: '超重场', venue: '南京', play: '火焰山', actor: '装箱师阿福', submitKey: 'k-heavy-1',
    items: [{ itemType: 'head', itemId: 'head-seed-3', boxNo: '箱9', layer: 1, weightGrams: 1900, boxWeightLimitGrams: 1800 }]
  });
  check('超重 422', 422, r.status);
  check('码 BOX_WEIGHT_EXCEEDED', 'BOX_WEIGHT_EXCEEDED', r.body.code);
  check('拒绝原因含同箱总重', true, r.body.reasons.some((x) => x.includes('同箱总重')));
  r = await call('GET', '/api/tourBoxes?showName=' + encodeURIComponent('超重场'));
  check('无半成品箱单', 0, r.body.length);
  // 无 submitKey：同报文重放（指纹键）也沿用首次结果
  const fpBody = {
    showName: '指纹场', venue: '镇江', play: '火焰山', actor: '装箱师乙',
    items: [{ itemType: 'head', itemId: 'head-seed-3', boxNo: '箱6', layer: 1, weightGrams: 1900, boxWeightLimitGrams: 1800 }]
  };
  r = await call('POST', '/api/tour/packing', fpBody);
  check('指纹首次 422', 422, r.status);
  r = await call('POST', '/api/tour/packing', fpBody);
  check('指纹重放 422 + replayed', [422, true], [r.status, r.body.replayed]);

  console.log('== 3. 重偶头压脆配件 → 422；重头在下则放行 ==');
  r = await call('POST', '/api/accessories', { name: '点翠小钗', role: '旦角', play: '火焰山', boxNo: '配件箱-03', fragile: true });
  const acc2 = r.body.id;
  r = await call('POST', '/api/tour/packing', {
    showName: '重压脆场', venue: '无锡', play: '火焰山', actor: '装箱师阿福', submitKey: 'k-crush-3',
    items: [
      { itemType: 'head', itemId: 'head-seed-3', boxNo: '箱8', layer: 2, weightGrams: 1900 },
      { itemType: 'accessory', itemId: acc2, boxNo: '箱8', layer: 1, weightGrams: 200 }
    ]
  });
  check('重压脆 422', 422, r.status);
  check('码 HEAVY_ON_FRAGILE', 'HEAVY_ON_FRAGILE', r.body.code);
  r = await call('POST', '/api/tour/packing', {
    showName: '重压脆反例', venue: '常州', play: '火焰山', actor: '装箱师阿福', submitKey: 'k-crush-4',
    items: [
      { itemType: 'head', itemId: 'head-seed-3', boxNo: '箱8', layer: 1, weightGrams: 1900 },
      { itemType: 'accessory', itemId: acc2, boxNo: '箱8', layer: 2, weightGrams: 200 }
    ]
  });
  check('重头在下放行 201', 201, r.status);
  const box3 = r.body.boxId;

  console.log('== 4. 偶头在未结束箱单中重复 → 409 且无半成品 ==');
  r = await call('POST', '/api/tour/packing', {
    showName: '冲突场', venue: '上海', play: '火焰山', actor: '装箱师乙', submitKey: 'k-dup-1',
    items: [{ itemType: 'head', itemId: 'head-seed-2', boxNo: '箱7', layer: 1, weightGrams: 1200 }]
  });
  check('占用冲突 409', 409, r.status);
  check('码 HEAD_OCCUPIED', 'HEAD_OCCUPIED', r.body.code);
  r = await call('GET', '/api/tourBoxes?showName=' + encodeURIComponent('冲突场'));
  check('冲突无半成品', 0, r.body.length);

  console.log('== 5. 重放沿用首次结果（含拒绝） ==');
  r = await call('POST', '/api/tour/packing', {
    showName: '火焰山·苏州站', venue: '苏州开明', play: '火焰山',
    actor: '装箱师阿福', sealCode: '封签-A-17', submitKey: 'k-ok-1',
    items: [
      { itemType: 'accessory', itemId: 'accessory-seed-2', boxNo: '箱1', layer: 1, weightGrams: 300 },
      { itemType: 'head', itemId: 'head-seed-2', boxNo: '箱1', layer: 2, weightGrams: 1200 }
    ]
  });
  check('成功键重放 201', 201, r.status);
  check('replayed 标记', true, r.body.replayed);
  check('同一箱号', box1, r.body.boxId);
  r = await call('POST', '/api/tour/packing', {
    showName: '超重场', venue: '南京', play: '火焰山', actor: '装箱师阿福', submitKey: 'k-heavy-1',
    items: [{ itemType: 'head', itemId: 'head-seed-3', boxNo: '箱9', layer: 1, weightGrams: 1900, boxWeightLimitGrams: 1800 }]
  });
  check('拒绝键重放 422', 422, r.status);
  check('拒绝重放 replayed', true, r.body.replayed);
  r = await call('GET', '/api/tourBoxes?showName=' + encodeURIComponent('超重场'));
  check('重放不产生第二单', 0, r.body.length);

  console.log('== 6. 到场错层+封签不符只转待复核，占用不变 ==');
  r = await call('POST', `/api/tour/boxes/${box1}/arrival`, {
    actor: '跟箱师丙', sealCode: '封签-被调换',
    observedItems: [{ itemType: 'head', itemId: 'head-seed-2', layer: 3 }]
  });
  check('到场异常 200', 200, r.status);
  check('转待复核', '待复核', r.body.box.status);
  check('findings=2', ['SEAL_MISMATCH', 'WRONG_LAYER'], r.body.findings.map((f) => f.type).sort());
  r = await call('GET', '/api/puppetHeads/head-seed-2');
  check('待复核不解除占用', '已装箱', r.body.status);

  console.log('== 7. 更正配重致重压脆 → 资格失效、旧稿留档、解封 409 ==');
  r = await call('POST', `/api/tour/boxes/${box1}/correct`, {
    actor: '装箱师阿福', reason: '复称更正',
    items: [{ itemType: 'head', itemId: 'head-seed-2', weightGrams: 1900 }]
  });
  check('更正 200', 200, r.status);
  check('装箱资格 false', false, r.body.packingEligible);
  check('解封资格 false', false, r.body.unsealEligible);
  check('旧稿留档 1 版', 1, r.body.archivedRevisions);
  check('不通过原因含重压脆', true, r.body.reasons.some((x) => x.includes('压在脆配件')));
  r = await call('POST', `/api/tour/boxes/${box1}/unseal`, { actor: '跟箱师丙' });
  check('资格失效解封 409', 409, r.status);

  console.log('== 8. 再更正恢复 → 复核无误 → 解封进入返场清点 ==');
  r = await call('POST', `/api/tour/boxes/${box1}/correct`, {
    actor: '装箱师阿福', reason: '重新复称无误',
    items: [{ itemType: 'head', itemId: 'head-seed-2', weightGrams: 1200 }]
  });
  check('资格恢复 true', true, r.body.packingEligible);
  r = await call('POST', `/api/tour/boxes/${box1}/arrival`, {
    actor: '跟箱师丙', sealCode: '封签-A-17',
    observedItems: [
      { itemType: 'head', itemId: 'head-seed-2', layer: 2 },
      { itemType: 'accessory', itemId: 'accessory-seed-2', layer: 1 }
    ]
  });
  check('复核无误 200', 200, r.status);
  check('findings 为空', 0, r.body.findings.length);
  r = await call('POST', `/api/tour/boxes/${box1}/unseal`, { actor: '跟箱师丙' });
  check('解封 200', 200, r.status);
  check('返场清点中', '返场清点中', r.body.box.status);

  console.log('== 9. 返场清点：装箱人拒绝、换人打断连续两次 ==');
  r = await call('POST', `/api/tour/boxes/${box1}/return-confirm`, { actor: '装箱师阿福' });
  check('装箱人 409', 409, r.status);
  check('码 CONFIRMER_MUST_BE_OTHER', 'CONFIRMER_MUST_BE_OTHER', r.body.code);
  r = await call('POST', `/api/tour/boxes/${box1}/return-confirm`, { actor: '点验人丁' });
  check('他人第一次 200 未解封', [200, false, 1], [r.status, r.body.released, r.body.confirmations]);
  r = await call('POST', `/api/tour/boxes/${box1}/return-confirm`, { actor: '点验人戊' });
  check('换人插入计数归 1 且未解封', [200, false, 1], [r.status, r.body.released, r.body.confirmations]);
  r = await call('POST', `/api/tour/boxes/${box1}/return-confirm`, { actor: '点验人戊' });
  // 两次到齐但修补/复位未满足，仍不解封
  check('同人第二次到齐仍被闸门拦', [200, false, 2], [r.status, r.body.released, r.body.confirmations]);
  check('blockers 含未复位', true, r.body.blockers.some((b) => b.code === 'POSITION_NOT_RESTORED'));

  console.log('== 10. 修补未完成 + 位置未复位 不能解封；全部满足后闭环解占 ==');
  r = await call('POST', `/api/tour/boxes/${box1}/repairs`, {
    actor: '点验人戊', puppetHeadId: 'head-seed-2', repairType: '补漆', handler: '漆匠己'
  });
  check('登记修补 201', 201, r.status);
  const repairId = r.body.id;
  r = await call('GET', '/api/puppetHeads/head-seed-2');
  check('箱内偶头转待修补', '待修补', r.body.status);
  r = await call('POST', `/api/tour/boxes/${box1}/restore`, {
    actor: '点验人戊',
    positions: [{ itemType: 'head', itemId: 'head-seed-2', boxNo: '箱1', layer: 1 }]
  });
  check('位置核对不符 422', 422, r.status);
  check('码 POSITION_MISMATCH', 'POSITION_MISMATCH', r.body.code);
  r = await call('POST', `/api/tour/boxes/${box1}/restore`, {
    actor: '点验人戊',
    positions: [
      { itemType: 'head', itemId: 'head-seed-2', boxNo: '箱1', layer: 2 },
      { itemType: 'accessory', itemId: 'accessory-seed-2', boxNo: '箱1', layer: 1 }
    ]
  });
  check('位置复位但修补未完', [200, false], [r.status, r.body.released]);
  check('blockers 含 REPAIR_NOT_FINISHED', true, r.body.blockers.some((b) => b.code === 'REPAIR_NOT_FINISHED'));
  r = await call('PATCH', `/api/tour/repairs/${repairId}`, { actor: '漆匠己', status: '已完成' });
  check('修补完成 200', 200, r.status);
  check('完成即触发解封闭环', true, r.body.release.released);
  r = await call('GET', `/api/tour/boxes/${box1}`);
  check('箱单已闭环', '已闭环', r.body.status);
  r = await call('GET', '/api/puppetHeads/head-seed-2');
  check('偶头解除占用回可演出', '可演出', r.body.status);
  r = await call('GET', '/api/accessories/accessory-seed-2');
  check('配件解除占用回在库', '在库', r.body.status);

  console.log('== 11. 反例箱走完解封；闭环后偶头可再装箱；履历/数量一致 ==');
  await call('POST', `/api/tour/boxes/${box3}/arrival`, { actor: '跟箱师丙', observedItems: [] });
  await call('POST', `/api/tour/boxes/${box3}/unseal`, { actor: '跟箱师丙' });
  r = await call('POST', `/api/tour/boxes/${box3}/return-confirm`, { actor: '点验人丁' });
  r = await call('POST', `/api/tour/boxes/${box3}/restore`, { actor: '点验人丁' });
  check('仅 1 次确认不解封', false, r.body.released);
  r = await call('POST', `/api/tour/boxes/${box3}/return-confirm`, { actor: '点验人丁' });
  check('两次确认后闭环', '已闭环', r.body.box.status);
  r = await call('GET', '/api/puppetHeads/head-seed-3');
  check('head-seed-3 回可演出', '可演出', r.body.status);
  r = await call('POST', '/api/tour/packing', {
    showName: '加场杭州', venue: '杭州', play: '火焰山', actor: '装箱师阿福', submitKey: 'k-ok-2',
    items: [{ itemType: 'head', itemId: 'head-seed-2', boxNo: '箱3', layer: 1, weightGrams: 1200 }]
  });
  check('闭环后再装箱 201', 201, r.status);
  const box2 = r.body.boxId;
  r = await call('GET', `/api/tourBoxes/${box1}/timeline`);
  check('箱1履历事件 >= 8', true, r.body.events.length >= 8);
  const actions = r.body.events.map((e) => e.action);
  check('履历含更正/解封/闭环', ['更正配重/层位并重算', '解封入返场清点', '解封闭环'].every((a) => actions.includes(a)), true);
  r = await call('GET', '/api/tour/overview');
  check('占用偶头=1 闭环=2 活跃=1', { h: 1, c: 2, a: 1 }, {
    h: r.body.counts.tour.occupiedHeads,
    c: r.body.counts.tour.closedBoxes,
    a: r.body.counts.tour.activeBoxes
  });
  r = await call('GET', `/api/tour/boxes/${box2}/layout`);
  check('布局按箱分层', { boxNo: '箱3', layer: 1 }, { boxNo: r.body.byBox['箱3'][0].boxNo, layer: r.body.byBox['箱3'][0].layer });

  console.log('== 12. 已闭环箱单拒绝更正；报文级错误不落拒绝台账 ==');
  r = await call('POST', `/api/tour/boxes/${box1}/correct`, { actor: '装箱师阿福', items: [{ itemType: 'head', itemId: 'head-seed-2', weightGrams: 1 }] });
  check('闭环箱更正 409', 409, r.status);
  r = await call('POST', '/api/tour/packing', {
    showName: '坏报文', venue: '宁波', play: '火焰山', actor: '装箱师阿福', submitKey: 'k-bad-1',
    items: [{ itemType: 'head', itemId: 'head-seed-2', boxNo: '箱5', layer: 0, weightGrams: 1200 }]
  });
  check('层位非法 400', 400, r.status);
  // 报文修正为业务冲突（头在 box2 占用），同一 submitKey 首次入台账
  r = await call('POST', '/api/tour/packing', {
    showName: '坏报文', venue: '宁波', play: '火焰山', actor: '装箱师阿福', submitKey: 'k-bad-1',
    items: [{ itemType: 'head', itemId: 'head-seed-2', boxNo: '箱5', layer: 1, weightGrams: 1200 }]
  });
  check('修正后业务冲突 409', 409, r.status);
  r = await call('POST', '/api/tour/packing', {
    showName: '坏报文', venue: '宁波', play: '火焰山', actor: '装箱师阿福', submitKey: 'k-bad-1',
    items: [{ itemType: 'head', itemId: 'head-seed-2', boxNo: '箱5', layer: 1, weightGrams: 1200 }]
  });
  check('冲突键重放带 replayed', [409, true], [r.status, r.body.replayed]);

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

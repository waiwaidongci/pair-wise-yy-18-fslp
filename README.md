# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。
本版扩展了**偶头配重分层**与**返场解封台**，巡演业务拆为三个文件：

| 文件 | 职责 |
| --- | --- |
| `tour/tourRoutes.js` | 路由与 HTTP 编排、状态码映射 |
| `tour/tourRules.js` | 判定（配重分层、冲突、到场、返场解封、更正重算），纯函数 |
| `tour/tourStore.js` | 记录存储（装箱单、提交台账、占用、修补、数量统计） |
| `lib/db.js` | SQLite 连接、事务、通用 records/events 读写 |

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914
SQLite 数据库首次启动创建到 `data/app.db`（通过 `sqlite3` Node 驱动，参数化查询，无需 sqlite3 命令行）。

## 装箱登记：`POST /api/tour/packing`

每条明细必须登记**箱号 `boxNo`、层位 `layer`、单件克重 `weightGrams`**。
层位约定：数字越小越靠箱底（1 为底层）。

```json
{
  "showName": "火焰山·苏州站",
  "venue": "苏州开明大戏院",
  "play": "火焰山",
  "actor": "装箱师阿福",
  "sealCode": "封签-A-017",
  "submitKey": "tour-2026-suzhou-01",
  "items": [
    { "itemType": "head", "itemId": "head-seed-2", "boxNo": "箱1", "layer": 1, "weightGrams": 1200 },
    { "itemType": "accessory", "itemId": "accessory-seed-2", "boxNo": "箱1", "layer": 2, "weightGrams": 300 }
  ]
}
```

判定规则（任一不过**整单拒绝**，不产生装箱单半成品）：

- **同箱总重超限**：按箱汇总克重，超过该箱上限（默认 4000 克，可在明细上用
  `boxWeightLimitGrams` 逐箱指定）→ `422 BOX_WEIGHT_EXCEEDED`。
- **重偶头压脆配件**：偶头克重 ≥ 1500 克为重偶头；同箱内重偶头层位数字大于
  `fragile: true` 配件即视为压在脆件上方 → `422 HEAVY_ON_FRAGILE`。
- **偶头在未结束装箱单中只能出现一次**：同一提交内重复、或已被其它未闭环装箱单
  占用 → `409`，不写入任何半成品。
- 偶头须为「可演出」、配件须为「在库」，否则 `422`。

**重放沿用首次结果**：相同 `submitKey`（不传则由报文要素生成指纹）重放时直接返回
首次结论——首次被整单拒绝也返回首次的拒绝结果，不重新判定、不重复建单。拒绝台账
存于 `packing_submissions` 表。

## 到场核验：`POST /api/tour/boxes/:id/arrival`

上报实际层位 `observedItems[].layer` 与到场封签 `sealCode`。
发现**错层或封签不符只转「待复核」**（`findings` 列异常明细），不解除占用、不改资格；
核验无误则进入「巡演中」。

## 返场解封台

1. `POST /api/tour/boxes/:id/unseal`：校验解封资格。配重或层位更正后资格已失效的，
   返回 `409 UNSEAL_QUALIFICATION_INVALID`，不得开箱。
2. `POST /api/tour/boxes/:id/return-confirm`：返场清点须**装箱人之外的另一人**
   **连续两次**确认。换人插入则计数作废、从新人重新计起。
3. `POST /api/tour/boxes/:id/repairs`：箱内偶头修补登记（`repairType`、`handler`），
   偶头转「待修补」。`PATCH /api/tour/repairs/:id` 推进修补，状态置「已完成」时偶头
   恢复「可演出」。
4. `POST /api/tour/boxes/:id/restore`：声明**箱内位置复位**，可随 `positions` 逐件
   核对（箱号+层位不符返回 `422 POSITION_MISMATCH`）。

**解除占用闸门**：修补全部完成、箱内位置复位、另一人连续两次确认、解封资格有效，
四条同时满足才解封——偶头回「可演出」、配件回「在库」、装箱单转「已闭环」。
任一不满足保持「返场清点中」并回执 `blockers`。

## 更正配重/层位：`POST /api/tour/boxes/:id/correct`

- 传入需要改动的明细（`weightGrams` / `layer` / `boxNo`），**解封资格与装箱资格
  一并失效并按新值全量重算**；重算不过则装箱单转「待复核」。
- **旧稿留档**：更正前的明细、资格与到场发现存入 `revisionHistory`。
- 返场两次确认与位置复位结论同时作废，须重新确认/复位。

## 一致的记录视图

- `GET /api/tour/boxes/:id/layout`：按箱号、层位（自下而上）查看分层布局。
- `GET /api/tour/boxes/:id` 与 `GET /api/tourBoxes/:id/timeline`：装箱单与履历。
- `GET /api/tour/overview`：数量刷新（各集合按状态计数、占用中偶头/配件数），
  与装箱记录、履历同库同事务聚合，刷新后三者一致。

## 既有通用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords` / `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

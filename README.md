# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱（偶头配重分层）与返场解封台。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `server.js` | 入口：通用集合 CRUD、挂载巡演业务路由、错误处理 |
| `lib/db.js` | SQLite 引擎（records/events/idempotency 三表） |
| `tour/routes.js` | 业务文件①路由：HTTP 编排与幂等重放 |
| `tour/rules.js` | 业务文件②判定：重量分层、唯一冲突、到场核验、双人确认、解封门禁、更正重算 |
| `tour/store.js` | 业务文件③记录存储：装箱单/占用/履历/旧稿的事务化落库 |

## 巡演装箱业务接口（均在 `/api` 下）

### 1. 装箱登记 `POST /tourBoxes/pack`

每件须登记 `itemType`（head/accessory）、`itemId`、`boxNo`（箱号）、`layer`（层位，数字越大越靠上）、`weightGrams`（单件克重）。

- 同箱总重超过 `tour.boxWeightLimitGrams`（默认 15000 克）→ **整单拒绝（422）**
- 重偶头（≥ `tour.heavyHeadGrams`，默认 2500 克）压在脆配件上层（同箱且层位更高）→ **整单拒绝（422）**
- 偶头在任一未结束装箱单（草稿/已装箱/巡演中/待复核/返场清点中）中重复出现，或本单内重复登记 → **409**
- 校验全部通过后单事务落库（装箱单 + 偶头/配件占用 + 履历），**失败不产生半成品**
- 支持 `Idempotency-Key` 请求头（或 body 中 `requestId`）：同键重放沿用**首次状态码与响应体**，不重复执行

### 2. 出发封签 `POST /tourBoxes/:id/seal`

body 带每个箱号的 `seals` 与 `actor`；封签不全 400，装箱资格失效 409。

### 3. 到场核验 `POST /tourBoxes/:id/arrival`

提交 `observedLayers` 与 `observedSeals`：

- 错层、缺件、封签缺失/不符 → 状态转为 **待复核**，只记录不符明细，**不拒绝、不闭环**
- 全部一致 → 状态进入 `巡演中`

### 4. 返场清点确认 `POST /tourBoxes/:id/return-check`

- 确认人必须**不是装箱人**（否则 409）
- 同一另一人**连续两次**确认后，进入 `返场清点中`；换人确认则连击清零重计

### 5. 箱内位置复位 `POST /tourBoxes/:id/reset-position`

逐层逐件与装箱登记比对，全部一致才标记 `positionReset`。

### 6. 解封台 `POST /tourBoxes/:id/release`（查看门禁 `GET /tourBoxes/:id/release-status`）

须同时满足：另一人连续两次确认、关联修补记录全部完成、箱内位置复位完成、非待复核。
任一不满足返回 409 并列出门禁；全部满足后偶头/配件解除占用（偶头回「可演出」、配件回「在库」），装箱单闭环。

### 7. 更正配重/层位 `POST /tourBoxes/:id/corrections`

- 更正后**解封进度与封签作废**（确认记录、复位标记、封签清空），装箱资格按新值重算
- 重算不过 → 转 `待复核`；待复核单更正后重算通过 → 回 `巡演中`
- 更正前整稿存入 `tourBoxRevisions`（**旧稿留档**），履历记录每件的前值/后值

### 8. 其他

- `GET /tourBoxes/:id/history`：装箱单履历 + 旧稿
- `GET /tour-overview`：装箱、占用、履历留档数量汇总（每次请求实时刷新，三处一致）
- `GET /api/puppetHeads?play=火焰山&status=可演出` 等通用集合接口不变；`tourBoxes` 的通用 POST/PATCH/DELETE/events 已封禁（405），必须走业务接口

SQLite 数据库文件在首次启动时创建到 `data/app.db`。

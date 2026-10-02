# 市场微观结构分析服务

纯后端 Node.js + TypeScript 服务，用于订单簿事件接入、历史行情重放、市场微观结构指标分析、策略沙盒、风险校验和撮合仿真。

## 能力范围

- 订单簿快照、逐笔成交、新单、撤单、行情事件接入
- 按交易日与时间顺序重放市场状态，支持单步、倍速运行
- 盘口深度、价差、订单失衡、冲击成本、成交概率、滑点、流动性指标
- 策略沙盒限价单/市价单模拟，保留资金、持仓、成交与审计轨迹
- 资金、持仓、下单频率、撤单率、价格偏离、最大回撤风险规则
- 价格优先/时间优先的基础撮合与部分成交
- 策略收益、风险暴露、最大回撤、成交率与异常交易事件

## 启动

```bash
npm install
npm run dev
```

服务默认运行在 `http://127.0.0.1:6190`。

## 关键接口

```text
GET  /api/health
GET  /api/instruments
POST /api/market-data/events
GET  /api/orderbook/:symbol
POST /api/replay/sessions
GET  /api/replay/sessions/:id
POST /api/replay/sessions/:id/step
POST /api/replay/sessions/:id/run
GET  /api/analytics/:symbol
POST /api/sandbox/orders
POST /api/sandbox/cancel
GET  /api/sandbox/strategies/:strategyId/orders            # 活动订单（含部分成交），可按 symbol/status 过滤
GET  /api/sandbox/strategies/:strategyId/orders/:orderId   # 单笔订单状态
GET  /api/sandbox/strategies/:strategyId/performance
GET  /api/sandbox/strategies/:strategyId/events
GET  /api/anomalies
GET  /api/metrics
```

所有数据默认存储在内存中，适合作为后端业务原型和后续接入 PostgreSQL、TimescaleDB、Kafka/NATS 的基础。

## 沙盒订单生命周期

订单状态机：`active → partially_filled → filled`，或任意活动状态 → `cancelled`（用户撤单 / `unfilled_market`），风控拒绝为 `rejected`。

- 下单即冻结资源：买单按 `价格 × 数量 × (1 + 费率)` 冻结现金，卖单冻结对应标的的可卖数量；成交按成交量逐笔释放，撤单只释放剩余部分。
- 风控检查纳入未结订单：买单可用资金为 `现金 - 未结买单冻结`，卖单可卖数量为 `持仓 - 未结卖单冻结`。
- 重复撤单返回 `409 ORDER_NOT_ACTIVE`，不重复释放占用；跨策略撤单/查单返回 `403` / `404`，策略间互不可见。
- 市价单未成交量立即按 `cancelled / unfilled_market` 撤销并释放占用。
- performance 区分 `realized`（已终结订单的成交）与 `open`（活动/部分成交订单的影响、剩余量、占用）。

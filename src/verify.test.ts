import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketEngine } from './engine.js';
import { MarketEvent } from './types.js';

/** 构造一个深度充足（每档 100）、价位在 center 附近的新标的，避免受种子行情影响 */
let bookSeq = 1;
function freshBook(engine: MarketEngine, symbol: string, depth = 10, size = 100, center = 100): void {
  const bids = Array.from({ length: depth }, (_, i) => ({ price: +(center - 0.01 * (i + 1)).toFixed(2), quantity: size }));
  const asks = Array.from({ length: depth }, (_, i) => ({ price: +(center + 0.01 * (i + 1)).toFixed(2), quantity: size }));
  const seq = ++bookSeq;
  // 使用 2026-10-01 的较早基准，保证测试内后续事件都可以给出更晚的时间戳
  engine.ingest({ id: `${symbol}-snap-${seq}`, symbol, tradingDay: '2026-10-02', timestamp: new Date(Date.UTC(2026, 9, 1, 0) + seq * 1000).toISOString(), sequence: 1_000_000 + seq, type: 'snapshot', bids, asks } as MarketEvent);
}

function buy(engine: MarketEngine, strategyId: string, symbol: string, quantity: number, price?: number) {
  return engine.submitOrder({ strategyId, symbol, side: 'buy', orderType: price === undefined ? 'market' : 'limit', price, quantity });
}
function sell(engine: MarketEngine, strategyId: string, symbol: string, quantity: number, price?: number) {
  return engine.submitOrder({ strategyId, symbol, side: 'sell', orderType: price === undefined ? 'market' : 'limit', price, quantity });
}

test('多笔挂单：买单冻结资金、卖单冻结可卖数量，风控纳入未结订单', () => {
  const engine = new MarketEngine();
  freshBook(engine, 'AAA');

  // 连续 20 笔不成交的买单（挂买一 99.99 下方），每笔 500 股 = 49,990
  for (let i = 0; i < 20; i++) {
    const r = buy(engine, 'S-multi', 'AAA', 500, 99.00);
    assert.equal(r.accepted, true, `第 ${i + 1} 笔买单应被接受`);
    assert.equal(r.order!.status, 'new');
    assert.equal(r.order!.reservedCash, 49_500);
  }
  const account = engine.account('S-multi');
  assert.equal(engine.listOrders('S-multi').length, 20, '应有 20 笔活动订单');
  assert.ok(Math.abs(account.reservedCash - 20 * 49_500) < 1e-6, '冻结资金应为 20 笔名义金额之和');

  // 可用资金仅剩 10,000，再挂 500 股应被风控拒绝（而非重复使用资金）
  const blocked = buy(engine, 'S-multi', 'AAA', 500, 99.00);
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.risk.code, 'INSUFFICIENT_CASH');
  assert.equal(blocked.order!.status, 'rejected');
  assert.ok(Math.abs(account.reservedCash - 20 * 49_500) < 1e-6, '拒单不新增冻结');

  // 撤掉一笔后释放，之前被拒的单现在可以再下
  const firstId = engine.listOrders('S-multi')[0].id;
  const cancel = engine.cancel('S-multi', firstId);
  assert.equal(cancel.cancelled, true);
  assert.equal(cancel.order!.reservedCash, 0);
  const retried = buy(engine, 'S-multi', 'AAA', 500, 99.00);
  assert.equal(retried.accepted, true);
  assert.equal(engine.listOrders('S-multi').length, 20);

  // 卖单冻结可卖数量：先买 300 股现货
  freshBook(engine, 'BBB');
  const establish = buy(engine, 'S-sell', 'BBB', 300); // market
  assert.equal(establish.accepted, true);
  assert.equal(engine.account('S-sell').position.BBB, 300);
  for (let i = 0; i < 5; i++) {
    const r = sell(engine, 'S-sell', 'BBB', 60, 101.00);
    assert.equal(r.accepted, true, `第 ${i + 1} 笔卖单应被接受`);
    assert.equal(r.order!.reservedQuantity, 60);
  }
  assert.equal(engine.account('S-sell').reservedPosition.BBB, 300);
  const oversell = sell(engine, 'S-sell', 'BBB', 1, 101.00);
  assert.equal(oversell.accepted, false);
  assert.equal(oversell.risk.code, 'INSUFFICIENT_POSITION');

  // 撤一笔卖单后重新释放可卖数量，可再卖
  const sellOrders = engine.listOrders('S-sell');
  assert.equal(sellOrders.length, 5);
  const release = engine.cancel('S-sell', sellOrders[0].id);
  assert.equal(release.cancelled, true);
  const resold = sell(engine, 'S-sell', 'BBB', 60, 101.00);
  assert.equal(resold.accepted, true);
  assert.equal(engine.account('S-sell').reservedPosition.BBB, 300);
});

test('部分成交：taker 与 resting maker 均结算并按成交量释放占用', () => {
  const engine = new MarketEngine();
  freshBook(engine, 'CCC', 5, 100); // 5 档，每档 100

  // 限价买 400，扫掉前 3 档卖单 300 股，剩 100 挂起
  const r = buy(engine, 'S-part', 'CCC', 400, 100.03);
  assert.equal(r.accepted, true);
  assert.equal(r.order!.status, 'partially_filled');
  assert.equal(r.order!.filledQuantity, 300);
  assert.equal(r.order!.remaining, 100);
  assert.equal(r.order!.reservedQuantity, 0, '买单不冻结数量');
  assert.ok(Math.abs(r.order!.reservedCash - 100.03 * 100) < 1e-6, '剩余 100 股继续冻结资金');
  assert.equal(engine.account('S-part').position.CCC, 300, '成交部分已入持仓');
  const expectedFrozen = 100.03 * 100;
  assert.ok(Math.abs(engine.account('S-part').reservedCash - expectedFrozen) < 1e-6);

  // 行情卖单（aggressor=sell）打到 100.03，使 resting 买单作为 maker 再成交 100
  const beforeFills = engine.fills.length;
  engine.ingest({ id: 'CCC-t1', symbol: 'CCC', tradingDay: '2026-10-02', timestamp: new Date(Date.UTC(2026, 9, 1, 12)).toISOString(), sequence: 2_000_001, type: 'trade', aggressorSide: 'sell', price: 100.03, quantity: 100 } as MarketEvent);
  const makerFills = engine.fills.slice(beforeFills).filter(f => f.strategyId === 'S-part');
  assert.equal(makerFills.length, 1, 'resting 挂单被吃时必须产生 maker 成交');
  assert.equal(makerFills[0].liquidity, 'maker');
  assert.equal(makerFills[0].quantity, 100);
  assert.equal(engine.account('S-part').position.CCC, 400);
  assert.equal(engine.account('S-part').reservedCash, 0, '全部成交后冻结资金清零');
  const order = engine.listOrders('S-part', { includeInactive: true })[0];
  assert.equal(order.status, 'filled');
  assert.equal(order.filledQuantity, 400);
  assert.equal(order.remaining, 0);
});

test('重复撤单幂等：不能重复释放，且不计撤单频率', () => {
  const engine = new MarketEngine();
  freshBook(engine, 'DDD');
  const r = buy(engine, 'S-cancel', 'DDD', 100, 99.00);
  const id = r.orderId;
  const frozen = engine.account('S-cancel').reservedCash;
  assert.ok(frozen > 0);

  const first = engine.cancel('S-cancel', id);
  assert.equal(first.cancelled, true);
  assert.equal(first.order!.status, 'cancelled');
  assert.equal(engine.account('S-cancel').reservedCash, 0, '首次撤单释放冻结');
  assert.equal(engine.account('S-cancel').cancelInWindow.length, 1);

  const second = engine.cancel('S-cancel', id);
  const third = engine.cancel('S-cancel', id);
  assert.equal(second.cancelled, false);
  assert.equal(second.code, 'ORDER_ALREADY_CANCELLED');
  assert.equal(third.cancelled, false);
  assert.equal(engine.account('S-cancel').reservedCash, 0, '重复撤单不重复释放');
  assert.equal(engine.account('S-cancel').cancelInWindow.length, 1, '重复撤单不计入撤单窗口');
  assert.equal(engine.listOrders('S-cancel').length, 0, '已撤单不在活动订单列表');

  // 对不存在的订单撤单也是安全失败
  const missing = engine.cancel('S-cancel', 'SIM-9999');
  assert.equal(missing.cancelled, false);
  assert.equal(missing.code, 'ORDER_NOT_FOUND');
});

test('跨策略隔离：不能撤/操作其他策略的订单，业绩互不可见', () => {
  const engine = new MarketEngine();
  freshBook(engine, 'EEE');
  const owner = buy(engine, 'S-owner', 'EEE', 100, 99.00);
  const frozenOwner = engine.account('S-owner').reservedCash;

  const cross = engine.cancel('S-intruder', owner.orderId);
  assert.equal(cross.cancelled, false);
  assert.equal(cross.code, 'ORDER_FORBIDDEN');
  assert.equal(engine.account('S-owner').reservedCash, frozenOwner, '被拒绝的跨策略撤单不得释放占用');
  assert.equal(engine.listOrders('S-owner').length, 1, '订单仍活动');
  assert.equal(engine.listOrders('S-intruder').length, 0, '入侵者看不到对方活动订单');

  // 审计轨迹
  const anomalies = engine.anomalies.filter(a => a.type === 'cross_strategy_cancel_denied');
  assert.equal(anomalies.length, 1);
  assert.deepEqual(anomalies[0].detail, { orderOwner: 'S-owner', requester: 'S-intruder' });

  // 原策略仍可正常撤单
  const own = engine.cancel('S-owner', owner.orderId);
  assert.equal(own.cancelled, true);

  // 业绩/事件互相隔离
  const other = buy(engine, 'S-owner2', 'EEE', 50); // market，成交
  assert.equal(other.accepted, true);
  const intruderPerf = engine.performance('S-intruder');
  assert.equal(intruderPerf.realized.fillCount, 0);
  const owner2Perf = engine.performance('S-owner2');
  assert.equal(owner2Perf.realized.fillCount >= 1, true);
  assert.equal(engine.strategyEvents('S-intruder').fills.length, 0);
});

test('市价单未完全成交：剩余部分撤单并释放占用，记录异常', () => {
  const engine = new MarketEngine();
  // 用低价标的避免触发单笔 50,000 名义金额上限：盘口共 1000 股、约 $10
  freshBook(engine, 'FFF', 10, 100, 10);

  const r = buy(engine, 'S-mkt', 'FFF', 1500);
  assert.equal(r.accepted, true);
  assert.equal(r.order!.filledQuantity, 1000);
  assert.equal(r.order!.remaining, 0, '残余不挂单');
  assert.equal(r.order!.status, 'cancelled', '未完全成交的市价单标记为已撤');
  assert.equal(r.order!.reservedCash, 0, '残余占用必须释放');
  assert.equal(engine.account('S-mkt').position.FFF, 1000);
  assert.equal(engine.account('S-mkt').reservedCash, 0);
  assert.equal(engine.listOrders('S-mkt').length, 0);
  const anomaly = engine.anomalies.find(a => a.type === 'unfilled_market_order');
  assert.ok(anomaly, '应记录未完全成交市价单异常');
  assert.equal((anomaly!.detail as { remaining: number }).remaining, 500);

  // 持仓 1000 股却卖 1500：风控前置拦截（冻结口径下也不能超卖）
  const oversell = engine.submitOrder({ strategyId: 'S-mkt', symbol: 'FFF', side: 'sell', orderType: 'market', quantity: 1500 });
  assert.equal(oversell.accepted, false);
  assert.equal(oversell.risk.code, 'INSUFFICIENT_POSITION');
});

test('performance 区分已实现盈亏与未结持仓影响', () => {
  const engine = new MarketEngine();
  freshBook(engine, 'GGG', 10, 100);

  // 100 股市价买入 @100.01（含费成本约 100.035/股）
  buy(engine, 'S-perf', 'GGG', 100);
  // 行情上移：重放快照把盘口抬到 $101，再市价卖 50 股 @100.99，锁定已实现盈亏
  freshBook(engine, 'GGG', 10, 100, 101);
  sell(engine, 'S-perf', 'GGG', 50);
  // 再挂一笔 20 股卖单在 102.00，保持未结，冻结可卖数量
  const resting = sell(engine, 'S-perf', 'GGG', 20, 102.00);
  assert.equal(resting.order!.status, 'new');

  const perf = engine.performance('S-perf');
  // 已实现：50*(100.99-100.035) - 费用 ≈ 46.49
  assert.ok(Math.abs(perf.realized.pnl - 46.49) < 0.05, `已实现盈亏异常: ${perf.realized.pnl}`);
  assert.ok(perf.realized.fees > 0);
  // 未结：剩余 50 股（其中 20 股被卖单冻结），mid 101.00，浮盈 ≈ 48.25
  const pos = perf.open.positions.find(p => p.symbol === 'GGG')!;
  assert.equal(pos.quantity, 50);
  assert.ok(Math.abs(pos.unrealizedPnl - 48.25) < 0.05, `未实现盈亏异常: ${pos.unrealizedPnl}`);
  assert.equal(perf.open.reservedPosition.GGG, 20);
  assert.equal(perf.account.availablePosition.GGG, 30);
  assert.equal(perf.open.orderCount, 1);
  assert.equal(perf.open.orders[0].reservedQuantity, 20);
  assert.ok(Math.abs(perf.totalPnl - (perf.realized.pnl + perf.open.unrealizedPnl)) < 1e-9);
});

test('沙盒挂单被其他沙盒单吃单：双边各自结算', () => {
  const engine = new MarketEngine();
  // 每档 50 股：A 买 50 后 100.01 档被扫空，A 在 100.05 挂卖 50
  freshBook(engine, 'HHH', 10, 50);

  buy(engine, 'S-A', 'HHH', 50);
  const ask = sell(engine, 'S-A', 'HHH', 50, 100.05);
  assert.equal(ask.order!.status, 'new');

  // B 限价买 250 @100.05：100.02..100.04 共 150 股 + 100.05 档种子 50 股 + A 的 50 股
  const cross = buy(engine, 'S-B', 'HHH', 250, 100.05);
  assert.equal(cross.accepted, true);
  assert.equal(cross.order!.filledQuantity, 250);

  const aFills = engine.fills.filter(f => f.strategyId === 'S-A');
  assert.equal(aFills.length, 2, 'A 应有买、卖各一笔成交');
  assert.equal(aFills[1].side, 'sell');
  assert.equal(aFills[1].liquidity, 'maker');
  assert.equal(aFills[1].price, 100.05);
  assert.equal(engine.account('S-A').position.HHH, 0, 'A 持仓回到 0');
  assert.equal(engine.account('S-A').reservedPosition.HHH ?? 0, 0, 'A 的卖单冻结已释放');
  assert.equal(engine.account('S-B').position.HHH, 250);
  assert.equal(engine.listOrders('S-A').length, 0);
});

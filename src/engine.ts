import { OrderBook } from './order-book.js';
import { Account, checkRisk } from './risk.js';
import { Analytics, BookOrder, Fill, MarketEvent, OrderView, OrderType, SandboxOrder, Side } from './types.js';

export type CancelResult = { cancelled: boolean; code?: string; message?: string; order?: OrderView };
export type SubmitOrderInput = { strategyId: string; symbol: string; side: Side; orderType: OrderType; price?: number; quantity: number };

const round4 = (value: number): number => +value.toFixed(4);
const round2 = (value: number): number => +value.toFixed(2);

export class MarketEngine {
  readonly books = new Map<string, OrderBook>();
  readonly events: MarketEvent[] = [];
  readonly fills: Fill[] = [];
  readonly anomalies: Array<Record<string, unknown>> = [];
  readonly accounts = new Map<string, Account>();
  /** 沙盒订单全生命周期台账，订单 ID -> 订单 */
  readonly orders = new Map<string, SandboxOrder>();
  private readonly seenSequences = new Set<string>();
  private orderSeq = 0;

  constructor() { this.seed(); }
  book(symbol: string): OrderBook { let book = this.books.get(symbol); if (!book) { book = new OrderBook(symbol); this.books.set(symbol, book); } return book; }
  ingest(event: MarketEvent): { accepted: boolean; anomaly?: Record<string, unknown> } {
    const key = `${event.symbol}:${event.sequence}`;
    if (this.seenSequences.has(key)) return { accepted: false, anomaly: this.recordAnomaly('duplicate_sequence', event, 'medium') };
    const previous = this.events.filter(item => item.symbol === event.symbol).at(-1);
    if (previous && event.sequence > previous.sequence + 1) this.recordAnomaly('sequence_gap', event, 'high');
    if (previous && event.timestamp < previous.timestamp) this.recordAnomaly('out_of_order_timestamp', event, 'medium');
    this.seenSequences.add(key); this.events.push(event); this.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence);
    // 行情事件（new_order/trade）可能命中沙盒挂单：aggressor 无 owner 不入台账，
    // 但被吃的沙盒挂单会产生 maker 成交，需要入台账、结算并释放占用
    const fills = this.book(event.symbol).apply(event).filter(fill => fill.strategyId);
    this.fills.push(...fills);
    if (fills.length) this.settleFills(fills, event.timestamp);
    return { accepted: true };
  }
  analytics(symbol: string): Analytics {
    const snapshot = this.book(symbol).snapshot(10); const bestBid = snapshot.bids[0]?.price ?? null; const bestAsk = snapshot.asks[0]?.price ?? null; const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null; const bidDepth = snapshot.bids.reduce((sum, l) => sum + l.quantity, 0); const askDepth = snapshot.asks.reduce((sum, l) => sum + l.quantity, 0); const impact = (side: Side, requested: number) => { const levels = side === 'buy' ? snapshot.asks : snapshot.bids; let left = requested, notional = 0, filled = 0; for (const level of levels) { const take = Math.min(left, level.quantity); notional += take * level.price; filled += take; left -= take; if (!left) break; } const averagePrice = filled ? notional / filled : null; const reference = side === 'buy' ? bestAsk : bestBid; return { quantity: requested, averagePrice: averagePrice ? +averagePrice.toFixed(4) : null, slippageBps: averagePrice && reference ? +(((side === 'buy' ? averagePrice - reference : reference - averagePrice) / reference) * 10_000).toFixed(2) : null, filled: +filled.toFixed(4) }; }; const imbalance = bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0; const weightedImbalance = snapshot.bids.length && snapshot.asks.length ? (snapshot.bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0) - snapshot.asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0)) / (snapshot.bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0) + snapshot.asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0)) : 0; const spread = bestBid && bestAsk ? bestAsk - bestBid : null; return { symbol, timestamp: snapshot.timestamp, bestBid, bestAsk, midPrice: mid, spread, relativeSpread: mid && spread ? spread / mid : null, bidDepth, askDepth, imbalance: +imbalance.toFixed(4), weightedImbalance: +weightedImbalance.toFixed(4), marketBuyImpact: [100, 500, 1000].map(q => impact('buy', q)), marketSellImpact: [100, 500, 1000].map(q => impact('sell', q)), estimatedFillProbability: { buy: +Math.min(0.98, 0.35 + Math.max(0, weightedImbalance) * .4).toFixed(3), sell: +Math.min(0.98, 0.35 + Math.max(0, -weightedImbalance) * .4).toFixed(3) }, liquidityScore: +Math.max(0, Math.min(100, 100 - (spread ?? 0) * 100 + Math.min(bidDepth + askDepth, 2000) / 40)).toFixed(2) };
  }

  submitOrder(input: SubmitOrderInput): { accepted: boolean; risk: ReturnType<typeof checkRisk>; fills: Fill[]; orderId: string; order: OrderView | null } {
    const analytics = this.analytics(input.symbol);
    const account = this.account(input.strategyId);
    const price = input.price ?? (input.side === 'buy' ? analytics.bestAsk ?? 0 : analytics.bestBid ?? 0);
    const now = Date.now();
    const orderId = this.nextOrderId();
    const risk = checkRisk({ ...input, price, bestBid: analytics.bestBid, bestAsk: analytics.bestAsk, account, now });
    if (!risk.allowed) {
      const rejected: SandboxOrder = { id: orderId, strategyId: input.strategyId, symbol: input.symbol, side: input.side, type: input.orderType, price, quantity: input.quantity, remaining: input.quantity, filledQuantity: 0, status: 'rejected', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
      this.orders.set(orderId, rejected);
      this.recordAnomaly('risk_rejection', { id: orderId, symbol: input.symbol, timestamp: new Date(now).toISOString(), sequence: 0 }, 'medium', { strategyId: input.strategyId, rule: risk.rule, code: risk.code });
      return { accepted: false, risk, fills: [], orderId, order: this.toView(rejected) };
    }
    account.ordersInWindow.push(now);

    const order: SandboxOrder = { id: orderId, strategyId: input.strategyId, symbol: input.symbol, side: input.side, type: input.orderType, price, quantity: input.quantity, remaining: input.quantity, filledQuantity: 0, status: 'new', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    this.orders.set(orderId, order);

    // 下单即冻结：买单冻结名义资金，卖单冻结可卖数量
    if (input.side === 'buy') account.reservedCash = round2(account.reservedCash + price * input.quantity);
    else account.reservedPosition[input.symbol] = round4((account.reservedPosition[input.symbol] ?? 0) + input.quantity);

    const bookOrder = { id: orderId, side: input.side, price, quantity: input.quantity, remaining: input.quantity, sequence: this.events.length + 1, owner: input.strategyId, type: input.orderType } as BookOrder & { type: OrderType };
    const timestamp = new Date(now).toISOString();
    const fills = this.book(input.symbol).execute(bookOrder, timestamp);
    this.fills.push(...fills);
    this.settleFills(fills, timestamp);
    order.remaining = round4(bookOrder.remaining);
    order.filledQuantity = round4(input.quantity - order.remaining);
    order.updatedAt = timestamp;

    if (order.remaining > 0 && input.orderType === 'market') {
      // 市价单不挂单：未成交部分撤单，释放占用
      this.recordAnomaly('unfilled_market_order', { id: orderId, symbol: input.symbol, timestamp, sequence: 0 }, 'high', { remaining: order.remaining });
      this.releaseReservation(order);
      order.remaining = 0;
      order.status = 'cancelled';
    } else {
      order.status = order.remaining > 0 ? (order.filledQuantity > 0 ? 'partially_filled' : 'new') : 'filled';
    }
    return { accepted: true, risk, fills, orderId, order: this.toView(order) };
  }

  cancel(strategyId: string, orderId: string): CancelResult {
    const order = this.orders.get(orderId);
    if (!order) return { cancelled: false, code: 'ORDER_NOT_FOUND', message: '订单不存在' };
    // 跨策略不能互相操作
    if (order.strategyId !== strategyId) {
      this.recordAnomaly('cross_strategy_cancel_denied', { id: orderId, symbol: order.symbol, timestamp: new Date().toISOString(), sequence: 0 }, 'high', { orderOwner: order.strategyId, requester: strategyId });
      return { cancelled: false, code: 'ORDER_FORBIDDEN', message: '不能操作其他策略的订单' };
    }
    // 重复撤单不能重复释放：已终结/已撤单直接返回，不计撤单、不动占用
    if (order.status === 'cancelled') return { cancelled: false, code: 'ORDER_ALREADY_CANCELLED', message: '订单已撤销，重复撤单被忽略', order: this.toView(order) };
    if (order.status === 'filled') return { cancelled: false, code: 'ORDER_ALREADY_FILLED', message: '订单已全部成交', order: this.toView(order) };
    if (order.status === 'rejected') return { cancelled: false, code: 'ORDER_REJECTED', message: '订单已被风控拒绝', order: this.toView(order) };

    this.books.get(order.symbol)?.cancel(orderId);
    this.releaseReservation(order);
    order.remaining = 0;
    order.status = 'cancelled';
    order.updatedAt = new Date().toISOString();
    const account = this.account(strategyId);
    account.cancelInWindow.push(Date.now());
    return { cancelled: true, order: this.toView(order) };
  }

  /** 查询订单；默认仅返回活动订单，includeInactive=true 返回含成交/撤单/拒单的全生命周期台账 */
  listOrders(strategyId: string, options: { includeInactive?: boolean } = {}): OrderView[] {
    return [...this.orders.values()]
      .filter(order => order.strategyId === strategyId)
      .filter(order => options.includeInactive || this.isActive(order.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(order => this.toView(order));
  }

  account(strategyId: string): Account { let account = this.accounts.get(strategyId); if (!account) { account = { strategyId, cash: 1_000_000, equity: 1_000_000, position: {}, reservedCash: 0, reservedPosition: {}, ordersInWindow: [], cancelInWindow: [], peakEquity: 1_000_000, maxDrawdown: .15 }; this.accounts.set(strategyId, account); } return account; }

  performance(strategyId: string) {
    const account = this.account(strategyId);
    const fills = this.fills.filter(fill => fill.strategyId === strategyId);

    // 已实现盈亏：买入按摊薄成本建仓（含费），卖出对当前持仓成本实现盈亏（含费）
    const costBasis: Record<string, { quantity: number; cost: number }> = {};
    let realizedPnl = 0;
    for (const fill of fills) {
      const basis = costBasis[fill.symbol] ?? { quantity: 0, cost: 0 };
      if (fill.side === 'buy') {
        basis.quantity = round4(basis.quantity + fill.quantity);
        basis.cost = round2(basis.cost + fill.price * fill.quantity + fill.fee);
      } else {
        const averageCost = basis.quantity > 0 ? basis.cost / basis.quantity : fill.price;
        realizedPnl = round2(realizedPnl + (fill.price - averageCost) * fill.quantity - fill.fee);
        basis.quantity = round4(basis.quantity - fill.quantity);
        basis.cost = round2(Math.max(0, basis.quantity) * averageCost);
        if (basis.quantity <= 0) { basis.quantity = 0; basis.cost = 0; }
      }
      costBasis[fill.symbol] = basis;
    }

    // 未结（持仓）影响：按最新盘口中间价估值
    const openPositions: Array<{ symbol: string; quantity: number; averageCost: number; marketPrice: number; unrealizedPnl: number; marketValue: number }> = [];
    let unrealizedPnl = 0;
    let marketValue = 0;
    for (const [symbol, quantity] of Object.entries(account.position)) {
      if (quantity === 0) continue;
      const analytics = this.analytics(symbol);
      const marketPrice = analytics.midPrice ?? fills.filter(x => x.symbol === symbol).at(-1)?.price ?? (costBasis[symbol] && costBasis[symbol].quantity ? costBasis[symbol].cost / costBasis[symbol].quantity : 0);
      const averageCost = costBasis[symbol]?.quantity ? costBasis[symbol].cost / costBasis[symbol].quantity : 0;
      const value = round2(marketPrice * quantity);
      const pnl = round2((marketPrice - averageCost) * quantity);
      marketValue = round2(marketValue + value);
      unrealizedPnl = round2(unrealizedPnl + pnl);
      openPositions.push({ symbol, quantity: round4(quantity), averageCost: round2(averageCost), marketPrice, marketValue: value, unrealizedPnl: pnl });
    }

    const openOrders = this.listOrders(strategyId);
    return {
      strategyId,
      account: {
        cash: round2(account.cash),
        equity: round2(account.equity),
        reservedCash: round2(account.reservedCash),
        availableCash: round2(account.cash - account.reservedCash),
        position: account.position,
        reservedPosition: account.reservedPosition,
        availablePosition: Object.fromEntries(Object.entries(account.position).map(([symbol, qty]) => [symbol, round4(qty - (account.reservedPosition[symbol] ?? 0))])),
      },
      realized: {
        fillCount: fills.length,
        tradedNotional: round2(fills.reduce((s, f) => s + f.price * f.quantity, 0)),
        fees: round2(fills.reduce((s, f) => s + f.fee, 0)),
        grossCashFlow: round2(fills.reduce((sum, fill) => sum + (fill.side === 'sell' ? fill.price * fill.quantity : -fill.price * fill.quantity), 0)),
        pnl: realizedPnl,
      },
      open: {
        orderCount: openOrders.length,
        orders: openOrders,
        positions: openPositions,
        marketValue,
        unrealizedPnl,
        reservedCash: round2(account.reservedCash),
        reservedPosition: account.reservedPosition,
      },
      totalPnl: round2(realizedPnl + unrealizedPnl),
    };
  }

  strategyEvents(strategyId: string) {
    return {
      orders: [...this.orders.values()].filter(order => order.strategyId === strategyId).map(order => this.toView(order)),
      fills: this.fills.filter(fill => fill.strategyId === strategyId),
      riskEvents: this.anomalies.filter(item => (item.detail as { strategyId?: string } | undefined)?.strategyId === strategyId),
    };
  }

  private isActive(status: SandboxOrder['status']): boolean { return status === 'new' || status === 'partially_filled'; }

  /**
   * 结算一批成交（taker 与 maker 都可能出现，按账户聚合）：
   * 资金/持仓按成交量结算，同时释放该成交量在挂单时冻结的资源。
   */
  private settleFills(fills: Fill[], timestamp: string): void {
    const byAccount = new Map<string, Fill[]>();
    for (const fill of fills) {
      if (!fill.strategyId) continue;
      const list = byAccount.get(fill.strategyId) ?? [];
      list.push(fill);
      byAccount.set(fill.strategyId, list);
    }
    for (const [strategyId, accountFills] of byAccount) {
      const account = this.account(strategyId);
      for (const fill of accountFills) {
        const order = this.orders.get(fill.orderId);
        if (order) {
          if (order.side === 'buy') account.reservedCash = Math.max(0, round2(account.reservedCash - order.price * fill.quantity));
          else account.reservedPosition[fill.symbol] = Math.max(0, round4((account.reservedPosition[fill.symbol] ?? 0) - fill.quantity));
          order.remaining = round4(Math.max(0, order.remaining - fill.quantity));
          order.filledQuantity = round4(order.quantity - order.remaining);
          order.updatedAt = timestamp;
        }
        const delta = fill.side === 'buy' ? fill.quantity : -fill.quantity;
        account.position[fill.symbol] = round4((account.position[fill.symbol] ?? 0) + delta);
        account.cash = round2(account.cash + (fill.side === 'buy' ? -(fill.price * fill.quantity + fill.fee) : fill.price * fill.quantity - fill.fee));
        if (order && order.remaining === 0 && this.isActive(order.status)) order.status = 'filled';
        else if (order && order.remaining > 0 && order.filledQuantity > 0 && order.status !== 'filled') order.status = 'partially_filled';
      }
      account.equity = account.cash;
      account.peakEquity = Math.max(account.peakEquity, account.equity);
    }
  }

  /** 撤单/市价单残余时释放剩余未成交部分的占用 */
  private releaseReservation(order: SandboxOrder): void {
    const account = this.account(order.strategyId);
    if (order.remaining <= 0) return;
    if (order.side === 'buy') account.reservedCash = Math.max(0, round2(account.reservedCash - order.price * order.remaining));
    else account.reservedPosition[order.symbol] = Math.max(0, round4((account.reservedPosition[order.symbol] ?? 0) - order.remaining));
  }

  private toView(order: SandboxOrder): OrderView {
    const orderFills = this.fills.filter(fill => fill.orderId === order.id);
    const filledNotional = orderFills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
    const active = this.isActive(order.status);
    return {
      ...order,
      averageFilledPrice: order.filledQuantity > 0 ? round2(filledNotional / order.filledQuantity) : null,
      fees: round2(orderFills.reduce((sum, fill) => sum + fill.fee, 0)),
      reservedCash: active && order.side === 'buy' ? round2(order.price * order.remaining) : 0,
      reservedQuantity: active && order.side === 'sell' ? round4(order.remaining) : 0,
      active,
    };
  }

  private nextOrderId(): string { this.orderSeq += 1; return `SIM-${this.orderSeq}`; }
  private recordAnomaly(type: string, event: Partial<MarketEvent>, severity: string, detail: Record<string, unknown> = {}) { const anomaly = { id: `AN-${this.anomalies.length + 1}`, type, severity, symbol: event.symbol, timestamp: event.timestamp ?? new Date().toISOString(), sequence: event.sequence, detail }; this.anomalies.push(anomaly); return anomaly; }
  private seed(): void { const symbol = 'ALPHA'; const now = new Date('2026-09-30T09:30:00.000Z'); const bids = [100.00, 99.99, 99.98, 99.97, 99.96].map((price, i) => ({ price, quantity: [420, 380, 610, 240, 720][i] })); const asks = [100.01, 100.02, 100.03, 100.04, 100.05].map((price, i) => ({ price, quantity: [300, 490, 260, 580, 410][i] })); this.ingest({ id: 'E-1', symbol, tradingDay: '2026-09-30', timestamp: now.toISOString(), sequence: 1, type: 'snapshot', bids, asks }); for (let i = 0; i < 12; i++) this.ingest({ id: `E-${i + 2}`, symbol, tradingDay: '2026-09-30', timestamp: new Date(now.getTime() + (i + 1) * 1000).toISOString(), sequence: i + 2, type: i % 3 === 0 ? 'trade' : 'new_order', orderId: `M-${i + 2}`, side: i % 2 ? 'buy' : 'sell', aggressorSide: i % 2 ? 'buy' : 'sell', price: i % 2 ? 100.01 : 99.99, quantity: 40 + i * 12 }); }
}

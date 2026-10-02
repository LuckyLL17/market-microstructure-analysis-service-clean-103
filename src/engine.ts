import { OrderBook } from './order-book.js';
import { Account, checkRisk, reserveForCash } from './risk.js';
import { Analytics, BookOrder, Fill, MarketEvent, OrderStatus, SandboxOrder, Side } from './types.js';

export type CancelResult = { cancelled: boolean; code?: string; order?: SandboxOrder };

const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set(['filled', 'cancelled', 'rejected']);

export class MarketEngine {
  readonly books = new Map<string, OrderBook>();
  readonly events: MarketEvent[] = [];
  readonly fills: Fill[] = [];
  readonly anomalies: Array<Record<string, unknown>> = [];
  readonly accounts = new Map<string, Account>();
  readonly orders = new Map<string, SandboxOrder>();
  private readonly seenSequences = new Set<string>();
  private orderCounter = 0;

  constructor() { this.seed(); }
  book(symbol: string): OrderBook { let book = this.books.get(symbol); if (!book) { book = new OrderBook(symbol); this.books.set(symbol, book); } return book; }
  ingest(event: MarketEvent): { accepted: boolean; anomaly?: Record<string, unknown> } {
    const key = `${event.symbol}:${event.sequence}`;
    if (this.seenSequences.has(key)) return { accepted: false, anomaly: this.recordAnomaly('duplicate_sequence', event, 'medium') };
    const previous = this.events.filter(item => item.symbol === event.symbol).at(-1);
    if (previous && event.sequence > previous.sequence + 1) this.recordAnomaly('sequence_gap', event, 'high');
    if (previous && event.timestamp < previous.timestamp) this.recordAnomaly('out_of_order_timestamp', event, 'medium');
    this.seenSequences.add(key); this.events.push(event); this.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence); this.book(event.symbol).apply(event);
    return { accepted: true };
  }
  analytics(symbol: string): Analytics {
    const snapshot = this.book(symbol).snapshot(10); const bestBid = snapshot.bids[0]?.price ?? null; const bestAsk = snapshot.asks[0]?.price ?? null; const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null; const bidDepth = snapshot.bids.reduce((sum, l) => sum + l.quantity, 0); const askDepth = snapshot.asks.reduce((sum, l) => sum + l.quantity, 0); const impact = (side: Side, requested: number) => { const levels = side === 'buy' ? snapshot.asks : snapshot.bids; let left = requested, notional = 0, filled = 0; for (const level of levels) { const take = Math.min(left, level.quantity); notional += take * level.price; filled += take; left -= take; if (!left) break; } const averagePrice = filled ? notional / filled : null; const reference = side === 'buy' ? bestAsk : bestBid; return { quantity: requested, averagePrice: averagePrice ? +averagePrice.toFixed(4) : null, slippageBps: averagePrice && reference ? +(((side === 'buy' ? averagePrice - reference : reference - averagePrice) / reference) * 10_000).toFixed(2) : null, filled: +filled.toFixed(4) }; }; const imbalance = bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0; const weightedImbalance = snapshot.bids.length && snapshot.asks.length ? (snapshot.bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0) - snapshot.asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0)) / (snapshot.bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0) + snapshot.asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0)) : 0; const spread = bestBid && bestAsk ? bestAsk - bestBid : null; return { symbol, timestamp: snapshot.timestamp, bestBid, bestAsk, midPrice: mid, spread, relativeSpread: mid && spread ? spread / mid : null, bidDepth, askDepth, imbalance: +imbalance.toFixed(4), weightedImbalance: +weightedImbalance.toFixed(4), marketBuyImpact: [100, 500, 1000].map(q => impact('buy', q)), marketSellImpact: [100, 500, 1000].map(q => impact('sell', q)), estimatedFillProbability: { buy: +Math.min(0.98, 0.35 + Math.max(0, weightedImbalance) * .4).toFixed(3), sell: +Math.min(0.98, 0.35 + Math.max(0, -weightedImbalance) * .4).toFixed(3) }, liquidityScore: +Math.max(0, Math.min(100, 100 - (spread ?? 0) * 100 + Math.min(bidDepth + askDepth, 2000) / 40)).toFixed(2) };
  }

  submitOrder(input: { strategyId: string; symbol: string; side: Side; orderType: 'limit' | 'market'; price?: number; quantity: number }): { accepted: boolean; risk: ReturnType<typeof checkRisk>; fills: Fill[]; orderId: string; order: SandboxOrder } {
    const analytics = this.analytics(input.symbol);
    const account = this.account(input.strategyId);
    const price = input.price ?? (input.side === 'buy' ? analytics.bestAsk ?? 0 : analytics.bestBid ?? 0);
    const now = Date.now();
    const orderId = `SIM-${++this.orderCounter}`;
    const risk = checkRisk({ ...input, price, bestBid: analytics.bestBid, bestAsk: analytics.bestAsk, account, now });
    const timestamp = new Date().toISOString();
    if (!risk.allowed) {
      const order: SandboxOrder = { id: orderId, strategyId: input.strategyId, symbol: input.symbol, side: input.side, orderType: input.orderType, price, quantity: input.quantity, remaining: input.quantity, filledQuantity: 0, averageFillPrice: 0, status: 'rejected', reservedCash: 0, reservedPosition: 0, createdAt: timestamp, updatedAt: timestamp, sequence: this.events.length + 1 };
      this.orders.set(orderId, order);
      this.recordAnomaly('risk_rejection', { id: orderId, symbol: input.symbol, timestamp, sequence: 0 }, 'medium', { strategyId: input.strategyId, rule: risk.rule, code: risk.code });
      return { accepted: false, risk, fills: [], orderId, order };
    }
    account.ordersInWindow.push(now);

    const order: SandboxOrder = { id: orderId, strategyId: input.strategyId, symbol: input.symbol, side: input.side, orderType: input.orderType, price, quantity: input.quantity, remaining: input.quantity, filledQuantity: 0, averageFillPrice: 0, status: 'active', reservedCash: 0, reservedPosition: 0, createdAt: timestamp, updatedAt: timestamp, sequence: this.events.length + 1 };
    // 挂单瞬间锁定资金/可卖数量，撤单或成交结算前不得重复使用
    if (input.side === 'buy') { order.reservedCash = reserveForCash(price, input.quantity); account.reservedCash = +(account.reservedCash + order.reservedCash).toFixed(4); }
    else { order.reservedPosition = input.quantity; account.reservedPosition[input.symbol] = (account.reservedPosition[input.symbol] ?? 0) + input.quantity; }
    this.orders.set(orderId, order);

    const bookOrder: BookOrder = { id: orderId, side: input.side, price, quantity: input.quantity, remaining: input.quantity, sequence: order.sequence, owner: input.strategyId, type: input.orderType };
    const fills = this.book(input.symbol).execute(bookOrder, timestamp);
    this.fills.push(...fills);
    this.settleFills(fills);

    // 市价单未成交量立即撤销并释放剩余占用
    if (order.remaining > 0 && input.orderType === 'market') {
      this.releaseReservation(order);
      order.status = 'cancelled';
      order.cancelReason = 'unfilled_market';
      order.updatedAt = new Date().toISOString();
      this.recordAnomaly('unfilled_market_order', { id: orderId, symbol: input.symbol, timestamp: order.updatedAt, sequence: 0 }, 'high', { remaining: order.remaining });
    }
    return { accepted: true, risk, fills: fills.filter(fill => fill.orderId === orderId), orderId, order: this.publicOrder(order) };
  }

  cancel(strategyId: string, orderId: string): CancelResult {
    const order = this.orders.get(orderId);
    if (!order) return { cancelled: false, code: 'ORDER_NOT_FOUND' };
    // 跨策略不能操作彼此的订单
    if (order.strategyId !== strategyId) return { cancelled: false, code: 'NOT_ORDER_OWNER' };
    // 已终结订单（完全成交/已撤/被拒）不能重复撤单，也不能重复释放占用
    if (TERMINAL_STATUSES.has(order.status)) return { cancelled: false, code: 'ORDER_NOT_ACTIVE', order: this.publicOrder(order) };

    this.book(order.symbol).cancel(orderId);
    this.releaseReservation(order);
    order.status = 'cancelled';
    order.cancelReason = 'user';
    order.updatedAt = new Date().toISOString();
    this.account(strategyId).cancelInWindow.push(Date.now());
    return { cancelled: true, order: this.publicOrder(order) };
  }

  /** 活动订单（含部分成交）查询，可按标的过滤 */
  activeOrders(strategyId: string, symbol?: string): SandboxOrder[] {
    return [...this.orders.values()]
      .filter(order => order.strategyId === strategyId && !TERMINAL_STATUSES.has(order.status) && (symbol === undefined || order.symbol === symbol))
      .map(order => this.publicOrder(order));
  }

  /** 单笔订单查询，跨策略按不存在处理，避免互相探测 */
  getOrder(strategyId: string, orderId: string): SandboxOrder | undefined {
    const order = this.orders.get(orderId);
    if (!order || order.strategyId !== strategyId) return undefined;
    return this.publicOrder(order);
  }

  account(strategyId: string): Account { let account = this.accounts.get(strategyId); if (!account) { account = { strategyId, cash: 1_000_000, equity: 1_000_000, position: {}, ordersInWindow: [], cancelInWindow: [], peakEquity: 1_000_000, maxDrawdown: .15, reservedCash: 0, reservedPosition: {} }; this.accounts.set(strategyId, account); } return account; }

  performance(strategyId: string) {
    const account = this.account(strategyId);
    const byStrategy = this.fills.filter(fill => fill.strategyId === strategyId);
    const summarize = (rows: Fill[]) => ({
      fillCount: rows.length,
      tradedNotional: +rows.reduce((s, f) => s + f.price * f.quantity, 0).toFixed(2),
      grossCashFlow: +rows.reduce((sum, fill) => sum + (fill.side === 'sell' ? fill.price * fill.quantity : -fill.price * fill.quantity), 0).toFixed(2),
      fees: +rows.reduce((s, f) => s + f.fee, 0).toFixed(2),
    });
    // 已实现：订单已终结（全部成交或撤单）的成交；未结：仍在活动订单上的成交
    const realizedFills = byStrategy.filter(fill => { const order = this.orders.get(fill.orderId); return order ? TERMINAL_STATUSES.has(order.status) && order.status !== 'rejected' : true; });
    const openFills = byStrategy.filter(fill => { const order = this.orders.get(fill.orderId); return order && !TERMINAL_STATUSES.has(order.status); });
    const realized = summarize(realizedFills);
    const openSummary = summarize(openFills);
    const openOrders = this.activeOrders(strategyId);
    const reservedPosition = Object.entries(account.reservedPosition).filter(([, q]) => q > 0).map(([symbol, quantity]) => ({ symbol, quantity }));
    const positions = Object.entries(account.position).map(([symbol, quantity]) => {
      const midPrice = this.analytics(symbol).midPrice;
      const reserved = account.reservedPosition[symbol] ?? 0;
      return { symbol, quantity, availableQuantity: +(quantity - reserved).toFixed(8), midPrice, marketValue: midPrice === null ? null : +(quantity * midPrice).toFixed(2) };
    });
    return {
      strategyId,
      account: {
        cash: +account.cash.toFixed(4),
        reservedCash: +account.reservedCash.toFixed(4),
        availableCash: +(account.cash - account.reservedCash).toFixed(4),
        equity: +account.equity.toFixed(4),
        peakEquity: account.peakEquity,
        positions,
      },
      metrics: {
        fillCount: byStrategy.length,
        tradedNotional: +(realized.tradedNotional + openSummary.tradedNotional).toFixed(2),
        fees: +(realized.fees + openSummary.fees).toFixed(2),
        grossCashFlow: +(realized.grossCashFlow + openSummary.grossCashFlow).toFixed(2),
        netPnl: +(realized.grossCashFlow + openSummary.grossCashFlow - realized.fees - openSummary.fees).toFixed(2),
        realized: { ...realized, netCashFlow: +(realized.grossCashFlow - realized.fees).toFixed(2) },
        open: {
          orderCount: openOrders.length,
          ...openSummary,
          netCashFlow: +(openSummary.grossCashFlow - openSummary.fees).toFixed(2),
          reservedCash: +account.reservedCash.toFixed(4),
          reservedPosition,
          orders: openOrders.map(order => ({ orderId: order.id, symbol: order.symbol, side: order.side, orderType: order.orderType, price: order.price, quantity: order.quantity, remaining: order.remaining, filledQuantity: order.filledQuantity, averageFillPrice: order.averageFillPrice, status: order.status })),
        },
      },
    };
  }

  /** 按成交逐笔结算账户并同步释放对应占用 */
  private settleFills(fills: Fill[]): void {
    for (const fill of fills) {
      const order = this.orders.get(fill.orderId);
      if (!order || order.strategyId !== fill.strategyId) continue;
      const account = this.accounts.get(order.strategyId)!;
      const filledNotional = order.averageFillPrice * order.filledQuantity + fill.price * fill.quantity;
      order.filledQuantity = +(order.filledQuantity + fill.quantity).toFixed(8);
      order.remaining = +(order.quantity - order.filledQuantity).toFixed(8);
      order.averageFillPrice = +(filledNotional / order.filledQuantity).toFixed(6);
      account.position[fill.symbol] = +((account.position[fill.symbol] ?? 0) + (fill.side === 'buy' ? fill.quantity : -fill.quantity)).toFixed(8);
      account.cash += fill.side === 'buy' ? -(fill.price * fill.quantity + fill.fee) : fill.price * fill.quantity - fill.fee;

      if (order.side === 'buy') {
        const release = order.remaining <= 0 ? order.reservedCash : reserveForCash(order.price, fill.quantity);
        order.reservedCash = +Math.max(0, order.reservedCash - release).toFixed(4);
        account.reservedCash = +Math.max(0, account.reservedCash - release).toFixed(4);
      } else {
        account.reservedPosition[fill.symbol] = Math.max(0, (account.reservedPosition[fill.symbol] ?? 0) - fill.quantity);
        order.reservedPosition = Math.max(0, order.reservedPosition - fill.quantity);
      }
      order.status = order.remaining <= 0 ? 'filled' : 'partially_filled';
      order.updatedAt = fill.timestamp;
      account.equity = account.cash;
      account.peakEquity = Math.max(account.peakEquity, account.equity);
    }
  }

  /** 订单终结时释放剩余的资金/持仓占用 */
  private releaseReservation(order: SandboxOrder): void {
    const account = this.accounts.get(order.strategyId)!;
    if (order.reservedCash > 0) { account.reservedCash = +Math.max(0, account.reservedCash - order.reservedCash).toFixed(4); order.reservedCash = 0; }
    if (order.reservedPosition > 0) { account.reservedPosition[order.symbol] = Math.max(0, (account.reservedPosition[order.symbol] ?? 0) - order.reservedPosition); order.reservedPosition = 0; }
  }

  private publicOrder(order: SandboxOrder): SandboxOrder {
    return { ...order };
  }

  private recordAnomaly(type: string, event: Partial<MarketEvent>, severity: string, detail: Record<string, unknown> = {}) { const anomaly = { id: `AN-${this.anomalies.length + 1}`, type, severity, symbol: event.symbol, timestamp: event.timestamp ?? new Date().toISOString(), sequence: event.sequence, detail }; this.anomalies.push(anomaly); return anomaly; }
  private seed(): void { const symbol = 'ALPHA'; const now = new Date('2026-09-30T09:30:00.000Z'); const bids = [100.00, 99.99, 99.98, 99.97, 99.96].map((price, i) => ({ price, quantity: [420, 380, 610, 240, 720][i] })); const asks = [100.01, 100.02, 100.03, 100.04, 100.05].map((price, i) => ({ price, quantity: [300, 490, 260, 580, 410][i] })); this.ingest({ id: 'E-1', symbol, tradingDay: '2026-09-30', timestamp: now.toISOString(), sequence: 1, type: 'snapshot', bids, asks }); for (let i = 0; i < 12; i++) this.ingest({ id: `E-${i + 2}`, symbol, tradingDay: '2026-09-30', timestamp: new Date(now.getTime() + (i + 1) * 1000).toISOString(), sequence: i + 2, type: i % 3 === 0 ? 'trade' : 'new_order', orderId: `M-${i + 2}`, side: i % 2 ? 'buy' : 'sell', aggressorSide: i % 2 ? 'buy' : 'sell', price: i % 2 ? 100.01 : 99.99, quantity: 40 + i * 12 }); }
}

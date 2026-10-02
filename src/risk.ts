import { OrderType, Side, RiskDecision } from './types.js';

export type Account = {
  strategyId: string;
  cash: number;
  equity: number;
  position: Record<string, number>;
  ordersInWindow: number[];
  cancelInWindow: number[];
  peakEquity: number;
  maxDrawdown: number;
  /** 活动买单冻结的现金（含预估费用） */
  reservedCash: number;
  /** 各标的活动卖单冻结的可卖数量 */
  reservedPosition: Record<string, number>;
};
export type RiskContext = {
  symbol: string;
  side: Side;
  orderType: OrderType;
  price: number;
  quantity: number;
  bestBid: number | null;
  bestAsk: number | null;
  account: Account;
  now: number;
};

const FEE_RATE = 0.00025;

export function checkRisk(context: RiskContext): RiskDecision {
  const { price, quantity, account, side, bestBid, bestAsk, now } = context;
  const notional = price * quantity;
  account.ordersInWindow = account.ordersInWindow.filter(time => now - time < 60_000);
  account.cancelInWindow = account.cancelInWindow.filter(time => now - time < 60_000);
  if (notional > 50_000) return { allowed: false, rule: 'capital', code: 'ORDER_NOTIONAL_LIMIT', message: '单笔模拟订单金额超过 50,000' };
  // 买单需要扣除其他活动订单已经冻结的资金后仍可覆盖本单
  const requiredCash = notional * (1 + FEE_RATE);
  if (side === 'buy' && account.cash - account.reservedCash < requiredCash) return { allowed: false, rule: 'capital', code: 'INSUFFICIENT_CASH', message: '可用资金不足（含未结买单占用）' };
  // 卖单需要扣除其他活动卖单已经冻结的数量后仍有足够持仓
  const position = account.position[context.symbol] ?? 0;
  const reserved = account.reservedPosition[context.symbol] ?? 0;
  if (side === 'sell' && position - reserved < quantity) return { allowed: false, rule: 'position', code: 'INSUFFICIENT_POSITION', message: '可卖持仓不足（含未结卖单占用）' };
  if (account.ordersInWindow.length >= 30) return { allowed: false, rule: 'frequency', code: 'ORDER_RATE_LIMIT', message: '60 秒内下单次数超过限制' };
  const reference = side === 'buy' ? bestAsk ?? price : bestBid ?? price;
  if (reference > 0 && Math.abs(price - reference) / reference > 0.02) return { allowed: false, rule: 'price_deviation', code: 'PRICE_DEVIATION', message: '订单价格偏离当前盘口超过 2%' };
  if (account.peakEquity > 0 && (account.peakEquity - account.equity) / account.peakEquity > account.maxDrawdown) return { allowed: false, rule: 'drawdown', code: 'MAX_DRAWDOWN', message: '策略已达到最大回撤限制' };
  return { allowed: true };
}

/** 活动订单需要冻结的资金（预估成交金额 + 费用） */
export function reserveForCash(price: number, quantity: number): number {
  return +(price * quantity * (1 + FEE_RATE)).toFixed(4);
}

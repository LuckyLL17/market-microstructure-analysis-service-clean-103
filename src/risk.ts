import { OrderType, Side, RiskDecision } from './types.js';

export type Account = {
  strategyId: string;
  /** 已成交结算后的现金 */
  cash: number;
  equity: number;
  /** 已成交结算后的净持仓 */
  position: Record<string, number>;
  /** 未成交买单挂单冻结的资金 */
  reservedCash: number;
  /** 未成交卖单挂单冻结的可卖数量 */
  reservedPosition: Record<string, number>;
  ordersInWindow: number[];
  cancelInWindow: number[];
  peakEquity: number;
  maxDrawdown: number;
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

export function checkRisk(context: RiskContext): RiskDecision {
  const { price, quantity, account, side, bestBid, bestAsk, now } = context;
  const notional = price * quantity;
  account.ordersInWindow = account.ordersInWindow.filter(time => now - time < 60_000);
  account.cancelInWindow = account.cancelInWindow.filter(time => now - time < 60_000);
  if (notional > 50_000) return { allowed: false, rule: 'capital', code: 'ORDER_NOTIONAL_LIMIT', message: '单笔模拟订单金额超过 50,000' };
  // 资金检查需扣除未结买单冻结的资金，避免连续下单重复使用
  if (side === 'buy' && account.cash - account.reservedCash < notional) {
    return { allowed: false, rule: 'capital', code: 'INSUFFICIENT_CASH', message: '可用资金不足（含未结买单占用）' };
  }
  const position = account.position[context.symbol] ?? 0;
  // 持仓检查需扣除未结卖单冻结的可卖数量
  const availablePosition = position - (account.reservedPosition[context.symbol] ?? 0);
  if (side === 'sell' && availablePosition < quantity) {
    return { allowed: false, rule: 'position', code: 'INSUFFICIENT_POSITION', message: '可卖数量不足（含未结卖单占用）' };
  }
  if (account.ordersInWindow.length >= 30) return { allowed: false, rule: 'frequency', code: 'ORDER_RATE_LIMIT', message: '60 秒内下单次数超过限制' };
  const reference = side === 'buy' ? bestAsk ?? price : bestBid ?? price;
  if (reference > 0 && Math.abs(price - reference) / reference > 0.02) return { allowed: false, rule: 'price_deviation', code: 'PRICE_DEVIATION', message: '订单价格偏离当前盘口超过 2%' };
  if (account.peakEquity > 0 && (account.peakEquity - account.equity) / account.peakEquity > account.maxDrawdown) return { allowed: false, rule: 'drawdown', code: 'MAX_DRAWDOWN', message: '策略已达到最大回撤限制' };
  return { allowed: true };
}

/**
 * 对齐 app/services/order/executor.py：单任务可用名义上限、目标数量、模拟侧目标仓位占比。
 */

/**
 * @param {number} totalAssetsUsdt
 * @param {number} taskCount
 */
export function maxPositionSlicePerTask(totalAssetsUsdt, taskCount) {
  const tc = Math.max(1, Math.floor(Number(taskCount)) || 1);
  const t = Number(totalAssetsUsdt);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return (t * 0.9) / tc;
}

/**
 * 用模拟成交后的权益估算「持仓市值 / 权益」≈ executor 中的 target_position_rate。
 * @param {object} trade WS trade
 * @param {{ initial_cash?: number, mm_initial_cash?: number }} meta
 */
export function inferSimTargetPositionRate(trade, meta) {
  const px = Number(trade.price || 0);
  const pos = Number(trade.position_after ?? 0);
  const cash = Number(trade.cash_after ?? 0);
  if (!(px > 0)) return 0;
  const equity = cash + pos * px;
  const exposure = Math.abs(pos) * px;
  if (equity > 1e-12) return Math.min(1, Math.max(0, exposure / equity));
  const ic = Number(meta?.initial_cash ?? meta?.mm_initial_cash ?? 0);
  if (ic > 1e-12) return Math.min(1, Math.max(0, exposure / ic));
  return 0;
}

/**
 * 与 executor.calculate_target_quantity 一致（数值版）。
 */
export function calculateTargetQuantity(
  currentPosition,
  currentEntryPrice,
  currentPrice,
  maxPositionAmount,
  tradeType,
  targetRate
) {
  const cp = Number(currentPrice);
  if (!(cp > 0)) return 0;
  const curPos = Number(currentPosition);
  const entry = Number(currentEntryPrice);
  const maxAmt = Number(maxPositionAmount);
  const rate = Number(targetRate);
  const absPos = Math.abs(curPos);

  let currentValue = 0;
  if (curPos > 0) currentValue = absPos * cp;
  else if (curPos < 0) currentValue = absPos * (2 * entry - cp);
  else currentValue = 0;

  let targetValue = maxAmt * rate;
  const tt = String(tradeType || "").toLowerCase();

  if (tt === "buy") {
    if (curPos < 0) targetValue += currentValue;
    if (targetValue <= currentValue) return 0;
  } else if (tt === "short") {
    if (curPos > 0) targetValue += currentValue;
    if (targetValue <= currentValue) return 0;
  } else if (tt === "sell") {
    if (curPos < 0) targetValue = 0;
    if (targetValue >= currentValue) return 0;
  } else if (tt === "cover") {
    if (curPos > 0) targetValue = 0;
    if (targetValue >= currentValue) return 0;
  } else {
    return 0;
  }

  const deltaValue = targetValue - currentValue;
  if (deltaValue === 0) return 0;
  const quantity = Math.abs(deltaValue) / cp;
  return deltaValue > 0 ? quantity : -quantity;
}

/**
 * 与 executor.check_slippage 一致：|当前价 − 参考价| / 参考价 ≤ maxSlippage。
 * 跟单场景下 **referencePrice 必须为模拟实盘 WS 推送的 trade.price**。
 */
export function checkExecutorSlippage(currentPrice, referencePrice, maxSlippage) {
  const cur = Number(currentPrice);
  const ref = Number(referencePrice);
  const ms = Number(maxSlippage);
  if (!(ref > 0)) return false;
  if (ms <= 0) return cur === ref;
  const diffPct = Math.abs((cur - ref) / ref);
  return diffPct <= ms;
}

/**
 * 相对模拟推送价 P_sim 的偏离比例：|P − P_sim| / P_sim（分母一律为模拟价）。
 */
export function slippageVsSimPrice(price, simPrice) {
  const sim = Number(simPrice);
  const p = Number(price);
  if (!(sim > 0)) return Infinity;
  return Math.abs(p - sim) / sim;
}

export function quantizeToStepDown(value, step) {
  const v = Number(value);
  const s = Number(step);
  if (!(v > 0) || !(s > 0)) return 0;
  const n = Math.floor(v / s) * s;
  const decimals = (String(s).split(".")[1] || "").length;
  return Number(n.toFixed(Math.min(decimals, 12)));
}

export function quantizePriceToTick(price, tickSize) {
  const p = Number(price);
  const t = Number(tickSize);
  if (!(t > 0)) return p;
  const q = Math.floor(p / t) * t;
  const decimals = (String(t).split(".")[1] || "").length;
  return Number(q.toFixed(Math.min(decimals, 12)));
}

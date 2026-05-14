/**
 * 跟单决策 + 调用币安下单（对齐 app/services/order/executor.py 的资金切片与 target 数量；
 * 下单类型、滑点、杠杆等与 user_exchange_keys 字段一致，由前端本地保存）。
 */
import {
  estimateFuturesTotalAssetsUsdt,
  estimateSpotTotalAssetsUsdt,
  getBookTicker,
  getExchangeInfoFutures,
  getExchangeInfoSpot,
  getFuturesPositionAmt,
  getSpotBaseTotal,
  lotFilter,
  placeFuturesLimitOrderWithRetry,
  placeMarketOrder,
  placeSpotLimitOrderWithRetry,
  setLeverage,
  setOneWayMode,
  signedRequest,
  summarizeFuturesResult,
  summarizeSpotFull,
  withBinanceUpstreamProxy,
} from "./binance-rest.js";
import {
  calculateTargetQuantity,
  checkExecutorSlippage,
  inferSimTargetPositionRate,
  maxPositionSlicePerTask,
  quantizePriceToTick,
  quantizeToStepDown,
  slippageVsSimPrice,
} from "./order-sizing.js";

const EPS = 1e-8;

/** @param {string} type */
export function classifySimType(type) {
  const t = String(type || "").toLowerCase();
  if (t === "buy" || t === "short") return "open";
  if (t === "sell" || t === "cover" || t.startsWith("force_close")) return "close";
  return "other";
}

/** executor 用 trade_type + 多空侧 */
function tradeTypeForSizing(simType) {
  const t = String(simType || "").toLowerCase();
  if (t.startsWith("force_close_long")) return "sell";
  if (t.startsWith("force_close_short")) return "cover";
  return t;
}

export function isSimAddonOpen(trade) {
  return Math.abs(Number(trade.position_before || 0)) > EPS;
}

export function createTaskCopyState() {
  return { awaitingSimZero: false };
}

/** @type {Map<number, ReturnType<createTaskCopyState>>} */
const taskStates = new Map();

function stateFor(taskId) {
  let s = taskStates.get(taskId);
  if (!s) {
    s = createTaskCopyState();
    taskStates.set(taskId, s);
  }
  return s;
}

export function clearTaskState(taskId) {
  taskStates.delete(taskId);
}

export function resetAllTaskStates() {
  taskStates.clear();
}

function settingsForConnector(exchangeSettings, connector) {
  const es = exchangeSettings || {};
  if (connector === "binance") return es.binance || {};
  return es.binance_perpetual || {};
}

function mapSide(simType, connector) {
  const t = String(simType || "").toLowerCase();
  if (connector === "binance") {
    if (t === "buy") return "BUY";
    if (t === "sell" || t.startsWith("force_close_long")) return "SELL";
    return "SELL";
  }
  if (t === "buy" || t === "cover" || t.startsWith("force_close_short")) return "BUY";
  if (t === "short" || t === "sell" || t.startsWith("force_close_long")) return "SELL";
  return "BUY";
}

function resolveActualQtyClose(_tradeTypeForQty, currentAbsPosition, targetQtyAbs, stepSize, minNotional, refPrice) {
  let qtyToClose = Math.abs(Number(targetQtyAbs));
  const step = Number(stepSize);
  const cap = Math.abs(Number(currentAbsPosition));
  const mn = Number(minNotional);
  const px = Number(refPrice);
  let quantized = quantizeToStepDown(qtyToClose, step);
  if (!(quantized > 0)) return 0;
  const remainQty = cap - quantized;
  if (remainQty > 0 && remainQty * px < mn * 0.999) {
    quantized = quantizeToStepDown(cap, step);
  }
  if (quantized > cap) quantized = quantizeToStepDown(cap, step);
  return quantized > 0 ? quantized : 0;
}

function resolveActualQtyOpen(targetQtyAbs, stepSize) {
  const q = quantizeToStepDown(Math.abs(Number(targetQtyAbs)), Number(stepSize));
  return q > 0 ? q : 0;
}

/**
 * @param {object} payload WS sim_trade_fill
 * @param {object} opts
 * @param {() => Promise<object|null>} opts.getTaskMeta
 * @param {{apiKey:string,secret:string,proxyBase:string,upstreamProxy?:string}} opts.creds
 * @param {{maxSlippagePct:number}} opts.risk
 * @param {{binance:object,binance_perpetual:object}} opts.exchangeSettings
 * @param {boolean} opts.realTrading
 * @param {(connector:string)=>number} opts.subscribedTaskCount
 * @param {(s:string,k?:string)=>void} opts.log
 */
export async function handleSimTradeFill(payload, opts) {
  const up = String(opts.creds?.upstreamProxy ?? "").trim();
  return withBinanceUpstreamProxy(up, async () => {
  const { trade, task_id: taskId } = payload;
  const meta = await opts.getTaskMeta(Number(taskId));
  if (!meta) {
    opts.log?.(`[task ${taskId}] 无任务元数据，已跳过`);
    return null;
  }

  const { connector, symbol } = meta;
  const kind = classifySimType(trade.type);
  if (kind === "other") {
    opts.log?.(`[task ${taskId}] 未知成交类型 ${trade.type}，跳过`);
    return null;
  }
  const rawType = String(trade.type || "").toLowerCase();
  if (connector === "binance" && (rawType === "short" || rawType === "cover")) {
    opts.log?.(`[task ${taskId}] 现货不支持 ${trade.type}，跳过`);
    return null;
  }

  const st = stateFor(Number(taskId));
  const simAfter = Math.abs(Number(trade.position_after || 0));
  if (simAfter < EPS) st.awaitingSimZero = false;

  let localQty = 0;
  try {
    await opts.syncTime?.();
    if (connector === "binance") {
      localQty = await getSpotBaseTotal(symbol, opts.creds.apiKey, opts.creds.secret, opts.creds.proxyBase);
    } else {
      localQty = await getFuturesPositionAmt(symbol, opts.creds.apiKey, opts.creds.secret, opts.creds.proxyBase);
    }
  } catch (e) {
    opts.log?.(`[task ${taskId}] 同步本地仓位失败: ${e.message}`, "err");
    return null;
  }

  if (kind === "open") {
    if (st.awaitingSimZero) {
      opts.log?.(`[task ${taskId}] 等待模拟仓位归零，跳过开仓类 ${trade.type}`);
      return null;
    }
    if (Math.abs(localQty) < EPS && isSimAddonOpen(trade)) {
      st.awaitingSimZero = true;
      opts.log?.(`[task ${taskId}] 本地无仓、模拟加仓，跳过并等待模拟归零`);
      return null;
    }
  }

  const tradetypeSizing = tradeTypeForSizing(trade.type);
  const exSet = settingsForConnector(opts.exchangeSettings, connector);
  const lev = connector === "binance" ? 1 : Math.max(1, Math.min(125, Math.floor(Number(exSet.leverage) || 1)));

  let totalAssets = 0;
  try {
    if (connector === "binance") {
      totalAssets = await estimateSpotTotalAssetsUsdt(opts.creds.apiKey, opts.creds.secret, opts.creds.proxyBase);
    } else {
      totalAssets = await estimateFuturesTotalAssetsUsdt(
        opts.creds.apiKey,
        opts.creds.secret,
        opts.creds.proxyBase,
        lev
      );
    }
  } catch (e) {
    opts.log?.(`[task ${taskId}] 读取账户资产失败: ${e.message}`, "err");
    return null;
  }

  let maxPositionAmount;
  if (opts.taskAllocationPct?.has(Number(taskId))) {
    // 用户自定义仓位比例
    maxPositionAmount = totalAssets * opts.taskAllocationPct.get(Number(taskId));
  } else {
    const taskCount = Math.max(1, opts.subscribedTaskCount?.(connector) ?? 1);
    maxPositionAmount = maxPositionSlicePerTask(totalAssets, taskCount);
  }
  const targetRate = inferSimTargetPositionRate(trade, meta);

  const simPx = Number(trade.price);
  const book = await getBookTicker(symbol, connector, opts.creds.proxyBase);
  const bid = Number(book.bidPrice);
  const ask = Number(book.askPrice);
  const mid = (bid + ask) / 2;
  /** 一律以模拟推送价 trade.price 为分母：|盘口中间价 − 模拟价| / 模拟价 */
  const slipBookMidVsSim = slippageVsSimPrice(mid, simPx);
  if (slipBookMidVsSim > opts.risk.maxSlippagePct) {
    opts.log?.(
      `[task ${taskId}] 盘口中间价相对模拟推送价偏离 ${(slipBookMidVsSim * 100).toFixed(3)}%（基准=模拟价 ${simPx}）超过上限 ${(opts.risk.maxSlippagePct * 100).toFixed(3)}%，跳过`,
      "err"
    );
    return null;
  }

  const currentPrice =
    tradetypeSizing === "buy" || tradetypeSizing === "cover"
      ? ask > 0
        ? ask
        : Number(trade.price)
      : bid > 0
        ? bid
        : Number(trade.price);

  let currentPosition = localQty;
  let currentEntryPrice = currentPrice;
  if (connector === "binance") {
    if (Math.abs(currentPosition) > EPS) currentEntryPrice = currentPrice;
  } else {
    const pr = await signedRequest(
      "GET",
      "fapi",
      "/fapi/v3/positionRisk",
      { symbol: symbol.toUpperCase() },
      opts.creds.apiKey,
      opts.creds.secret,
      opts.creds.proxyBase
    );
    const row = (Array.isArray(pr) ? pr : []).find((r) => r.symbol === symbol.toUpperCase()) || {};
    currentPosition = Number(row.positionAmt || currentPosition);
    currentEntryPrice = Number(row.entryPrice || 0) || currentPrice;
    if (Math.abs(currentPosition) > EPS && !(currentEntryPrice > 0)) currentEntryPrice = currentPrice;
  }

  const targetQty = calculateTargetQuantity(
    currentPosition,
    currentEntryPrice,
    currentPrice,
    maxPositionAmount,
    tradetypeSizing,
    targetRate
  );

  if (Math.abs(targetQty) < EPS) {
    opts.log?.(`[task ${taskId}] 目标调整数量为 0（target_rate=${targetRate.toFixed(4)} slice=${maxPositionAmount.toFixed(2)} USDT），跳过`);
    return null;
  }

  let exInfo;
  let lot;
  try {
    if (connector === "binance") {
      exInfo = await getExchangeInfoSpot(symbol, opts.creds.proxyBase);
      const si = (exInfo.symbols || []).find((s) => s.symbol === symbol.toUpperCase());
      if (!si) throw new Error("exchangeInfo 无该交易对");
      lot = lotFilter(si);
    } else {
      exInfo = await getExchangeInfoFutures(symbol, opts.creds.proxyBase);
      const si = (exInfo.symbols || []).find((s) => s.symbol === symbol.toUpperCase());
      if (!si) throw new Error("exchangeInfo 无该交易对");
      lot = lotFilter(si);
    }
  } catch (e) {
    opts.log?.(`[task ${taskId}] 拉取交易规则失败: ${e.message}`, "err");
    return null;
  }

  const refPx = simPx;
  const isClose = kind === "close";
  let actualQty = 0;
  if (isClose) {
    actualQty = resolveActualQtyClose(
      tradetypeSizing,
      Math.abs(currentPosition),
      Math.abs(targetQty),
      lot.stepSize,
      lot.minNotional,
      currentPrice
    );
  } else {
    actualQty = resolveActualQtyOpen(targetQty, lot.stepSize);
  }

  if (!(actualQty > 0)) {
    opts.log?.(`[task ${taskId}] 量化后数量为 0，跳过`, "err");
    return null;
  }
  if (lot.minNotional > 0 && refPx > 0 && actualQty * refPx < lot.minNotional * 0.99) {
    opts.log?.(`[task ${taskId}] 名义金额低于 minNotional，跳过`, "err");
    return null;
  }

  const side = mapSide(trade.type, connector);
  const reduceOnly = connector !== "binance" && isClose;

  const openType = String(exSet.open_order_type || "LIMIT").toUpperCase();
  const closeType = String(exSet.close_order_type || "LIMIT").toUpperCase();
  const openSec = Math.max(5, Number(exSet.open_order_seconds) || 120);
  const closeSec = Math.max(5, Number(exSet.close_order_seconds) || 120);
  const openSlip = Number(exSet.open_order_slippage ?? 0.001);
  const closeSlip = Number(exSet.close_order_slippage ?? 0.001);
  const openMAfter = !!Number(exSet.open_market_after_limit ?? 1);

  const slipHelpers = {
    checkSlippageFn: checkExecutorSlippage,
    quantizePriceFloor: quantizePriceToTick,
  };

  const allocDesc = opts.taskAllocationPct?.has(Number(taskId))
    ? `自定义仓位 ${(opts.taskAllocationPct.get(Number(taskId)) * 100).toFixed(0)}%`
    : `自动均分 → 切片`;
  opts.log?.(
    `[task ${taskId}] 资金估算 ${totalAssets.toFixed(2)} USDT | ${allocDesc} ${maxPositionAmount.toFixed(2)} USDT | ` +
      `sim_target_rate≈${targetRate.toFixed(4)} | 计划下单 ${side} qty=${actualQty} (${connector} ${isClose ? closeType : openType})`
  );

  if (!opts.realTrading) {
    opts.log?.(`[task ${taskId}] 未勾选「真实下单」，仅日志`, "ok");
    return null;
  }

  try {
    if (connector !== "binance") {
      await setOneWayMode(opts.creds.apiKey, opts.creds.secret, opts.creds.proxyBase);
      await setLeverage(symbol, lev, opts.creds.apiKey, opts.creds.secret, opts.creds.proxyBase);
    }

    let rowSummary;
    if (isClose) {
      const slipExceeded = !checkExecutorSlippage(currentPrice, refPx, closeSlip);
      const wantMarket = closeType === "MARKET" || slipExceeded;
      if (wantMarket) {
        const raw = await placeMarketOrder(connector === "binance" ? "binance" : "binance_perpetual", symbol, side, actualQty, {
          ...opts.creds,
          reduceOnly,
          spotLot: connector === "binance" ? { stepSize: lot.stepSize, minQty: lot.minQty } : undefined,
          futuresLot: connector !== "binance" ? { stepSize: lot.stepSize, minQty: lot.minQty } : undefined,
        });
        rowSummary = connector === "binance" ? summarizeSpotFull(raw) : summarizeFuturesResult(raw);
      } else if (connector === "binance") {
        rowSummary = await placeSpotLimitOrderWithRetry(
          symbol,
          side,
          actualQty,
          refPx,
          closeSec,
          closeSlip,
          false,
          true,
          opts.creds,
          slipHelpers
        );
      } else {
        rowSummary = await placeFuturesLimitOrderWithRetry(
          symbol,
          side,
          actualQty,
          refPx,
          closeSec,
          closeSlip,
          false,
          true,
          reduceOnly,
          opts.creds,
          slipHelpers
        );
      }
    } else {
      if (!checkExecutorSlippage(currentPrice, refPx, openSlip)) {
        opts.log?.(`[task ${taskId}] 开仓相对模拟价滑点超限 (${currentPrice} vs ${refPx})，放弃`, "err");
        return {
          id: trade.id,
          task_id: Number(taskId),
          timestamp: trade.timestamp,
          type: trade.type,
          price: trade.price,
          quantity: trade.quantity,
          connector,
          symbol,
          order_status: "failed",
          exchange_order_id: null,
          filled_qty: null,
          filled_amount: null,
          exchange_fee: null,
          realized_pnl_usdt: null,
          order_updated_at: new Date().toISOString(),
          error_msg: "开仓滑点超限",
        };
      }
      const wantMarket = openType === "MARKET";
      if (wantMarket) {
        const raw = await placeMarketOrder(connector === "binance" ? "binance" : "binance_perpetual", symbol, side, actualQty, {
          ...opts.creds,
          reduceOnly: false,
          spotLot: connector === "binance" ? { stepSize: lot.stepSize, minQty: lot.minQty } : undefined,
          futuresLot: connector !== "binance" ? { stepSize: lot.stepSize, minQty: lot.minQty } : undefined,
        });
        rowSummary = connector === "binance" ? summarizeSpotFull(raw) : summarizeFuturesResult(raw);
      } else if (connector === "binance") {
        rowSummary = await placeSpotLimitOrderWithRetry(
          symbol,
          side,
          actualQty,
          refPx,
          openSec,
          openSlip,
          true,
          openMAfter,
          opts.creds,
          slipHelpers
        );
      } else {
        rowSummary = await placeFuturesLimitOrderWithRetry(
          symbol,
          side,
          actualQty,
          refPx,
          openSec,
          openSlip,
          true,
          openMAfter,
          false,
          opts.creds,
          slipHelpers
        );
      }
    }

    const filledQty = Number(rowSummary.filled_qty);
    const filledAmt = Number(rowSummary.filled_amount);
    const oid = rowSummary.exchange_order_id ?? rowSummary.order_id ?? null;
    const ok =
      (Number.isFinite(filledQty) && filledQty > 0) ||
      String(rowSummary.order_status || "").toUpperCase() === "FILLED" ||
      rowSummary.success === true;

    if (!ok) {
      throw new Error(rowSummary.reason || rowSummary.msg || "下单未成交");
    }

    return {
      id: trade.id,
      task_id: Number(taskId),
      timestamp: trade.timestamp,
      type: trade.type,
      price: trade.price,
      quantity: trade.quantity,
      connector,
      symbol,
      order_status: "filled",
      exchange_order_id: oid != null ? String(oid) : "—",
      filled_qty: filledQty,
      filled_amount: filledAmt,
      exchange_fee: rowSummary.exchange_fee ?? rowSummary.total_commission ?? null,
      realized_pnl_usdt: null,
      order_updated_at: new Date().toISOString(),
      error_msg: null,
    };
  } catch (e) {
    opts.log?.(`[task ${taskId}] 下单失败: ${e.message}`, "err");
    return {
      id: trade.id,
      task_id: Number(taskId),
      timestamp: trade.timestamp,
      type: trade.type,
      price: trade.price,
      quantity: trade.quantity,
      connector,
      symbol,
      order_status: "failed",
      exchange_order_id: null,
      filled_qty: null,
      filled_amount: null,
      exchange_fee: null,
      realized_pnl_usdt: null,
      order_updated_at: new Date().toISOString(),
      error_msg: String(e.message || e),
    };
  }
  });
}

export function handleTaskStopped(taskId, log) {
  clearTaskState(Number(taskId));
  log?.(`[task ${taskId}] 已停止，已清理跟单状态`, "ok");
}

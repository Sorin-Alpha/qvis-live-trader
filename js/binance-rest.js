/**
 * 币安 REST（现货 / U 本位合约），支持本地 CORS 代理前缀。
 * 签名与 Python BinanceClient 对齐：sorted query + HMAC-SHA256。
 */
import { hmacSha256Hex } from "./binance-sign.js";

/** @type {number} */
let _timeOffsetMs = 0;

function joinUrl(base, path) {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return b + p;
}

/**
 * @param {string} proxyBase 如 http://127.0.0.1:8787
 * @param {'spot'|'fapi'} kind
 * @param {string} path 含前导 /，如 /api/v3/time
 */
function proxiedPath(proxyBase, kind, path) {
  const prefix = kind === "spot" ? "/spot" : "/fapi";
  return joinUrl(proxyBase, prefix + path);
}

/** 浏览器发往本地 CORS 代理时附带，由代理经该 HTTP(s) 代理访问币安（与界面「出境代理」一致） */
const _upstreamStack = [];

function peekUpstreamProxyHeaderValue() {
  if (!_upstreamStack.length) return "";
  return _upstreamStack[_upstreamStack.length - 1];
}

/**
 * 在本次异步调用链内的 fetch 均带上 X-Upstream-Proxy（可嵌套：栈）。
 * @param {string} url 如 http://127.0.0.1:7890 ，空字符串表示仅用代理进程的环境变量 HTTPS_PROXY
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withBinanceUpstreamProxy(url, fn) {
  const u = String(url || "").trim();
  _upstreamStack.push(u);
  try {
    return await fn();
  } finally {
    _upstreamStack.pop();
  }
}

function isBinanceTimestampError(e) {
  const c = e?.body?.code;
  if (c === -1021) return true;
  const s = String(e?.message || "");
  return s.includes("-1021") || s.includes("Timestamp for this request");
}

/**
 * 502/超时等多为本地代理连不上币安 upstream；原始信息里的奇怪 IP 常为 DNS/代理误转发。
 * @returns {string|null} 若非典型网络/代理问题则返回 null，保留原始 Error。
 */
function maybeHumanizeBinanceProxyError(err, proxyBase) {
  const pb = String(proxyBase || "").trim() || "（未填写代理地址）";
  const status = err?.status;
  const rawMsg = String(err?.message || err || "");
  // 已是本函数生成的说明，避免 syncServerTime 末尾再次 throwWithOptionalProxyHint 嵌套一整段
  if (rawMsg.includes("代理将「/spot」前缀转到")) return null;
  let bodyStr = "";
  const b = err?.body;
  if (b && typeof b === "object") {
    try {
      bodyStr = JSON.stringify(b);
    } catch {
      bodyStr = "";
    }
  }
  const combined = `${rawMsg} ${bodyStr}`;

  const looksProxyOrNetwork =
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (typeof status === "number" && status >= 500 && status < 600) ||
    /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|ECONNRESET|CERT_|UNABLE_TO_VERIFY/i.test(
      combined
    ) ||
    /Failed to fetch|NetworkError|Load failed|network error/i.test(rawMsg);

  if (!looksProxyOrNetwork) return null;

  const detail = rawMsg.length > 200 ? `${rawMsg.slice(0, 200)}…` : rawMsg;
  const timeoutHint = /timeout|ETIMEDOUT/i.test(combined)
    ? `④ 若能直连 Python 而浏览器超时：在界面填写「币安出境 HTTP 代理」，或在运行 binance-cors-proxy 的终端设置 HTTPS_PROXY（与 VPN 本地端口一致）；依赖 npm 已安装 https-proxy-agent。`
    : "";
  return (
    `本地代理「${pb}」访问币安失败（${detail || "网络异常"}）。` +
    `请检查：① 本页配套的本地转发服务已启动（与一键启动脚本一致）；② 路由「/spot」→ api.binance.com、「/fapi」→ fapi.binance.com ；③ 异常 IP 多为 DNS/系统代理问题。` +
    (timeoutHint ? ` ${timeoutHint}` : "")
  );
}

function throwWithOptionalProxyHint(err, proxyBase) {
  const hint = maybeHumanizeBinanceProxyError(err, proxyBase);
  if (!hint) throw err;
  const ne = new Error(hint);
  // 勿附带 HTTP 502，否则可能被上层再次当成「需人性化」而重复包装
  ne.body = err?.body;
  throw ne;
}

/**
 * @param {string} [proxyBase] 填则对 502/超时等给出中文说明
 */
async function rawFetch(url, opts, proxyBase) {
  const up = peekUpstreamProxyHeaderValue();
  const headers = { ...(opts.headers || {}) };
  if (up) headers["X-Upstream-Proxy"] = up;
  let r;
  try {
    r = await fetch(url, { ...opts, headers });
  } catch (e) {
    throwWithOptionalProxyHint(e, proxyBase);
  }
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  if (!r.ok) {
    const msg = json?.msg || json?.message || text || r.statusText;
    const err = new Error(`HTTP ${r.status}: ${msg}`);
    err.status = r.status;
    err.body = json;
    throwWithOptionalProxyHint(err, proxyBase);
  }
  if (json && typeof json.code === "number" && json.code && json.code !== 200) {
    const err = new Error(`${json.code} ${json.msg || ""}`);
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * 与 BinanceClient / BinancePerpetualClient._update_time_offset 一致：
 * offset = serverTime − 本地时刻 − 200ms；不要用 RTT/2，否则易把签名时间戳算超前触发 -1021。
 */
export async function syncServerTime(proxyBase) {
  const spotUrl = proxiedPath(proxyBase, "spot", "/api/v3/time");
  const futUrl = proxiedPath(proxyBase, "fapi", "/fapi/v1/time");
  let lastErr;
  try {
    const j = await rawFetch(spotUrl, { method: "GET" }, proxyBase);
    const server = Number(j.serverTime);
    const local = Date.now();
    _timeOffsetMs = server - local - 200;
    return;
  } catch (e) {
    lastErr = e;
  }
  try {
    const j = await rawFetch(futUrl, { method: "GET" }, proxyBase);
    const server = Number(j.serverTime);
    const local = Date.now();
    _timeOffsetMs = server - local - 200;
    return;
  } catch (e) {
    lastErr = e;
  }
  throwWithOptionalProxyHint(lastErr, proxyBase);
}

function ts() {
  return Math.floor(Date.now() + _timeOffsetMs);
}

/**
 * @param {Record<string,string|number>} params
 */
async function signParams(secret, params) {
  const p = { ...params, timestamp: ts(), recvWindow: 60000 };
  const keys = Object.keys(p).sort();
  // 与 Python BinanceClient._request 一致：sorted keys + key=value 直连（不做 encodeURIComponent），
  // HMAC 明文须与 POST body / GET query 发送内容一致（币安典型 ASCII 参数下与 URL 编码形式相同）。
  const qs = keys.map((k) => `${k}=${String(p[k])}`).join("&");
  const sig = await hmacSha256Hex(secret, qs);
  return `${qs}&signature=${sig}`;
}

/**
 * @param {'spot'|'fapi'} kind
 * 对齐后端 _request：签名请求遇 -1021 时刷新时间偏移后重试一次。
 */
export async function signedRequest(method, kind, path, params, apiKey, secret, proxyBase) {
  const base = proxiedPath(proxyBase, kind, path);
  const headers = {
    "X-MBX-APIKEY": apiKey,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const body = await signParams(secret, params);
      if (method === "GET") {
        const url = `${base}?${body}`;
        return await rawFetch(url, { method: "GET", headers: { "X-MBX-APIKEY": apiKey } }, proxyBase);
      }
      if (method === "POST") {
        return await rawFetch(base, { method: "POST", headers, body }, proxyBase);
      }
      if (method === "DELETE") {
        const url = `${base}?${body}`;
        return await rawFetch(url, { method: "DELETE", headers: { "X-MBX-APIKEY": apiKey } }, proxyBase);
      }
      throw new Error(`unsupported ${method}`);
    } catch (e) {
      lastErr = e;
      if (attempt === 0 && isBinanceTimestampError(e)) {
        await syncServerTime(proxyBase);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export async function getExchangeInfoSpot(symbol, proxyBase) {
  const url = `${proxiedPath(proxyBase, "spot", "/api/v3/exchangeInfo")}?symbol=${encodeURIComponent(symbol)}`;
  return rawFetch(url, { method: "GET" }, proxyBase);
}

export async function getExchangeInfoFutures(symbol, proxyBase) {
  const url = `${proxiedPath(proxyBase, "fapi", "/fapi/v1/exchangeInfo")}?symbol=${encodeURIComponent(symbol)}`;
  return rawFetch(url, { method: "GET" }, proxyBase);
}

export function lotFilter(symbolInfo) {
  const f = (symbolInfo.filters || []).find((x) => x.filterType === "LOT_SIZE");
  // Binance 现货部分交易对已从 MIN_NOTIONAL 迁移至 NOTIONAL 过滤器类型，需同时兼容
  const mn = (symbolInfo.filters || []).find(
    (x) => x.filterType === "MIN_NOTIONAL" || x.filterType === "NOTIONAL"
  );
  return {
    stepSize: Number(f?.stepSize || "0.00000001"),
    minQty: Number(f?.minQty || "0"),
    minNotional: Number(mn?.minNotional || mn?.notional || "0"),
  };
}

export function priceFilter(symbolInfo) {
  const f = (symbolInfo.filters || []).find((x) => x.filterType === "PRICE_FILTER");
  return { tickSize: Number(f?.tickSize || "0.01") };
}

/**
 * 对齐 binance_api / binance_perpetual_api.quantize_price：round 到 tick；
 * 卖侧若 round 后低于原值则 +1 tick（Post-Only 等场景）。
 */
export function quantizePriceBinance(price, tickSize, isBuy) {
  const t = Number(tickSize);
  const p = Number(price);
  if (!(t > 0) || !Number.isFinite(p)) return p;
  let np = Math.round(p / t) * t;
  const dec = (String(t).split(".")[1] || "").length;
  np = Number(np.toFixed(Math.min(dec, 12)));
  if (!isBuy && np < p) np = Number((np + t).toFixed(Math.min(dec, 12)));
  return np;
}

/**
 * 对齐 BinanceClient.quantize_quantity：卖出只向下取整且绝不抬到 min_qty（避免超 free 报 -2010）；
 * 买入若原量小于 min_qty 先抬到 min_qty 再按步长向下取整。
 */
export function quantizeSpotQuantity(quantity, lot, side) {
  const step = Number(lot.stepSize);
  const minQty = Number(lot.minQty || 0);
  let qty = Number(quantity);
  if (!(qty > 0) || !(step > 0)) return 0;
  const dec = (String(step).split(".")[1] || "").length;
  let q = Math.floor(qty / step) * step;
  q = Number(q.toFixed(Math.min(dec, 12)));
  if (!(q > 0)) return 0;
  const su = String(side || "").toUpperCase();
  if (su === "SELL") {
    if (q < minQty) return 0;
    return q;
  }
  if (qty < minQty) qty = minQty;
  q = Math.floor(qty / step) * step;
  return Number(q.toFixed(Math.min(dec, 12)));
}

/** 对齐 BinancePerpetualClient.quantize_quantity */
export function quantizeFuturesQuantity(quantity, lot) {
  const step = Number(lot.stepSize);
  const minQty = Number(lot.minQty || 0);
  let qty = Number(quantity);
  if (qty < minQty) qty = minQty;
  if (!(step > 0)) return 0;
  const q = Math.round(qty / step) * step;
  const dec = (String(step).split(".")[1] || "").length;
  return Number(q.toFixed(Math.min(dec, 12)));
}

export function lotLiteFromSymbolInfo(si) {
  const lot = lotFilter(si);
  return { stepSize: lot.stepSize, minQty: lot.minQty };
}

export function floorToStep(qty, stepSize) {
  if (!(qty > 0) || !(stepSize > 0)) return 0;
  const n = Math.floor(qty / stepSize) * stepSize;
  const decimals = (String(stepSize).split(".")[1] || "").length;
  return Number(n.toFixed(Math.min(decimals, 12)));
}

/** 避免科学计数法，满足币安 quantity 字符串要求 */
export function stringifyBinanceQty(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) throw new Error("invalid quantity");
  const abs = Math.abs(n);
  let decimals = 8;
  if (abs >= 1) decimals = 6;
  if (abs < 1e-4) decimals = 12;
  let s = n.toFixed(decimals).replace(/\.?0+$/, "");
  if (!s || s === "-") throw new Error("invalid quantity string");
  if (s.includes("e") || s.includes("E")) s = n.toFixed(12).replace(/\.?0+$/, "");
  return s;
}

export async function getBookTicker(symbol, connector, proxyBase) {
  const sym = symbol.toUpperCase();
  if (connector === "binance") {
    const url = `${proxiedPath(proxyBase, "spot", "/api/v3/ticker/bookTicker")}?symbol=${sym}`;
    return rawFetch(url, { method: "GET" }, proxyBase);
  }
  const url = `${proxiedPath(proxyBase, "fapi", "/fapi/v1/ticker/bookTicker")}?symbol=${sym}`;
  return rawFetch(url, { method: "GET" }, proxyBase);
}

/**
 * 相对模拟推送价 P_sim 的偏离：|盘口中间价 − P_sim| / P_sim（分母为模拟价，与 copy-engine 首道风控一致）。
 */
export function slippageAgainstBook(tradePrice, bid, ask) {
  const pSim = Number(tradePrice);
  const mid = (Number(bid) + Number(ask)) / 2;
  if (!(pSim > 0)) return Infinity;
  return Math.abs(mid - pSim) / pSim;
}

/**
 * @param {'BUY'|'SELL'} side
 * @param {boolean} reduceOnly 仅合约平仓侧
 * @param {{apiKey:string,secret:string,proxyBase:string,reduceOnly?:boolean,spotLot?:{stepSize:number,minQty:number},futuresLot?:{stepSize:number,minQty:number}}} creds
 * spotLot / futuresLot 与后端 create_order 内 quantize_quantity 对齐；不传则仅做 stringify（不推荐现货卖单）。
 */
export async function placeMarketOrder(
  connector,
  symbol,
  side,
  quantity,
  { apiKey, secret, proxyBase, reduceOnly = false, spotLot, futuresLot }
) {
  const sym = symbol.toUpperCase();
  let q = Number(quantity);
  if (connector === "binance" && spotLot && spotLot.stepSize != null) {
    q = quantizeSpotQuantity(quantity, spotLot, side);
  } else if (connector === "binance_perpetual" && futuresLot && futuresLot.stepSize != null) {
    q = quantizeFuturesQuantity(quantity, futuresLot);
  }
  if (!(q > 0)) throw new Error("quantity after quantize is 0");
  const qtyStr = stringifyBinanceQty(q);
  if (connector === "binance") {
    return signedRequest(
      "POST",
      "spot",
      "/api/v3/order",
      {
        symbol: sym,
        side,
        type: "MARKET",
        quantity: qtyStr,
        newOrderRespType: "FULL",
      },
      apiKey,
      secret,
      proxyBase
    );
  }
  return signedRequest(
    "POST",
    "fapi",
    "/fapi/v1/order",
    {
      symbol: sym,
      side,
      type: "MARKET",
      quantity: qtyStr,
      reduceOnly: reduceOnly ? "true" : "false",
      newOrderRespType: "RESULT",
    },
    apiKey,
    secret,
    proxyBase
  );
}

/** 现货：base 资产可用余额 */
export async function getSpotBaseFree(symbol, apiKey, secret, proxyBase) {
  const base = symbol.replace(/USDT$/i, "").toUpperCase();
  const acc = await signedRequest("GET", "spot", "/api/v3/account", {}, apiKey, secret, proxyBase);
  const b = (acc.balances || []).find((x) => x.asset === base);
  return Number(b?.free || 0);
}

/** 现货：base 总持仓（free+locked），用于跟单「是否有本地仓」判断 */
export async function getSpotBaseTotal(symbol, apiKey, secret, proxyBase) {
  const base = symbol.replace(/USDT$/i, "").toUpperCase();
  const acc = await signedRequest("GET", "spot", "/api/v3/account", {}, apiKey, secret, proxyBase);
  const b = (acc.balances || []).find((x) => x.asset === base);
  return Number(b?.free || 0) + Number(b?.locked || 0);
}

/** 合约：positionAmt */
export async function getFuturesPositionAmt(symbol, apiKey, secret, proxyBase) {
  const sym = symbol.toUpperCase();
  const rows = await signedRequest("GET", "fapi", "/fapi/v3/positionRisk", { symbol: sym }, apiKey, secret, proxyBase);
  const row = (Array.isArray(rows) ? rows : []).find((r) => r.symbol === sym) || {};
  return Number(row.positionAmt || 0);
}

export async function setLeverage(symbol, leverage, apiKey, secret, proxyBase) {
  const sym = symbol.toUpperCase();
  return signedRequest(
    "POST",
    "fapi",
    "/fapi/v1/leverage",
    { symbol: sym, leverage: String(Math.max(1, Math.min(125, Math.floor(Number(leverage) || 1)))) },
    apiKey,
    secret,
    proxyBase
  );
}

function isBenignOneWayModeError(e) {
  const msg = String(e?.message || "").toLowerCase();
  const bm = String(e?.body?.msg || "").toLowerCase();
  const combined = `${msg} ${bm}`;
  if (combined.includes("-4059")) return true;
  // 已是单向持仓时币安可能返回 400 + "No need to change position side."
  if (combined.includes("no need to change position side")) return true;
  return false;
}

export async function setOneWayMode(apiKey, secret, proxyBase) {
  try {
    await signedRequest("POST", "fapi", "/fapi/v1/positionSide/dual", { dualSidePosition: "false" }, apiKey, secret, proxyBase);
  } catch (e) {
    if (isBenignOneWayModeError(e)) return;
    throw e;
  }
}

/** 校验币安密钥（现货账户接口）；需代理可访问币安。 */
export async function verifyBinanceCredentials(apiKey, secret, proxyBase) {
  await syncServerTime(proxyBase);
  return signedRequest("GET", "spot", "/api/v3/account", {}, apiKey, secret, proxyBase);
}

/** U 本位账户余额接口（签名）；与后端 BinancePerpetualClient.get_balance_v3 一致。 */
export async function verifyBinanceFuturesAccount(apiKey, secret, proxyBase) {
  await syncServerTime(proxyBase);
  return signedRequest("GET", "fapi", "/fapi/v3/balance", {}, apiKey, secret, proxyBase);
}

/** 现货 + 合约账户均可读（旧版校验，不含下单权限）。 */
export async function verifyBinanceSpotAndFutures(apiKey, secret, proxyBase) {
  await verifyBinanceCredentials(apiKey, secret, proxyBase);
  await verifyBinanceFuturesAccount(apiKey, secret, proxyBase);
}

const VALIDATE_SPOT_SYMBOL = "BTCUSDT";
const VALIDATE_SPOT_MIN_USDT_FREE = 300;
const VALIDATE_PERP_SYMBOL = "BTCUSDT";
const VALIDATE_PERP_MIN_USDT_AVAILABLE = 100;
const VALIDATE_PERP_MIN_NOTIONAL_FLOOR = 100;

/**
 * 现货：对齐 `app/utils/binance_api.BinanceClient.validate` — 低价限价 BUY（GTC）后立即撤单。
 * 调用方须先 `syncServerTime(proxyBase)`。
 */
export async function verifyBinanceSpotLimitTrade(apiKey, secret, proxyBase) {
  const acc = await signedRequest("GET", "spot", "/api/v3/account", {}, apiKey, secret, proxyBase);
  const usdtRow = (acc.balances || []).find((x) => x.asset === "USDT");
  const usdtFree = Number(usdtRow?.free || 0);
  if (usdtFree < VALIDATE_SPOT_MIN_USDT_FREE) {
    throw new Error(`现货 USDT 可用 ${usdtFree.toFixed(2)} < ${VALIDATE_SPOT_MIN_USDT_FREE}U`);
  }
  const sym = VALIDATE_SPOT_SYMBOL;
  const ex = await getExchangeInfoSpot(sym, proxyBase);
  const si = (ex.symbols || []).find((s) => s.symbol === sym);
  if (!si) throw new Error(`现货 exchangeInfo 无 ${sym}`);
  const lot = lotFilter(si);
  const tick = priceFilter(si).tickSize;
  const book = await getBookTicker(sym, "binance", proxyBase);
  let current = Number(book.askPrice || 0);
  if (!(current > 0)) current = Number(book.bidPrice || 0);
  if (!(current > 0)) throw new Error(`无法取得 ${sym} 盘口价`);

  let price = quantizePriceBinance(current * 0.95, tick, true);
  if (!(price > 0)) price = tick;

  let quantity = lot.minNotional / price;
  if (quantity < lot.minQty) quantity = lot.minQty;
  const step = lot.stepSize;
  quantity = Math.round(quantity / step) * step;
  quantity = Number(quantity.toFixed(12));
  let guard = 0;
  while (quantity * price < lot.minNotional && step > 0 && guard++ < 10000) {
    quantity += step;
    quantity = Math.round(quantity / step) * step;
    quantity = Number(quantity.toFixed(12));
  }
  if (quantity * price < lot.minNotional) {
    throw new Error("无法满足现货最小名义金额，无法构造探测单");
  }

  const qtyStr = stringifyBinanceQty(quantity);
  let order;
  try {
    order = await signedRequest(
      "POST",
      "spot",
      "/api/v3/order",
      {
        symbol: sym,
        side: "BUY",
        type: "LIMIT",
        timeInForce: "GTC",
        quantity: qtyStr,
        price: String(price),
        newOrderRespType: "FULL",
      },
      apiKey,
      secret,
      proxyBase
    );
  } catch (e) {
    const code = e?.body?.code;
    const msg = e?.message || String(e);
    if (String(msg).includes("401") || code === -2015 || String(msg).includes("-2015")) {
      throw new Error("API Key 无现货交易权限或 IP 未在白名单");
    }
    throw new Error(`现货探测下单失败: ${msg}`);
  }
  const orderId = order?.orderId;
  if (orderId == null) throw new Error("现货探测下单未返回 orderId");
  try {
    await signedRequest("DELETE", "spot", "/api/v3/order", { symbol: sym, orderId }, apiKey, secret, proxyBase);
  } catch (e) {
    throw new Error(`现货探测单已下但撤销失败（orderId=${orderId}）: ${e.message || e}`);
  }
}

/**
 * U 本位：对齐 `app/utils/binance_perpetual_api.BinancePerpetualClient.validate` — 低价限价 BUY + 撤单。
 * 调用方须先 `syncServerTime(proxyBase)`。
 */
export async function verifyBinancePerpLimitTrade(apiKey, secret, proxyBase) {
  await setOneWayMode(apiKey, secret, proxyBase);
  await setLeverage(VALIDATE_PERP_SYMBOL, 10, apiKey, secret, proxyBase);

  const bals = await signedRequest("GET", "fapi", "/fapi/v3/balance", {}, apiKey, secret, proxyBase);
  const u = (bals || []).find((x) => x.asset === "USDT");
  const avail = Number(u?.availableBalance ?? u?.balance ?? 0);
  if (avail < VALIDATE_PERP_MIN_USDT_AVAILABLE) {
    throw new Error(`合约 USDT 可用 ${avail.toFixed(2)} < ${VALIDATE_PERP_MIN_USDT_AVAILABLE}U`);
  }

  const sym = VALIDATE_PERP_SYMBOL;
  const ex = await getExchangeInfoFutures(sym, proxyBase);
  const si = (ex.symbols || []).find((s) => s.symbol === sym);
  if (!si) throw new Error(`合约 exchangeInfo 无 ${sym}`);
  const lot = lotFilter(si);
  const tick = priceFilter(si).tickSize;
  const minNotionalFilter = Number(lot.minNotional || 0);
  const effectiveMinNotional = Math.max(minNotionalFilter, VALIDATE_PERP_MIN_NOTIONAL_FLOOR);

  const book = await getBookTicker(sym, "binance_perpetual", proxyBase);
  let current = Number(book.askPrice || 0);
  if (!(current > 0)) current = Number(book.bidPrice || 0);
  if (!(current > 0)) throw new Error(`无法取得 ${sym} 盘口价`);

  let price = quantizePriceBinance(current * 0.95, tick, true);
  if (!(price > 0)) price = tick;

  let quantity = effectiveMinNotional / price;
  if (quantity < lot.minQty) quantity = lot.minQty;
  const step = lot.stepSize;
  quantity = Math.round(quantity / step) * step;
  quantity = Number(quantity.toFixed(12));

  const maxSteps = 5000;
  let qFinal = 0;
  let pFinal = 0;
  for (let i = 0; i < maxSteps; i++) {
    const qAdj = quantizeFuturesQuantity(quantity, lot);
    const pAdj = quantizePriceBinance(price, tick, true);
    if (qAdj * pAdj >= effectiveMinNotional) {
      qFinal = qAdj;
      pFinal = pAdj;
      break;
    }
    quantity += step;
  }
  if (!(qFinal > 0) || !(pFinal > 0)) {
    throw new Error(
      "无法满足合约最小名义金额（100 USDT 与交易对规则取大），无法构造探测单"
    );
  }

  let order;
  try {
    order = await signedRequest(
      "POST",
      "fapi",
      "/fapi/v1/order",
      {
        symbol: sym,
        side: "BUY",
        type: "LIMIT",
        timeInForce: "GTC",
        quantity: stringifyBinanceQty(qFinal),
        price: String(pFinal),
        reduceOnly: "false",
        newOrderRespType: "RESULT",
      },
      apiKey,
      secret,
      proxyBase
    );
  } catch (e) {
    const code = e?.body?.code;
    const msg = e?.message || String(e);
    if (String(msg).includes("401") || code === -2015 || String(msg).includes("-2015")) {
      throw new Error("API Key 无 U 本位合约交易权限或 IP 未在白名单");
    }
    throw new Error(`合约探测下单失败: ${msg}`);
  }
  const orderId = order?.orderId;
  if (orderId == null) throw new Error("合约探测下单未返回 orderId");
  try {
    await signedRequest("DELETE", "fapi", "/fapi/v1/order", { symbol: sym, orderId }, apiKey, secret, proxyBase);
  } catch (e) {
    throw new Error(`合约探测单已下但撤销失败（orderId=${orderId}）: ${e.message || e}`);
  }
}

/**
 * 分别验证现货 / U 本位：各下一笔远离市价的限价单并立即撤销（与后端 Python validate 一致）。
 * @returns {{ spotOk: boolean, perpOk: boolean, spotError: string|null, perpError: string|null }}
 */
export async function verifyBinanceTradingCapabilities(apiKey, secret, proxyBase) {
  const out = { spotOk: false, perpOk: false, spotError: null, perpError: null };
  try {
    await syncServerTime(proxyBase);
  } catch (e) {
    const msg = e?.message || String(e);
    out.spotError = msg;
    out.perpError = msg;
    return out;
  }
  try {
    await verifyBinanceSpotLimitTrade(apiKey, secret, proxyBase);
    out.spotOk = true;
  } catch (e) {
    out.spotError = e?.message || String(e);
  }
  try {
    await verifyBinancePerpLimitTrade(apiKey, secret, proxyBase);
    out.perpOk = true;
  } catch (e) {
    out.perpError = e?.message || String(e);
  }
  return out;
}

/** 对齐 executor.calculate_max_position_amount_with_tasks：现货侧总资产（USDT + 非 U 估值） */
export async function estimateSpotTotalAssetsUsdt(apiKey, secret, proxyBase) {
  await syncServerTime(proxyBase);
  const acc = await signedRequest("GET", "spot", "/api/v3/account", {}, apiKey, secret, proxyBase);
  let usdt = 0;
  let extra = 0;
  for (const bal of acc.balances || []) {
    const sum = Number(bal.free || 0) + Number(bal.locked || 0);
    if (sum <= 0) continue;
    if (bal.asset === "USDT") {
      usdt += sum;
      continue;
    }
    const sym = `${bal.asset}USDT`;
    try {
      const bt = await getBookTicker(sym, "binance", proxyBase);
      const mid = (Number(bt.bidPrice) + Number(bt.askPrice)) / 2;
      if (mid > 0) extra += sum * mid;
    } catch {
      /* 忽略无法估值的小币种 */
    }
  }
  return usdt + extra;
}

/** 对齐 executor：名义持仓 + USDT 可用 × 杠杆 */
export async function estimateFuturesTotalAssetsUsdt(apiKey, secret, proxyBase, leverage) {
  await syncServerTime(proxyBase);
  const rows = await signedRequest("GET", "fapi", "/fapi/v3/positionRisk", {}, apiKey, secret, proxyBase);
  let nominal = 0;
  for (const pos of rows || []) {
    const amt = Number(pos.positionAmt || 0);
    if (amt !== 0) nominal += Math.abs(amt * Number(pos.entryPrice || 0));
  }
  const bals = await signedRequest("GET", "fapi", "/fapi/v3/balance", {}, apiKey, secret, proxyBase);
  const u = (bals || []).find((x) => x.asset === "USDT");
  const wallet = Number(u?.availableBalance ?? u?.balance ?? 0);
  const lev = Math.max(1, Math.min(125, Math.floor(Number(leverage) || 1)));
  return nominal + wallet * lev;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 现货限价重试（简化版 executor.place_spot_limit_order_with_retry）：GTX + 超时撤单 + 可选收尾市价。
 */
export async function placeSpotLimitOrderWithRetry(
  symbol,
  side,
  quantity,
  referencePrice,
  maxSeconds,
  maxSlippage,
  isOpen,
  openMarketAfterLimit,
  creds,
  { checkSlippageFn, quantizePriceFloor }
) {
  const sym = symbol.toUpperCase();
  const refPx = Number(referencePrice);
  let remaining = Number(quantity);
  let totalQty = 0;
  let totalQuote = 0;
  let totalFee = 0;
  let lastOid = null;
  const start = Date.now() / 1000;
  const exCached = await getExchangeInfoSpot(sym, creds.proxyBase);
  const siCached = (exCached.symbols || []).find((s) => s.symbol === sym);
  if (!siCached) throw new Error("exchangeInfo 无该交易对");
  const spotLotRef = lotLiteFromSymbolInfo(siCached);
  const tickCached = priceFilter(siCached).tickSize;
  while (remaining > 0 && Date.now() / 1000 - start < maxSeconds) {
    const book = await getBookTicker(sym, "binance", creds.proxyBase);
    const ask = Number(book.askPrice);
    const bid = Number(book.bidPrice);
    if (!(ask > 0) || !(bid > 0)) {
      await sleep(500);
      continue;
    }
    const opponent = side === "BUY" ? ask : bid;
    if (!checkSlippageFn(opponent, refPx, maxSlippage)) {
      if (isOpen) {
        return { success: false, reason: "slippage", filled_qty: totalQty, filled_amount: totalQuote, exchange_fee: totalFee, order_id: lastOid };
      }
      const m = await placeMarketOrder("binance", sym, side, remaining, { ...creds, spotLot: spotLotRef });
      const row = summarizeSpotFull(m);
      if (row.order_status === "FILLED" || row.filled_qty > 0) {
        totalQty += row.filled_qty;
        totalQuote += row.filled_amount;
        totalFee += row.exchange_fee;
        lastOid = row.exchange_order_id || lastOid;
      }
      remaining = 0;
      break;
    }
    const tick = tickCached;
    let limitPrice =
      side === "BUY"
        ? quantizePriceFloor(bid - tick, tick)
        : quantizePriceFloor(ask + tick, tick);
    if (side === "BUY" && limitPrice >= ask) limitPrice = quantizePriceFloor(ask - tick, tick);
    if (side === "SELL" && limitPrice <= bid) limitPrice = quantizePriceFloor(bid + tick, tick);
    limitPrice = quantizePriceBinance(limitPrice, tick, side === "BUY");

    const lot = lotFilter(siCached);
    const qExec = quantizeSpotQuantity(remaining, lot, side);
    if (!(qExec > 0)) break;

    const order = await signedRequest(
      "POST",
      "spot",
      "/api/v3/order",
      {
        symbol: sym,
        side,
        type: "LIMIT",
        timeInForce: "GTX",
        quantity: stringifyBinanceQty(qExec),
        price: String(limitPrice),
        newOrderRespType: "FULL",
      },
      creds.apiKey,
      creds.secret,
      creds.proxyBase
    );
    lastOid = String(order.orderId ?? lastOid);
    const fills = order.fills || [];
    for (const f of fills) totalFee += Number(f.commission || 0);

    const waitUntil = Date.now() + 10000;
    while (Date.now() < waitUntil) {
      await sleep(4000);
      const st = await signedRequest("GET", "spot", "/api/v3/order", { symbol: sym, orderId: order.orderId }, creds.apiKey, creds.secret, creds.proxyBase);
      const exq = Number(st.executedQty || 0);
      if (exq >= qExec - 1e-12) {
        totalQty += qExec;
        totalQuote += qExec * limitPrice;
        remaining = Math.max(0, remaining - qExec);
        break;
      }
      if (["CANCELED", "EXPIRED", "FILLED"].includes(st.status)) {
        if (exq > 0) {
          totalQty += exq;
          totalQuote += exq * limitPrice;
          remaining = Math.max(0, remaining - exq);
        }
        break;
      }
    }
    try {
      await signedRequest("DELETE", "spot", "/api/v3/order", { symbol: sym, orderId: order.orderId }, creds.apiKey, creds.secret, creds.proxyBase);
    } catch {
      /* 已成交或不存在 */
    }
  }

  if (remaining > 0 && ((isOpen && openMarketAfterLimit) || !isOpen)) {
    const m = await placeMarketOrder("binance", sym, side, remaining, { ...creds, spotLot: spotLotRef });
    const row = summarizeSpotFull(m);
    if (row.filled_qty > 0) {
      totalQty += row.filled_qty;
      totalQuote += row.filled_amount;
      totalFee += row.exchange_fee;
      lastOid = row.exchange_order_id || lastOid;
      remaining = 0;
    }
  }

  return {
    success: remaining <= 1e-12,
    filled_qty: totalQty,
    filled_amount: totalQuote,
    exchange_fee: totalFee,
    order_id: lastOid,
    reason: remaining > 1e-12 ? "incomplete" : undefined,
  };
}

/** 合约限价重试（简化版）：轮询成交；收尾市价逻辑对齐 executor。 */
export async function placeFuturesLimitOrderWithRetry(
  symbol,
  side,
  quantity,
  referencePrice,
  maxSeconds,
  maxSlippage,
  isOpen,
  openMarketAfterLimit,
  reduceOnly,
  creds,
  { checkSlippageFn, quantizePriceFloor }
) {
  const sym = symbol.toUpperCase();
  const refPx = Number(referencePrice);
  let remaining = Number(quantity);
  let totalQty = 0;
  let totalQuote = 0;
  let totalFee = 0;
  let lastOid = null;
  const start = Date.now() / 1000;
  const exCached = await getExchangeInfoFutures(sym, creds.proxyBase);
  const siCached = (exCached.symbols || []).find((s) => s.symbol === sym);
  if (!siCached) throw new Error("exchangeInfo 无该交易对");
  const futuresLotRef = lotLiteFromSymbolInfo(siCached);
  const tickCached = priceFilter(siCached).tickSize;

  while (remaining > 0 && Date.now() / 1000 - start < maxSeconds) {
    const book = await getBookTicker(sym, "binance_perpetual", creds.proxyBase);
    const ask = Number(book.askPrice);
    const bid = Number(book.bidPrice);
    if (!(ask > 0) || !(bid > 0)) {
      await sleep(500);
      continue;
    }
    const opponent = side === "BUY" ? ask : bid;
    if (!checkSlippageFn(opponent, refPx, maxSlippage)) {
      if (isOpen) {
        return { success: false, reason: "slippage", filled_qty: totalQty, filled_amount: totalQuote, exchange_fee: totalFee, order_id: lastOid };
      }
      const raw = await placeMarketOrder("binance_perpetual", sym, side, remaining, {
        ...creds,
        reduceOnly,
        futuresLot: futuresLotRef,
      });
      const row = summarizeFuturesResult(raw);
      totalQty += row.filled_qty;
      totalQuote += row.filled_amount;
      totalFee += row.exchange_fee;
      lastOid = row.exchange_order_id || lastOid;
      remaining = 0;
      break;
    }

    const tick = tickCached;
    let limitPrice =
      side === "BUY"
        ? quantizePriceFloor(bid - tick, tick)
        : quantizePriceFloor(ask + tick, tick);
    if (side === "BUY" && limitPrice >= ask) limitPrice = quantizePriceFloor(ask - tick, tick);
    if (side === "SELL" && limitPrice <= bid) limitPrice = quantizePriceFloor(bid + tick, tick);
    limitPrice = quantizePriceBinance(limitPrice, tick, side === "BUY");

    const lot = lotFilter(siCached);
    const qExec = quantizeFuturesQuantity(remaining, lot);
    if (!(qExec > 0)) break;

    const order = await signedRequest(
      "POST",
      "fapi",
      "/fapi/v1/order",
      {
        symbol: sym,
        side,
        type: "LIMIT",
        timeInForce: "GTX",
        quantity: stringifyBinanceQty(qExec),
        price: String(limitPrice),
        reduceOnly: reduceOnly ? "true" : "false",
        newOrderRespType: "RESULT",
      },
      creds.apiKey,
      creds.secret,
      creds.proxyBase
    );
    lastOid = String(order.orderId ?? lastOid);

    const waitUntil = Date.now() + 10000;
    while (Date.now() < waitUntil) {
      await sleep(4000);
      const st = await signedRequest("GET", "fapi", "/fapi/v1/order", { symbol: sym, orderId: order.orderId }, creds.apiKey, creds.secret, creds.proxyBase);
      const exq = Number(st.executedQty || 0);
      if (exq >= qExec - 1e-12) {
        totalQty += qExec;
        totalQuote += qExec * Number(st.avgPrice || limitPrice);
        totalFee += Math.abs(Number(st.commission || 0));
        remaining = Math.max(0, remaining - qExec);
        break;
      }
      if (["CANCELED", "EXPIRED", "FILLED"].includes(st.status)) {
        if (exq > 0) {
          totalQty += exq;
          totalQuote += exq * Number(st.avgPrice || limitPrice);
          totalFee += Math.abs(Number(st.commission || 0));
          remaining = Math.max(0, remaining - exq);
        }
        break;
      }
    }
    try {
      await signedRequest("DELETE", "fapi", "/fapi/v1/order", { symbol: sym, orderId: order.orderId }, creds.apiKey, creds.secret, creds.proxyBase);
    } catch {
      /* noop */
    }
  }

  if (remaining > 0 && ((isOpen && openMarketAfterLimit) || !isOpen)) {
    const raw = await placeMarketOrder("binance_perpetual", sym, side, remaining, {
      ...creds,
      reduceOnly,
      futuresLot: futuresLotRef,
    });
    const row = summarizeFuturesResult(raw);
    totalQty += row.filled_qty;
    totalQuote += row.filled_amount;
    totalFee += row.exchange_fee;
    lastOid = row.exchange_order_id || lastOid;
    remaining = 0;
  }

  return {
    success: remaining <= 1e-12,
    filled_qty: totalQty,
    filled_amount: totalQuote,
    exchange_fee: totalFee,
    order_id: lastOid,
    reason: remaining > 1e-12 ? "incomplete" : undefined,
  };
}

/**
 * 从现货 FULL 响应汇总成交量与额（与后端展示口径接近）
 */
export function summarizeSpotFull(order) {
  const fills = order.fills || [];
  let qty = 0;
  let quote = 0;
  let commission = 0;
  let commissionAsset = "";
  for (const f of fills) {
    qty += Number(f.qty || 0);
    quote += Number(f.price || 0) * Number(f.qty || 0);
    commission += Number(f.commission || 0);
    commissionAsset = f.commissionAsset || commissionAsset;
  }
  if (qty <= 0 && order.executedQty) {
    qty = Math.abs(Number(order.executedQty));
    const c = Number(order.cummulativeQuoteQty || 0);
    quote = c > 0 ? c : qty * Number(order.fills?.[0]?.price || order.price || 0);
  }
  const avgPx = qty > 0 ? quote / qty : 0;
  return {
    exchange_order_id: String(order.orderId ?? ""),
    order_status: order.status || "UNKNOWN",
    filled_qty: qty,
    filled_amount: quote,
    exchange_fee: commission,
    commission_asset: commissionAsset,
    avg_price: avgPx,
  };
}

/**
 * 合约 RESULT 单条
 */
export function summarizeFuturesResult(order) {
  const q = Math.abs(Number(order.executedQty || order.origQty || 0));
  const avg = Number(order.avgPrice || 0);
  const cum = Number(order.cumQuote || 0);
  const filled_amount = cum > 0 ? cum : q * avg;
  return {
    exchange_order_id: String(order.orderId ?? ""),
    order_status: order.status || "UNKNOWN",
    filled_qty: q,
    filled_amount,
    exchange_fee: Math.abs(Number(order.commission || 0)),
    avg_price: avg,
  };
}

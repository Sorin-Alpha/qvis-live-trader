/**
 * QVIS 本地跟单终端 — 入口脚本
 */
import { DEFAULT_MAX_SLIPPAGE_PCT, DEFAULT_PLATFORM_API_ROOT } from "./constants.js";
import {
  loadSettings,
  saveSettings,
  clearSecrets,
  mergeExchangeSettings,
  clearKeysValidationState,
} from "./storage.js";
import {
  verifyBinanceTradingCapabilities,
  syncServerTime,
  withBinanceUpstreamProxy,
} from "./binance-rest.js";

/** 与 `start-dev.mjs` / `binance-cors-proxy.mjs` 默认一致；Electron 可通过 ?binanceProxyPort= 覆盖（避免与 npm start 抢 8787） */
function resolveBinanceCorsProxyBase() {
  try {
    const raw = new URLSearchParams(window.location.search).get("binanceProxyPort");
    const n = raw != null ? Number(raw) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return `http://127.0.0.1:${n}`;
  } catch {
    /* noop */
  }
  return "http://127.0.0.1:8787";
}
const BINANCE_CORS_PROXY_BASE = resolveBinanceCorsProxyBase();
import {
  fetchRunningSimulated,
  fetchTaskDetail,
  connectClientWs,
  verifyClientApiKey,
} from "./platform-api.js";
import { handleSimTradeFill, handleTaskStopped, resetAllTaskStates } from "./copy-engine.js";

/** @type {Map<number, Record<string, unknown>>} */
const taskMetaCache = new Map();

/** 当前 WS 订阅的 task_id（用于按 connector 计数资本切片） */
/** @type {number[]} */
let wsSubscribedTaskIds = [];

function subscribedTaskCountForConnector(connector) {
  let hasPortfolio = false;
  let n = 0;
  for (const tid of wsSubscribedTaskIds) {
    const m = taskMetaCache.get(tid);
    if (!m) continue;
    if (m.task_type === "portfolio") hasPortfolio = true;
    if (m.connector === connector) n += 1;
  }
  if (hasPortfolio && connector === "binance_perpetual") return 1;
  return Math.max(1, n);
}

function readMaxSlippagePct() {
  return Number($("slippage").value) || DEFAULT_MAX_SLIPPAGE_PCT;
}

/** 开仓/平仓允许偏离与 02 最大滑点共用同一数值（界面不单独展示） */
function syncExchangeSlippageFromMax(es, slip) {
  const s = Number(slip);
  const v = Number.isFinite(s) && s >= 0 ? s : DEFAULT_MAX_SLIPPAGE_PCT;
  for (const key of ["binance", "binance_perpetual"]) {
    if (!es[key]) es[key] = {};
    es[key].open_order_slippage = v;
    es[key].close_order_slippage = v;
  }
  return es;
}

function readExchangeSettingsFromDom() {
  const slip = readMaxSlippagePct();
  const es = {
    binance: {
      open_order_type: $("spot-open-type").value,
      open_order_seconds: Number($("spot-open-seconds").value) || 120,
      open_market_after_limit: $("spot-open-mkt-after").checked,
      open_order_slippage: slip,
      close_order_type: $("spot-close-type").value,
      close_order_seconds: Number($("spot-close-seconds").value) || 120,
      close_order_slippage: slip,
    },
    binance_perpetual: {
      leverage: Math.max(1, Math.min(125, Math.floor(Number($("perp-leverage").value) || 3))),
      open_order_type: $("perp-open-type").value,
      open_order_seconds: Number($("perp-open-seconds").value) || 120,
      open_market_after_limit: $("perp-open-mkt-after").checked,
      open_order_slippage: slip,
      close_order_type: $("perp-close-type").value,
      close_order_seconds: Number($("perp-close-seconds").value) || 120,
      close_order_slippage: slip,
    },
  };
  return syncExchangeSlippageFromMax(es, slip);
}

/** @param {{ binance?: object, binance_perpetual?: object }} es */
function applyExchangeSettingsToDom(es) {
  const b = es.binance || {};
  const p = es.binance_perpetual || {};
  $("spot-open-type").value = b.open_order_type || "MARKET";
  $("spot-close-type").value = b.close_order_type || "MARKET";
  $("spot-open-seconds").value = String(b.open_order_seconds ?? 120);
  $("spot-close-seconds").value = String(b.close_order_seconds ?? 120);
  $("spot-open-mkt-after").checked = !!b.open_market_after_limit;

  $("perp-leverage").value = String(p.leverage ?? 3);
  $("perp-open-type").value = p.open_order_type || "MARKET";
  $("perp-close-type").value = p.close_order_type || "MARKET";
  $("perp-open-seconds").value = String(p.open_order_seconds ?? 120);
  $("perp-close-seconds").value = String(p.close_order_seconds ?? 120);
  $("perp-open-mkt-after").checked = !!p.open_market_after_limit;
}

/** @type {{close:()=>void}|null} */
let wsHandle = null;
let pingTimer = null;
/** 每分钟：连接时长 + 订单汇总 */
let heartbeatTimer = null;
/** @type {number} */
let wsConnectedAt = 0;

// ── 自定义仓位分配 task_id → 占总资产比例(0~1) ─────────────
/** @type {Map<number,number>} */
let wsTaskAllocations = new Map();

function taskTypeLabel(taskType) {
  const t = String(taskType || "live").toLowerCase();
  return t === "portfolio" ? "Portfolio" : "单币";
}

// ── 自动重连 ──────────────────────────────────────────────
let wsUserDisconnected = false;   // 用户主动断开时置 true，跳过自动重连
let wsReconnectTimer   = null;    // 重连延时句柄
let wsReconnectAttempt = 0;       // 当前重连次数（1-based）
// 每次重连的等待秒数，共 11 次，超出后放弃
const WS_RECONNECT_SCHEDULE = [2, 4, 8, 16, 30, 60, 120, 240, 480, 960, 1800];
/** 连接序号：旧连接的 onClose 与新连接并发时用于判断是否已过期 */
let _wsSerial = 0;
/** 最近一次连接使用的 task_types，供断线重连时 DOM 已清空时兜底 */
let wsLastTaskTypes = {};

function refreshWsActionButtons() {
  const connectBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("btn-ws-connect"));
  const disconnectBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("btn-ws-disconnect"));
  if (!connectBtn || !disconnectBtn) return;
  const rs = wsHandle?.ws?.readyState;
  const connectedOrConnecting = rs === WebSocket.OPEN || rs === WebSocket.CONNECTING;
  const reconnecting = !!wsReconnectTimer;
  let gateOk = false;
  try { gateOk = keysValidationGateOk(readForm()); } catch { gateOk = false; }
  connectBtn.disabled = !gateOk || connectedOrConnecting || reconnecting;
  disconnectBtn.disabled = !(connectedOrConnecting || reconnecting);
}

const orderSessionStats = {
  total: 0,
  filled: 0,
  failed: 0,
  sumQty: 0,
  sumAmount: 0,
  sumFee: 0,
};

function resetOrderSessionStats() {
  orderSessionStats.total = 0;
  orderSessionStats.filled = 0;
  orderSessionStats.failed = 0;
  orderSessionStats.sumQty = 0;
  orderSessionStats.sumAmount = 0;
  orderSessionStats.sumFee = 0;
}

/**
 * @param {object} row 与 prependOrderRow 一致
 */
function recordOrderSessionStats(row) {
  orderSessionStats.total += 1;
  const st = String(row.order_status || "").toLowerCase();
  const em = row.error_msg != null ? String(row.error_msg).trim() : "";
  const failed = st === "failed" || (em.length > 0 && em !== "—");
  if (failed) orderSessionStats.failed += 1;
  else orderSessionStats.filled += 1;
  const q = Number(row.filled_qty);
  const a = Number(row.filled_amount);
  const f = Number(row.exchange_fee);
  if (Number.isFinite(q)) orderSessionStats.sumQty += q;
  if (Number.isFinite(a)) orderSessionStats.sumAmount += a;
  if (Number.isFinite(f)) orderSessionStats.sumFee += f;
}

function formatConnectedDuration(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (m <= 0) return `${s}秒`;
  return `${m}分${s}秒`;
}

function logWsHeartbeat() {
  if (!wsConnectedAt) return;
  const ms = Date.now() - wsConnectedAt;
  const dur = formatConnectedDuration(ms);
  const o = orderSessionStats;
  const part =
    o.total === 0
      ? "本连接内本地订单：0 笔"
      : `本连接内本地订单：共 ${o.total} 笔（成功 ${o.filled} / 失败 ${o.failed}），累计成交量 ${o.sumQty.toFixed(8)}、成交额 ${o.sumAmount.toFixed(4)} USDT、手续费 ${o.sumFee.toFixed(8)}`;
  log(`[WS 心跳] 已连接 ${dur} | ${part}`);
}

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

function log(msg, kind = "") {
  const panel = $("log-panel");
  const line = document.createElement("div");
  line.className = `line${kind ? ` ${kind}` : ""}`;
  const t = new Date().toLocaleTimeString();
  line.textContent = `[${t}] ${msg}`;
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;
}

function readForm() {
  return {
    platformApiRoot: DEFAULT_PLATFORM_API_ROOT,
    platformApiKey: $("platform-key").value.trim(),
    binanceApiKey: $("binance-key").value.trim(),
    binanceSecret: $("binance-secret").value.trim(),
    binanceProxy: BINANCE_CORS_PROXY_BASE,
    binanceUpstreamProxy: $("binance-upstream-proxy").value.trim(),
    maxSlippagePct: readMaxSlippagePct(),
    exchangeSettings: syncExchangeSlippageFromMax(
      mergeExchangeSettings(readExchangeSettingsFromDom()),
      readMaxSlippagePct()
    ),
    realTradingEnabled: $("real-trading-enabled").checked,
  };
}

function applyForm(s) {
  $("platform-key").value = s.platformApiKey || "";
  $("binance-key").value = s.binanceApiKey || "";
  $("binance-secret").value = s.binanceSecret || "";
  $("binance-upstream-proxy").value = s.binanceUpstreamProxy || "";
  const slip = Number.isFinite(s.maxSlippagePct) ? s.maxSlippagePct : DEFAULT_MAX_SLIPPAGE_PCT;
  $("slippage").value = String(slip);
  $("real-trading-enabled").checked = s.realTradingEnabled !== false;
  applyExchangeSettingsToDom(
    syncExchangeSlippageFromMax(s.exchangeSettings || mergeExchangeSettings({}), slip)
  );
}

function renderTasks(items) {
  const tb = $("tbl-tasks").querySelector("tbody");

  // 刷新前记录已勾选的 task_id，渲染后恢复
  const checkedIds = new Set();
  tb.querySelectorAll("input[type=checkbox]:checked").forEach(cb => {
    checkedIds.add(Number(cb.dataset.taskId));
  });

  tb.innerHTML = "";
  $("task-hint").style.display = items.length ? "none" : "block";

  const st = readForm();
  const s = loadSettings();
  const fpMatch = s.keysValidationFingerprint === credentialsFingerprint(st);
  const spotOk = fpMatch && s.keysValidationBinanceSpotOk;
  const perpOk = fpMatch && s.keysValidationBinancePerpOk;

  const localPerpLeverage = Math.max(1, Math.min(125, Math.floor(Number($("perp-leverage").value) || 1)));

  for (const it of items) {
    const taskType = String(it.task_type || "live").toLowerCase();
    const conn = String(it.connector || "").toLowerCase();
    const supported =
      conn === "binance" ? spotOk : conn === "binance_perpetual" ? perpOk : false;
    const disAttr = supported ? "" : " disabled";
    const title = supported
      ? taskType === "portfolio"
        ? "订阅 Portfolio 组合调仓成交通知（不可与单币任务同时订阅）"
        : "订阅该任务的模拟成交通知"
      : "当前币安密钥未通过该侧（现货 / U 本位）限价探测，无法订阅；请重新验证或更换 Key";
    const tr = document.createElement("tr");
    const kline = it.kline_interval != null ? `${it.kline_interval}m` : "—";
    const roi = (() => {
      const init = Number(it.initial_cash);
      const total = Number(it.total_assets);
      if (!(init > 0) || !Number.isFinite(total)) return { text: "—", cls: "" };
      const pct = (total - init) / init * 100;
      const sign = pct >= 0 ? "+" : "";
      return {
        text: `${sign}${pct.toFixed(2)}%`,
        cls: pct > 0 ? "roi-pos" : pct < 0 ? "roi-neg" : "",
      };
    })();
    const leverageDisplay =
      taskType === "portfolio" ? `${localPerpLeverage}（本地）` : (it.leverage ?? "—");
    tr.innerHTML = `
      <td class="col-subscribe">
        <input type="checkbox" data-task-id="${it.id}" data-task-type="${taskType}" data-tpair-id="${it.trading_pair_id}" title="${escapeHtml(title)}"${disAttr} />
      </td>
      <td>${it.id}</td>
      <td>${escapeHtml(taskTypeLabel(taskType))}</td>
      <td>${escapeHtml(it.strategy_name || "—")}</td>
      <td>${escapeHtml(it.symbol || "—")}</td>
      <td style="font-family:var(--mono,monospace);font-size:12px">${kline}</td>
      <td>${escapeHtml(it.connector || "—")}</td>
      <td>${escapeHtml(leverageDisplay)}</td>
      <td class="${roi.cls}" style="font-family:var(--mono,monospace);font-weight:600">${roi.text}</td>
    `;
    tb.appendChild(tr);

    // 恢复刷新前的勾选状态
    if (checkedIds.has(Number(it.id)) && supported) {
      tr.querySelector("input[type=checkbox]").checked = true;
    }

    const inp = tr.querySelector("input[type='checkbox']");
    inp?.addEventListener("change", () => enforceSubscribeExclusivity(inp));

    taskMetaCache.set(Number(it.id), {
      task_type: taskType,
      connector: it.connector,
      symbol: it.symbol,
      strategy_name: it.strategy_name || "",
      leverage: Number(it.leverage || 1),
      trading_pair_id: Number(it.trading_pair_id),
      initial_cash: it.initial_cash != null ? Number(it.initial_cash) : undefined,
      mm_initial_cash: it.mm_initial_cash != null ? Number(it.mm_initial_cash) : undefined,
      total_assets: it.total_assets != null ? Number(it.total_assets) : undefined,
    });
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function selectedSubscribeIds() {
  /** @type {number[]} */
  const ids = [];
  /** @type {Set<number>} */
  const pairs = new Set();
  let portfolioCount = 0;
  let liveCount = 0;
  document
    .querySelectorAll("#tbl-tasks tbody input[type='checkbox'][data-task-id]:not(:disabled)")
    .forEach((el) => {
      const inp = /** @type {HTMLInputElement} */ (el);
      if (!inp.checked) return;
      const tid = Number(inp.dataset.taskId);
      const taskType = String(inp.dataset.taskType || "live").toLowerCase();
      if (taskType === "portfolio") {
        portfolioCount += 1;
      } else {
        liveCount += 1;
        const tpid = Number(inp.dataset.tpairId);
        if (pairs.has(tpid)) {
          throw new Error(`交易对重复：不能同时订阅多个 task 使用同一 trading_pair_id=${tpid}`);
        }
        pairs.add(tpid);
      }
      ids.push(tid);
    });
  if (portfolioCount > 0 && liveCount > 0) {
    throw new Error("Portfolio 组合任务不能与单币模拟实盘任务同时订阅");
  }
  if (portfolioCount > 1) {
    throw new Error("Portfolio 组合任务一次只能订阅一个");
  }
  return ids;
}

function selectedSubscribeTaskTypes() {
  /** @type {Record<string, string>} */
  const types = {};
  document
    .querySelectorAll("#tbl-tasks tbody input[type='checkbox'][data-task-id]:not(:disabled)")
    .forEach((el) => {
      const inp = /** @type {HTMLInputElement} */ (el);
      if (!inp.checked) return;
      const tid = Number(inp.dataset.taskId);
      const taskType = String(inp.dataset.taskType || "live").toLowerCase();
      if (Number.isFinite(tid) && (taskType === "live" || taskType === "portfolio")) {
        types[String(tid)] = taskType;
      }
    });
  return types;
}

function enforceSubscribeExclusivity(changedInput) {
  const checked = [
    ...document.querySelectorAll("#tbl-tasks tbody input[type='checkbox'][data-task-id]:checked:not(:disabled)"),
  ];
  if (!checked.length) return;
  const changedType = changedInput ? String(changedInput.dataset.taskType || "live") : "";
  const types = checked.map((el) => String(/** @type {HTMLInputElement} */ (el).dataset.taskType || "live"));
  const hasPortfolio = types.includes("portfolio");
  const hasLive = types.some((t) => t === "live");
  if (hasPortfolio && hasLive) {
    for (const el of checked) {
      const inp = /** @type {HTMLInputElement} */ (el);
      const tt = String(inp.dataset.taskType || "live");
      if (tt !== changedType) inp.checked = false;
    }
    log("Portfolio 与单币模拟任务不能同时订阅，已取消另一侧勾选", "err");
    return;
  }
  const portChecked = checked.filter(
    (el) => String(/** @type {HTMLInputElement} */ (el).dataset.taskType || "live") === "portfolio"
  );
  if (portChecked.length > 1) {
    for (const el of portChecked) {
      const inp = /** @type {HTMLInputElement} */ (el);
      if (inp !== changedInput) inp.checked = false;
    }
    log("Portfolio 一次只能订阅一个任务", "err");
  }
}

function prependOrderRow(row) {
  const tb = $("tbl-orders").querySelector("tbody");
  const tr = document.createElement("tr");
  const ts = row.timestamp
    ? new Date(Number(row.timestamp)).toLocaleString()
    : "—";
  tr.innerHTML = `
    <td>${ts}</td>
    <td>${row.task_id}</td>
    <td>${escapeHtml(row.type || "—")}</td>
    <td>${escapeHtml(row.connector || "—")}</td>
    <td>${escapeHtml(row.symbol || "—")}</td>
    <td>${escapeHtml(row.order_status || "—")}</td>
    <td>${escapeHtml(row.exchange_order_id || "—")}</td>
    <td>${fmtNum(row.filled_qty)}</td>
    <td>${fmtNum(row.filled_amount)}</td>
    <td>${fmtNum(row.exchange_fee)}</td>
    <td style="max-width:220px;word-break:break-all">${escapeHtml(row.error_msg || "—")}</td>
  `;
  tb.insertBefore(tr, tb.firstChild);
  recordOrderSessionStats(row);
}

function fmtNum(v) {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

async function getTaskMeta(taskId) {
  const cached = taskMetaCache.get(Number(taskId));
  if (cached?.connector) return cached;
  const st = readForm();
  if (!st.platformApiKey) return null;
  const domInp = document.querySelector(`#tbl-tasks input[data-task-id="${taskId}"]`);
  const taskType =
    cached?.task_type ||
    (domInp ? String(/** @type {HTMLInputElement} */ (domInp).dataset.taskType || "live") : "live");
  try {
    const d = await fetchTaskDetail(st.platformApiRoot, st.platformApiKey, taskId, taskType);
    const m = {
      task_type: String(d.task_type || taskType || "live").toLowerCase(),
      connector: d.connector,
      symbol: d.symbol,
      leverage: Number(d.leverage || 1),
      trading_pair_id: Number(d.trading_pair_id),
      initial_cash: d.initial_cash != null ? Number(d.initial_cash) : undefined,
      mm_initial_cash: d.mm_initial_cash != null ? Number(d.mm_initial_cash) : undefined,
      total_assets: d.total_assets != null ? Number(d.total_assets) : undefined,
    };
    taskMetaCache.set(Number(taskId), m);
    return m;
  } catch {
    return null;
  }
}

function setBadge(elId, text, cls) {
  const el = $(elId);
  el.textContent = text;
  el.className = `badge ${cls}`;
}

/** 与当前表单一致的指纹，用于判断「已验证」是否仍对应当前密钥 */
function credentialsFingerprint(st) {
  return [
    st.platformApiKey || "",
    st.binanceApiKey || "",
    st.binanceSecret || "",
    st.binanceUpstreamProxy || "",
  ].join("\u0001");
}

function keysValidationGateOk(st) {
  const s = loadSettings();
  const fp = credentialsFingerprint(st);
  const binAny = !!(s.keysValidationBinanceSpotOk || s.keysValidationBinancePerpOk);
  return s.keysValidationFingerprint === fp && s.keysValidationQvisOk && binAny;
}

function updateKeyValidationBadges() {
  const st = readForm();
  const s = loadSettings();
  const fp = credentialsFingerprint(st);
  const match = s.keysValidationFingerprint === fp;
  const qvisOk = match && s.keysValidationQvisOk;
  const spotOk = match && s.keysValidationBinanceSpotOk;
  const perpOk = match && s.keysValidationBinancePerpOk;
  setBadge("key-val-qvis", qvisOk ? "QVIS 已验证" : "QVIS 未验证", qvisOk ? "badge-ok" : "badge-muted");
  let binLabel = "币安 未验证";
  let binCls = "badge-muted";
  if (match) {
    if (spotOk && perpOk) {
      binLabel = "币安 现货+合约";
      binCls = "badge-ok";
    } else if (spotOk) {
      binLabel = "币安 仅现货";
      binCls = "badge-ok";
    } else if (perpOk) {
      binLabel = "币安 仅合约";
      binCls = "badge-ok";
    }
  }
  setBadge("key-val-binance", binLabel, binCls);
}

function refreshGateButtons() {
  const st = readForm();
  const ok = keysValidationGateOk(st);
  $("btn-refresh-tasks").disabled = !ok;
  const iconBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("btn-refresh-tasks-icon"));
  if (iconBtn) iconBtn.disabled = !ok;
  $("btn-ws-connect").disabled = !ok;
}

function invalidateKeysValidationIfCredentialsChanged() {
  clearKeysValidationState();
  updateKeyValidationBadges();
  refreshGateButtons();
}

async function onVerifyKeys() {
  const st = readForm();
  if (!st.platformApiKey) {
    log("请填写平台 Client API Key（qvis_…）", "err");
    return;
  }
  if (!st.binanceApiKey || !st.binanceSecret) {
    log("请填写币安 API Key / Secret", "err");
    return;
  }
  const verifyBtn = /** @type {HTMLButtonElement} */ ($("btn-verify-keys"));
  verifyBtn.disabled = true;
  let qvisOk = false;
  let spotOk = false;
  let perpOk = false;
  try {
    try {
      await verifyClientApiKey(st.platformApiRoot, st.platformApiKey);
      qvisOk = true;
      log("QVIS Client API Key 校验通过（可访问模拟任务列表）", "ok");
    } catch (e) {
      log(`QVIS 校验失败: ${e.message}`, "err");
    }
    let caps = { spotOk: false, perpOk: false, spotError: null, perpError: null };
    try {
      caps = await withBinanceUpstreamProxy(st.binanceUpstreamProxy || "", async () =>
        verifyBinanceTradingCapabilities(st.binanceApiKey, st.binanceSecret, st.binanceProxy)
      );
      spotOk = caps.spotOk;
      perpOk = caps.perpOk;
      if (spotOk) log("币安现货：限价探测（BTCUSDT 低价 BUY + 撤单）通过", "ok");
      else log(`币安现货侧未通过: ${caps.spotError || "未知"}`, "err");
      if (perpOk) log("币安 U 本位：限价探测（BTCUSDT 低价 BUY + 撤单）通过", "ok");
      else log(`币安合约侧未通过: ${caps.perpError || "未知"}`, "err");
      if (qvisOk && spotOk && perpOk) {
        log("币安双侧均已验证；实盘跟单可对现货与 U 本位任务分别真实下单。", "ok");
      } else if (qvisOk && spotOk && !perpOk) {
        log(
          "实盘跟单可正常使用：当前仅通过**现货**侧验证。请只订阅 connector 为「binance」的任务；勾选「真实下单」时只会向币安发**现货**单。",
          "ok"
        );
      } else if (qvisOk && !spotOk && perpOk) {
        log(
          "实盘跟单可正常使用：当前仅通过 **U 本位合约**侧验证。请只订阅 connector 为「binance_perpetual」的任务；勾选「真实下单」时只会向币安发**合约**单。",
          "ok"
        );
      }
    } catch (e) {
      log(`币安校验异常: ${e.message}`, "err");
    }
    const fp = credentialsFingerprint(st);
    saveSettings({
      keysValidationFingerprint: fp,
      keysValidationQvisOk: qvisOk,
      keysValidationBinanceOk: spotOk && perpOk,
      keysValidationBinanceSpotOk: spotOk,
      keysValidationBinancePerpOk: perpOk,
      binanceUpstreamProxy: st.binanceUpstreamProxy,
    });
    updateKeyValidationBadges();
    refreshGateButtons();
    if (qvisOk && (spotOk || perpOk)) {
      log("可拉取运行中任务：表格里仅与当前已验证侧一致的任务可勾选订阅。", "ok");
    } else {
      log("请修正失败项后再次点击「验证密钥」。", "err");
    }
  } finally {
    verifyBtn.disabled = false;
  }
}

async function onRefreshTasks() {
  const st = readForm();
  if (!keysValidationGateOk(st)) {
    log("请先点击「验证密钥」并通过 QVIS 与币安校验后再拉取任务", "err");
    return;
  }
  if (!st.platformApiKey) {
    log("请填写平台 Client API Key（qvis_…）", "err");
    return;
  }
  try {
    const data = await fetchRunningSimulated(st.platformApiRoot, st.platformApiKey);
    const items = data.items || [];
    renderTasks(items);
    const s0 = loadSettings();
    const fp0 = credentialsFingerprint(st);
    const match0 = s0.keysValidationFingerprint === fp0;
    const sk = match0 && s0.keysValidationBinanceSpotOk;
    const pk = match0 && s0.keysValidationBinancePerpOk;
    const sub = items.filter((it) => {
      const c = String(it.connector || "").toLowerCase();
      return c === "binance" ? sk : c === "binance_perpetual" ? pk : false;
    }).length;
    const portN = items.filter((it) => String(it.task_type || "").toLowerCase() === "portfolio").length;
    const liveN = items.length - portN;
    log(
      `已加载 ${items.length} 个运行中任务（单币 ${liveN} / Portfolio ${portN}，当前密钥可订阅 ${sub} 个）`,
      "ok"
    );
    setBadge("conn-badge", "已拉取", "badge-ok");
  } catch (e) {
    log(`拉取任务失败: ${e.message}`, "err");
    setBadge("conn-badge", "失败", "badge-err");
  }
}

/** 内部：清理 WS 资源，不修改 wsUserDisconnected / wsReconnectAttempt */
function _cleanupWs() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (wsConnectedAt) {
    logWsHeartbeat();
    log(`WebSocket 会话结束，本次连接 ${formatConnectedDuration(Date.now() - wsConnectedAt)}`, "");
  }
  wsConnectedAt = 0;
  wsSubscribedTaskIds = [];
  const h = wsHandle;
  wsHandle = null;
  if (h) h.close();
}

/** 用户主动断开 */
function onWsDisconnect() {
  wsUserDisconnected = true;
  wsReconnectAttempt = 0;
  _cleanupWs();
  setBadge("ws-badge", "未连接", "badge-muted");
  refreshWsActionButtons();
}

/** 前置校验，返回 taskIds 或 null（失败时已打日志） */
function preConnectCheck() {
  const st = readForm();
  if (!keysValidationGateOk(st)) {
    log("请先点击「验证密钥」并通过 QVIS 与币安校验后再连接 WebSocket", "err");
    return null;
  }
  if (!st.platformApiKey) { log("请填写平台 Client API Key（qvis_…）", "err"); return null; }
  if (!st.binanceApiKey || !st.binanceSecret) { log("请填写币安 API Key / Secret", "err"); return null; }
  let taskIds;
  try { taskIds = selectedSubscribeIds(); } catch (e) { log(String(e.message), "err"); return null; }
  if (!taskIds.length) { log("请至少勾选一个 task", "err"); return null; }
  const sGate = loadSettings();
  const fpG = credentialsFingerprint(st);
  const spotGate = sGate.keysValidationFingerprint === fpG && sGate.keysValidationBinanceSpotOk;
  const perpGate = sGate.keysValidationFingerprint === fpG && sGate.keysValidationBinancePerpOk;
  for (const tid of taskIds) {
    const m = taskMetaCache.get(Number(tid));
    const c = String(m?.connector || "").toLowerCase();
    if (c === "binance" && !spotGate) { log("所选任务含现货 connector，但当前币安密钥未通过现货侧验证。", "err"); return null; }
    if (c === "binance_perpetual" && !perpGate) { log("所选任务含 U 本位 connector，但当前币安密钥未通过合约侧验证。", "err"); return null; }
  }
  return taskIds;
}

/** 打开仓位分配弹窗 */
function onWsConnect() {
  const taskIds = preConnectCheck();
  if (!taskIds) return;

  // 构建弹窗行
  const rowsEl = document.getElementById("alloc-rows");
  rowsEl.innerHTML = "";
  for (const tid of taskIds) {
    const meta = taskMetaCache.get(Number(tid)) || {};
    const prevPct = wsTaskAllocations.has(Number(tid))
      ? Math.round(wsTaskAllocations.get(Number(tid)) * 100)
      : Math.round(90 / taskIds.length);  // 默认均分 90%

    const row = document.createElement("div");
    row.className = "alloc-row";
    row.innerHTML = `
      <div class="alloc-row-info">
        <span class="alloc-strategy">${meta.strategy_name || "策略 " + tid}</span>
        <span class="alloc-pair">${meta.symbol || "—"} · ${meta.connector || "—"} · task #${tid}</span>
      </div>
      <div class="alloc-row-controls">
        <div class="alloc-presets">
          ${[10,20,30,40,50].map(p =>
            `<button class="alloc-preset${p === prevPct ? " active" : ""}" data-pct="${p}">${p}%</button>`
          ).join("")}
        </div>
        <div class="alloc-input-wrap">
          <input type="number" class="field alloc-input" min="1" max="100" step="1"
            value="${prevPct}" data-task-id="${tid}">
          <span class="alloc-unit">%</span>
        </div>
      </div>`;

    // 预设按钮点击
    row.querySelectorAll(".alloc-preset").forEach(btn => {
      btn.addEventListener("click", () => {
        const pct = Number(btn.dataset.pct);
        row.querySelectorAll(".alloc-preset").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        row.querySelector(".alloc-input").value = pct;
        updateAllocTotal();
      });
    });
    // 手动输入同步
    row.querySelector(".alloc-input").addEventListener("input", () => {
      row.querySelectorAll(".alloc-preset").forEach(b => {
        b.classList.toggle("active", Number(b.dataset.pct) === Number(row.querySelector(".alloc-input").value));
      });
      updateAllocTotal();
    });
    rowsEl.appendChild(row);
  }
  updateAllocTotal();
  document.getElementById("alloc-modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function updateAllocTotal() {
  let sum = 0;
  document.querySelectorAll(".alloc-input").forEach(inp => { sum += Number(inp.value) || 0; });
  const el = document.getElementById("alloc-total-pct");
  el.textContent = sum + "%";
  el.className = "alloc-total-value" + (sum > 100 ? " over" : sum > 90 ? " warn" : "");
}

/** 实际执行 WebSocket 连接（仓位分配确认后调用） */
function doWsConnect(taskIds) {
  wsUserDisconnected = false;          // 非用户主动，不能置 true
  // 先 bump serial，使旧连接的 onClose 回调在 _cleanupWs 触发 h.close() 时立即失效
  const mySerial = ++_wsSerial;
  _cleanupWs();                        // 清理旧连接资源，不修改 wsUserDisconnected
  wsSubscribedTaskIds = [...taskIds];
  resetOrderSessionStats();
  setBadge("ws-badge", "连接中…", "badge-warn");
  refreshWsActionButtons();

  const st = readForm();
  // 优先读 DOM 勾选；重连时勾选可能已清空，则 fallback 到上次快照
  const domTypes = selectedSubscribeTaskTypes();
  const taskTypes = Object.keys(domTypes).length > 0 ? domTypes : wsLastTaskTypes;
  wsLastTaskTypes = taskTypes;         // 持久化，供下次重连使用

  wsHandle = connectClientWs(st.platformApiRoot, st.platformApiKey, {
    onOpen: () => {
      wsConnectedAt = Date.now();
      wsReconnectAttempt = 0;
      log("WebSocket 已连接", "ok");
      setBadge("ws-badge", "已连接", "badge-ok");
      refreshWsActionButtons();
      const payload = JSON.stringify({ op: "subscribe", task_ids: taskIds, task_types: taskTypes });
      wsHandle.ws.send(payload);
      log(`已发送订阅 task_ids: [${taskIds.join(", ")}]`, "ok");
      pingTimer = setInterval(() => {
        try {
          if (wsHandle?.ws?.readyState === WebSocket.OPEN) {
            wsHandle.ws.send(JSON.stringify({ op: "ping" }));
          }
        } catch {
          /* noop */
        }
      }, 25000);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (wsHandle?.ws?.readyState === WebSocket.OPEN) logWsHeartbeat();
      }, 60000);
    },
    onMessage: async (data) => {
      const ev = data.event;
      if (ev === "pong") return;
      if (ev === "connected" || ev === "subscribed") {
        log(JSON.stringify(data));
        return;
      }
      if (ev === "error") {
        log(`WS 错误: ${data.detail || JSON.stringify(data)}`, "err");
        return;
      }
      if (ev === "task_stopped") {
        handleTaskStopped(data.task_id, log);
        return;
      }
      if (ev === "sim_trade_fill") {
        const tt = String(data.task_type || "").toLowerCase();
        const sym = data.trade?.symbol ? ` ${data.trade.symbol}` : "";
        log(
          `${tt === "portfolio" ? "Portfolio" : "模拟"}成交 task=${data.task_id}${sym} trade_id=${data.trade?.id} type=${data.trade?.type}`
        );
        const creds = {
          apiKey: st.binanceApiKey,
          secret: st.binanceSecret,
          proxyBase: st.binanceProxy,
          upstreamProxy: st.binanceUpstreamProxy || "",
        };
        const row = await handleSimTradeFill(
          { ...data, task_type: data.task_type || taskMetaCache.get(Number(data.task_id))?.task_type },
          {
          getTaskMeta,
          creds,
          risk: { maxSlippagePct: st.maxSlippagePct },
          exchangeSettings: st.exchangeSettings,
          realTrading: st.realTradingEnabled,
          subscribedTaskCount: subscribedTaskCountForConnector,
          taskAllocationPct: wsTaskAllocations.size > 0 ? wsTaskAllocations : null,
          syncTime: () => syncServerTime(st.binanceProxy),
          log: (m, k) => log(m, k === "err" ? "err" : k === "ok" ? "ok" : ""),
        });
        if (row) prependOrderRow(row);
        return;
      }
      log(`消息: ${JSON.stringify(data)}`);
    },
    onClose: (e) => {
      // 过期回调保护：若已建立新连接则忽略旧连接的 onClose
      if (mySerial !== _wsSerial) return;

      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (wsConnectedAt) {
        logWsHeartbeat();
        log(`WebSocket 会话结束，本次连接 ${formatConnectedDuration(Date.now() - wsConnectedAt)}`, "");
      }
      wsConnectedAt = 0;
      // 先快照再清空，保证重连时 snapIds 不为空
      const snapIds = [...wsSubscribedTaskIds];
      wsSubscribedTaskIds = [];
      wsHandle = null;
      refreshWsActionButtons();
      const reason = e.reason || `code=${e.code}`;
      log(`WebSocket 关闭: ${reason}`, e.code === 4000 ? "err" : "");
      setBadge("ws-badge", "已断开", "badge-muted");

      // 4000 = 服务端主动踢出，用户主动断开 → 不重连
      if (!wsUserDisconnected && e.code !== 4000) {
        wsReconnectAttempt += 1;
        const idx = wsReconnectAttempt - 1;
        if (idx >= WS_RECONNECT_SCHEDULE.length) {
          log("已连续重连 11 次仍未成功，自动重连已停止，请手动点击「连接并订阅」重试。", "err");
          setBadge("ws-badge", "重连失败", "badge-err");
          wsReconnectAttempt = 0;
        } else {
          const delayS = WS_RECONNECT_SCHEDULE[idx];
          const total = WS_RECONNECT_SCHEDULE.length;
          log(`将在 ${delayS >= 60 ? (delayS / 60).toFixed(0) + "min" : delayS + "s"} 后自动重连（第 ${wsReconnectAttempt}/${total} 次）…`, "");
          setBadge("ws-badge", `重连中 ${wsReconnectAttempt}/${total}`, "badge-warn");
          wsReconnectTimer = setTimeout(() => {
            wsReconnectTimer = null;
            refreshWsActionButtons();
            if (!wsUserDisconnected) doWsConnect(snapIds);
          }, delayS * 1000);
          refreshWsActionButtons();
        }
      }
    },
    onError: () => log("WebSocket error", "err"),
  });
  refreshWsActionButtons();
}

async function onSave() {
  const st = readForm();
  saveSettings(st);
  log("已保存到 localStorage。修改密钥后请重新点击「验证密钥」。", "ok");
}

function onClear() {
  clearSecrets();
  $("platform-key").value = "";
  $("binance-key").value = "";
  $("binance-secret").value = "";
  log("已清除平台 Key 与币安密钥字段（请重新填写或从备份恢复）", "ok");
  resetAllTaskStates();
  updateKeyValidationBadges();
  refreshGateButtons();
}

function init() {
  applyForm(loadSettings());
  const credIds = [
    "platform-key",
    "binance-key",
    "binance-secret",
    "binance-upstream-proxy",
  ];
  credIds.forEach((id) => {
    $(id).addEventListener("input", () => invalidateKeysValidationIfCredentialsChanged());
    $(id).addEventListener("change", () => invalidateKeysValidationIfCredentialsChanged());
  });
  $("binance-upstream-proxy").addEventListener("blur", () => {
    saveSettings({ binanceUpstreamProxy: $("binance-upstream-proxy").value.trim() });
  });
  $("btn-save").addEventListener("click", () => onSave());
  $("btn-clear").addEventListener("click", () => onClear());
  $("btn-verify-keys").addEventListener("click", () => onVerifyKeys());
  $("btn-refresh-tasks").addEventListener("click", () => onRefreshTasks());
  // 卡片右上角图标刷新按钮（不同 ID，避免重复）
  document.getElementById("btn-refresh-tasks-icon")?.addEventListener("click", () => onRefreshTasks());
  $("btn-ws-connect").addEventListener("click", () => onWsConnect());
  $("btn-ws-disconnect").addEventListener("click", () => {
    onWsDisconnect();
    log("已手动断开", "ok");
  });

  // 仓位分配弹窗事件
  function closeAllocModal() {
    document.getElementById("alloc-modal").classList.add("hidden");
    document.body.style.overflow = "";
  }
  document.getElementById("alloc-modal-close").addEventListener("click", closeAllocModal);
  document.getElementById("alloc-cancel-btn").addEventListener("click", closeAllocModal);
  document.getElementById("alloc-modal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("alloc-modal")) closeAllocModal();
  });
  document.getElementById("alloc-confirm-btn").addEventListener("click", () => {
    // 读取每行的分配比例，存入 wsTaskAllocations
    const newAlloc = new Map();
    let allocSum = 0;
    let hasZero = false;
    document.querySelectorAll(".alloc-input").forEach(inp => {
      const tid = Number(inp.dataset.taskId);
      const pct = Math.max(0, Math.min(100, Number(inp.value) || 0));
      if (pct <= 0) hasZero = true;
      allocSum += pct;
      newAlloc.set(tid, pct / 100);
    });
    if (hasZero) {
      log("仓位分配中存在 0%，请为每个任务设置大于 0 的比例后再确认。", "err");
      return;
    }
    if (allocSum > 100) {
      log(`仓位分配合计 ${allocSum}% 超过 100%，请调整后再确认。`, "err");
      return;
    }
    wsTaskAllocations = newAlloc;
    closeAllocModal();
    // 拿最新校验过的 taskIds 执行真正连接
    const taskIds = preConnectCheck();
    if (taskIds) doWsConnect(taskIds);
  });
  updateKeyValidationBadges();
  refreshGateButtons();
  refreshWsActionButtons();
  log("就绪。请填写密钥后点击「验证密钥」，再拉取任务并连接 WebSocket。", "ok");

  // 若 QVIS 已验证，自动拉取一次模拟任务
  const _s = loadSettings();
  const _st = readForm();
  const _fp = credentialsFingerprint(_st);
  if (_s.keysValidationFingerprint === _fp && _s.keysValidationQvisOk) {
    log("检测到 QVIS 已验证，自动拉取模拟任务…", "ok");
    onRefreshTasks();
  }
}

init();

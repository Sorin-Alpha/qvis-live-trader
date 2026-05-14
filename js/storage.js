import {
  STORAGE_KEYS,
  DEFAULT_MAX_SLIPPAGE_PCT,
  DEFAULT_PLATFORM_API_ROOT,
  DEFAULT_EXCHANGE_SETTINGS,
} from "./constants.js";

/** @param {unknown} raw */
export function mergeExchangeSettings(raw) {
  let parsed = {};
  try {
    if (typeof raw === "string") parsed = JSON.parse(raw || "{}");
    else if (raw && typeof raw === "object") parsed = /** @type {object} */ (raw);
  } catch {
    parsed = {};
  }
  const p = /** @type {{ binance?: object, binance_perpetual?: object }} */ (parsed);
  return {
    binance: { ...DEFAULT_EXCHANGE_SETTINGS.binance, ...(p.binance || {}) },
    binance_perpetual: {
      ...DEFAULT_EXCHANGE_SETTINGS.binance_perpetual,
      ...(p.binance_perpetual || {}),
    },
  };
}

export function loadSettings() {
  const rawEx = localStorage.getItem(STORAGE_KEYS.exchangeSettings);
  const rt = localStorage.getItem(STORAGE_KEYS.realTradingEnabled);
  return {
    platformApiRoot:
      localStorage.getItem(STORAGE_KEYS.platformApiRoot) || DEFAULT_PLATFORM_API_ROOT,
    platformApiKey: localStorage.getItem(STORAGE_KEYS.platformApiKey) || "",
    binanceApiKey: localStorage.getItem(STORAGE_KEYS.binanceApiKey) || "",
    binanceSecret: localStorage.getItem(STORAGE_KEYS.binanceSecret) || "",
    binanceProxy: localStorage.getItem(STORAGE_KEYS.binanceProxy) || "http://127.0.0.1:8787",
    binanceUpstreamProxy: localStorage.getItem(STORAGE_KEYS.binanceUpstreamProxy) || "",
    maxSlippagePct: Number(localStorage.getItem(STORAGE_KEYS.maxSlippagePct) || DEFAULT_MAX_SLIPPAGE_PCT),
    subscribedTaskIds: JSON.parse(localStorage.getItem(STORAGE_KEYS.subscribedTaskIds) || "[]"),
    exchangeSettings: mergeExchangeSettings(rawEx),
    /** 默认 true：未写入 storage 时视为真实下单 */
    realTradingEnabled: rt !== "false",
    keysValidationFingerprint: localStorage.getItem(STORAGE_KEYS.keysValidationFingerprint) || "",
    keysValidationQvisOk: localStorage.getItem(STORAGE_KEYS.keysValidationQvisOk) === "1",
    keysValidationBinanceOk: localStorage.getItem(STORAGE_KEYS.keysValidationBinanceOk) === "1",
    keysValidationBinanceSpotOk: localStorage.getItem(STORAGE_KEYS.keysValidationBinanceSpotOk) === "1",
    keysValidationBinancePerpOk: localStorage.getItem(STORAGE_KEYS.keysValidationBinancePerpOk) === "1",
  };
}

export function saveSettings(partial) {
  const map = [
    [STORAGE_KEYS.platformApiRoot, partial.platformApiRoot],
    [STORAGE_KEYS.platformApiKey, partial.platformApiKey],
    [STORAGE_KEYS.binanceApiKey, partial.binanceApiKey],
    [STORAGE_KEYS.binanceSecret, partial.binanceSecret],
    [STORAGE_KEYS.binanceProxy, partial.binanceProxy],
    [STORAGE_KEYS.binanceUpstreamProxy, partial.binanceUpstreamProxy],
    [STORAGE_KEYS.maxSlippagePct, partial.maxSlippagePct],
    [STORAGE_KEYS.subscribedTaskIds, partial.subscribedTaskIds],
  ];
  for (const [k, v] of map) {
    if (v === undefined) continue;
    if (typeof v === "string") localStorage.setItem(k, v);
    else if (typeof v === "number" && Number.isFinite(v)) localStorage.setItem(k, String(v));
    else if (Array.isArray(v)) localStorage.setItem(k, JSON.stringify(v));
  }
  if (partial.exchangeSettings !== undefined) {
    localStorage.setItem(
      STORAGE_KEYS.exchangeSettings,
      JSON.stringify(mergeExchangeSettings(partial.exchangeSettings))
    );
  }
  if (partial.realTradingEnabled !== undefined) {
    localStorage.setItem(STORAGE_KEYS.realTradingEnabled, partial.realTradingEnabled ? "true" : "false");
  }
  if (partial.keysValidationFingerprint !== undefined) {
    if (partial.keysValidationFingerprint)
      localStorage.setItem(STORAGE_KEYS.keysValidationFingerprint, partial.keysValidationFingerprint);
    else localStorage.removeItem(STORAGE_KEYS.keysValidationFingerprint);
  }
  if (partial.keysValidationQvisOk !== undefined) {
    localStorage.setItem(STORAGE_KEYS.keysValidationQvisOk, partial.keysValidationQvisOk ? "1" : "0");
  }
  if (partial.keysValidationBinanceOk !== undefined) {
    localStorage.setItem(STORAGE_KEYS.keysValidationBinanceOk, partial.keysValidationBinanceOk ? "1" : "0");
  }
  if (partial.keysValidationBinanceSpotOk !== undefined) {
    localStorage.setItem(STORAGE_KEYS.keysValidationBinanceSpotOk, partial.keysValidationBinanceSpotOk ? "1" : "0");
  }
  if (partial.keysValidationBinancePerpOk !== undefined) {
    localStorage.setItem(STORAGE_KEYS.keysValidationBinancePerpOk, partial.keysValidationBinancePerpOk ? "1" : "0");
  }
}

/** 密钥或代理变更后调用，使「已验证」状态失效 */
export function clearKeysValidationState() {
  localStorage.removeItem(STORAGE_KEYS.keysValidationFingerprint);
  localStorage.removeItem(STORAGE_KEYS.keysValidationQvisOk);
  localStorage.removeItem(STORAGE_KEYS.keysValidationBinanceOk);
  localStorage.removeItem(STORAGE_KEYS.keysValidationBinanceSpotOk);
  localStorage.removeItem(STORAGE_KEYS.keysValidationBinancePerpOk);
}

export function clearSecrets() {
  [
    STORAGE_KEYS.platformApiKey,
    STORAGE_KEYS.binanceApiKey,
    STORAGE_KEYS.binanceSecret,
  ].forEach((k) => localStorage.removeItem(k));
  clearKeysValidationState();
}

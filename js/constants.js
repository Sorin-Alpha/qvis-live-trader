/** @typedef {'binance'|'binance_perpetual'} Connector */

/** 正式环境 API 根地址（无末尾斜杠） */
export const DEFAULT_PLATFORM_API_ROOT = "https://api.qvis.ai";

export const STORAGE_KEYS = {
  platformApiRoot: "qvis_lt_platform_api_root",
  platformApiKey: "qvis_lt_platform_api_key",
  binanceApiKey: "qvis_lt_binance_api_key",
  binanceSecret: "qvis_lt_binance_secret",
  binanceProxy: "qvis_lt_binance_proxy",
  /** 本地 CORS 代理访问 api.binance.com 时使用的出境 HTTP 代理（可选） */
  binanceUpstreamProxy: "qvis_lt_binance_upstream_proxy",
  maxSlippagePct: "qvis_lt_max_slippage_pct",
  subscribedTaskIds: "qvis_lt_subscribed_task_ids",
  /** JSON：对齐 user_exchange_keys 中现货/合约下单参数 */
  exchangeSettings: "qvis_lt_exchange_settings",
  realTradingEnabled: "qvis_lt_real_trading_enabled",
  /** 与下列 *_ok 同时写入：任一密钥变更后需重新验证 */
  keysValidationFingerprint: "qvis_lt_keys_validation_fp",
  keysValidationQvisOk: "qvis_lt_keys_validation_qvis_ok",
  keysValidationBinanceOk: "qvis_lt_keys_validation_binance_ok",
  /** 币安侧：各用一笔远离市价的限价单下单后立即撤单验证 TRADE 权限 */
  keysValidationBinanceSpotOk: "qvis_lt_keys_validation_binance_spot_ok",
  keysValidationBinancePerpOk: "qvis_lt_keys_validation_binance_perp_ok",
};

/** 相对模拟推送价允许的最大偏离，小数 0.001 = 0.1% */
export const DEFAULT_MAX_SLIPPAGE_PCT = 0.001;

/** @typedef {{open_order_type:string,open_order_seconds:number,open_market_after_limit:boolean,open_order_slippage:number,close_order_type:string,close_order_seconds:number,close_order_slippage:number}} SpotLikeSettings */

/** @type {{ binance: SpotLikeSettings & {}, binance_perpetual: SpotLikeSettings & { leverage: number } }} */
export const DEFAULT_EXCHANGE_SETTINGS = {
  binance: {
    open_order_type: "MARKET",
    open_order_seconds: 120,
    open_market_after_limit: true,
    open_order_slippage: 0.001,
    close_order_type: "MARKET",
    close_order_seconds: 120,
    close_order_slippage: 0.001,
  },
  binance_perpetual: {
    leverage: 3,
    open_order_type: "MARKET",
    open_order_seconds: 120,
    open_market_after_limit: true,
    open_order_slippage: 0.001,
    close_order_type: "MARKET",
    close_order_seconds: 120,
    close_order_slippage: 0.001,
  },
};

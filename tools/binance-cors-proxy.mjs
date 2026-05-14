#!/usr/bin/env node
/**
 * 本地 CORS 代理：浏览器 -> 本脚本 -> 币安 REST。
 * 默认监听 8787；不打印 query 中的 signature。
 * 用法：node binance-cors-proxy.mjs
 *
 * 访问币安超时 / 502：多数为本机无法直连 api.binance.com。
 * 与 Python 使用同一出境代理时，可先在该终端导出 HTTPS_PROXY 再启动，例如：
 *   set HTTPS_PROXY=http://127.0.0.1:7890
 *   node tools/binance-cors-proxy.mjs
 */
import http from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { HttpsProxyAgent } from "https-proxy-agent";

const PORT = Number(process.env.PORT || 8787);
const SPOT_HOST = "api.binance.com";
const FUT_HOST = "fapi.binance.com";

const UPSTREAM_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
let upstreamAgent;
try {
  upstreamAgent = UPSTREAM_PROXY.trim()
    ? new HttpsProxyAgent(UPSTREAM_PROXY.trim())
    : undefined;
} catch (e) {
  console.error("[binance-cors-proxy] invalid HTTPS_PROXY / HTTP_PROXY:", e.message);
  process.exit(1);
}

function send(res, status, headers, body) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-MBX-APIKEY,X-Upstream-Proxy",
    ...headers,
  });
  res.end(body);
}

/** 每个不同的 X-Upstream-Proxy 缓存一个 Agent */
const headerAgentCache = new Map();

/** @returns {string|null} 合法代理 URL；null 表示非法；"" 表示未传（用环境变量） */
function parseUpstreamProxyHeader(req) {
  const raw = req.headers["x-upstream-proxy"];
  if (raw === undefined) return "";
  const s = Array.isArray(raw) ? raw[0] : raw;
  const t = String(s || "").trim();
  if (!t) return "";
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href.replace(/\/+$/, "") || t;
  } catch {
    return null;
  }
}

function pipeBinance(req, res, hostname, pathWithQuery) {
  const fromHeader = parseUpstreamProxyHeader(req);
  if (fromHeader === null) {
    send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "invalid X-Upstream-Proxy (need http(s)://host:port)");
    return;
  }
  let agent = upstreamAgent;
  let viaLabel = upstreamAgent ? ` env=${UPSTREAM_PROXY}` : "";
  if (fromHeader) {
    if (!headerAgentCache.has(fromHeader)) {
      headerAgentCache.set(fromHeader, new HttpsProxyAgent(fromHeader));
    }
    agent = headerAgentCache.get(fromHeader);
    viaLabel = ` header=${fromHeader}`;
  }
  // 必须转发 POST/DELETE 的实体相关头，否则 https.request 默认只有 APIKEY，
  // Node 可能不发正文或长度不对，币安返回 -1102 / 签名校验失败等。
  const headers = {
    "X-MBX-APIKEY": req.headers["x-mbx-apikey"] || "",
  };
  const ct = req.headers["content-type"];
  if (ct) headers["Content-Type"] = ct;
  const cl = req.headers["content-length"];
  if (cl !== undefined && cl !== "" && req.method !== "GET" && req.method !== "HEAD") {
    headers["Content-Length"] = cl;
  }
  const opts = {
    hostname,
    path: pathWithQuery,
    method: req.method,
    headers,
    // 优先走 IPv4，避免部分环境下 IPv6 不可达导致 ETIMEDOUT，浏览器侧只看到代理返回 502
    family: 4,
    ...(agent ? { agent } : {}),
  };
  const upstream = httpsRequest(opts, (up) => {
    const chunks = [];
    up.on("data", (c) => chunks.push(c));
    up.on("end", () => {
      const body = Buffer.concat(chunks);
      const h = { "Content-Type": up.headers["content-type"] || "application/json" };
      send(res, up.statusCode || 502, h, body);
    });
  });
  upstream.on("error", (e) => {
    console.error(
      `[binance-cors-proxy] upstream https://${hostname}${pathWithQuery.split("?")[0]}${viaLabel} : ${e.code || ""} ${e.message}`
    );
    send(res, 502, { "Content-Type": "text/plain" }, String(e.message));
  });
  upstream.setTimeout(30000, () => {
    upstream.destroy(new Error("upstream socket timeout (30s)"));
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, {}, "");
    return;
  }
  const u = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  let targetHost;
  let newPath;
  if (u.pathname.startsWith("/spot")) {
    targetHost = SPOT_HOST;
    newPath = u.pathname.replace(/^\/spot/, "") + u.search;
  } else if (u.pathname.startsWith("/fapi")) {
    targetHost = FUT_HOST;
    newPath = u.pathname.replace(/^\/fapi/, "") + u.search;
  } else {
    send(res, 404, { "Content-Type": "text/plain" }, "use /spot/... or /fapi/...");
    return;
  }
  pipeBinance(req, res, targetHost, newPath);
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`Binance CORS proxy http://127.0.0.1:${PORT}`);
  console.error(`  Spot   -> https://${SPOT_HOST}`);
  console.error(`  Futures-> https://${FUT_HOST}`);
  if (upstreamAgent) {
    console.error(`  Outbound default: HTTPS_PROXY=${UPSTREAM_PROXY}`);
  } else {
    console.error(`  Outbound default: (direct) — or set HTTPS_PROXY; browser can also send X-Upstream-Proxy per page配置`);
  }
});

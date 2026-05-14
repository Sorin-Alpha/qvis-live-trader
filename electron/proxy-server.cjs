/**
 * 与 tools/binance-cors-proxy.mjs 逻辑一致，供 Electron 主进程 require。
 * 浏览器 -> 本服务 -> 币安 REST；默认 8787。
 */
"use strict";

const http = require("node:http");
const { request: httpsRequest } = require("node:https");
const { URL } = require("node:url");
const { HttpsProxyAgent } = require("https-proxy-agent");

const SPOT_HOST = "api.binance.com";
const FUT_HOST = "fapi.binance.com";

function send(res, status, headers, body) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-MBX-APIKEY,X-Upstream-Proxy",
    ...headers,
  });
  res.end(body);
}

/** @param {http.IncomingMessage} req */
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

const headerAgentCache = new Map();

/**
 * 在指定端口启动币安 CORS 代理；listen 成功才 resolve。
 * @param {number} port
 * @returns {Promise<import('node:http').Server>}
 */
function startBinanceProxyAsync(port) {
  return new Promise((resolve, reject) => {
    const UPSTREAM_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
    let upstreamAgent;
    try {
      upstreamAgent = UPSTREAM_PROXY.trim()
        ? new HttpsProxyAgent(UPSTREAM_PROXY.trim())
        : undefined;
    } catch (e) {
      console.error("[binance-proxy] invalid HTTPS_PROXY / HTTP_PROXY:", e.message);
      reject(e);
      return;
    }

    function pipeBinance(req, res, hostname, pathWithQuery) {
      const fromHeader = parseUpstreamProxyHeader(req);
      if (fromHeader === null) {
        send(
          res,
          400,
          { "Content-Type": "text/plain; charset=utf-8" },
          "invalid X-Upstream-Proxy (need http(s)://host:port)"
        );
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
          `[binance-proxy] upstream https://${hostname}${String(pathWithQuery).split("?")[0]}${viaLabel} : ${e.code || ""} ${e.message}`
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
      const u = new URL(req.url || "/", `http://127.0.0.1:${port}`);
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

    const onListenErr = (err) => {
      server.removeListener("error", onListenErr);
      reject(err);
    };
    server.once("error", onListenErr);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onListenErr);
      console.error(`[QVIS] Binance CORS proxy http://127.0.0.1:${port}`);
      if (upstreamAgent) {
        console.error(`[QVIS] Outbound default: HTTPS_PROXY=${UPSTREAM_PROXY}`);
      }
      resolve(server);
    });
  });
}

module.exports = { startBinanceProxyAsync };

#!/usr/bin/env node
/**
 * 一键启动：币安 CORS 代理（8787）+ 静态页（5173）
 * 用法：node start-dev.mjs
 *      npm start
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";

const PROXY_PORT = String(process.env.PROXY_PORT || "8787");
const WEB_PORT = String(process.env.WEB_PORT || "5173");

function launch(cmd, args, extraEnv = {}) {
  return spawn(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
    env: { ...process.env, ...extraEnv },
  });
}

const proxyScript = path.join(root, "tools", "binance-cors-proxy.mjs");
const proxy = launch("node", [proxyScript], { PORT: PROXY_PORT });
const server = launch("npx", ["--yes", "serve", "-l", WEB_PORT, "."]);

console.error(
  `\n[QVIS live-trader] 币安代理 http://127.0.0.1:${PROXY_PORT}  |  页面 http://127.0.0.1:${WEB_PORT}\n 可选环境变量：WEB_PORT、PROXY_PORT\n Ctrl+C 退出\n`
);

function killProc(proc) {
  if (!proc || proc.pid == null) return;
  try {
    if (isWin) {
      spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], { shell: false, stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    /* noop */
  }
}

function shutdown(code = 0) {
  killProc(proxy);
  killProc(server);
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

proxy.on("exit", (c) => {
  if (c !== 0 && c !== null) console.error(`[live-trader] 代理进程退出 code=${c}`);
  killProc(server);
  process.exit(c ?? 0);
});

server.on("exit", (c) => {
  if (c !== 0 && c !== null) console.error(`[live-trader] Web 进程退出 code=${c}`);
  killProc(proxy);
  process.exit(c ?? 0);
});

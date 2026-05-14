/**
 * 从 NODE_OPTIONS 中移除 Electron 不允许的项（如 --openssl-legacy-provider），
 * 再启动子进程，避免全局/终端里 NODE_OPTIONS 导致 electron 直接退出。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));

/** @returns {NodeJS.ProcessEnv} */
function cleanedEnv() {
  const env = { ...process.env };
  const raw = env.NODE_OPTIONS;
  if (!raw || !String(raw).trim()) {
    delete env.NODE_OPTIONS;
    return env;
  }
  const parts = String(raw)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => {
      const s = String(t).trim();
      if (s === "--openssl-legacy-provider") return false;
      if (s.startsWith("--openssl-legacy-provider=")) return false;
      return true;
    });
  if (parts.length) env.NODE_OPTIONS = parts.join(" ");
  else delete env.NODE_OPTIONS;
  return env;
}

const mode = process.argv[2];
const forwarded = process.argv.slice(3);
const env = cleanedEnv();

if (mode === "electron") {
  const electronCli = require.resolve("electron/cli.js", { paths: [root] });
  const args = [electronCli, ".", ...forwarded];
  const child = spawn(process.execPath, args, {
    env,
    stdio: "inherit",
    cwd: root,
    windowsHide: true,
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} else if (mode === "electron-builder") {
  const ebCli = require.resolve("electron-builder/cli.js", { paths: [root] });
  const args = [ebCli, ...forwarded];
  const child = spawn(process.execPath, args, {
    env,
    stdio: "inherit",
    cwd: root,
    windowsHide: true,
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} else {
  console.error("用法: node scripts/run-with-safe-node-options.mjs electron [args...]");
  console.error("  或: node scripts/run-with-safe-node-options.mjs electron-builder [args...]");
  process.exit(1);
}

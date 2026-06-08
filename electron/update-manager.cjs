"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app } = require("electron");
const AdmZip = require("adm-zip");

const FETCH_TIMEOUT_MS = 12_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const SHELL_TOO_OLD_CACHE_MS = 24 * 60 * 60 * 1000;
const VERSION_FILE = "version.json";
const CHECK_CACHE_FILE = "ui-check-cache.json";

/** @param {string} a @param {string} b @returns {number} 1 if a>b, -1 if a<b, 0 if equal */
function compareSemver(a, b) {
  const pa = String(a || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonSafe(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function rmDirRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

function getPkgConfig() {
  try {
    return readJsonSafe(path.join(app.getAppPath(), "package.json")) || {};
  } catch {
    return {};
  }
}

/** @param {string} hostname */
function isAllowedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  if (host === "github.com" || host.endsWith(".github.com")) return true;
  if (host.endsWith(".githubusercontent.com")) return true;
  const extra = getPkgConfig()?.qvisUpdate?.allowedHosts || [];
  return extra.some((h) => String(h).toLowerCase() === host);
}

/** @param {string} urlString @param {string} label */
function assertAllowedHttpsUrl(urlString, label) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new Error(`${label} URL 无效`);
  }
  if (u.protocol !== "https:") {
    throw new Error(`${label} 仅允许 HTTPS`);
  }
  if (!isAllowedHost(u.hostname)) {
    throw new Error(`${label} 来源不在白名单：${u.hostname}`);
  }
}

/** @param {string} child @param {string} parent */
function isPathInsideDir(child, parent) {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  if (resolvedChild === resolvedParent) return true;
  const rel = path.relative(resolvedParent, resolvedChild);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** @param {import('adm-zip')} zip @param {string} destDir */
function validateZipEntries(zip, destDir) {
  const destNorm = path.resolve(destDir);
  for (const entry of zip.getEntries()) {
    const raw = String(entry.entryName || "").replace(/\\/g, "/");
    if (!raw || entry.isDirectory) continue;
    if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
      throw new Error("UI 包含非法绝对路径");
    }
    const segments = raw.split("/");
    if (segments.some((s) => s === "..")) {
      throw new Error("UI 包含路径穿越（..）");
    }
    const target = path.resolve(destNorm, ...segments);
    if (!isPathInsideDir(target, destNorm)) {
      throw new Error("UI 包路径超出解压目录");
    }
  }
}

/** @param {string} url @param {number} timeoutMs */
async function fetchWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 流式下载并限制体积，避免大文件占满内存/磁盘。
 * @param {string} url
 * @param {number} maxBytes
 * @param {number} timeoutMs
 */
async function downloadWithSizeLimit(url, maxBytes, timeoutMs) {
  const res = await fetchWithTimeout(url, timeoutMs);
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new Error(`UI 包过大（${contentLength} bytes > ${maxBytes}）`);
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error("UI 包过大");
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error("UI 包过大");
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function getManifestUrl() {
  const env = String(process.env.QVIS_UI_MANIFEST_URL || "").trim();
  if (env) return env;
  return String(getPkgConfig()?.qvisUpdate?.manifestUrl || "").trim();
}

function getCheckCachePath() {
  return path.join(app.getPath("userData"), CHECK_CACHE_FILE);
}

function readCheckCache() {
  return readJsonSafe(getCheckCachePath());
}

/** @param {object} data */
function writeCheckCache(data) {
  writeJsonSafe(getCheckCachePath(), {
    checkedAt: new Date().toISOString(),
    ...data,
  });
}

/** @param {string} minShell */
function shouldSuppressShellTooOldDialog(minShell) {
  const cache = readCheckCache();
  if (cache?.status !== "shell-too-old") return false;
  if (String(cache.minShell || "") !== minShell) return false;
  const age = Date.now() - Date.parse(cache.checkedAt || "");
  return Number.isFinite(age) && age >= 0 && age < SHELL_TOO_OLD_CACHE_MS;
}

function getUiDir() {
  return path.join(app.getPath("userData"), "ui");
}

function getBundledUiVersion() {
  return String(getPkgConfig()?.version || "0.0.0");
}

function getLocalUiVersion() {
  const uiDir = getUiDir();
  const indexPath = path.join(uiDir, "index.html");
  const vf = path.join(uiDir, VERSION_FILE);
  const stored = readJsonSafe(vf);
  // version.json 仅在热更新目录完整（含 index.html）时才可信
  if (stored?.version && fs.existsSync(indexPath)) return String(stored.version);
  return getBundledUiVersion();
}

/** @param {string} dir @param {string} version */
function writeVersionFile(dir, version) {
  writeJsonSafe(path.join(dir, VERSION_FILE), {
    version,
    updatedAt: new Date().toISOString(),
  });
}

function rollbackUiDirs(uiDir, backupDir, stagingDir) {
  rmDirRecursive(stagingDir);
  if (!fs.existsSync(uiDir) && fs.existsSync(backupDir)) {
    fs.renameSync(backupDir, uiDir);
  }
}

/**
 * @param {string} zipUrl
 * @param {string} expectedVersion
 * @param {string} expectedSha256
 */
async function downloadAndApplyUiBundle(zipUrl, expectedVersion, expectedSha256) {
  if (!expectedSha256) {
    throw new Error("manifest 缺少 sha256，拒绝安装");
  }

  assertAllowedHttpsUrl(zipUrl, "UI 包");

  const uiDir = getUiDir();
  const stagingDir = path.join(app.getPath("userData"), "ui-staging");
  const backupDir = path.join(app.getPath("userData"), "ui-backup");
  const tmpZip = path.join(app.getPath("temp"), `qvis-ui-${expectedVersion}.zip`);

  rmDirRecursive(stagingDir);
  rmDirRecursive(backupDir);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    const buf = await downloadWithSizeLimit(zipUrl, MAX_ZIP_BYTES, DOWNLOAD_TIMEOUT_MS);
    fs.writeFileSync(tmpZip, buf);

    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    if (hash.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error("UI 包校验失败（sha256 不匹配）");
    }

    const zip = new AdmZip(tmpZip);
    validateZipEntries(zip, stagingDir);
    zip.extractAllTo(stagingDir, true);

    const indexPath = path.join(stagingDir, "index.html");
    if (!fs.existsSync(indexPath)) {
      throw new Error("UI 包无效：缺少 index.html");
    }

    // version.json 与 UI 文件一同写入 staging，rename 后原子生效
    writeVersionFile(stagingDir, expectedVersion);

    const hadUi = fs.existsSync(uiDir);
    if (hadUi) {
      fs.renameSync(uiDir, backupDir);
    }
    try {
      fs.renameSync(stagingDir, uiDir);
      rmDirRecursive(backupDir);
    } catch (swapErr) {
      rollbackUiDirs(uiDir, backupDir, stagingDir);
      throw swapErr;
    }
  } finally {
    rmDirRecursive(stagingDir);
    try {
      fs.unlinkSync(tmpZip);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 启动时检查并应用 UI 热更新（每次均拉取 manifest，确保能及时发现新版本）。
 * @returns {Promise<{ applied: boolean, version?: string, skippedReason?: string, error?: string }>}
 */
async function checkAndApplyUiUpdate() {
  if (!app.isPackaged && !process.env.QVIS_FORCE_UI_UPDATE) {
    return { applied: false, skippedReason: "dev-mode" };
  }
  if (process.env.QVIS_SKIP_UI_UPDATE === "1") {
    return { applied: false, skippedReason: "env-skip" };
  }

  // 若用户下载了更新的 exe（bundled 版本 > uiDir 版本），
  // 清除旧 uiDir，让新 exe 自带的 bundled UI 生效，
  // 避免旧热更新目录遮盖更新的打包内容。
  const uiDir = getUiDir();
  const bundledVersion = getBundledUiVersion();
  const uiDirVersionFile = path.join(uiDir, VERSION_FILE);
  const uiDirIndex = path.join(uiDir, "index.html");
  if (fs.existsSync(uiDirIndex)) {
    const stored = readJsonSafe(uiDirVersionFile);
    const uiDirVersion = stored?.version ? String(stored.version) : null;
    if (uiDirVersion && compareSemver(bundledVersion, uiDirVersion) > 0) {
      console.log(`[QVIS] bundled ${bundledVersion} > uiDir ${uiDirVersion}，清除旧热更新目录`);
      rmDirRecursive(uiDir);
    }
  }

  const manifestUrl = getManifestUrl();
  if (!manifestUrl) {
    return { applied: false, skippedReason: "no-manifest-url" };
  }

  const localVersion = getLocalUiVersion();

  try {
    assertAllowedHttpsUrl(manifestUrl, "manifest");

    const res = await fetchWithTimeout(manifestUrl, FETCH_TIMEOUT_MS);
    const manifest = await res.json();
    const remoteVersion = String(manifest.version || "").trim();
    const zipUrl = String(manifest.url || "").trim();
    const minShell = String(manifest.minShellVersion || manifest.min_shell_version || "0.0.0").trim();
    const sha256 = String(manifest.sha256 || "").trim();

    if (!remoteVersion || !zipUrl) {
      return { applied: false, skippedReason: "invalid-manifest" };
    }

    const shellVersion = app.getVersion();
    if (compareSemver(shellVersion, minShell) < 0) {
      if (shouldSuppressShellTooOldDialog(minShell)) {
        return { applied: false, skippedReason: "shell-too-old-suppressed", version: localVersion };
      }
      writeCheckCache({ status: "shell-too-old", localVersion, minShell, shellVersion });
      return {
        applied: false,
        skippedReason: "shell-too-old",
        error: `需要程序版本 ≥ ${minShell}（当前 ${shellVersion}），请下载新版安装包`,
      };
    }

    if (compareSemver(remoteVersion, localVersion) <= 0) {
      writeCheckCache({ status: "up-to-date", localVersion, remoteVersion });
      return { applied: false, skippedReason: "up-to-date", version: localVersion };
    }

    if (!sha256) {
      return { applied: false, skippedReason: "missing-sha256" };
    }

    await downloadAndApplyUiBundle(zipUrl, remoteVersion, sha256);
    writeCheckCache({ status: "up-to-date", localVersion: remoteVersion, remoteVersion });
    return { applied: true, version: remoteVersion };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "检查更新超时" : String(e?.message || e);
    console.warn("[QVIS] UI 热更新失败:", msg);
    return { applied: false, error: msg, version: localVersion };
  }
}

module.exports = {
  checkAndApplyUiUpdate,
  getUiDir,
  getLocalUiVersion,
  getBundledUiVersion,
  compareSemver,
};

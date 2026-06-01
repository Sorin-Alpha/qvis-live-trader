#!/usr/bin/env node
/**
 * 打包 UI 热更新资源：ui-{version}.zip + manifest.json
 * 用法：node scripts/build-ui-bundle.mjs [--out dist-electron]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const outArg = process.argv.indexOf("--out");
const outDir = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, "dist-electron");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const repo = pkg.qvisUpdate?.githubRepo || "Sorin-Alpha/qvis-live-trader";
const tag = `v${version}`;

function addDir(zip, localDir, zipPath) {
  const abs = path.join(root, localDir);
  if (!fs.existsSync(abs)) return;
  zip.addLocalFolder(abs, zipPath);
}

fs.mkdirSync(outDir, { recursive: true });

const zipName = `ui-${version}.zip`;
const zipPath = path.join(outDir, zipName);
const zip = new AdmZip();
zip.addLocalFile(path.join(root, "index.html"), "");
addDir(zip, "js", "js");
addDir(zip, "css", "css");
zip.writeZip(zipPath);

const sha256 = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");

const minShell = pkg.qvisUpdate?.minShellVersion || version;

const manifest = {
  version,
  minShellVersion: minShell,
  url: `https://github.com/${repo}/releases/download/${tag}/${zipName}`,
  sha256,
  publishedAt: new Date().toISOString(),
};

const manifestPath = path.join(outDir, "manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

console.log(`[build-ui-bundle] ${zipPath} (${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB)`);
console.log(`[build-ui-bundle] ${manifestPath}`);
console.log(`[build-ui-bundle] sha256=${sha256}`);

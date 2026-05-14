/**
 * electron-builder 在 win.signAndEditExecutable=false 时会跳过 rcedit，导致自定义图标无法写入 exe。
 * 在打包完成后用 rcedit 补写图标（与官方 signAndEditResources 中的 --set-icon 一致）。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const rcedit = require("rcedit");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const productName = pkg.build?.productName || "QVIS跟单终端";
const iconPath = path.join(root, "build", "icon.ico");
const distDir = path.join(root, "dist-electron");

async function main() {
  if (!fs.existsSync(iconPath)) {
    console.warn("[apply-win-icon] 未找到 build/icon.ico，跳过（请放置 .ico 后重新 dist:win）");
    process.exit(0);
  }
  const targets = [];

  const unpackedExe = path.join(distDir, "win-unpacked", `${productName}.exe`);
  if (fs.existsSync(unpackedExe)) targets.push(unpackedExe);

  // 切勿对 *-portable.exe 使用 rcedit：NSIS 便携包自带完整性校验，改写 PE 会导致
  // 「Installer integrity check has failed」。自定义图标仅写入 win-unpacked 内主程序。

  if (targets.length === 0) {
    console.warn("[apply-win-icon] 未找到 dist-electron 下的 exe，跳过");
    process.exit(0);
  }

  for (const exe of targets) {
    try {
      await rcedit(exe, { icon: iconPath });
      console.log("[apply-win-icon] 已写入图标:", exe);
    } catch (e) {
      console.error("[apply-win-icon] 失败:", exe, e.message || e);
      process.exitCode = 1;
    }
  }
}

main();

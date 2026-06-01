"use strict";

const { app, BrowserWindow, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { startBinanceProxyAsync } = require("./proxy-server.cjs");
const { startStaticServer } = require("./static-server.cjs");
const { checkAndApplyUiUpdate, getUiDir } = require("./update-manager.cjs");

const PROXY_PORT = Number(process.env.PROXY_PORT || process.env.QVIS_PROXY_PORT || 8787);
const STATIC_PORT = Number(process.env.QVIS_WEB_PORT || 5199);

/** @returns {Promise<{ server: import('node:http').Server; port: number }>} */
async function bindProxyWithFallback() {
  const maxTry = 20;
  for (let i = 0; i < maxTry; i++) {
    const p = PROXY_PORT + i;
    try {
      const server = await startBinanceProxyAsync(p);
      if (i > 0) {
        console.warn(`[QVIS] 端口 ${PROXY_PORT} 已被占用，币安 CORS 代理已改用 ${p}（请保持本窗口为唯一 Electron 实例或关闭 npm start）`);
      }
      return { server, port: p };
    } catch (e) {
      if (e && e.code === "EADDRINUSE") continue;
      throw e;
    }
  }
  throw new Error(`端口 ${PROXY_PORT}–${PROXY_PORT + maxTry - 1} 均被占用，无法启动币安代理`);
}

/** @returns {Promise<{ server: import('node:http').Server; port: number }>} */
async function bindStaticWithFallback(roots) {
  const maxTry = 15;
  for (let i = 0; i < maxTry; i++) {
    const p = STATIC_PORT + i;
    try {
      const server = await startStaticServer(roots, p);
      if (i > 0) {
        console.warn(`[QVIS] 端口 ${STATIC_PORT} 已被占用，静态页已改用 ${p}`);
      }
      return { server, port: p };
    } catch (e) {
      if (e && e.code === "EADDRINUSE") continue;
      throw e;
    }
  }
  throw new Error(`端口 ${STATIC_PORT}–${STATIC_PORT + maxTry - 1} 均被占用，无法启动界面服务`);
}

/** 开发时从项目根读静态文件；打包后为 resources/app(.asar) */
function getAppRoot() {
  if (app.isPackaged) {
    return app.getAppPath();
  }
  return path.join(__dirname, "..");
}

/** 静态资源根：热更新目录优先，其次 asar 内置 */
function getStaticRoots() {
  const bundled = getAppRoot();
  const uiDir = getUiDir();
  if (fs.existsSync(path.join(uiDir, "index.html"))) {
    return [uiDir, bundled];
  }
  return [bundled];
}

let mainWindow = null;
let proxyServer = null;
let staticServer = null;
/** @type {string} */
let internalPageUrl = "";

function createWindow(pageUrl) {
  const buildDir = path.join(__dirname, "..", "build");
  const icns = path.join(buildDir, "icon.icns");
  const ico = path.join(buildDir, "icon.ico");
  const iconPath = process.platform === "darwin" && fs.existsSync(icns) ? icns : fs.existsSync(ico) ? ico : undefined;
  const winIcon = iconPath;
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "QVIS 跟单终端",
    ...(winIcon ? { icon: winIcon } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.loadURL(pageUrl);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function shutdownServers() {
  return new Promise((resolve) => {
    let n = 0;
    const done = () => {
      n += 1;
      if (n >= 2) resolve();
    };
    if (staticServer) {
      staticServer.close(() => done());
      staticServer = null;
    } else done();
    if (proxyServer) {
      proxyServer.close(() => done());
      proxyServer = null;
    } else done();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    let proxyPort = PROXY_PORT;
    let staticPort = STATIC_PORT;

    const updateResult = await checkAndApplyUiUpdate();
    if (updateResult.applied) {
      await dialog.showMessageBox({
        type: "info",
        title: "界面已更新",
        message: `已自动更新到 v${updateResult.version}`,
        detail: "本次更新仅包含界面与跟单逻辑，无需重新下载程序。",
      });
    } else if (updateResult.skippedReason === "shell-too-old" && updateResult.error) {
      await dialog.showMessageBox({
        type: "warning",
        title: "需要更新程序",
        message: updateResult.error,
        detail: "请从 GitHub Releases 下载最新版安装包后重新安装。",
      });
    }

    try {
      const r = await bindProxyWithFallback();
      proxyServer = r.server;
      proxyPort = r.port;
    } catch (e) {
      await dialog.showErrorBox(
        "启动失败",
        `币安 CORS 代理无法启动：\n${e.message}\n\n常见原因：已运行「npm start」或另一份本程序。可先关闭再打开桌面版。`
      );
      app.quit();
      return;
    }

    try {
      const s = await bindStaticWithFallback(getStaticRoots());
      staticServer = s.server;
      staticPort = s.port;
    } catch (e) {
      await dialog.showErrorBox(
        "启动失败",
        `静态页服务无法启动：\n${e.message}\n可设置环境变量 QVIS_WEB_PORT 换起始端口。`
      );
      if (proxyServer) proxyServer.close();
      app.quit();
      return;
    }

    const q = new URLSearchParams({ binanceProxyPort: String(proxyPort) });
    internalPageUrl = `http://127.0.0.1:${staticPort}/?${q.toString()}`;
    createWindow(internalPageUrl);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && internalPageUrl) {
        createWindow(internalPageUrl);
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      shutdownServers().finally(() => app.quit());
    }
  });

  app.on("before-quit", () => {
    shutdownServers();
  });
}

<p align="center">
  <h1 align="center">QVIS 本地跟单终端</h1>
  <p align="center">基于 Electron + 币安 REST API 的本地自动跟单工具</p>
  <p align="center">
    <img src="https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen?logo=node.js" />
    <img src="https://img.shields.io/badge/Electron-33.x-blue?logo=electron" />
    <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" />
    <img src="https://img.shields.io/badge/License-MIT-yellow" />
  </p>
</p>

---

> **免责声明**：本项目为**第三方开源工具**，与 QVIS 平台官方无关。使用前请自行审计代码，作者不对任何交易损失承担责任。

---

## 简介

QVIS 本地跟单终端订阅 QVIS 平台的**模拟实盘 WebSocket 信号**，收到开仓 / 平仓通知后在**本机**直接调用币安 API 完成下单。

- 支持**现货**（Binance Spot）和 **U 本位合约**（Binance Perpetual Futures）
- **密钥与签名全程在本地完成**，不经过任何第三方服务器
- 提供浏览器网页版和 Windows / macOS 桌面客户端两种使用方式

---

## 目录

- [架构说明](#架构说明)
- [前置条件](#前置条件)
- [快速开始](#快速开始)
  - [Windows](#windows)
  - [macOS](#macos)
  - [Linux](#linux)
- [桌面客户端打包](#桌面客户端打包)
- [界面配置项](#界面配置项)
- [下单参数详解](#下单参数详解)
- [环境变量参考](#环境变量参考)
- [常见问题](#常见问题)
- [安全说明](#安全说明)
- [许可证](#许可证)

---

## 架构说明

```
浏览器 / Electron 页面
        │
        │ HTTP（localhost）
        ▼
  本地 CORS 代理（:8787）      ← 解决浏览器跨域限制
        │
        │ HTTPS
        ▼
  api.binance.com / fapi.binance.com
```

> 币安 API 不支持浏览器直接跨域调用，因此需要在本机运行一个轻量代理服务来转发请求。`npm start` 会自动同时启动代理和页面服务。

---

## 前置条件

### 运行环境

| 软件 | 最低版本 | 推荐版本 | 下载地址 |
|------|---------|---------|---------|
| Node.js | 18.x | 20.x LTS | https://nodejs.org |
| npm | 9.x | 随 Node.js 自带 | — |
| Git | 任意 | — | https://git-scm.com |

安装后验证：

```bash
node -v   # v18.0.0 或以上
npm -v    # 显示版本号即可
```

### 必要账号与密钥

在开始之前，请准备以下三项：

| 密钥 | 用途 | 获取方式 |
|------|------|---------|
| **QVIS Client API Key** | 接收平台模拟交易信号 | 登录 QVIS 平台 → 设置 → 创建 Client API Key |
| **币安 API Key** | 身份认证 | 币安 → 账户 → API 管理 → 创建 |
| **币安 API Secret** | 签名每笔请求 | 创建 API 时仅显示一次，请立即保存 |

> ⚠️ **币安 API 权限建议**：仅勾选「现货交易」或「U 本位合约交易」，**绝对不要开启提现权限**，并绑定本机出口 IP。

---

## 快速开始

### 第一步：克隆仓库

```bash
git clone https://github.com/Sorin-Alpha/qvis-live-trader.git
cd qvis-live-trader
```

### 第二步：安装依赖

```bash
npm install
```

> 首次安装需要联网下载依赖，耗时约 1~2 分钟，请耐心等待。

### 第三步：启动项目

根据你的操作系统选择对应方式：

---

#### Windows

打开 **PowerShell** 或 **命令提示符（CMD）**：

```powershell
npm start
```

启动成功后终端会显示：

```
[QVIS live-trader] 币安代理 http://127.0.0.1:8787  |  页面 http://127.0.0.1:5173
```

打开浏览器，访问 **http://127.0.0.1:5173**

**如遇端口冲突，可临时更换端口：**

```powershell
$env:PROXY_PORT = "8788"
$env:WEB_PORT   = "5174"
npm start
```

**如需设置出境代理（国内无法直连币安时）：**

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
npm start
```

---

#### macOS

打开**终端（Terminal）**：

```bash
npm start
```

启动成功后终端会显示：

```
[QVIS live-trader] 币安代理 http://127.0.0.1:8787  |  页面 http://127.0.0.1:5173
```

打开浏览器，访问 **http://127.0.0.1:5173**

**如遇端口冲突：**

```bash
PROXY_PORT=8788 WEB_PORT=5174 npm start
```

**如需设置出境代理：**

```bash
HTTPS_PROXY=http://127.0.0.1:7890 npm start
```

> macOS 如提示「无法验证开发者」，前往「系统设置 → 隐私与安全性」点击「仍要打开」。

---

#### Linux

打开**终端**：

```bash
npm start
```

启动成功后终端会显示：

```
[QVIS live-trader] 币安代理 http://127.0.0.1:8787  |  页面 http://127.0.0.1:5173
```

打开浏览器，访问 **http://127.0.0.1:5173**

**如遇端口冲突：**

```bash
PROXY_PORT=8788 WEB_PORT=5174 npm start
```

**如需设置出境代理：**

```bash
HTTPS_PROXY=http://127.0.0.1:7890 npm start
```

**仅启动 CORS 代理（不启动页面服务）：**

```bash
node tools/binance-cors-proxy.mjs
```

**仅启动静态页（不启动代理）：**

```bash
npx --yes serve -l 5173 .
```

---

### 第四步：填写配置

页面加载后，在设置面板填写以下信息并点击「保存」：

1. **QVIS Client API Key**（`qvis_` 开头）
2. **币安 API Key** 和 **Secret**
3. 其余选项保持默认即可（详见[界面配置项](#界面配置项)）

---

## 桌面客户端打包

如果你想打包成独立的桌面应用分发给其他人，而不是每次都用命令行启动：

### 开发模式预览（无需打包）

```bash
npm run electron
```

### 打包 Windows 便携版（.exe）

> 在 **Windows** 上执行

```bash
npm run dist:win
```

产物：`dist-electron/QVIS跟单终端-x.x.x-portable.exe`，双击运行，无需安装。

### 打包 macOS 安装包（.dmg）

> 必须在 **macOS** 上执行，Windows 无法交叉编译

```bash
npm run dist:mac
```

产物：`dist-electron/QVIS跟单终端-x.x.x-mac-arm64.dmg`（Apple Silicon）

> 首次打开 `.dmg` 若被 macOS 拦截：「系统设置 → 隐私与安全性 → 仍要打开」

---

## 界面配置项

| 配置项 | 必填 | 说明 | 默认值 |
|--------|:----:|------|--------|
| QVIS 平台地址 | 否 | 平台 API 根地址，一般无需修改 | `https://api.qvis.ai` |
| QVIS Client API Key | ✅ | 以 `qvis_` 开头的平台密钥 | — |
| 币安 API Key | ✅ | 币安账户 API Key | — |
| 币安 API Secret | ✅ | 币安账户 API Secret | — |
| 本地 CORS 代理地址 | 否 | 与代理启动端口一致，一般无需修改 | `http://127.0.0.1:8787` |
| 币安出境 HTTP 代理 | 否 | 无法直连币安时填写，如 `http://127.0.0.1:7890` | 空（直连） |
| 最大滑点 | 否 | 超过此偏离则跳过该笔信号 | `0.1%` |

---

## 下单参数详解

现货和合约各自维护一套参数，可在界面「下单设置」里调整：

### 现货（Binance Spot）

| 参数 | 说明 | 默认值 | 可选值 |
|------|------|--------|--------|
| `open_order_type` | 开仓类型 | `MARKET` | `MARKET` / `LIMIT` |
| `open_order_seconds` | 限价单最长等待时间（秒），超时转市价 | `120` | 正整数 |
| `open_market_after_limit` | 限价超时后是否自动转市价 | `true` | `true` / `false` |
| `open_order_slippage` | 开仓允许最大滑点（0.001 = 0.1%） | `0.001` | 小数 |
| `close_order_type` | 平仓类型 | `MARKET` | `MARKET` / `LIMIT` |
| `close_order_seconds` | 平仓限价单最长等待时间（秒） | `120` | 正整数 |
| `close_order_slippage` | 平仓允许最大滑点 | `0.001` | 小数 |

### U 本位合约（Binance Futures）

在现货参数基础上，新增：

| 参数 | 说明 | 默认值 | 可选值 |
|------|------|--------|--------|
| `leverage` | 合约杠杆倍数 | `3` | 正整数（受币安账户限制） |

---

## 环境变量参考

| 变量名 | 作用 | 默认值 | 适用版本 |
|--------|------|--------|---------|
| `WEB_PORT` | 静态页监听端口 | `5173` | 浏览器版 |
| `PROXY_PORT` | CORS 代理监听端口 | `8787` | 浏览器版 |
| `QVIS_WEB_PORT` | 静态页监听端口 | `5199` | Electron 版 |
| `QVIS_PROXY_PORT` | CORS 代理监听端口 | `8787` | Electron 版 |
| `HTTPS_PROXY` | 代理进程访问币安的出境代理 | 空 | 全部 |
| `HTTP_PROXY` | 同上（备用） | 空 | 全部 |

---

## 常见问题

<details>
<summary>❌ 页面显示「本地代理访问币安失败」</summary>

**原因**：币安 CORS 代理未启动，或本机无法直连 `api.binance.com`。

**解决步骤**：
1. 确认已执行 `npm start`，且终端无报错
2. 浏览器访问 `http://127.0.0.1:8787/spot/api/v3/time`，应返回 JSON
3. 若无法直连，设置出境代理后重启：
   ```bash
   HTTPS_PROXY=http://127.0.0.1:7890 npm start
   ```

</details>

<details>
<summary>❌ WebSocket 连接失败 / code=1006</summary>

**解决步骤**：
1. 确认 QVIS Client API Key 填写正确（`qvis_` 开头）
2. 浏览器访问 `https://api.qvis.ai/api/v1/client-api/health`，应返回 `{"ok":true,...}`
3. 若页面是 HTTPS 而代理是 HTTP，浏览器会因「混合内容」拦截，改用 HTTP 访问页面

</details>

<details>
<summary>❌ 端口已被占用（EADDRINUSE）</summary>

更换端口后重试：

```bash
# macOS / Linux
PROXY_PORT=8788 WEB_PORT=5174 npm start

# Windows PowerShell
$env:PROXY_PORT = "8788"; $env:WEB_PORT = "5174"; npm start
```

</details>

<details>
<summary>❌ 打包时提示「文件被占用」（Windows）</summary>

1. 关闭所有正在运行的 `QVIS跟单终端.exe`
2. 删除 `dist-electron/` 目录
3. 重新执行 `npm run dist:win`

</details>

<details>
<summary>❌ macOS 首次打开被系统拦截</summary>

**方法一**：「系统设置 → 隐私与安全性」→ 找到被拦截的应用 → 点击「仍要打开」

**方法二**（终端）：
```bash
xattr -cr /Applications/QVIS跟单终端.app
```

</details>

---

## 安全说明

- 所有密钥（币安 Secret、QVIS API Key）**仅存储在本机浏览器 `localStorage`**
- 签名计算在本地完成，**原始密钥不会离开你的设备**
- 使用完毕后建议点击界面「清除本地密钥」
- 请勿在公共电脑或他人设备上保存密钥
- 建议为币安 API 绑定 IP 白名单，仅开启交易权限
- 本项目为开源示例，**实盘使用前请自行审计全部代码**

---


> 可自由使用、修改和分发，需保留原始版权声明。

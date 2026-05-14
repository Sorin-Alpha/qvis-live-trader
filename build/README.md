# 应用图标（Windows）

## 重要：不要用 SVG 作为 exe 图标

**electron-builder 在 Windows 上不会用 `.svg` 嵌入 exe。**  
SVG 只能用在网页里（`<img>` / CSS）；桌面程序图标必须是 **`.ico`**（推荐）或符合要求的 **`.png`**（见下文）。

若你只有 **SVG**，请先导出为位图再转 ico，例如：

1. 用 Figma / Illustrator / Inkscape 将 SVG **导出为 PNG**，边长至少 **512px**（建议 **1024×1024**）。  
2. 用 [CloudConvert](https://cloudconvert.com/svg-to-ico)、[ICO Convert](https://icoconvert.com/) 等，把 PNG 转成 **多尺寸 `.ico`**（含 16、32、48、256）。  
3. 将得到的文件保存为：**`build/icon.ico`**（见下方「做法一」）。

---

## 做法一（推荐）

1. 准备 **`.ico`** 文件，建议包含多档尺寸（16、32、48、256），任务栏/窗口标题栏显示更清楚。  
2. 将文件放到本目录，命名为：**`icon.ico`**。  
3. 确认项目根目录 **`package.json`** 里 **`build.icon`** 为 **`build/icon.ico`**（本仓库已写好；若你改名，请同步改 `package.json`）。  
4. 重新执行 **`npm run dist:win`**。打包结束后会自动运行 **`scripts/apply-win-icon.mjs`**，把图标写入 **`win-unpacked` 内的主程序 exe（仅此文件）**（**不会**改写 `*-portable.exe`：NSIS 便携包有完整性校验，后处理改图标会导致「Installer integrity check has failed」）。便携版若需自定义图标，需在能开启 `signAndEditExecutable` 的环境下由 electron-builder 在生成阶段写入，或改为 zip 分发 `win-unpacked` 整目录。  
5. 若资源管理器里仍显示旧图标：**换文件夹看 exe** 或 **注销/重启一次**（Windows 会缓存 exe 图标）。

## 做法二：只有 PNG、没有 ICO

可将 **至少 256×256 的 PNG**（建议 512×512）存为 **`build/icon.png`**，并把 `package.json` 里的 **`build.icon`** 改成 **`build/icon.png`** 后重新打包。不同 electron-builder 版本对 PNG 支持略有差异，**优先仍建议用 `.ico`**。

---

## 开发时 `npm run electron` 的窗口标题栏图标

**macOS**：若存在 **`build/icon.icns`** 会优先使用；否则使用 **`build/icon.ico`**（若存在）。  
**Windows**：使用 **`build/icon.ico`**（若存在）。

---

## macOS 应用图标（.icns）

打包 **Mac 版**时，electron-builder 会使用 **`build/icon.icns`**（若存在），否则会尝试从 **`build/icon.ico`** 转换。  
在 macOS 上可用 **iconutil** 或在线工具由 PNG 生成 **`.icns`**，放到 **`build/icon.icns`**。  
开发运行时：若存在 **`build/icon.icns`**，会优先用作窗口图标（见 `electron/main.cjs`）。

---

## 开源注意

若图标有版权（外包/购买的素材），请在仓库 **README 或 LICENSE** 里说明归属；仅自己品牌图标可直接随仓库分发。

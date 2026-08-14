# 开发者工具箱（DevToolbox）

MooTool 风格的桌面端开发者工具集，基于 **Tauri 2 + Vite**，界面用 HTML/CSS/JS，可打包成 Windows 安装包。

> 主路径已切换为 Tauri。旧的 Electron 壳仍保留在 `electron/`，仅作对照：`npm run dev:electron` / `npm run dist:electron`。

## 运行

```bash
# 安装依赖
npm install

# 桌面应用开发（Vite + Tauri）
npm run dev

# 仅浏览器预览前端
npm run dev:web   # http://127.0.0.1:5173

# 前端构建
npm run build

# 打包桌面端（Tauri / NSIS）
npm run dist
```

## 技术栈

- **Tauri 2** — 桌面壳，Rust 后端 `src-tauri/src/lib.rs`
- **Vite 8** — 前端构建与开发服务器
- **依赖库**：`crypto-js`、`sql-formatter`、`dayjs`、`uuid`、`qrcode` + `jsqr`、`cron-parser`、`@xterm/xterm` 等

## 目录结构

```
dev-toolbox/
├─ src-tauri/        Tauri / Rust 后端（SSH、笔记、部署、Hosts…）
├─ src/
│  ├─ main.js        渲染入口
│  ├─ tauri-shim.js  Tauri → window.toolbox 桥
│  ├─ app.js         外壳：侧边栏 + 工具切换
│  └─ tools/         各工具模块
├─ electron/         （遗留，逐步废弃）
├─ index.html
├─ vite.config.js
└─ package.json
```

## 扩展新工具

在 `src/tools/` 新建模块，导出 `{ id, name, category, icon, desc, render(container) }`，在 `registry.js` 中注册即可。

已内嵌的外部服务类工具：

| 工具 | 说明 |
|------|------|
| TestHub | 本机测试平台 iframe |
| New API | 本机 LLM 网关 |
| AI 编制 | 本机 [OpenAcme](https://openacme.org/)（:3456），附带产品交付 8 岗人设模板；启动脚本见 `openacme/ensure-openacme.ps1`（Windows 优先走已安装 CLI 或 WSL） |
| DeepSeek Harness | 本机 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（:3080），默认安装目录 `D:\deepseek-ai`；启动脚本见 `dsh/ensure-dsh.ps1` |
| PDF 工具 | 本机 [Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF)（:8090），Docker 一键启动；脚本见 `stirling-pdf/ensure-stirling-pdf.ps1` |
| 知识库 | 本机 [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm)（:3002，避开 TestHub :3001），Docker 一键启动；脚本见 `anythingllm/ensure-anythingllm.ps1`；模型建议接 New API `host.docker.internal:5780`；青绿皮肤见 `anythingllm/toolbox-skin.css`（`apply-toolbox-skin.ps1`） |

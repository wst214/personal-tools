# 开发者工具箱（DevToolbox）

MooTool 风格的桌面端开发者工具集，基于 **Electron + Vite**，界面用 HTML/CSS/JS，可打包成 Windows `.exe`。

## 功能模块（19 个）

**编码转换**
- **JSON 格式化** — 美化(2/4 空格)/压缩/转义/去转义/校验(错误定位)、JSON↔XML、JSON->CSV、JSON->Properties、生成 Java 实体类、生成 C# 实体类
- **加解密编码** — 编码：Base64/URL/Hex/Unicode/HTML实体/Morse/Native-ASCII；哈希：MD5/SHA1/SHA224/SHA256/SHA384/SHA512/SHA3/RIPEMD160/SM3/HMAC-MD5/HMAC-SHA256；对称：AES/DES/3DES/RC4/Rabbit/SM4；非对称：RSA/SM2
- **进制转换** — 二/八/十/十六进制互转
- **字符 / ASCII** — 字符与 ASCII/Unicode 码点互查
- **UUID 生成** — v1/v4/v7 批量生成，大写/花括号/去横线

**时间**
- **时间戳** — 实时时钟、时间戳↔日期互转(秒/毫秒自动识别)、本地/UTC/ISO/相对/星期

**文本**
- **SQL 格式化** — 美化/压缩、13 种方言、关键字大小写、缩进选项
- **正则测试** — 匹配高亮、分组、替换、匹配详情
- **文本处理** — 行去重(保序)/排序/反转/去空行/大小写/驼峰下划线互转/简繁互转/全半角互转/加行号/统计

**其它**
- **二维码** — 生成(尺寸/容错/颜色/边距) + 解析(上传图片)
- **颜色** — HEX/RGB/HSL/HSV/CMYK 互转 + 互补/类比/三色配色方案
- **Cron** — 中文+英文描述、字段分解、未来 5 次执行时间、常用预设
- **随手记** — 本地笔记（localStorage 保存）
- **翻译** — 多语言互译（桌面端调用）

**网络**（需桌面端，调用主进程）
- **HTTP 工具** — GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS，Headers/Body，响应美化
- **端口扫描** — 扫描指定主机端口范围
- **IP 查询** — IP 归属地（留空查本机出口 IP）

**系统**（需桌面端）
- **系统信息** — CPU/内存/网络/主机名/运行时长/版本
- **Hosts** — 读取/编辑系统 hosts（写入需管理员）

> 侧边栏支持「★ 常用」置顶：鼠标悬停工具项，点 ☆/★ 即可置顶/取消，置顶项聚到顶部「常用」分组。

## 运行

```bash
# 安装依赖（已配置 npmmirror 国内镜像）
npm install

# 桌面应用开发模式（启动 vite + electron 窗口）
npm run dev

# 仅浏览器预览（调试前端用，最快）
npm run dev:web   # 打开 http://127.0.0.1:5173

# 生产构建（输出到 dist/）
npm run build

# 打包成 Windows 便携版（输出到 release/）
npm run dist
```

> Electron 二进制走 `npmmirror` 镜像下载（已在 `dev`/`dist` 脚本中通过 `ELECTRON_MIRROR` 环境变量配置），无需直连 GitHub。

## 免安装便携版

已组装好一个可直接双击运行的免安装目录（无需命令行、无需安装）：

```
release/win-unpacked/DevToolbox.exe   ← 双击即运行
```

整个 `win-unpacked` 文件夹可整体复制到任意位置（桌面、D 盘等）使用。

**关于 `npm run dist` 的已知问题**：electron-builder 在解压 `electron.exe` 时会触发 Windows Defender / 360 实时扫描，导致 `win-unpacked.tmp -> win-unpacked` 改名失败（EPERM）。上面的 `release/win-unpacked` 是绕过该问题手动组装的（直接复用 `node_modules/electron/dist` 运行时 + 应用文件）。若要让 `npm run dist` 正常工作，需把项目目录加入杀软排除名单，或临时关闭实时防护。

## 技术栈

- **Electron 43** — 桌面壳，主进程 `electron/main.cjs`，预加载 `electron/preload.cjs`
- **Vite 8** — 渲染进程构建与开发服务器
- **依赖库**：`crypto-js`（加解密）、`sql-formatter`（SQL 美化）、`dayjs`（时间）、`uuid`、`qrcode` + `jsqr`（二维码）、`cron-parser` + `cronstrue`（Cron）

## 目录结构

```
dev-toolbox/
├─ electron/          主进程与 preload
├─ src/
│  ├─ main.js        渲染入口
│  ├─ app.js         外壳：侧边栏 + 内容区 + 工具切换
│  ├─ styles.css     主题（深/浅色）
│  ├─ ui/helpers.js  通用 DOM/交互辅助
│  └─ tools/         各工具模块（json/timestamp/crypto/...）
├─ index.html
├─ vite.config.js
└─ package.json
```

## 扩展新工具

在 `src/tools/` 新建模块，导出 `{ id, name, category, icon, desc, render(container) }`，在 `registry.js` 中注册即可。`render` 返回一个清理函数用于释放定时器等资源。

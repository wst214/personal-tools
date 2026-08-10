# SSH 工具改造:内嵌终端(多标签)+ 本地/远程双栏 SFTP

## 目标
把 SSH 工具从「弹外部 cmd 跑原生 ssh.exe」改成「工具内嵌」:
1. **多标签终端**:工具里直接开终端,可同时连多台服务器,标签页切换。
2. **双栏 SFTP**:左本地目录、右远程目录,拖拽上传/下载,像 SFTP 客户端。
3. 复用现有主机清单(地址/端口/用户/密码 safeStorage 加密 / 密钥 id_ed25519)。

## 技术选型(纯 JS,避开原生编译)
- **@xterm/xterm + @xterm/addon-fit**:终端 UI,纯 JS,无原生模块。
- **ssh2**:SSH/SFTP 协议(主进程用)。可选原生 `cpu-features` 装不上时自动降级纯 JS,不阻断安装、不影响功能(性能略低,日常无感)。
- **不用 node-pty**:原生编译,Windows + 国内网络有风险。
- 拖拽用浏览器原生 HTML5 drag/drop,不引依赖。

## 架构

### 主进程 `electron/main.cjs`(加 ssh2)
连接管理:`Map<tabId, { conn, stream, sftp, hostId, name }>`(每个标签一条独立 conn)。

新增 IPC:
- `ssh:term:connect(hostId)` -> 建连接 + 开 shell channel(`{term:'xterm-256color', cols, rows}`)。成功返回 `{ ok, tabId }`,失败 `{ ok:false, msg }`。`stream` 的 data 经 `win.webContents.send('ssh:term:data', {tabId, data})` 推流;`stream.close`/`conn.close` 推 `ssh:term:closed`。
- `ssh:term:input(tabId, data)` -> `stream.write(data)`。
- `ssh:term:resize(tabId, cols, rows)` -> `stream.setWindow(rows, cols, cols, rows)`。
- `ssh:term:disconnect(tabId)` -> `stream.end()` + `conn.end()`,从 Map 移除。
- `ssh:sftp:list(tabId, remotePath)` -> `sftp.readdir` 返回 `[{name, type, size, mtime}]`(type 区分文件/目录/链接)。
- `ssh:sftp:upload(tabId, localPath, remotePath)` -> `sftp.fastPut`,进度经 `ssh:sftp:progress` 推。
- `ssh:sftp:download(tabId, remotePath, localPath)` -> `sftp.fastGet`。
- `ssh:sftp:mkdir(tabId, path)`、`ssh:sftp:stat(tabId, path)`(拖拽到不存在目录时建)。
- `ssh:local:list(dir)`、`ssh:local:pickFile`、`ssh:local:pickDir`(左栏本地浏览 + 选保存位置,用 `dialog`/`fs`)。

保留原样:`ssh:list/save/delete/getPwd/copyCmd/genKey/publicKey/setupKeyless`。
**删除**:`ssh:connect`(外部 cmd 弹窗,被 `term:connect` 替代)。

认证:密码用现有 `decPwd`(safeStorage)/密钥用现有 `defaultKeyPath()`(id_ed25519)。`conn.connect({host, port, username, password?, privateKey?})`。

### `preload/preload.cjs`
新增 API(都走 `ipcRenderer.invoke`,回调类用 `ipcRenderer.on`):
```
ssh.term = { connect, input, resize, disconnect, onData(cb), onClosed(cb) }
ssh.sftp = { listRemote, upload, download, mkdir, onProgress(cb) }
ssh.local = { list, pickFile, pickDir }
```
保留 `ssh.list/save/delete/copyCmd/genKey/publicKey/setupKeyless`。

### `src/tools/ssh.js`(重写 UI)
布局:`左主机列表(窄) | 右工作区`
- **无标签时**:右工作区显示主机编辑表单(原样保留:名称/地址/端口/用户/认证方式/密码/备注 + 保存/删除/生成密钥/配密钥)。
- **点主机「连接」**:开新标签,右工作区切到标签视图。
  - 顶部:标签栏(每个标签 = `主机名 ✕`,可切/可关)+ 「终端 / 文件」子标签切换。
  - 终端子标签:xterm.js 实例。
    - 每个 tab 一个 `Terminal` + `FitAddon`,`open` 到各自隐藏容器,active 的显示。
    - `onData -> store.term.input(tabId, data)`;`onOutput 流 -> terminal.write`;`onResize -> store.term.resize`。
    - 顶栏:主机名 + 「断开」。
  - 文件子标签:SFTP 双栏。
    - 左栏:本地目录(路径栏 + 列表,`ssh.local.list`)。
    - 右栏:远程目录(路径栏 + 列表,`ssh.sftp.listRemote`)。
    - 拖拽:本地项拖到右栏 = 上传;远程项拖到左栏 = 下载。进度在底部状态条。
    - 双击目录进入;双击文件下载;右键菜单(可选,MVP 先不做)。

### 依赖 `package.json`
- `ssh2`(dependencies,主进程)
- `@xterm/xterm` + `@xterm/addon-fit`(dependencies,渲染层;vite 打包)

### 样式 `src/styles.css`
- 标签栏、终端容器(黑底)、SFTP 双栏(两列等宽 + 拖拽高亮)、状态条。

## 分阶段
1. **内嵌多标签终端**(核心):装依赖 + main.cjs term handlers + preload + ssh.js xterm 多标签。
2. **SFTP 双栏 + 拖拽**:main.cjs sftp/local handlers + preload + ssh.js 文件子标签双栏拖拽。

一次做完两端,验证分阶段跑。

## 风险/约束
- ssh2 `cpu-features` 国内装可能失败,但属 `optionalDependencies`,失败不阻断 `ssh2` 本体安装,降级纯 JS。
- xterm 多实例内存:正常(几个 tab 无感)。
- 拖拽:HTML5 drag/drop 跨栏传路径,拖到目录要递归上传(MVP 先单文件,目录拖拽递归留后续)。
- 打包:ssh2 在 asar 主进程 require;若 `cpu-features` 装上有 `.node` 需 electron-rebuild,装不上降级无 `.node`。验证时确认。
- 不硬编码地址/凭据:复用 ssh-hosts.json + safeStorage。
- 日志不输出密码:conn.connect 不打印 password/privateKey。

## 验证
1. `NO_PROXY=* npm install ssh2 @xterm/xterm @xterm/addon-fit --registry=https://registry.npmmirror.com`
2. 改代码。
3. `npm run dev`:连一台 SSH 服务器 -> 终端能敲命令、resize 自适应、断开;开第二台 -> 多标签切换。
4. 文件子标签:左栏浏览本地、右栏浏览远程、拖拽上传/下载、进度显示。
5. `npm run dist -- --dir` 打包 win-unpacked,确认 ssh2/xterm 正常加载无原生报错。

## 改动文件清单
- `toolbox/package.json`(加依赖)
- `toolbox/electron/main.cjs`(加 ssh2,删 ssh:connect,加 term/sftp/local handlers)
- `toolbox/preload/preload.cjs`(加 term/sftp/local API)
- `toolbox/src/tools/ssh.js`(重写:多标签终端 + 双栏 SFTP)
- `toolbox/src/styles.css`(标签栏 + 终端 + SFTP 样式)

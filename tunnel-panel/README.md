# 内网穿透面板

输入本地地址，一键生成 Cloudflare / cpolar 公网映射。

访问地址：http://localhost:5760

## 目录说明

| 文件 | 用途 |
|------|------|
| `setup-docker.bat` | 一键 Docker 启动（推荐） |
| `start-local.bat` | 本机 Python 启动（开发用） |
| `tunnel.bat` | 命令行 Cloudflare 临时穿透 |
| `tunnel.ps1` | `tunnel.bat` 脚本 |
| `.env` | cpolar Token 配置 |
| `app.py` | Web 面板后端 |
| `docker-compose.cli.yml` | 纯命令行 cloudflared（可选） |

## 快速开始

### Docker（推荐）

1. 双击 `setup-docker.bat`
2. 若提示，在 `.env` 填写 `CPOLAR_AUTHTOKEN`（[cpolar 控制台](https://dashboard.cpolar.com) 验证页）
3. 打开 http://localhost:5760

也可由 mytools 根目录统一启动：

```bash
cd mytools
docker compose up -d --build mytools-tunnel-panel
```

### 命令行 Cloudflare

```bat
tunnel.bat 8080
tunnel.bat 52262
```

## cpolar 配置

复制 `.env.example` 为 `.env`：

```env
CPOLAR_AUTHTOKEN=你的token
CPOLAR_REGION=cn_vip
```

修改后重启容器：

```bash
cd mytools
docker compose restart mytools-tunnel-panel
```

## 宿主机 localhost 说明

面板在 **Docker** 里运行时，你填 `http://localhost:52262` 就是指 **Windows 宿主机**上的服务。

容器内不能写 `127.0.0.1`（那是容器自己），所以会自动转成 `host.docker.internal:52262`——这就是访问你宿主机 localhost 的正确方式，**不是**转到某个 Docker 容器。

```
外网用户 → cpolar/Cloudflare → 面板容器 → host.docker.internal:52262 → 你宿主机 localhost:52262
```

若用 `start-local.bat` 在本机直接跑面板（不用 Docker），则直接用 `127.0.0.1`，无需 `host.docker.internal`。

## 注意

- Docker 模式下 `localhost` 会自动转为宿主机 `host.docker.internal`
- 工具聚合页端口是 **8080**，不是 80
- API 类服务需在客户端配置 Base URL + API Key
- 使用 Clash 等代理时，建议关闭 TUN 模式

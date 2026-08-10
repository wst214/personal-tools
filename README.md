# My Tools



本机个人工具集，统一通过 Docker Compose 管理。Compose 项目名使用 `mytools-stack`，服务/容器/镜像名使用 `mytools-<tool-name>`，这样 Docker Desktop 会完整显示工具名。



## 容器命名规范

mytools 下所有 Docker Compose 服务、容器和镜像统一使用：`mytools-<tool-name>`。例如：`mytools-linux-remote-panel`、`mytools-ops-panel`、`mytools-personal-dev-site`。Compose 项目名固定为 `mytools-stack`，用于避免 Docker Desktop 折叠 `mytools-` 前缀。新增工具时不要使用裸名称或随机名称；服务名也不要以 `mytools-stack-` 开头，否则 Desktop 会折叠成短名（例如 `mytools-stack-panel` 会显示成 `panel`）。

## 工具列表



| 工具 | 地址 | 说明 |

|------|------|------|

| 个人开发工作台 | http://localhost:8090 | WST Lab 工具入口与状态概览 |

| Stack 运维面板 | http://localhost:5770 | 本机 Docker 打包、构建镜像与容器重启 |

| Linux 远程面板 | http://localhost:5757 | Web 界面 SSH 执行常用命令 |

| 内网穿透面板 | http://localhost:5760 | 见 [tunnel-panel/README.md](tunnel-panel/README.md) |

| PERF 压测操作台 | http://localhost:8100 | Compose 项目 `leidian-tools`，目录 `leidian-perf-web` |

| 功能测试操作台 | http://localhost:8200 | Compose 项目 `leidian-tools`，目录 `leidian-func-web` |

| 雷电设备工具台 | http://localhost:9000 | 独立 Compose 项目，目录 `leidian-protocol-parse` |

| New API | http://localhost:5780 | 多上游 LLM 统一转发（`mytools-new-api`，SQLite） |



## 启动 / 停止

**推荐（Windows 一键）：** 双击 `start-all.bat`，会同时启动 Docker 容器和 WSL 助手（后台运行，无需留窗口）。

```bash

cd mytools

docker compose up -d --build   # 仅启动 Docker 容器

docker compose down            # 停止容器

docker compose logs -f         # 查看日志

```

仅启动 WSL 助手（Linux 远程面板的本地 WSL 功能需要）：

```powershell

cd mytools\wsl-helper

.\start.ps1              # 前台运行，需保持窗口

.\start.ps1 -Background  # 后台运行（start-all.bat 使用此方式）

```

**开机自启（推荐，只需配置一次）：** 登录 Windows 后自动后台启动 WSL 助手，重启电脑后不用再双击 `start-all.bat`。

```powershell

cd mytools\wsl-helper

.\install-autostart.ps1    # 安装开机自启

.\uninstall-autostart.ps1  # 取消开机自启

```

Docker 容器会在 Docker Desktop 启动后自动恢复（`restart: unless-stopped`）。请在 Docker Desktop 设置里勾选 **Start Docker Desktop when you log in**。



## 数据持久化



- `mytools-linux-remote-panel`：卷 `mytools_linux-remote-data`（自定义命令、连接配置）




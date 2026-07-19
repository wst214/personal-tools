# Stack 运维面板

本机 Docker Compose 打包、构建镜像、重启容器与查看日志的可视化面板，UI 风格与 [personal-dev-site](../personal-dev-site) / WST Lab 工作台一致。

## 功能

- 管理 **MyTools 主栈**（工作台、远程面板、隧道面板、本面板）
- 管理 **PERF 压测操作台** 与 **雷电设备工具台** 独立 Compose 项目
- 单服务 / 整栈：构建、启动、重启、停止、拉取镜像、查看日志
- 实时输出命令执行日志

## Docker 启动（推荐）

在 **mytools** 根目录：

```bash
docker compose up --build -d mytools-ops-panel
```

或双击 `run-docker.bat`。

浏览器访问：**http://localhost:5770**

> 面板容器会挂载 Docker Socket 与 mytools 工作区，以便在宿主机上执行 `docker compose`。

## 本机直接运行

需本机已安装 Docker Desktop 与 Python 3.12+：

```powershell
cd mytools\stack-panel
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:MYTOOLS_ROOT = (Resolve-Path ..).Path
python app.py
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `MYTOOLS_ROOT` | 上级目录 | mytools 根路径 |
| `LEIDIAN_BACKEND_ROOT` | `D:/workspace/leidian/leidian-backend` | 雷电后端仓库路径（只读挂载到面板容器） |
| `STACK_PANEL_PORT` | `5770` | 面板监听端口 |

雷电 P0 五个服务（gateway / system / data / biz / task）通过 `LEIDIAN_BACKEND_ROOT` 引用原项目 Compose，**不修改** leidian 仓库内任何文件。

构建模式（面板内可选，默认「本机构建」）：

| 模式 | 行为 |
|------|------|
| 本机构建 | 叠 `docker-compose.local-build.yml` 构建镜像；需先执行「Maven 打包」生成 system/data/biz 的 JAR |
| 容器构建 | 只用主 `docker-compose.yml`，Dockerfile 内完整 Maven |

`LEIDIAN_BACKEND_HOST_PATH` 必须是 Docker Desktop 能挂载的宿主机路径（默认 `D:/workspace/leidian/leidian-backend`），供 Maven 容器写入 `target/`。

## 新增 Compose 项目

编辑 `stacks_config.py` 中的 `STACKS` 列表即可。

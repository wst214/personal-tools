# 服务器系统更新工具

面向 Docker Compose 系统的通用更新面板：按环境配置连接服务器，把镜像构建、打包上传、远端加载、可选配置同步/数据库迁移、服务重启和健康检查串成可选择、可追踪的步骤。

默认提供“雷电当前环境”模板。页面上只保留会变的内容，Compose、`.env`、镜像包目录和远端部署路径都走默认值，不再单独展示。

## 使用方式

1. 打开 `http://localhost:5770`，保存环境配置；密码、私钥口令和 sudo 密码会被遮罩，只保存在 `stack-panel/data/environments.json`（已被 Git 忽略）。
2. 选择本次要更新的一个或多个服务。业务镜像会按服务分别保存为 `exports/leidian-*-image.tar` 并上传；`db-migration` 默认不勾选。
3. 先执行“仅检查环境”，确认本机 Docker、SSH 和远端可用性。
4. 按需勾选更新步骤。默认不同步 Compose/.env，也不执行迁移；发生环境参数、编排或迁移变更时才勾选对应步骤。
5. 查看每个步骤的成功/失败状态与完整日志；失败后修复问题，再从需要的步骤继续。

## 本机运行

```powershell
cd D:\mytools\stack-panel
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

## Docker 运行

在 `D:\mytools`：

```powershell
docker compose up --build -d mytools-ops-panel
```

页面中的“本地项目目录”可以填写电脑上的 Windows 路径。容器默认把 `D:/workspace/leidian/leidan-pgsql` 挂载到 `/deploy-project`，面板会自动映射到容器内路径。如项目目录不同，在 `D:\mytools\.env` 中设置：

```dotenv
LEIDIAN_DEPLOY_PROJECT_HOST_PATH=D:/your/project
```

面板容器包含 Docker CLI、Maven 和 JDK，用于本地构建镜像；远端 SSH 通过 Paramiko 连接。

## 安全边界

- 不会自动连接、上传或重启服务器；只有点击“仅检查环境”或“执行所选步骤”才会操作远端。
- 密码和口令不会出现在 API 响应、页面回显或任务日志中。
- 首次 SSH 会接受服务器主机指纹；生产环境建议限制面板所在机器的访问权限。

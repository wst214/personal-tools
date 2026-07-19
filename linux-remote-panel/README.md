# Linux 远程面板



Web 版 SSH 工具：终端、快捷命令、文件管理、系统监控。UI 风格与工具聚合页一致。



## 功能



- **SSH 连接**：密码或私钥，支持保存快捷配置

- **终端**：清晰命令行输出，↑↓ 历史，Enter 执行

- **快捷命令**：9 大类 50+ 常用命令，点击填入终端（不自动执行）

- **文件管理**：浏览、上传、下载、删除远程文件

- **系统监控**：一键刷新主机名、负载、内存、磁盘、Docker 快照

- **本地 WSL**：一键打开 WSL 终端、启动 SSH、连接本机 WSL



## 访问



http://localhost:5757



## Docker 启动



```bash

cd mytools

docker compose up -d --build linux-remote-panel

```



## 连接本机 WSL（Docker 部署）



面板跑在 Docker 里时，连本机 WSL 不能填 `127.0.0.1`，应填 `host.docker.internal`。



### 1. 一次性准备（WSL 内）



```bash

sudo apt update

sudo apt install -y openssh-server

sudo service ssh start

```



### 2. 启动 WSL 助手（Windows 本机，保持窗口开着）



```powershell

cd d:\workspace\cursor_workspace\mytools\wsl-helper

.\start.ps1

```



助手监听 `http://127.0.0.1:5758`，供 Docker 容器调用。



### 3. 在面板里操作



左侧 **本地 WSL** 区域：

- **一键连接 WSL**：自动启动 SSH 并连接（推荐，点一下即可）
- **启动 SSH**：只唤醒 WSL 并启动 sshd，不连接面板
- **打开本地终端**：弹出 Windows 里的 WSL 命令行窗口

本地凭据写在 `config/wsl.defaults.json`（已 gitignore，不会提交到仓库），Docker 会挂载到容器内。

```json
{
  "host": "host.docker.internal",
  "port": 22,
  "username": "你的WSL用户名",
  "password": "你的WSL密码"
}
```

复制 `config/wsl.defaults.example.json` 为 `wsl.defaults.json` 后修改即可。



## 私钥挂载



`docker-compose.yml` 已将 `%USERPROFILE%\.ssh` 只读挂载到容器 `/ssh-keys`。  

私钥路径可填 `C:\Users\你\.ssh\id_rsa` 或仅文件名 `id_rsa`。



## 自定义命令



- 页面内「+ 自定义命令」添加

- 或编辑 `config/default_commands.json`


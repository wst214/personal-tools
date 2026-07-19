# DevTool Gallery

个人开发工具作品集静态站点，展示 Linux 远程面板等工具规划与入口。

## 本地预览

直接用浏览器打开 `index.html`，或在目录下启动静态服务：

```bash
cd mytools/personal-dev-site
python -m http.server 8090
```

访问 http://localhost:8090

## Docker 启动

在 **mytools** 根目录：

```bash
cd mytools
docker compose up --build -d mytools-personal-dev-site
```

或双击 `run-docker.bat`。

浏览器访问：**http://localhost:8090**

## 内容维护

- `index.html` / `styles.css` / `app.js`：页面结构与交互
- `content-plan.md`：站点规划
- `assets/xiaohei/`：插画资源

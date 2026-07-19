# 独立设备协议解析小工具

这个目录是独立小工具，不加入后端 Maven 多模块，也不依赖 Spring 服务启动。它可以直接粘贴防雷设备协议 HEX 报文，解析出设备类型、地址、命令、CRC、业务字段。

## Docker 部署

构建镜像：

```bash
docker build -t leidian-tool .
```

运行容器：

```bash
docker run --rm -p 9000:9000 -e PORT=9000 leidian-tool
```

或使用 Compose（推荐，含 MinIO 预签名环境变量）：

```bash
cd ../tools/leidian-protocol-parse              # 从 leidian-backend 根目录
# 或 cd leidian-protocol-parse                  # 已在 tools 目录下时
docker compose up -d --build
```

访问：

```text
http://localhost:9000
```

预签名 URL 默认使用 **`http://localhost:19000`**（供宿主机浏览器打开）。勿用 `host.docker.internal` 作为 URL 主机名。可通过 `LEIDIAN_MINIO_BROWSER_ENDPOINT` 覆盖。

## MinIO Webhook 测试（工具台 Tab）

网页第三个 Tab **「MinIO Webhook」** 内置接收器，用于本地验证 MinIO 上传通知（与 `device-file-uploaded` Kafka 消息体同为事件 JSON）。

| 运行方式 | MinIO `notify_webhook` endpoint |
|----------|----------------------------------|
| 本机 `.\web.ps1`（默认 8099） | `http://host.docker.internal:8099/minio-test` |
| Docker Compose（端口 9000） | `http://leidian-tool:9000/minio-test` |

配置后向 `uploads/` 前缀上传文件，在 Tab 页 **历史记录** 中点击展开查看 POST JSON。服务重启后记录清空。

修改 `web/` 后若用 Docker，需执行：`docker compose up -d --build`。

## 网页使用

```powershell
.\web.ps1
```

浏览器打开 `http://localhost:8099`，在文本框里粘贴协议内容即可解析。

换端口：

```powershell
.\web.ps1 --port=8100
```

## 命令行使用

```powershell
.\parse.ps1 "5A 4B 14 01 00 01 00 35 00 01 00 05 00 05 00 19 04 A4 06 1E 00 00 04 11 57 0D 0A"
```

Windows 如果禁止运行 `.ps1`，直接用 `parse.bat`：

```bat
parse.bat "5A 4B 14 01 00 01 00 35 00 01 00 05 00 05 00 19 04 A4 06 1E 00 00 04 11 57 0D 0A"
```

从文件读取：

```powershell
.\parse.ps1 -f .\sample.txt
```

## MinIO 预签名 URL

根据 raw 表 `dedup_key`（格式 `bucket:objectKey`）生成私有桶临时下载链接，与 data-service 预签名逻辑一致。

首次使用需安装依赖：

```powershell
cd ..\tools\leidian-protocol-parse              # 从 leidian-backend 根目录
npm install
```

命令行：

```powershell
.\presign.ps1 --dedup-key "leidian-device:uploads/device01/00010073/20260513/offset-7.json"
```

或：

```powershell
.\presign.ps1 --bucket leidian-device --object-key "uploads/device01/00010073/20260513/offset-7.json"
```

环境变量（与后端一致，可选）：

| 变量 | 说明 |
|------|------|
| `LEIDIAN_MINIO_ENDPOINT` | 默认 `http://localhost:19000` |
| `LEIDIAN_MINIO_ACCESS_KEY` | 默认 `minioadmin` |
| `LEIDIAN_MINIO_SECRET_KEY` | 默认 `minioadmin` |
| `LEIDIAN_MINIO_PRESIGN_EXPIRY_SECONDS` | 默认 `3600` |

网页：启动 `.\web.ps1` 或 Docker 后打开 http://localhost:9000 ，顶部 Tab 切换 **设备协议解析** / **预签名 URL**；预签名页各输入框可留空，将使用左侧内置样例与环境变量（`GET /api/presign/defaults`）。

API：`POST /api/presign`，JSON 体示例：

```json
{
  "dedupKey": "leidian-device:uploads/device01/00010073/20260513/offset-7.json",
  "endpoint": "http://localhost:19000",
  "expirySeconds": 3600
}
```

## 支持设备

- `01` 低误报雷暴预警仪
- `19` GPS版低误报雷暴预警仪
- `03` 接地电阻监测仪
- `0F` 智能监测型 iSPD / 智能防雷 PDU
- `05` 雷电流峰值监测仪
- `15` GPS版本雷电流智能监测仪
- `09` 智能断接卡
- `10` 定位仪远程监测控制终端
- `17` 电源控制板
- `14` 避雷器在线监测仪，支持 `0001` / `000A` / `0102`
- `18` SPD多重雷击波形监测，支持心跳帧和波形帧摘要

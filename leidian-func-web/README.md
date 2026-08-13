# 功能测试操作台（leidian-func-web）

本地工具：按模块维护功能测试用例，勾选后自动请求被测 HTTP 接口并用判定条件核对，逐条展示结果并保留历史。

## Docker 启动（推荐）

与 PERF 压测台同属 Compose 项目 **`leidian-tools`**。

```bash
cd D:\mytools\leidian-func-web
docker compose up -d --build
```

浏览器：http://127.0.0.1:8200/

容器访问本机被测服务时，在「环境」填写网关根地址用 `host.docker.internal`，例如：

`http://host.docker.internal:8080`

服务前缀默认：`/api/system`、`/api/data`、`/api/biz`、`/api/task`、`/api/v1/radar`、`/api/open`。
用例步骤用 `service: biz`（等）选择前缀；登录凭证走 system 前缀自动拼接。

停止本服务（不影响同项目下的 perf-web）：

```bash
docker compose stop func-web
# 或
docker compose rm -sf func-web
```

## 本地启动

```bash
pip install -r requirements.txt
python web/server.py
```

浏览器打开：http://127.0.0.1:8200/

## 测试

```bash
pip install -r requirements-dev.txt
python -m pytest tests/ -q
```

## 目录

- `web/` 操作台前端与本地控制服务
- 操作台一级能力：`预警规则管理` / `预警抑制管理` / `预警运行` / `设备解析接入` / `业务监测查询` / `闪电定位接入` / `雷达回波接入`
  - 规则侧二级含：配置流转 + 因子 + 回测（目录仍为 `warn-rule-*` / `warn-factor-*` / `warn-backtest-*`）
  - 运行侧二级含：生成评估/事件 + 通知（目录仍为 `warn-gen-*` / `warn-notify-*`）
  - 设备解析侧二级含：烟测 / Monitor / 附件映射 / 全链路；执行页可按全部设备类型多选过滤（默认全选）
  - 业务监测查询：biz 列表与详情（`device-monitor-query`）；执行页同样可按设备类型展开
- `cases/warn-acceptance-inventory.md` 运行侧验收口径总表（按需求，默认 skip）
- `cases/device-ingest-inventory.md` 设备解析用例总清单（终态链路 + 全类型矩阵）
- `cases/device-monitor-inventory.md` 业务监测列表/详情总清单
- `cases/*-inventory.md` 各域用例总清单
- `data/` 环境配置与跑批历史（Docker volume 挂载）

说明：执行引擎支持 HTTP 与 Kafka 投递。设备 CRC/粘包/拒收/低质与雷电未来时间/低质/去重等 e2e 已可跑；设备幂等（di-61）因后端无 dedup 仍 skip。低质断言依赖 data-service `GET /ingest/clean-logs/recent`。

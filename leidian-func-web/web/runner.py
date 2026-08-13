"""执行引擎：按用例步骤发 HTTP，并用判定条件核对。"""
from __future__ import annotations

import json
import re
import threading
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from datetime import datetime, timezone

from env_store import assert_credential_runnable, load_env, resolve_step_url
from case_store import (
    DEVICE_TYPES,
    LIGHTNING_NETWORKS,
    device_has_biz_query,
    device_has_hex_fixture,
    expand_device_run_units,
    get_case,
)
from history_store import save_run

_run_lock = threading.Lock()
_progress_lock = threading.Lock()
_busy = False
_progress: dict[str, Any] = {
    "busy": False,
    "phase": "idle",  # idle | running | done | error
    "total": 0,
    "done": 0,
    "currentCaseId": "",
    "currentName": "",
    "results": [],
    "summary": {"total": 0, "passed": 0, "failed": 0, "skipped": 0},
    "run": None,
    "error": "",
    "startedAt": "",
}


def is_busy() -> bool:
    return _busy


def get_progress() -> dict[str, Any]:
    with _progress_lock:
        return {
            "busy": _progress["busy"],
            "phase": _progress["phase"],
            "total": _progress["total"],
            "done": _progress["done"],
            "currentCaseId": _progress["currentCaseId"],
            "currentName": _progress["currentName"],
            "results": list(_progress["results"]),
            "summary": dict(_progress["summary"]),
            "run": _progress["run"],
            "error": _progress["error"],
            "startedAt": _progress["startedAt"],
        }


def _set_progress(**kwargs: Any) -> None:
    with _progress_lock:
        _progress.update(kwargs)


def _summary_of(results: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "total": len(results),
        "passed": sum(1 for r in results if r.get("status") == "passed"),
        "failed": sum(1 for r in results if r.get("status") == "failed"),
        "skipped": sum(1 for r in results if r.get("status") == "skipped"),
    }


# 与 data-service DeviceRawAttachmentPackService 高频档对齐（电场 01/19）
_HIGH_FREQ_DEVICE_TYPES = frozenset({"ATMOSPHERE_ELECTRIC_FIELD"})


def start_batch(
    case_refs: list[dict[str, str]],
    device_types: list[str] | None = None,
    networks: list[str] | None = None,
) -> dict[str, Any]:
    """异步启动跑批，立即返回进度快照；前端轮询 get_progress。

    expandByDeviceType 的用例会按 device_types（默认目录全量）展开为多条执行实例。
    """
    global _busy
    if not case_refs:
        raise ValueError("未选择用例")
    env = load_env()
    if not (env.get("gateway") or env.get("baseUrl")):
        raise ValueError("未配置网关根地址")
    assert_credential_runnable(str(env.get("credential") or ""))
    expanded = expand_case_refs(case_refs, device_types, networks)
    if not expanded:
        raise ValueError("按当前设备类型筛选后没有可执行实例（请至少选择一种设备类型）")
    if not _run_lock.acquire(blocking=False):
        raise RuntimeError("已有跑批进行中")
    if _busy:
        _run_lock.release()
        raise RuntimeError("已有跑批进行中")

    _busy = True
    started = datetime.now(timezone.utc).isoformat()
    _set_progress(
        busy=True,
        phase="running",
        total=len(expanded),
        done=0,
        currentCaseId="",
        currentName="",
        results=[],
        summary={"total": len(expanded), "passed": 0, "failed": 0, "skipped": 0},
        run=None,
        error="",
        startedAt=started,
    )
    thread = threading.Thread(
        target=_run_batch_worker,
        args=(list(expanded), started),
        daemon=True,
        name="func-web-run-batch",
    )
    thread.start()
    return get_progress()


def expand_case_refs(
    case_refs: list[dict[str, str]],
    device_types: list[str] | None,
    networks: list[str] | None = None,
) -> list[dict[str, Any]]:
    """将通用用例按所选设备类型展开；非展开用例原样保留。"""
    by_id = {t["id"]: t for t in DEVICE_TYPES}
    selected_ids = [str(x).strip() for x in (device_types or []) if str(x).strip()]
    if not selected_ids:
        selected_ids = [t["id"] for t in DEVICE_TYPES]
    selected = [by_id[i] for i in selected_ids if i in by_id]
    if not selected:
        selected = list(DEVICE_TYPES)

    out: list[dict[str, Any]] = []
    for ref in case_refs:
        module = str(ref.get("module") or "")
        case_id = str(ref.get("id") or "")
        if not module or not case_id:
            continue
        case = get_case(module, case_id)
        # 雷电三网展开(expandByNetwork)
        if case.get("expandByNetwork"):
            net_ids = [str(x).strip() for x in (networks or []) if str(x).strip()]
            all_nets = list(LIGHTNING_NETWORKS)
            if not net_ids:
                net_ids = [n["id"] for n in all_nets]
            nets = [n for n in all_nets if n["id"] in net_ids]
            if not nets:
                out.append(
                    {
                        "module": module,
                        "id": case_id,
                        "skipOverride": True,
                        "skipReason": "当前未选择网络，已跳过展开",
                    }
                )
                continue
            for n in nets:
                out.append(
                    {
                        "module": module,
                        "id": case_id,
                        "network": n["id"],
                        "networkName": n["name"],
                        "bizPath": n.get("bizPath") or "",
                        "otherBizPath": n.get("otherBizPath") or "",
                        "recentPath": n.get("recentPath") or "",
                        "kafkaTopic": n.get("kafkaTopic") or "",
                        "kafkaJson": n.get("kafkaJson") or "",
                        "kafkaJsonDedup": n.get("kafkaJsonDedup") or "",
                        "kafkaJsonFuture": n.get("kafkaJsonFuture") or "",
                        "kafkaJsonLowQuality": n.get("kafkaJsonLowQuality") or "",
                        "fixedStrikeId": n.get("fixedStrikeId") or "",
                        "lowQualityRuleCode": n.get("lowQualityRuleCode") or "",
                    }
                )
            continue
        if not case.get("expandByDeviceType"):
            out.append({"module": module, "id": case_id})
            continue
        types = selected
        if case.get("expandRequiresBiz"):
            types = [t for t in types if device_has_biz_query(t)]
            if not types:
                out.append(
                    {
                        "module": module,
                        "id": case_id,
                        "skipOverride": True,
                        "skipReason": "当前所选设备类型均无业务列表接口，已跳过展开",
                    }
                )
                continue
        for t in types:
            units = expand_device_run_units(t)
            if case.get("expandRequiresBiz"):
                units = [u for u in units if u.get("bizPath")]
                if not units:
                    out.append(
                        {
                            "module": module,
                            "id": case_id,
                            "deviceType": t["id"],
                            "deviceTypeName": t["name"],
                            "bizPath": "",
                            "detailPath": "",
                            "skipOverride": True,
                            "skipReason": f"{t['id']} 无业务列表接口（如 SPD 心跳），已跳过",
                        }
                    )
                    continue
            if case.get("expandRequiresDeviceHex") and not device_has_hex_fixture(t):
                # 勾选了就必须有夹具：缺失时显式 skip，禁止静默丢掉
                out.append(
                    {
                        "module": module,
                        "id": case_id,
                        "deviceType": t["id"],
                        "deviceTypeName": units[0]["deviceTypeName"] if units else t["name"],
                        "bizPath": t.get("bizPath") or "",
                        "detailPath": t.get("detailPath") or "",
                        "deviceHex": "",
                        "skipOverride": True,
                        "skipReason": f"已勾选 {t['id']} 但未配置 deviceHex 夹具",
                    }
                )
                continue
            for unit in units:
                hex_ok = bool(str(unit.get("deviceHex") or "").strip())
                if case.get("expandRequiresDeviceHex") and not hex_ok:
                    out.append(
                        {
                            "module": module,
                            "id": case_id,
                            "deviceType": unit["deviceType"],
                            "deviceTypeName": unit["deviceTypeName"],
                            "bizPath": unit.get("bizPath") or "",
                            "detailPath": unit.get("detailPath") or "",
                            "deviceHex": "",
                            "skipOverride": True,
                            "skipReason": f"已勾选 {t['id']} 变体 {unit['deviceType']} 但未配置 deviceHex 夹具",
                        }
                    )
                    continue
                out.append(
                    {
                        "module": module,
                        "id": case_id,
                        "deviceType": unit["deviceType"],
                        "deviceTypeName": unit["deviceTypeName"],
                        "bizPath": unit.get("bizPath") or "",
                        "detailPath": unit.get("detailPath") or "",
                        "deviceHex": unit.get("deviceHex") or "",
                    }
                )
    return out


def run_batch(
    case_refs: list[dict[str, str]],
    device_types: list[str] | None = None,
) -> dict[str, Any]:
    """同步跑批（兼容脚本/测试）；也会更新进度快照。"""
    start_batch(case_refs, device_types)
    while True:
        snap = get_progress()
        if snap["phase"] in ("done", "error") and not snap["busy"]:
            if snap["phase"] == "error":
                raise RuntimeError(snap.get("error") or "跑批失败")
            run = snap.get("run")
            if not isinstance(run, dict):
                raise RuntimeError("跑批未生成结果")
            return run
        threading.Event().wait(0.05)


def _run_batch_worker(case_refs: list[dict[str, Any]], started_at: str) -> None:
    global _busy
    results: list[dict[str, Any]] = []
    try:
        env = load_env()
        credential = env.get("credential") or ""
        vars_ctx: dict[str, Any] = {}
        for idx, ref in enumerate(case_refs):
            module = ref["module"]
            case_id = ref["id"]
            case = get_case(module, case_id)
            dtype = str(ref.get("deviceType") or "")
            dtype_name = str(ref.get("deviceTypeName") or "")
            network = str(ref.get("network") or "")
            network_name = str(ref.get("networkName") or "")
            display_id = f"{case_id}@{dtype}" if dtype else (f"{case_id}@{network}" if network else case_id)
            display_name = (
                f"{case.get('name') or case_id} · {dtype_name}" if dtype_name
                else (f"{case.get('name') or case_id} · {network_name}" if network_name else (case.get("name") or case_id))
            )
            _set_progress(
                currentCaseId=display_id,
                currentName=str(display_name),
                done=idx,
            )
            local_vars = dict(vars_ctx)
            if dtype:
                local_vars["deviceType"] = dtype
                local_vars["monitorType"] = dtype
                local_vars["deviceTypeName"] = dtype_name
                local_vars["bizPath"] = str(ref.get("bizPath") or "")
                local_vars["detailPath"] = str(ref.get("detailPath") or "")
                local_vars["deviceHex"] = str(ref.get("deviceHex") or "")
                # 电场等高频原文攒包默认 60s 才刷 MinIO；E2E 等待须盖过该间隔
                local_vars["waitSeconds"] = (
                    "70" if dtype in _HIGH_FREQ_DEVICE_TYPES else "5"
                )
            if network:
                local_vars["network"] = network
                local_vars["networkName"] = str(ref.get("networkName") or "")
                local_vars["bizPath"] = str(ref.get("bizPath") or "")
                local_vars["otherBizPath"] = str(ref.get("otherBizPath") or "")
                local_vars["recentPath"] = str(ref.get("recentPath") or "")
                local_vars["kafkaTopic"] = str(ref.get("kafkaTopic") or "")
                local_vars["kafkaJson"] = str(ref.get("kafkaJson") or "")
                local_vars["kafkaJsonDedup"] = str(ref.get("kafkaJsonDedup") or "")
                local_vars["kafkaJsonFuture"] = str(ref.get("kafkaJsonFuture") or "")
                local_vars["kafkaJsonLowQuality"] = str(ref.get("kafkaJsonLowQuality") or "")
                local_vars["fixedStrikeId"] = str(ref.get("fixedStrikeId") or "")
                local_vars["lowQualityRuleCode"] = str(ref.get("lowQualityRuleCode") or "")
            if ref.get("skipOverride"):
                case = dict(case)
                case["skip"] = True
                case["skipReason"] = ref.get("skipReason") or case.get("skipReason") or ""
            one = _run_one(case, env, credential, local_vars)
            if dtype:
                one["caseId"] = case_id
                one["instanceId"] = display_id
                one["name"] = display_name
                one["deviceType"] = dtype
            if network:
                one["caseId"] = case_id
                one["instanceId"] = display_id
                one["name"] = display_name
                one["network"] = network
                one["networkName"] = network_name
            results.append(one)
            _set_progress(
                done=idx + 1,
                results=list(results),
                summary=_summary_of(results),
            )
        run = save_run(results, started_at=started_at)
        _set_progress(
            phase="done",
            busy=False,
            currentCaseId="",
            currentName="",
            results=list(results),
            summary=run.get("summary") or _summary_of(results),
            run=run,
            error="",
        )
    except Exception as ex:  # noqa: BLE001
        _set_progress(
            phase="error",
            busy=False,
            currentCaseId="",
            currentName="",
            results=list(results),
            summary=_summary_of(results),
            run=None,
            error=str(ex),
        )
    finally:
        _busy = False
        _run_lock.release()


def _run_one(
    case: dict[str, Any],
    env: dict[str, Any],
    credential: str,
    vars_ctx: dict[str, Any],
) -> dict[str, Any]:
    case_id = case.get("id")
    name = case.get("name") or case_id
    if case.get("skip"):
        return {
            "caseId": case_id,
            "name": name,
            "module": case.get("module"),
            "status": "skipped",
            "reason": case.get("skipReason") or "用例标记为跳过",
            "steps": [],
        }
    if not (env.get("gateway") or env.get("baseUrl")):
        return {
            "caseId": case_id,
            "name": name,
            "module": case.get("module"),
            "status": "failed",
            "reason": "未配置网关根地址",
            "steps": [],
        }

    _ensure_radar_frame_vars(case, vars_ctx)

    step_results: list[dict[str, Any]] = []
    for idx, step in enumerate(case.get("steps") or []):
        skip_if_empty = step.get("skipIfEmpty") or []
        if isinstance(skip_if_empty, str):
            skip_if_empty = [skip_if_empty]
        if isinstance(skip_if_empty, list) and skip_if_empty:
            missing = [
                str(v)
                for v in skip_if_empty
                if vars_ctx.get(str(v)) is None or str(vars_ctx.get(str(v))).strip() == ""
            ]
            if missing:
                title = describe_step_action(
                    str(step.get("method") or "GET").upper(),
                    str(step.get("path") or ""),
                    step,
                )
                step_results.append(
                    {
                        "index": idx,
                        "method": str(step.get("method") or "GET").upper(),
                        "path": _render(str(step.get("path") or ""), vars_ctx),
                        "service": str(step.get("service") or ""),
                        "title": title,
                        "action": title,
                        "status": "skipped",
                        "reason": f"变量为空已跳过: {', '.join(missing)}",
                        "httpStatus": None,
                        "body": None,
                    }
                )
                continue
        sr = _run_step(step, env, credential, vars_ctx, idx)
        step_results.append(sr)
        if sr.get("status") == "failed":
            return {
                "caseId": case_id,
                "name": name,
                "module": case.get("module"),
                "status": "failed",
                "reason": sr.get("reason") or "判定条件未满足",
                "steps": step_results,
            }
        # capture 已在 _run_step 内基于完整响应写入 vars_ctx（避免 truncate 后丢字段）

    return {
        "caseId": case_id,
        "name": name,
        "module": case.get("module"),
        "status": "passed",
        "reason": "",
        "steps": step_results,
    }


def describe_step_action(method: str, path: str, step: dict[str, Any] | None = None) -> str:
    """把 HTTP 步骤翻成中文说明；用例 step.name / step.title 优先。"""
    if isinstance(step, dict):
        custom = str(step.get("name") or step.get("title") or "").strip()
        if custom:
            return custom

    m = (method or "GET").upper()
    if m == "SLEEP":
        return "等待消费落库"
    if m == "KAFKA":
        topic = str((step or {}).get("topic") or path or "topic")
        return f"Kafka 投递 {topic}"
    if m == "MINIO":
        key = str((step or {}).get("objectKey") or path or "object")
        return f"MinIO 上传 {key}"
    if m == "WS":
        return "WebSocket 等待推送"

    raw = str(path or "/")
    path_only = raw.split("?", 1)[0]
    # 归一化动态段，便于规则匹配
    norm = re.sub(r"/[0-9]{6,}", "/{id}", path_only)
    norm = re.sub(r"/[0-9a-fA-F-]{16,}", "/{id}", norm)

    rules: list[tuple[str, str, str]] = [
        # method, path_suffix_or_contains, title
        ("POST", r"^/warning/rules$", "新建预警规则草稿"),
        ("PUT", r"^/warning/rules/\{id\}$", "更新预警规则"),
        ("GET", r"^/warning/rules/\{id\}$", "查询预警规则详情"),
        ("DELETE", r"^/warning/rules/\{id\}$", "删除预警规则"),
        ("POST", r"^/warning/rules/\{id\}/submit$", "提交预警规则生效"),
        ("POST", r"^/warning/rules/\{id\}/disable$", "停用预警规则"),
        ("POST", r"^/warning/rules/\{id\}/enable$", "启用预警规则"),
        ("POST", r"^/warning/rules/\{id\}/approve$", "审核通过预警规则"),
        ("POST", r"^/warning/rules/\{id\}/reject$", "驳回预警规则"),
        ("POST", r"^/warning/rules/\{id\}/withdraw$", "撤回预警规则审核"),
        ("POST", r"^/warning/rules/\{id\}/test$", "对规则发起回测"),
        ("GET", r"^/warning/rules/\{id\}/test/", "查询规则回测结果"),
        ("GET", r"^/warning/rules$", "分页查询预警规则"),
        ("POST", r"^/warning/suppress$", "新建预警抑制草稿"),
        ("PUT", r"^/warning/suppress/\{id\}$", "更新预警抑制"),
        ("GET", r"^/warning/suppress/\{id\}$", "查询预警抑制详情"),
        ("DELETE", r"^/warning/suppress/\{id\}$", "删除预警抑制"),
        ("POST", r"^/warning/suppress/\{id\}/submit$", "提交预警抑制生效"),
        ("POST", r"^/warning/suppress/\{id\}/terminate$", "终止预警抑制"),
        ("POST", r"^/warning/suppress/\{id\}/approve$", "审核通过预警抑制"),
        ("POST", r"^/warning/suppress/\{id\}/reject$", "驳回预警抑制"),
        ("POST", r"^/warning/suppress/jobs/expire$", "触发抑制到期扫描"),
        ("GET", r"^/warning/suppress$", "分页查询预警抑制"),
        ("POST", r"^/warning/eval/dry-run$", "评估试跑（dry-run）"),
        ("POST", r"^/warning/eval/trigger$", "触发预警评估"),
        ("POST", r"^/warning/eval/jobs/advance-time$", "推进评估时间（测试）"),
        ("GET", r"^/warning/events/\{id\}$", "查询预警事件详情"),
        ("POST", r"^/warning/events/\{id\}/confirm$", "确认预警事件"),
        ("POST", r"^/warning/events/\{id\}/release$", "解除/关闭预警事件"),
        ("GET", r"^/warning/events$", "分页查询预警事件"),
        ("GET", r"^/warnings$", "查询占位预警列表"),
        ("GET", r"^/warning/notify/records/\{id\}$", "查询通知记录详情"),
        ("GET", r"^/warning/notify/records$", "分页查询通知记录"),
        ("GET", r"^/warning/notify/tasks$", "分页查询通知确认任务"),
        ("POST", r"^/warning/factors$", "新建预警因子（一期不开放）"),
        ("PUT", r"^/warning/factors/", "更新预警因子"),
        ("GET", r"^/warning/factors/by-code/", "按编码查询预警因子"),
        ("GET", r"^/warning/factors/options", "查询预警因子选项"),
        ("GET", r"^/warning/factors/", "查询预警因子详情"),
        ("GET", r"^/warning/factors$", "分页查询预警因子"),
        ("GET", r"^/ingest/attachment/refs$", "查询设备原文附件映射"),
        ("GET", r"^/ingest/attachment/presign$", "生成设备原文附件预签名"),
        ("GET", r"^/ingest/monitor/device/recent$", "查询设备 monitor 最近记录"),
        ("GET", r"^/ingest/device/status$", "查询设备接入统计"),
        ("GET", r"^/ingest/status$", "查询接入各层统计"),
    ]

    for rule_method, pattern, title in rules:
        if m != rule_method:
            continue
        if re.search(pattern, norm):
            # GET 列表带查询条件时补一句
            if "?" in raw and title.startswith("分页查询"):
                return title + "（带筛选条件）"
            return title

    # 兜底：按资源猜
    if "/warning/rules" in norm:
        resource = "预警规则"
    elif "/warning/suppress" in norm:
        resource = "预警抑制"
    elif "/warning/events" in norm or norm.endswith("/warnings"):
        resource = "预警事件"
    elif "/warning/notify" in norm:
        resource = "通知"
    elif "/warning/factors" in norm:
        resource = "预警因子"
    elif "/warning/eval" in norm:
        resource = "预警评估"
    else:
        resource = "接口"

    verb = {
        "GET": f"查询{resource}",
        "POST": f"调用{resource}写接口",
        "PUT": f"更新{resource}",
        "DELETE": f"删除{resource}",
        "PATCH": f"修改{resource}",
    }.get(m, f"请求{resource}")
    return verb


def _run_step(
    step: dict[str, Any],
    env: dict[str, Any],
    credential: str,
    vars_ctx: dict[str, Any],
    idx: int,
) -> dict[str, Any]:
    method = str(step.get("method") or "GET").upper()
    if method == "SLEEP":
        return _run_sleep_step(step, vars_ctx, idx)
    if method == "KAFKA":
        return _run_kafka_step(step, env, vars_ctx, idx)
    if method == "MINIO":
        return _run_minio_step(step, env, vars_ctx, idx)
    if method == "WS":
        return _run_ws_step(step, env, credential, vars_ctx, idx)

    path = _render(str(step.get("path") or "/"), vars_ctx)
    service = str(step.get("service") or "biz")
    expect = step.get("expect") or {}
    expect_status = expect.get("status")
    expect_fields = expect.get("fields") or {}
    title = describe_step_action(method, path, step)

    def result(**extra: Any) -> dict[str, Any]:
        base = {
            "index": idx,
            "method": method,
            "path": path,
            "service": service,
            "expectStatus": expect_status,
            "title": title,
            "action": f"{method} {path}",
        }
        base.update(extra)
        return base

    try:
        url = _encode_url_query(resolve_step_url(env, step, path))
    except ValueError as e:
        return result(status="failed", reason=str(e), httpStatus=None, body=None)

    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if credential:
        headers["Authorization"] = credential if credential.lower().startswith("bearer ") else f"Bearer {credential}"
    extra_headers = step.get("headers") or {}
    if isinstance(extra_headers, dict):
        headers.update({str(k): _render(str(v), vars_ctx) for k, v in extra_headers.items()})

    body_obj = step.get("body")
    data = None
    if body_obj is not None:
        rendered = _render_obj(body_obj, vars_ctx)
        data = json.dumps(rendered, ensure_ascii=False).encode("utf-8")

    try:
        req = Request(url, data=data, headers=headers, method=method)
        with urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            status = resp.status
            try:
                parsed: Any = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = raw
    except HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        status = e.code
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = raw
    except URLError as e:
        return result(status="failed", reason=f"请求失败: {e.reason}", httpStatus=None, body=None)
    except Exception as e:  # noqa: BLE001
        return result(status="failed", reason=f"请求异常: {e}", httpStatus=None, body=None)

    if expect_status is not None and int(status) != int(expect_status):
        return result(
            status="failed",
            reason=f"状态码不符: 期望 {expect_status} 实际 {status}",
            httpStatus=status,
            body=_truncate(parsed),
        )

    if isinstance(expect_fields, dict) and expect_fields:
        if not isinstance(parsed, dict):
            return result(
                status="failed",
                reason="响应不是 JSON 对象，无法核对判定条件字段",
                httpStatus=status,
                body=_truncate(parsed),
            )
        for field_path, expected in expect_fields.items():
            path_r = _render(str(field_path), vars_ctx)
            actual = _dig(parsed, path_r)
            expected_r = _render_obj(expected, vars_ctx)
            if isinstance(expected_r, str) and expected_r == "__not_empty__":
                if actual is None or actual == "" or actual == []:
                    return result(
                        status="failed",
                        reason=f"判定条件未满足: {path_r} 期望非空 实际 {actual!r}",
                        httpStatus=status,
                        body=_truncate(parsed),
                    )
                continue
            negate = False
            if isinstance(expected_r, str) and expected_r.startswith("!"):
                negate = True
                expected_r = expected_r[1:]
            if negate:
                if _values_equal(actual, expected_r):
                    return result(
                        status="failed",
                        reason=f"判定条件未满足(不应等于): {path_r} 实际 {actual!r}",
                        httpStatus=status,
                        body=_truncate(parsed),
                    )
            elif not _values_equal(actual, expected_r):
                return result(
                    status="failed",
                    reason=f"判定条件未满足: {path_r} 期望 {expected_r!r} 实际 {actual!r}",
                    httpStatus=status,
                    body=_truncate(parsed),
                )

    not_contains = expect.get("notContains") or []
    if isinstance(not_contains, dict):
        not_contains = [not_contains]
    if isinstance(not_contains, list) and not_contains:
        if not isinstance(parsed, dict):
            return result(
                status="failed",
                reason="响应不是 JSON 对象，无法核对 notContains",
                httpStatus=status,
                body=_truncate(parsed),
            )
        for rule in not_contains:
            if not isinstance(rule, dict):
                continue
            list_path = _render(str(rule.get("path") or "data"), vars_ctx)
            items = _dig(parsed, list_path)
            if not isinstance(items, list):
                continue
            match = rule.get("match")
            if isinstance(match, dict) and match:
                for item in items:
                    if isinstance(item, dict) and _dict_matches(item, match, vars_ctx):
                        return result(
                            status="failed",
                            reason=f"notContains 未满足: {list_path}[] 不应出现匹配 {match!r}",
                            httpStatus=status,
                            body=_truncate(parsed),
                        )
                continue
            field = _render(str(rule.get("field") or ""), vars_ctx)
            if rule.get("valueContains") is not None:
                needle = _render(str(rule.get("valueContains")), vars_ctx)
                if field and needle:
                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        hay = item.get(field)
                        if hay is not None and needle in str(hay):
                            return result(
                                status="failed",
                                reason=f"notContains 未满足: {list_path}[].{field} 不应包含 {needle!r}",
                                httpStatus=status,
                                body=_truncate(parsed),
                            )
                continue
            expected_r = _render_obj(rule.get("value"), vars_ctx)
            if field:
                for item in items:
                    if isinstance(item, dict) and _field_value_ok(item.get(field), expected_r):
                        return result(
                            status="failed",
                            reason=f"notContains 未满足: {list_path}[].{field} 不应出现 {expected_r!r}",
                            httpStatus=status,
                            body=_truncate(parsed),
                        )

    contains = expect.get("contains") or []
    if isinstance(contains, dict):
        contains = [contains]
    if isinstance(contains, list) and contains:
        if not isinstance(parsed, dict):
            return result(
                status="failed",
                reason="响应不是 JSON 对象，无法核对 contains",
                httpStatus=status,
                body=_truncate(parsed),
            )
        for rule in contains:
            if not isinstance(rule, dict):
                continue
            list_path = _render(str(rule.get("path") or "data"), vars_ctx)
            items = _dig(parsed, list_path)
            if not isinstance(items, list):
                return result(
                    status="failed",
                    reason=f"contains 未满足: {list_path} 不是列表",
                    httpStatus=status,
                    body=_truncate(parsed),
                )
            match = rule.get("match")
            if isinstance(match, dict) and match:
                if not any(isinstance(item, dict) and _dict_matches(item, match, vars_ctx) for item in items):
                    return result(
                        status="failed",
                        reason=f"contains 未满足: {list_path}[] 未找到匹配 {match!r}",
                        httpStatus=status,
                        body=_truncate(parsed),
                    )
                continue
            field = _render(str(rule.get("field") or ""), vars_ctx)
            expected_r = _render_obj(rule.get("value"), vars_ctx)
            if field and not any(
                isinstance(item, dict) and _field_value_ok(item.get(field), expected_r) for item in items
            ):
                return result(
                    status="failed",
                    reason=f"contains 未满足: {list_path}[].{field} 未出现 {expected_r!r}",
                    httpStatus=status,
                    body=_truncate(parsed),
                )

    # 必须在 truncate 之前从完整 JSON 捕获变量；超长响应 truncate 可能变成字符串
    capture = step.get("capture") or {}
    if isinstance(capture, dict) and isinstance(parsed, dict):
        for var_name, json_path in capture.items():
            vars_ctx[str(var_name)] = _dig(parsed, str(json_path))

    return result(status="passed", reason="", httpStatus=status, body=_truncate(parsed))


def _field_value_ok(actual: Any, expected_r: Any) -> bool:
    if isinstance(expected_r, str) and expected_r == "__not_empty__":
        return not (actual is None or actual == "" or actual == [])
    return _values_equal(actual, expected_r)


def _dict_matches(item: dict[str, Any], match: dict[str, Any], vars_ctx: dict[str, Any]) -> bool:
    for k, expected in match.items():
        expected_r = _render_obj(expected, vars_ctx)
        if not _field_value_ok(item.get(k), expected_r):
            return False
    return True


def _run_sleep_step(step: dict[str, Any], vars_ctx: dict[str, Any], idx: int) -> dict[str, Any]:
    title = describe_step_action("SLEEP", "", step)
    try:
        seconds = float(_render(str(step.get("seconds") if step.get("seconds") is not None else "1"), vars_ctx))
    except (TypeError, ValueError):
        return {
            "index": idx,
            "method": "SLEEP",
            "path": "",
            "service": "",
            "title": title,
            "action": "SLEEP",
            "status": "failed",
            "reason": "seconds 无效",
            "httpStatus": None,
            "body": None,
        }
    seconds = max(0.0, min(seconds, 120.0))
    threading.Event().wait(seconds)
    return {
        "index": idx,
        "method": "SLEEP",
        "path": "",
        "service": "",
        "title": title,
        "action": f"SLEEP {seconds}s",
        "status": "passed",
        "reason": "",
        "httpStatus": None,
        "body": {"sleptSeconds": seconds},
    }


def _run_kafka_step(
    step: dict[str, Any],
    env: dict[str, Any],
    vars_ctx: dict[str, Any],
    idx: int,
) -> dict[str, Any]:
    topic = _render(str(step.get("topic") or "device-raw-data"), vars_ctx).strip()
    key = _render(str(step.get("key") or ""), vars_ctx)
    value = _render(str(step.get("value") or ""), vars_ctx)
    title = describe_step_action("KAFKA", topic, step)
    brokers = str(env.get("kafkaBrokers") or "").strip()

    def result(**extra: Any) -> dict[str, Any]:
        base = {
            "index": idx,
            "method": "KAFKA",
            "path": topic,
            "service": "kafka",
            "title": title,
            "action": f"KAFKA {topic}",
        }
        base.update(extra)
        return base

    if not brokers:
        return result(status="failed", reason="未配置 kafkaBrokers", httpStatus=None, body=None)
    if not topic:
        return result(status="failed", reason="topic 不能为空", httpStatus=None, body=None)
    if not value:
        return result(status="failed", reason="value/HEX 不能为空", httpStatus=None, body=None)

    try:
        from kafka import KafkaProducer  # type: ignore
    except ImportError:
        return result(
            status="failed",
            reason="缺少 kafka-python，请 pip install kafka-python",
            httpStatus=None,
            body=None,
        )

    producer = None
    try:
        producer = KafkaProducer(
            bootstrap_servers=[b.strip() for b in brokers.split(",") if b.strip()],
            key_serializer=lambda k: k.encode("utf-8") if k is not None else None,
            value_serializer=lambda v: v.encode("utf-8") if isinstance(v, str) else v,
            acks="all",
            max_block_ms=8000,
            request_timeout_ms=10000,
        )
        future = producer.send(topic, key=key or None, value=value)
        meta = future.get(timeout=15)
        body = {
            "topic": meta.topic,
            "partition": meta.partition,
            "offset": meta.offset,
            "key": key,
            "valueLen": len(value),
        }
        return result(status="passed", reason="", httpStatus=None, body=body)
    except Exception as e:  # noqa: BLE001
        return result(status="failed", reason=f"Kafka 投递失败: {e}", httpStatus=None, body=None)
    finally:
        if producer is not None:
            try:
                producer.flush(timeout=5)
                producer.close(timeout=5)
            except Exception:  # noqa: BLE001
                pass


def _ensure_radar_frame_vars(case: dict[str, Any], vars_ctx: dict[str, Any]) -> None:
    """为雷达回波用例注入唯一 frame 时间戳（合法 yyyyMMddHHmmss，且落在 recent 窗口内）。"""
    module = str(case.get("module") or "")
    steps = case.get("steps") or []
    needs = module.startswith("radar-frame") or any(
        str((s or {}).get("method") or "").upper() == "MINIO" for s in steps if isinstance(s, dict)
    )
    if not needs:
        return
    if vars_ctx.get("radarTs"):
        return
    import uuid
    from datetime import datetime, timedelta, timezone

    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo("Asia/Shanghai")
    except Exception:  # noqa: BLE001
        tz = timezone(timedelta(hours=8))
    # 拉开秒级偏移，避免同批全链路用例撞同一 frameId（原先仅 0~49s 极易冲突）
    offset = 1 + (int(uuid.uuid4().hex[:8], 16) % 2900)
    event = datetime.now(tz) - timedelta(seconds=offset)
    radar_ts = event.strftime("%Y%m%d%H%M%S")
    vars_ctx["radarTs"] = radar_ts
    vars_ctx["frameId"] = f"radar-{radar_ts}"
    vars_ctx["frameStart"] = (event - timedelta(minutes=10)).strftime("%Y-%m-%d %H:%M:%S")
    vars_ctx["frameEnd"] = (event + timedelta(minutes=10)).strftime("%Y-%m-%d %H:%M:%S")
    vars_ctx["radarObjectKey"] = f"upstream/radar/realtime/radar_{radar_ts}.json"
    vars_ctx["radarAltObjectKey"] = f"upstream/radar/realtime/{event.strftime('%Y%m%d_%H%M%S')}.json"
    # 非法名：不可解析 frameId，且不要嵌入 radarTs（避免与正向用例撞号误判）
    vars_ctx["radarBadObjectKey"] = f"upstream/radar/realtime/badname_{uuid.uuid4().hex[:12]}.json"
    vars_ctx["radarWrongPrefixKey"] = f"upstream/other/radar_{radar_ts}.json"


def _rewrite_minio_endpoint(endpoint: str) -> str:
    """Docker 内 localhost/127.0.0.1 的 MinIO 改写为同网 leidian-minio:9000。"""
    from pathlib import Path
    from urllib.parse import urlparse

    text = str(endpoint or "").strip().rstrip("/")
    if not text:
        return text
    if not Path("/.dockerenv").exists():
        return text
    parsed = urlparse(text if "://" in text else f"http://{text}")
    host = (parsed.hostname or "").lower()
    if host not in ("localhost", "127.0.0.1", "::1"):
        return text
    # 宿主机映射口 19000 / 默认 9000 → 容器内直连
    if parsed.port in (19000, 9000, None):
        return "http://leidian-minio:9000"
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme or 'http'}://host.docker.internal{port}"


def _run_minio_step(
    step: dict[str, Any],
    env: dict[str, Any],
    vars_ctx: dict[str, Any],
    idx: int,
) -> dict[str, Any]:
    """上传对象到 MinIO；可选向 Kafka 投递上传通知（本地 MinIO notify 常未开）。"""
    bucket = _render(
        str(step.get("bucket") or env.get("minioRadarBucket") or "leidian-frame"),
        vars_ctx,
    ).strip()
    object_key = _render(str(step.get("objectKey") or ""), vars_ctx).strip()
    body_raw = step.get("body")
    if body_raw is None:
        body_text = "{}"
    elif isinstance(body_raw, (dict, list)):
        body_text = json.dumps(_render_obj(body_raw, vars_ctx), ensure_ascii=False)
    else:
        body_text = _render(str(body_raw), vars_ctx)
    content_type = _render(str(step.get("contentType") or "application/json"), vars_ctx)
    title = describe_step_action("MINIO", object_key, step)
    publish_notify = step.get("publishNotify")
    if publish_notify is None:
        publish_notify = True
    notify_topic = _render(str(step.get("notifyTopic") or "radar-frame-upstream"), vars_ctx).strip()

    def result(**extra: Any) -> dict[str, Any]:
        base = {
            "index": idx,
            "method": "MINIO",
            "path": object_key,
            "service": "minio",
            "title": title,
            "action": f"MINIO {bucket}/{object_key}",
        }
        base.update(extra)
        return base

    if not object_key:
        return result(status="failed", reason="objectKey 不能为空", httpStatus=None, body=None)

    endpoint = _rewrite_minio_endpoint(str(env.get("minioEndpoint") or "http://leidian-minio:9000"))
    access_key = str(env.get("minioAccessKey") or "minioadmin")
    secret_key = str(env.get("minioSecretKey") or "minioadmin")

    try:
        from minio import Minio  # type: ignore
    except ImportError:
        return result(
            status="failed",
            reason="缺少 minio，请 pip install minio",
            httpStatus=None,
            body=None,
        )

    from io import BytesIO
    from urllib.parse import urlparse

    parsed = urlparse(endpoint if "://" in endpoint else f"http://{endpoint}")
    host = parsed.hostname or "leidian-minio"
    port = parsed.port or (443 if parsed.scheme == "https" else 9000)
    secure = parsed.scheme == "https"

    meta = step.get("metadata") or {}
    metadata: dict[str, str] = {}
    if isinstance(meta, dict):
        for k, v in meta.items():
            metadata[str(k)] = _render(str(v), vars_ctx)

    data = body_text.encode("utf-8")
    try:
        client = Minio(
            f"{host}:{port}",
            access_key=access_key,
            secret_key=secret_key,
            secure=secure,
        )
        client.put_object(
            bucket,
            object_key,
            BytesIO(data),
            length=len(data),
            content_type=content_type,
            metadata=metadata or None,
        )
    except Exception as e:  # noqa: BLE001
        return result(status="failed", reason=f"MinIO 上传失败: {e}", httpStatus=None, body=None)

    notify_body = None
    if publish_notify:
        brokers = str(env.get("kafkaBrokers") or "").strip()
        if not brokers:
            return result(
                status="failed",
                reason="已上传但未配置 kafkaBrokers，无法投递 MinIO 通知",
                httpStatus=None,
                body={"bucket": bucket, "objectKey": object_key},
            )
        try:
            from kafka import KafkaProducer  # type: ignore
        except ImportError:
            return result(
                status="failed",
                reason="缺少 kafka-python，无法投递 MinIO 通知",
                httpStatus=None,
                body={"bucket": bucket, "objectKey": object_key},
            )
        notify_payload = json.dumps(
            {"bucket": bucket, "objectKey": object_key, "EventName": "s3:ObjectCreated:Put"},
            ensure_ascii=False,
        )
        producer = None
        try:
            producer = KafkaProducer(
                bootstrap_servers=[b.strip() for b in brokers.split(",") if b.strip()],
                value_serializer=lambda v: v.encode("utf-8") if isinstance(v, str) else v,
                acks="all",
                max_block_ms=8000,
                request_timeout_ms=10000,
            )
            meta_k = producer.send(notify_topic, value=notify_payload).get(timeout=15)
            notify_body = {
                "topic": meta_k.topic,
                "partition": meta_k.partition,
                "offset": meta_k.offset,
            }
        except Exception as e:  # noqa: BLE001
            return result(
                status="failed",
                reason=f"MinIO 已上传，但通知 Kafka 失败: {e}",
                httpStatus=None,
                body={"bucket": bucket, "objectKey": object_key},
            )
        finally:
            if producer is not None:
                try:
                    producer.flush(timeout=5)
                    producer.close(timeout=5)
                except Exception:  # noqa: BLE001
                    pass

    # 从 objectKey 推导 frameId（与 RadarFrameObjectKeyParser 对齐）
    file_name = object_key.rsplit("/", 1)[-1]
    base = file_name[:-5] if file_name.endswith(".json") else file_name
    frame_id = None
    m = re.search(r"radar_(\d{12,14})", base)
    if m:
        digits = m.group(1)
        if len(digits) == 12:
            digits = digits + "00"
        frame_id = f"radar-{digits}"
        vars_ctx["frameId"] = frame_id
        vars_ctx["radarTs"] = digits
    else:
        m2 = re.search(r"(\d{8})_(\d{6})", base)
        if m2:
            digits = m2.group(1) + m2.group(2)
            frame_id = f"radar-{digits}"
            vars_ctx["frameId"] = frame_id
            vars_ctx["radarTs"] = digits
    vars_ctx["objectKey"] = object_key

    return result(
        status="passed",
        reason="",
        httpStatus=None,
        body={
            "bucket": bucket,
            "objectKey": object_key,
            "bytes": len(data),
            "frameId": frame_id,
            "notify": notify_body,
            "endpoint": endpoint,
        },
    )


def _resolve_ws_url(env: dict[str, Any], step: dict[str, Any]) -> str:
    """拼 WebSocket URL：默认走网关 biz 前缀 + /realtime/ws。"""
    from env_store import _rewrite_gateway_for_runtime, service_base

    path = str(step.get("path") or "/realtime/ws").strip() or "/realtime/ws"
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", path):
        raise ValueError("WS path 禁止绝对 URL，请使用相对路径 + service")
    if not path.startswith("/"):
        path = "/" + path
    # 已写全网关路径
    if path.startswith("/api/"):
        gateway = _rewrite_gateway_for_runtime(str(env.get("gateway") or ""))
        if not gateway:
            raise ValueError("未配置网关根地址")
        http_url = gateway.rstrip("/") + path
    else:
        service = str(step.get("service") or "biz").strip() or "biz"
        base = service_base(env, service)
        if not base:
            raise ValueError(f"未配置网关根地址（服务 {service}）")
        http_url = base.rstrip("/") + path
    if http_url.startswith("https://"):
        return "wss://" + http_url[len("https://") :]
    if http_url.startswith("http://"):
        return "ws://" + http_url[len("http://") :]
    return http_url


def _run_ws_step(
    step: dict[str, Any],
    env: dict[str, Any],
    credential: str,
    vars_ctx: dict[str, Any],
    idx: int,
) -> dict[str, Any]:
    """连接 WebSocket，可选先执行 trigger 步骤，再等待匹配推送。"""
    title = describe_step_action("WS", str(step.get("path") or "/realtime/ws"), step)
    try:
        timeout = float(_render(str(step.get("timeoutSeconds") if step.get("timeoutSeconds") is not None else "30"), vars_ctx))
    except (TypeError, ValueError):
        timeout = 30.0
    timeout = max(3.0, min(timeout, 120.0))

    def result(**extra: Any) -> dict[str, Any]:
        base = {
            "index": idx,
            "method": "WS",
            "path": str(step.get("path") or "/realtime/ws"),
            "service": str(step.get("service") or "biz"),
            "title": title,
            "action": "WS",
        }
        base.update(extra)
        return base

    try:
        import websocket  # type: ignore
    except ImportError:
        return result(
            status="failed",
            reason="缺少 websocket-client，请 pip install websocket-client",
            httpStatus=None,
            body=None,
        )

    try:
        ws_url = _resolve_ws_url(env, step)
    except ValueError as e:
        return result(status="failed", reason=str(e), httpStatus=None, body=None)

    headers: list[str] = []
    if credential:
        token = credential if credential.lower().startswith("bearer ") else f"Bearer {credential}"
        headers.append(f"Authorization: {token}")

    messages: list[Any] = []
    err_box: list[str] = []
    opened = threading.Event()

    def on_open(_ws: Any) -> None:
        opened.set()

    def on_message(_ws: Any, message: Any) -> None:
        text = message.decode("utf-8", errors="replace") if isinstance(message, (bytes, bytearray)) else str(message)
        try:
            messages.append(json.loads(text))
        except json.JSONDecodeError:
            messages.append({"_raw": text})

    def on_error(_ws: Any, error: Any) -> None:
        err_box.append(str(error))

    app = websocket.WebSocketApp(
        ws_url,
        header=headers or None,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
    )
    thread = threading.Thread(
        target=lambda: app.run_forever(ping_interval=20, ping_timeout=10),
        daemon=True,
        name="func-web-ws",
    )
    thread.start()
    if not opened.wait(timeout=8):
        try:
            app.close()
        except Exception:  # noqa: BLE001
            pass
        reason = err_box[0] if err_box else "WebSocket 连接超时"
        return result(
            status="failed",
            reason=f"{reason} url={ws_url}",
            httpStatus=None,
            body={"url": ws_url, "messages": messages[:5]},
        )

    # 连接成功后再触发上传，确保在线时能收到广播
    trigger_results: list[dict[str, Any]] = []
    for t_idx, t_step in enumerate(step.get("trigger") or []):
        if not isinstance(t_step, dict):
            continue
        tr = _run_step(t_step, env, credential, vars_ctx, t_idx)
        trigger_results.append(tr)
        if tr.get("status") == "failed":
            try:
                app.close()
            except Exception:  # noqa: BLE001
                pass
            return result(
                status="failed",
                reason=f"WS trigger 失败: {tr.get('reason')}",
                httpStatus=None,
                body={"url": ws_url, "trigger": trigger_results},
            )

    expect = step.get("expect") or {}
    want_type = _render(str(expect.get("type") or "RADAR_FRAME_READY"), vars_ctx)
    match = expect.get("match") or expect.get("fields") or {}
    if not isinstance(match, dict):
        match = {}

    deadline = __import__("time").time() + timeout
    hit: Any = None
    while __import__("time").time() < deadline:
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            msg_type = msg.get("type") or msg.get("messageType") or ""
            if want_type and str(msg_type) != want_type:
                continue
            data = msg.get("data") if isinstance(msg.get("data"), dict) else msg
            if match and not _dict_matches(data if isinstance(data, dict) else {}, match, vars_ctx):
                # 也允许 match 写在根上（兼容）
                if not _dict_matches(msg, match, vars_ctx):
                    continue
            hit = msg
            break
        if hit is not None:
            break
        threading.Event().wait(0.2)

    try:
        app.close()
    except Exception:  # noqa: BLE001
        pass

    if hit is None:
        return result(
            status="failed",
            reason=f"未在 {timeout:.0f}s 内收到 type={want_type} 且匹配 {match!r} 的推送",
            httpStatus=None,
            body={"url": ws_url, "received": _truncate(messages[-8:]), "trigger": trigger_results, "errors": err_box},
        )
    return result(
        status="passed",
        reason="",
        httpStatus=None,
        body={"url": ws_url, "message": _truncate(hit), "trigger": trigger_results},
    )


def _render(text: str, ctx: dict[str, Any]) -> str:
    """渲染 ${var}；支持嵌套（如 ${kafkaJsonDedup} 内含 ${now-1m}/${rand}）。"""

    def repl(m: re.Match[str]) -> str:
        key = m.group(1)
        if key == "rand":
            import uuid

            return uuid.uuid4().hex[:8]
        if key == "radarTs":
            if not ctx.get("radarTs"):
                _ensure_radar_frame_vars({"module": "radar-frame-e2e", "steps": [{"method": "MINIO"}]}, ctx)
            return str(ctx.get("radarTs") or "")
        if key == "frameId":
            if not ctx.get("frameId") and ctx.get("radarTs"):
                ctx["frameId"] = f"radar-{ctx['radarTs']}"
            return str(ctx.get("frameId") or "")
        now_m = re.fullmatch(r"now([+-]\d+)([dhms])", key)
        if now_m:
            return _iso_now_offset(int(now_m.group(1)), now_m.group(2))
        local_m = re.fullmatch(r"localNow([+-]\d+)([dhms])", key)
        if local_m:
            return _local_now_offset(int(local_m.group(1)), local_m.group(2))
        val = ctx.get(key)
        return "" if val is None else str(val)

    # 支持 ${rand}、${ruleId}、${now+1d}、${now-2h}；多轮替换嵌套模板
    pattern = re.compile(r"\$\{([a-zA-Z0-9_+-]+)\}")
    out = text
    for _ in range(8):
        nxt = pattern.sub(repl, out)
        if nxt == out:
            break
        out = nxt
    return out


def _iso_now_offset(amount: int, unit: str) -> str:
    from datetime import datetime, timedelta, timezone

    delta = {
        "d": timedelta(days=amount),
        "h": timedelta(hours=amount),
        "m": timedelta(minutes=amount),
        "s": timedelta(seconds=amount),
    }[unit]
    # 与 data-service LocalDateTime.now()（通常为业务时区东八区）对齐；
    # 容器默认 UTC 会导致 ${now+10m} 相对服务端变成“过去”，未来时间拒收用例失效。
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo("Asia/Shanghai")
    except Exception:  # noqa: BLE001
        tz = timezone(timedelta(hours=8))
    # 与 FlexibleLocalDateTimeDeserializer / ISO_LOCAL_DATE_TIME 对齐：yyyy-MM-ddTHH:mm:ss
    return (datetime.now(tz) + delta).replace(tzinfo=None).strftime("%Y-%m-%dT%H:%M:%S")


def _local_now_offset(amount: int, unit: str) -> str:
    """监测 biz 时间窗格式：yyyy-MM-dd HH:mm:ss（东八区）。"""
    from datetime import datetime, timedelta, timezone

    delta = {
        "d": timedelta(days=amount),
        "h": timedelta(hours=amount),
        "m": timedelta(minutes=amount),
        "s": timedelta(seconds=amount),
    }[unit]
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo("Asia/Shanghai")
    except Exception:  # noqa: BLE001
        tz = timezone(timedelta(hours=8))
    return (datetime.now(tz) + delta).replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")


def _encode_url_query(url: str) -> str:
    """对 query 参数值做 UTF-8 百分号编码，避免中文等非 ASCII 触发 urllib 报错。"""
    parts = urlsplit(url)
    if not parts.query:
        return url
    query = urlencode(parse_qsl(parts.query, keep_blank_values=True), doseq=True)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


def _render_obj(obj: Any, ctx: dict[str, Any]) -> Any:
    if isinstance(obj, str):
        return _render(obj, ctx)
    if isinstance(obj, list):
        return [_render_obj(x, ctx) for x in obj]
    if isinstance(obj, dict):
        return {k: _render_obj(v, ctx) for k, v in obj.items()}
    return obj


def _dig(data: Any, path: str) -> Any:
    """支持 data.code、data.list.0.id 点路径（含数组下标）。"""
    cur: Any = data
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
            continue
        if isinstance(cur, list) and part.isdigit():
            idx = int(part)
            if 0 <= idx < len(cur):
                cur = cur[idx]
                continue
        return None
    return cur


def _values_equal(actual: Any, expected: Any) -> bool:
    """字段相等：兼容 JSON 数字与模板渲染出的字符串；支持 null 与 list/dict 深比较。"""
    if actual is None and expected is None:
        return True
    if actual == expected:
        return True
    if actual is None or expected is None:
        return False
    if isinstance(actual, (dict, list)) or isinstance(expected, (dict, list)):
        return actual == expected
    return str(actual) == str(expected)


def _truncate(body: Any, limit: int = 2000) -> Any:
    if isinstance(body, (dict, list)):
        text = json.dumps(body, ensure_ascii=False)
        if len(text) > limit:
            return text[:limit] + "…"
        return body
    if isinstance(body, str) and len(body) > limit:
        return body[:limit] + "…"
    return body

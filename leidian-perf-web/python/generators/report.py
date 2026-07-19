"""对齐 Word §11 测试结果记录模板的结构化报告。"""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from generators.db import pg_connection
from generators.preflight import run_preflight
from generators.stage_catalog import load_stage_catalog
from generators.validate import CheckResult, validate_stage
from generators.volume_matrix import (
    TABLE_SPECS,
    build_physical_volume_rows,
    build_word_volume_rows,
    format_total_rows_label,
    raw_breakdown,
    stage_total_target_rows,
)

# §11.3 校验项分组（Word 表行 → 匹配规则）
VALIDATION_TEMPLATE: list[tuple[str, Callable[[str], bool]]] = [
    ("行数校验", lambda n: n.startswith("row_count:")),
    ("经纬度合法性校验", lambda n: n == "geo:lightning_bounds"),
    ("mine_site 坐标校验", lambda n: n in ("geo:mine_dispatch_room_point", "geo:mine_fence_geom")),
    (
        "standard ↔ biz 关系校验",
        lambda n: (n.startswith("relation:") and n.endswith("_biz_1_1")) or n == "relation:lowfreq_raw_trace",
    ),
    (
        "50km 闪电关联校验",
        lambda n: n in ("geo:50km_lightning_per_process", "geo:50km_lightning_count_band"),
    ),
    ("预警事件与预警信息关系校验", lambda n: n == "relation:warning_per_process"),
    ("雷暴过程闭环数据量校验", lambda n: n == "relation:process_closure_per_process"),
    ("时间窗口校验", lambda n: n == "time:process_window"),
    ("预警动作时间线校验", lambda n: n == "time:warning_publish_lift"),
    ("raw 原始报文去重校验", lambda n: n in ("dedup:raw_kafka_tpo", "quality:raw_abnormal_ratio")),
]

PERF_SCENARIOS = [
    ("PERF-01", "大气电场持续写入"),
    ("PERF-02", "原始报文持续写入"),
    ("PERF-03", "活跃过程闪电突发写入"),
    ("PERF-04", "大气电场仪监测记录分页查询"),
    ("PERF-05", "多电场仪雷暴过程窗曲线查询"),
    ("PERF-05-AGG", "多电场仪雷暴过程窗曲线查询（10分钟聚合）"),
    ("PERF-06", "闪电事件时空统计查询"),
]

STAGE_SCALE_DESC = {
    "S0": "1万级",
    "S1": "核心大表约200万",
    "S2": "核心大表约800万～1000万",
    "S3": "核心大表约1500万～2000万",
    "S4": "推荐存量档（当前不强制执行）",
}


def _parse_actual_from_checks(checks: list[CheckResult], table_key: str) -> int | None:
    name = f"row_count:{table_key}"
    for c in checks:
        if c.name == name:
            part = c.detail.split("actual=")
            if len(part) > 1:
                try:
                    return int(part[1].split(",")[0].strip())
                except ValueError:
                    return None
    return None


def _probe_volume_counts(dsn: str, schema: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    with pg_connection(dsn, schema=schema) as conn:
        with conn.cursor() as cur:
            for table_key, _, _ in TABLE_SPECS:
                cur.execute(f"SELECT count(*) FROM {schema}.{table_key}")
                counts[table_key] = int(cur.fetchone()[0])
    return counts


def _actuals_from_checks(checks: list[CheckResult]) -> dict[str, int]:
    actuals: dict[str, int] = {}
    for table_key, _, _ in TABLE_SPECS:
        val = _parse_actual_from_checks(checks, table_key)
        if val is not None:
            actuals[table_key] = val
    return actuals


def _build_validation_groups(checks: list[CheckResult]) -> list[dict[str, Any]]:
    used: set[str] = set()
    groups: list[dict[str, Any]] = []
    for title, matcher in VALIDATION_TEMPLATE:
        matched = [c for c in checks if matcher(c.name)]
        for c in matched:
            used.add(c.name)
        if not matched:
            groups.append({"item": title, "result": "—", "passed": None, "note": "尚未执行校验"})
            continue
        ok = all(c.passed for c in matched)
        detail = "; ".join(f"{c.name}: {c.detail}" for c in matched[:2])
        if len(matched) > 2:
            detail += f" (+{len(matched) - 2})"
        groups.append(
            {
                "item": title,
                "result": "通过" if ok else "未通过",
                "passed": ok,
                "note": detail,
            }
        )
    extra = [c for c in checks if c.name not in used]
    if extra:
        ok = all(c.passed for c in extra)
        groups.append(
            {
                "item": "扩展校验项",
                "result": "通过" if ok else "未通过",
                "passed": ok,
                "note": "; ".join(c.name for c in extra),
            }
        )
    return groups


def _probe_env(dsn: str, schema: str) -> dict[str, str]:
    out = {
        "testTime": datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S"),
        "tester": "",
        "pgVersion": "",
        "postgisVersion": "",
        "cpu": "",
        "memory": "",
        "disk": "",
        "os": "",
        "dbDeploy": "",
        "appDeploy": "",
        "loadTester": "",
        "network": "",
        "isProduction": "否",
    }
    try:
        with pg_connection(dsn, schema=schema) as conn:
            with conn.cursor() as cur:
                cur.execute("SHOW server_version")
                out["pgVersion"] = f"PostgreSQL {cur.fetchone()[0]}"
                cur.execute("SELECT PostGIS_Version()")
                out["postgisVersion"] = str(cur.fetchone()[0])
    except Exception as exc:  # noqa: BLE001
        out["pgVersion"] = f"不可达: {exc}"
    return out


def build_test_report(
    stage: str,
    dsn: str,
    schema: str = "perf",
    config_dir: Path | None = None,
    truncate: bool = False,
    run_validate: bool = True,
) -> dict[str, Any]:
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    preflight = run_preflight(dsn, schema=schema, config_dir=root, selected_stage=stage, truncate=truncate)

    checks: list[CheckResult] = []
    if run_validate and preflight.get("prerequisitesOk"):
        try:
            checks = validate_stage(stage=stage, dsn=dsn, schema=schema, config_dir=root)
        except Exception as exc:  # noqa: BLE001
            checks = [CheckResult("report:validate_error", False, str(exc))]

    actual_counts: dict[str, int] | None = None
    if checks:
        actual_counts = _actuals_from_checks(checks)
    elif preflight.get("prerequisitesOk"):
        try:
            actual_counts = _probe_volume_counts(dsn, schema)
        except Exception:  # noqa: BLE001
            actual_counts = None

    volume_rows = build_word_volume_rows(stage, actual_counts, root)
    physical_volume_rows = build_physical_volume_rows(stage, actual_counts, root)
    validation_groups = _build_validation_groups(checks) if checks else [
        {"item": title, "result": "—", "passed": None, "note": "尚未执行校验"}
        for title, _ in VALIDATION_TEMPLATE
    ]

    physical_decided = [r["passed"] for r in physical_volume_rows if r["passed"] is not None]
    volume_pass = all(physical_decided) if physical_decided else None
    validation_decided = [g["passed"] for g in validation_groups if g["passed"] is not None]
    validation_pass = all(validation_decided) if validation_decided else None

    stage_conclusions = []
    for cat in load_stage_catalog(root):
        code = cat["code"]
        st = next((s for s in preflight["stages"] if s["code"] == code), None)
        status = st["status"] if st else "empty"
        if code == stage and checks:
            if volume_pass and validation_pass:
                conclusion = "造数与校验通过"
                proceed = "是" if code != "S4" else "按需"
            elif volume_rows or validation_groups:
                conclusion = "造数或校验未完全通过"
                proceed = "修复后复测"
            else:
                conclusion = ""
                proceed = ""
        elif status == "match":
            conclusion = "库内数据已对齐该档"
            proceed = "可进入压测" if code != "S4" else "按需"
        else:
            conclusion = "未造数" if status == "empty" else "与目标有偏差"
            proceed = "待造数" if code == stage else ""

        total_rows = int(cat.get("totalRows") or stage_total_target_rows(code, root))
        stage_conclusions.append(
            {
                "stage": code,
                "label": cat["label"],
                "scale": STAGE_SCALE_DESC.get(code, cat["summary"]),
                "totalRows": total_rows,
                "totalRowsLabel": cat.get("totalRowsLabel") or format_total_rows_label(total_rows),
                "conclusion": conclusion,
                "issues": st["detail"] if st and status != "match" else "",
                "proceed": proceed,
                "isCurrent": code == stage,
            }
        )

    workflow = {
        "preflightOk": preflight.get("prerequisitesOk"),
        "ddlOk": preflight.get("ddlOk"),
        "canInitSchema": preflight.get("canInitSchema"),
        "canLoad": preflight.get("readyForLoad"),
        "volumeOk": volume_pass,
        "validationOk": validation_pass,
        "hasData": any((r.get("actual") or 0) > 0 for r in volume_rows)
        or any(s.get("status") != "empty" for s in preflight.get("stages", [])),
    }

    return {
        "stage": stage,
        "workflow": workflow,
        "preflight": preflight,
        "section11_1": _probe_env(dsn, schema),
        "section11_2": volume_rows,
        "section11_2_physical": physical_volume_rows,
        "rawBreakdown": raw_breakdown(stage, root),
        "section11_3": validation_groups,
        "section11_4": [
            {
                "id": sid,
                "name": name,
                "stage": stage,
                "concurrency": "",
                "executions": "",
                "successRate": "",
                "avgMs": "",
                "p95": "",
                "p99": "",
                "tps": "",
                "passed": None,
                "note": "直连 SQL 压测（不经 API/解析）",
            }
            for sid, name in PERF_SCENARIOS
        ],
        "section11_5": [
            {
                "id": sid,
                "cpuAvg": "",
                "cpuPeak": "",
                "memAvg": "",
                "diskIoWait": "",
                "connPeak": "",
                "slowSqlCount": "",
                "note": "压测时采集（Prometheus / node_exporter）",
            }
            for sid, _ in PERF_SCENARIOS
        ],
        "section11_6": [
            {
                "scene": "",
                "symptom": "",
                "cause": "",
                "advice": "",
                "retest": "",
                "note": "压测后填写",
            }
        ],
        "section11_7": stage_conclusions,
        "rawChecks": [asdict(c) for c in checks],
    }

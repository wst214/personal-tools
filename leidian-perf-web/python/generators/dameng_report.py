"""达梦 DM8 §11 测试报告（与 report.py / PostgreSQL 完全隔离）。"""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from generators.dameng_conn import DamengConn
from generators.dameng_geo import probe_dm_instance_version, probe_geo_version_label
from generators.dameng_validate import validate_stage_dameng
from generators.dm_exec import build_disql_conn
from generators.dialect import catalog_schema
from generators.preflight import run_preflight
from generators.report import (
    PERF_SCENARIOS,
    STAGE_SCALE_DESC,
    VALIDATION_TEMPLATE,
    _actuals_from_checks,
    _build_validation_groups,
)
from generators.stage_catalog import load_stage_catalog
from generators.validate import CheckResult
from generators.volume_matrix import (
    TABLE_SPECS,
    build_physical_volume_rows,
    build_word_volume_rows,
    format_total_rows_label,
    raw_breakdown,
    stage_total_target_rows,
)
from generators.dm_write import dm_scalar


def _probe_env_dameng(conn: DamengConn) -> dict[str, str]:
    out = {
        "testTime": datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S"),
        "tester": "",
        "pgVersion": "",
        "postgisVersion": "",
        "dmVersion": "",
        "geoVersion": "",
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
        disql_conn = build_disql_conn(conn.user, conn.password, conn.host, conn.port)
        out["dmVersion"] = probe_dm_instance_version(disql_conn)
        out["geoVersion"] = probe_geo_version_label(disql_conn)
    except Exception as exc:  # noqa: BLE001
        out["dmVersion"] = f"不可达: {exc}"
    return out


def _probe_volume_counts_dameng(conn: DamengConn) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table_key, _, _ in TABLE_SPECS:
        counts[table_key] = dm_scalar(conn, f"SELECT count(*) FROM {table_key}")
    return counts


def build_test_report_dameng(
    *,
    stage: str,
    conn: DamengConn,
    config_dir: Path | None = None,
    truncate: bool = False,
    run_validate: bool = True,
    host: str | None = None,
    port: str | None = None,
    user: str | None = None,
    password: str | None = None,
    progress=None,
) -> dict[str, Any]:
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    owner = catalog_schema(conn.schema, "dameng")
    if progress:
        progress("前置检查 / 档位探测…")
    preflight = run_preflight(
        dsn="",
        schema=owner,
        config_dir=root,
        selected_stage=stage,
        truncate=truncate,
        dialect="dameng",
        host=host or conn.host,
        port=port or conn.port,
        user=user or conn.user,
        password=password if password is not None else conn.password,
    )

    checks: list[CheckResult] = []
    if run_validate and preflight.get("prerequisitesOk"):
        try:
            if progress:
                progress(f"开始校验 stage={stage} …")
            checks = validate_stage_dameng(
                stage=stage, conn=conn, config_dir=root, progress=progress
            )
        except Exception as exc:  # noqa: BLE001
            checks = [CheckResult("report:validate_error", False, str(exc))]

    actual_counts: dict[str, int] | None = None
    if checks:
        actual_counts = _actuals_from_checks(checks)
    elif preflight.get("prerequisitesOk"):
        try:
            actual_counts = _probe_volume_counts_dameng(conn)
        except Exception:  # noqa: BLE001
            actual_counts = None

    volume_rows = build_word_volume_rows(stage, actual_counts, root)
    physical_volume_rows = build_physical_volume_rows(stage, actual_counts, root)
    validation_groups = (
        _build_validation_groups(checks)
        if checks
        else [
            {"item": title, "result": "—", "passed": None, "note": "尚未执行校验"}
            for title, _ in VALIDATION_TEMPLATE
        ]
    )

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
        "dialect": "dameng",
        "workflow": workflow,
        "preflight": preflight,
        "section11_1": _probe_env_dameng(conn),
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
                "note": "直连 SQL 压测（达梦方言，不经 API/解析）",
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

"""造数前置条件检查 + 各阶段入库状态探测。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from generators.db import pg_connection
from generators.dialect import catalog_schema, normalize_dialect, normalize_schema
from generators.dm_exec import DisqlNotFoundError, build_disql_conn, disql_scalar
from generators.load_guard import SMALL_COUNT_TABLES, is_load_in_progress
from generators.init_schema import SQL_FILES
from generators.stage_catalog import load_stage_catalog
from generators.validate import CheckResult

# init-schema 完成后应存在的核心表（按 SQL 批次归类）
PLANNING_TABLES = [
    "mine_site",
    "thunderstorm_process",
    "thunderstorm_warning_event",
    "thunderstorm_warning_message",
    "device_alarm_event",
    "thunderstorm_notice_event",
    "inspection_task",
    "hidden_risk",
    "repair_order",
]

DEVICE_TABLES = [
    "standard_grounding_resistance",
    "biz_grounding_resistance_event",
    "standard_surge_current",
    "biz_surge_current_event",
    "standard_remote_terminal",
    "biz_remote_terminal_event",
    "standard_power_board",
    "biz_power_board_event",
    "standard_disconnect_card",
    "biz_disconnect_card_event",
    "standard_spd_waveform_heartbeat",
    "biz_spd_waveform_heartbeat_event",
    "standard_spd_waveform_summary",
    "biz_spd_waveform_summary_event",
    "standard_ispd_pdu",
    "biz_ispd_pdu_event",
    "standard_surge_monitor",
    "biz_surge_monitor_event",
]

PARTITIONED_TABLES = [
    "raw_kafka_message",
    "standard_atmosphere_electric_field",
    "biz_atmosphere_electric_field_event",
    "standard_lightning_strike_cmb",
    "standard_lightning_strike_locator",
    "biz_lightning_event",
]

MATCH_METRICS = [
    ("mine_site", "mine_site"),
    ("thunderstorm_process", "thunderstorm_process"),
    ("standard_atmosphere_electric_field", "atmosphere_rows"),
    ("raw_kafka_message", "raw_rows"),
    ("biz_lightning_event", "biz_lightning_event"),
]


def _scalar(cur, sql: str, params: tuple = ()) -> Any:
    cur.execute(sql, params)
    row = cur.fetchone()
    return row[0] if row else None


def _estimate_table_rows(cur, schema: str, table: str) -> int:
    """大表用统计信息估算，避免千万级 count(*) 长时间占锁。"""
    est = _scalar(
        cur,
        """
        SELECT COALESCE(c.reltuples, 0)::bigint
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = %s AND c.relname = %s
        """,
        (schema, table),
    )
    return max(int(est or 0), 0)


def _table_count(cur, schema: str, table: str, *, fast: bool = False) -> int | None:
    exists = _scalar(
        cur,
        """
        SELECT count(*) FROM information_schema.tables
        WHERE table_schema = %s AND table_name = %s
        """,
        (schema, table),
    )
    if not exists:
        return None
    if fast and table not in SMALL_COUNT_TABLES:
        return _estimate_table_rows(cur, schema, table)
    cur.execute("SET LOCAL lock_timeout = '5s'")
    cur.execute("SET LOCAL statement_timeout = '180s'")
    return int(_scalar(cur, f"SELECT count(*) FROM {schema}.{table}") or 0)


def _load_profiles(config_dir: Path) -> dict[str, dict[str, Any]]:
    with (config_dir / "volume-profiles.yaml").open(encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    return cfg["stages"]


def _dm_table_exists(conn: str, owner: str, table: str) -> bool:
    val = disql_scalar(
        conn,
        f"""
        SELECT COUNT(*) FROM DBA_TABLES
        WHERE OWNER = '{owner.upper()}' AND TABLE_NAME = '{table.upper()}'
        """,
    )
    return int(val or 0) > 0


def _dm_table_count(conn: str, owner: str, table: str, *, fast: bool = False) -> int | None:
    if not _dm_table_exists(conn, owner, table):
        return None
    if fast and table not in SMALL_COUNT_TABLES:
        val = disql_scalar(
            conn,
            f"""
            SELECT NUM_ROWS FROM DBA_TABLES
            WHERE OWNER = '{owner.upper()}' AND TABLE_NAME = '{table.upper()}'
            """,
        )
        return max(int(val or 0), 0)
    val = disql_scalar(conn, f'SELECT COUNT(*) FROM "{owner.upper()}".{table.upper()}')
    return int(val or 0)


def check_prerequisites_dameng(
    host: str,
    port: str,
    user: str,
    password: str | None,
    schema: str = "PERF",
) -> list[CheckResult]:
    results: list[CheckResult] = []
    owner = catalog_schema(schema, "dameng")
    try:
        conn = build_disql_conn(user, password, host, port)
        version = disql_scalar(conn, "SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1")
        results.append(
            CheckResult(
                "preflight:db_connect",
                True,
                f"connected, Dameng {version}" if version else "connected, Dameng DM8",
            )
        )

        geo_schemas = int(
            disql_scalar(
                conn,
                """
                SELECT COUNT(*) FROM SYS.SYSOBJECTS
                WHERE NAME = 'SYSGEO2' AND TYPE$ = 'SCH'
                """,
            )
            or 0
        )
        geo_ok = geo_schemas > 0
        results.append(
            CheckResult(
                "preflight:postgis",
                geo_ok,
                "DMGEO2 installed (SYSGEO2 schema)"
                if geo_ok
                else "DMGEO2 missing: install DM8 spatial module on dbserver, then CALL SP_INIT_GEO2_SYS(1)",
            )
        )

        schema_ok = int(
            disql_scalar(
                conn,
                f"""
                SELECT COUNT(*) FROM SYS.SYSOBJECTS
                WHERE NAME = '{owner}' AND TYPE$ = 'SCH'
                """,
            )
            or 0
        ) > 0
        results.append(
            CheckResult(
                "preflight:schema",
                schema_ok,
                f"schema '{owner}' exists" if schema_ok else f"schema '{owner}' missing, run init-schema",
            )
        )

        for sql_file in SQL_FILES:
            key = f"preflight:sql_{sql_file.replace('.sql', '')}"
            ok = True
            detail = "inferred ok"
            if sql_file == "00_init_schema.sql":
                ok = schema_ok and geo_ok
                detail = f"{owner} schema + DMGEO2" if ok else f"{owner} schema; DMGEO2 required"
            elif sql_file == "01_planning_tables.sql":
                missing = [t for t in PLANNING_TABLES if not _dm_table_exists(conn, owner, t)]
                ok = not missing
                detail = f"tables={len(PLANNING_TABLES)}" if ok else f"missing: {', '.join(missing)}"
            elif sql_file == "02_device_tables.sql":
                missing = [t for t in DEVICE_TABLES if not _dm_table_exists(conn, owner, t)]
                ok = not missing
                detail = f"tables={len(DEVICE_TABLES)}" if ok else f"missing: {', '.join(missing[:3])}..."
            elif sql_file == "03_partitioned_tables.sql":
                missing = [t for t in PARTITIONED_TABLES if not _dm_table_exists(conn, owner, t)]
                ok = not missing
                detail = f"parents={len(PARTITIONED_TABLES)}" if ok else f"missing: {', '.join(missing)}"
            elif sql_file == "04_functions_triggers.sql":
                fn = disql_scalar(
                    conn,
                    f"""
                    SELECT COUNT(*) FROM DBA_OBJECTS
                    WHERE OWNER = '{owner}' AND OBJECT_NAME = 'CREATE_MONTHLY_PARTITIONS'
                      AND OBJECT_TYPE IN ('PROCEDURE', 'PROC')
                    """,
                )
                ok = int(fn or 0) > 0
                detail = "create_monthly_partitions()" if ok else "procedure missing"
            elif sql_file == "05_default_partitions.sql":
                parts = int(
                    disql_scalar(
                        conn,
                        f"""
                        SELECT COUNT(*) FROM DBA_TAB_PARTITIONS
                        WHERE TABLE_OWNER = '{owner}' AND TABLE_NAME = 'RAW_KAFKA_MESSAGE'
                        """,
                    )
                    or 0
                )
                ok = parts > 0
                detail = f"raw partitions={parts}" if ok else "no monthly partitions, run init-schema"
            results.append(CheckResult(key, ok, detail))

        spatial_idx = disql_scalar(
            conn,
            f"""
            SELECT COUNT(*) FROM DBA_INDEXES
            WHERE TABLE_OWNER = '{owner}' AND TABLE_NAME = 'MINE_SITE'
              AND INDEX_NAME LIKE '%DISPATCH%'
            """,
        )
        results.append(
            CheckResult(
                "preflight:mine_site_gist",
                int(spatial_idx or 0) > 0,
                "dispatch_room spatial index" if spatial_idx else "mine_site spatial index missing",
            )
        )
    except DisqlNotFoundError as exc:
        results.append(CheckResult("preflight:db_connect", False, str(exc)))
    except Exception as exc:  # noqa: BLE001
        results.append(CheckResult("preflight:db_connect", False, str(exc)))

    return results


def check_prerequisites(dsn: str, schema: str = "perf") -> list[CheckResult]:
    results: list[CheckResult] = []

    try:
        with pg_connection(dsn, schema=schema) as conn:
            with conn.cursor() as cur:
                pg_ver = _scalar(cur, "SHOW server_version")
                results.append(
                    CheckResult(
                        "preflight:db_connect",
                        True,
                        f"connected, PostgreSQL {pg_ver}",
                    )
                )

                postgis = _scalar(cur, "SELECT PostGIS_Version()")
                results.append(
                    CheckResult(
                        "preflight:postgis",
                        bool(postgis),
                        f"PostGIS {postgis}" if postgis else "extension missing",
                    )
                )

                schema_ok = bool(
                    _scalar(
                        cur,
                        "SELECT count(*) FROM information_schema.schemata WHERE schema_name = %s",
                        (schema,),
                    )
                )
                results.append(
                    CheckResult(
                        "preflight:schema",
                        schema_ok,
                        f"schema '{schema}' exists" if schema_ok else f"schema '{schema}' missing, run init-schema",
                    )
                )

                for sql_file in SQL_FILES:
                    key = f"preflight:sql_{sql_file.replace('.sql', '')}"
                    ok = True
                    detail = "inferred ok"
                    if sql_file == "00_init_schema.sql":
                        ok = schema_ok and bool(postgis)
                        detail = "perf schema + PostGIS"
                    elif sql_file == "01_planning_tables.sql":
                        missing = [t for t in PLANNING_TABLES if _table_count(cur, schema, t) is None]
                        ok = not missing
                        detail = f"tables={len(PLANNING_TABLES)}" if ok else f"missing: {', '.join(missing)}"
                    elif sql_file == "02_device_tables.sql":
                        missing = [t for t in DEVICE_TABLES if _table_count(cur, schema, t) is None]
                        ok = not missing
                        detail = f"tables={len(DEVICE_TABLES)}" if ok else f"missing: {', '.join(missing[:3])}..."
                    elif sql_file == "03_partitioned_tables.sql":
                        missing = [t for t in PARTITIONED_TABLES if _table_count(cur, schema, t) is None]
                        ok = not missing
                        detail = f"parents={len(PARTITIONED_TABLES)}" if ok else f"missing: {', '.join(missing)}"
                    elif sql_file == "04_functions_triggers.sql":
                        fn = _scalar(
                            cur,
                            """
                            SELECT count(*) FROM pg_proc p
                            JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = %s AND p.proname = 'create_monthly_partitions'
                            """,
                            (schema,),
                        )
                        ok = int(fn or 0) > 0
                        detail = "create_monthly_partitions()" if ok else "function missing"
                    elif sql_file == "05_default_partitions.sql":
                        parts = int(
                            _scalar(
                                cur,
                                """
                                SELECT count(*) FROM pg_tables
                                WHERE schemaname = %s AND tablename LIKE 'raw_kafka_message_y%%'
                                """,
                                (schema,),
                            )
                            or 0
                        )
                        ok = parts > 0
                        detail = f"raw partitions={parts}" if ok else "no monthly partitions, run init-schema"
                    results.append(CheckResult(key, ok, detail))

                mine_gist = _scalar(
                    cur,
                    """
                    SELECT count(*) FROM pg_indexes
                    WHERE schemaname = %s AND tablename = 'mine_site'
                      AND indexname = 'idx_mine_site_dispatch_room_gist'
                    """,
                    (schema,),
                )
                results.append(
                    CheckResult(
                        "preflight:mine_site_gist",
                        int(mine_gist or 0) > 0,
                        "dispatch_room GiST index" if mine_gist else "mine_site spatial index missing",
                    )
                )

    except Exception as exc:  # noqa: BLE001
        results.append(CheckResult("preflight:db_connect", False, str(exc)))

    return results


def probe_stage_load_status(
    dsn: str,
    schema: str = "perf",
    config_dir: Path | None = None,
    *,
    fast_counts: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """读取当前库行数，并与各档位目标对比。"""
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    profiles = _load_profiles(root)
    catalog = {s["code"]: s for s in load_stage_catalog(root)}

    actual: dict[str, int] = {}
    with pg_connection(dsn, schema=schema) as conn:
        with conn.cursor() as cur:
            for table, _ in MATCH_METRICS:
                cnt = _table_count(cur, schema, table, fast=fast_counts)
                actual[table] = cnt if cnt is not None else 0

    total_rows = sum(actual.values())
    stages_out: list[dict[str, Any]] = []

    for code, profile in profiles.items():
        cmb = int(profile["lightning_cmb"])
        loc = int(profile["lightning_locator"])
        expected = {
            "mine_site": int(profile["mine_site"]),
            "thunderstorm_process": int(profile["thunderstorm_process"]),
            "atmosphere_rows": int(profile["atmosphere_rows"]),
            "raw_rows": int(profile["raw_rows"]),
            "biz_lightning_event": cmb + loc,
        }
        metric_actual = {
            "mine_site": actual.get("mine_site", 0),
            "thunderstorm_process": actual.get("thunderstorm_process", 0),
            "atmosphere_rows": actual.get("standard_atmosphere_electric_field", 0),
            "raw_rows": actual.get("raw_kafka_message", 0),
            "biz_lightning_event": actual.get("biz_lightning_event", 0),
        }
        if total_rows == 0:
            status = "empty"
            detail = "库内尚无造数数据"
        else:
            mismatches = [
                f"{k}: actual={metric_actual[k]}, expected={expected[k]}"
                for k in expected
                if metric_actual[k] != expected[k]
            ]
            if not mismatches:
                status = "match"
                detail = "与目标档位一致"
            else:
                status = "mismatch"
                detail = "; ".join(mismatches[:2])
                if len(mismatches) > 2:
                    detail += f" (+{len(mismatches) - 2})"

        stages_out.append(
            {
                "code": code,
                "label": catalog[code]["label"],
                "summary": catalog[code]["summary"],
                "status": status,
                "detail": detail,
                "expected": expected,
                "actual": metric_actual,
            }
        )

    return stages_out, actual


def probe_stage_load_status_dameng(
    host: str,
    port: str,
    user: str,
    password: str | None,
    schema: str = "PERF",
    config_dir: Path | None = None,
    *,
    fast_counts: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    profiles = _load_profiles(root)
    catalog = {s["code"]: s for s in load_stage_catalog(root)}
    owner = catalog_schema(schema, "dameng")
    conn = build_disql_conn(user, password, host, port)

    actual: dict[str, int] = {}
    for table, _ in MATCH_METRICS:
        cnt = _dm_table_count(conn, owner, table, fast=fast_counts)
        actual[table] = cnt if cnt is not None else 0

    total_rows = sum(actual.values())
    stages_out: list[dict[str, Any]] = []

    for code, profile in profiles.items():
        cmb = int(profile["lightning_cmb"])
        loc = int(profile["lightning_locator"])
        expected = {
            "mine_site": int(profile["mine_site"]),
            "thunderstorm_process": int(profile["thunderstorm_process"]),
            "atmosphere_rows": int(profile["atmosphere_rows"]),
            "raw_rows": int(profile["raw_rows"]),
            "biz_lightning_event": cmb + loc,
        }
        metric_actual = {
            "mine_site": actual.get("mine_site", 0),
            "thunderstorm_process": actual.get("thunderstorm_process", 0),
            "atmosphere_rows": actual.get("standard_atmosphere_electric_field", 0),
            "raw_rows": actual.get("raw_kafka_message", 0),
            "biz_lightning_event": actual.get("biz_lightning_event", 0),
        }
        if total_rows == 0:
            status = "empty"
            detail = "库内尚无造数数据"
        else:
            mismatches = [
                f"{k}: actual={metric_actual[k]}, expected={expected[k]}"
                for k in expected
                if metric_actual[k] != expected[k]
            ]
            if not mismatches:
                status = "match"
                detail = "与目标档位一致"
            else:
                status = "mismatch"
                detail = "; ".join(mismatches[:2])
                if len(mismatches) > 2:
                    detail += f" (+{len(mismatches) - 2})"

        stages_out.append(
            {
                "code": code,
                "label": catalog[code]["label"],
                "summary": catalog[code]["summary"],
                "status": status,
                "detail": detail,
                "expected": expected,
                "actual": metric_actual,
            }
        )

    return stages_out, actual


def _stages_placeholder(config_dir: Path) -> list[dict[str, Any]]:
    catalog = load_stage_catalog(config_dir)
    return [
        {
            "code": s["code"],
            "label": s["label"],
            "summary": s["summary"],
            "status": "loading",
            "detail": "造数进行中，暂不统计行数",
            "expected": {},
            "actual": {},
        }
        for s in catalog
    ]


def run_preflight(
    dsn: str,
    schema: str = "perf",
    config_dir: Path | None = None,
    selected_stage: str | None = None,
    truncate: bool = False,
    dialect: str = "postgres",
    host: str | None = None,
    port: str | None = None,
    user: str | None = None,
    password: str | None = None,
) -> dict[str, Any]:
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    resolved = normalize_dialect(dialect)
    schema = normalize_schema(schema, resolved)

    if resolved == "dameng":
        from generators.dameng_conn import DamengConn
        from generators.dameng_load_guard import is_load_in_progress as dm_load_busy
        from generators.dialect import resolve_conn

        h, p, _db, u, pw = resolve_conn(resolved, host, port, None, user, password)
        conn = DamengConn(host=h, port=p, user=u, password=pw, schema=schema)
        try:
            load_busy = dm_load_busy(conn)
        except Exception:
            load_busy = False
        prerequisites = check_prerequisites_dameng(h, p, u, pw, schema=schema)
        if load_busy:
            stages = _stages_placeholder(root)
            actual = {}
        else:
            try:
                stages, actual = probe_stage_load_status_dameng(
                    h, p, u, pw, schema=schema, config_dir=root
                )
            except Exception as exc:  # noqa: BLE001
                stages = _stages_placeholder(root)
                actual = {}
                prerequisites.append(
                    CheckResult("preflight:stage_probe", False, f"档位探测失败: {exc}")
                )
        spatial_label = "GEO 空间模块"
    else:
        load_busy = is_load_in_progress(dsn)
        prerequisites = check_prerequisites(dsn, schema=schema)
        if load_busy:
            stages = _stages_placeholder(root)
            actual = {}
        else:
            stages, actual = probe_stage_load_status(dsn, schema=schema, config_dir=root)
        spatial_label = "PostGIS 扩展"

    ddl_ok = all(r.passed for r in prerequisites if r.name.startswith("preflight:sql_"))
    prereq_ok = all(r.passed for r in prerequisites)

    matched = [s for s in stages if s["status"] == "match"]
    inferred_stage = matched[0]["code"] if len(matched) == 1 else None

    selected = selected_stage or inferred_stage
    selected_info = next((s for s in stages if s["code"] == selected), None) if selected else None

    load_block_reason: str | None = None
    if load_busy:
        load_block_reason = "造数进行中（库内造数锁已占用），请等待完成后再造数/压测/全表检查"
    elif not prereq_ok:
        load_block_reason = "前置检查未通过，请先执行「初始化 Schema」或修复数据库"
    elif selected_info and selected_info["status"] == "match" and not truncate:
        load_block_reason = f"库内数据已对齐 {selected}，需勾选「造数前清空」或更换档位"
    ready_for_load = load_block_reason is None

    init_block_reason: str | None = None
    if ddl_ok:
        init_block_reason = f"{schema} schema 已初始化（00～05 DDL 已就绪），禁止重复执行 init-schema"
    elif not any(r.name == "preflight:db_connect" and r.passed for r in prerequisites):
        init_block_reason = "数据库不可达，无法初始化 Schema"
    elif resolved != "dameng" and not any(r.name == "preflight:postgis" and r.passed for r in prerequisites):
        init_block_reason = (
            f"缺少 {spatial_label}：请在 dbserver 安装 DM8 空间组件并执行 SP_INIT_GEO2_SYS(1)"
        )

    can_init_schema = init_block_reason is None

    return {
        "dialect": resolved,
        "prerequisites": [{"name": r.name, "passed": r.passed, "detail": r.detail} for r in prerequisites],
        "prerequisitesOk": prereq_ok and not load_busy,
        "ddlOk": ddl_ok,
        "canInitSchema": can_init_schema and not load_busy,
        "initBlockReason": (
            "造数进行中，禁止初始化 Schema"
            if load_busy
            else init_block_reason
        ),
        "readyForLoad": ready_for_load,
        "loadBlockReason": load_block_reason,
        "loadInProgress": load_busy,
        "stages": stages,
        "actualSnapshot": actual,
        "inferredStage": inferred_stage if not load_busy else None,
        "selectedStage": selected,
        "spatialLabel": spatial_label,
        "catalog": load_stage_catalog(root),
    }

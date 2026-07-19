#!/usr/bin/env python3
"""PERF 压测操作台：页面触发 run_load.py，校验结果结构化展示。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import records_store

WEB_ROOT = Path(__file__).resolve().parent
TOOL_ROOT = WEB_ROOT.parent
PYTHON_DIR = TOOL_ROOT / "python"
sys.path.insert(0, str(PYTHON_DIR))

DEFAULT_PORT = int(os.environ.get("PERF_WEB_PORT", "8100"))
_jobs: dict[str, "Job"] = {}
_jobs_lock = threading.Lock()


def _payload_dialect(payload: dict[str, Any] | None) -> str:
    raw = str((payload or {}).get("dialect") or "postgres").strip().lower()
    return "dameng" if raw == "dameng" else "postgres"


def _is_dameng(payload: dict[str, Any] | None) -> bool:
    return _payload_dialect(payload) == "dameng"


def _load_env_profile(dialect: str | None = None) -> dict[str, str]:
    from records_store import load_env_profile

    raw = load_env_profile(_payload_dialect({"dialect": dialect}))
    return {k: str(v) for k, v in raw.items() if v is not None}


@dataclass
class Job:
    id: str
    action: str
    status: str = "pending"  # pending | running | success | failed
    log: list[str] = field(default_factory=list)
    exit_code: int | None = None
    validation: list[dict[str, Any]] | None = None
    report: dict[str, Any] | None = None
    benchmark: dict[str, Any] | None = None
    error: str | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None

    def append_log(self, line: str) -> None:
        self.log.append(line.rstrip("\n"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "action": self.action,
            "status": self.status,
            "log": self.log,
            "exitCode": self.exit_code,
            "validation": self.validation,
            "report": self.report,
            "benchmark": self.benchmark,
            "error": self.error,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
        }


def _python_exe() -> str:
    """本机 Windows 用 .venv\\Scripts；Linux/Docker 用 .venv/bin 或镜像内 python。"""
    venv_unix = PYTHON_DIR / ".venv" / "bin" / "python"
    venv_win = PYTHON_DIR / ".venv" / "Scripts" / "python.exe"
    if os.name == "nt":
        if venv_win.exists():
            return str(venv_win)
        if venv_unix.exists():
            return str(venv_unix)
    elif venv_unix.exists():
        return str(venv_unix)
    return sys.executable


def _run_subprocess(job: Job, args: list[str], env: dict[str, str] | None = None) -> int:
    cmd = [_python_exe(), "-u", "run_load.py", *args]
    job.append_log("$ " + " ".join(cmd))
    run_env = dict(env or os.environ)
    run_env.setdefault("PYTHONUNBUFFERED", "1")
    proc = subprocess.Popen(
        cmd,
        cwd=str(PYTHON_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=run_env,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        job.append_log(line.rstrip("\n"))
    return proc.wait()


def _db_args(payload: dict[str, Any]) -> list[str]:
    args: list[str] = []
    args.extend(["--dialect", _payload_dialect(payload)])
    mapping = {
        "host": "--host",
        "port": "--port",
        "database": "--database",
        "user": "--user",
        "password": "--password",
        "schema": "--schema",
    }
    for key, flag in mapping.items():
        val = payload.get(key)
        if val not in (None, ""):
            args.extend([flag, str(val)])
    return args


def _resolved_conn_from_payload(payload: dict[str, Any]) -> tuple[str, str, str, str, str | None]:
    dialect = _payload_dialect(payload)
    if dialect == "dameng":
        host = str(payload.get("host") or os.environ.get("DMHOST", "127.0.0.1"))
        port = str(payload.get("port") or os.environ.get("DMPORT", "5236"))
        database = str(payload.get("database") or os.environ.get("DMSERVICE", "LEIDIAN_PERF"))
        user = str(payload.get("user") or os.environ.get("DMUSER", "LEIDIAN_APP"))
        password = payload.get("password")
        if password in (None, ""):
            password = os.environ.get("DMPASSWORD")
        return host, port, database, user, str(password) if password not in (None, "") else None
    host = str(payload.get("host") or os.environ.get("PGHOST", "localhost"))
    port = str(payload.get("port") or os.environ.get("PGPORT", "5432"))
    database = str(payload.get("database") or os.environ.get("PGDATABASE", "leidian_perf"))
    user = str(payload.get("user") or os.environ.get("PGUSER", "leidian"))
    password = payload.get("password")
    if password in (None, ""):
        password = os.environ.get("PGPASSWORD")
    return host, port, database, user, str(password) if password not in (None, "") else None


def _dsn_from_payload(payload: dict[str, Any]) -> str:
    from generators.db import build_dsn
    host, port, database, user, password = _resolved_conn_from_payload(payload)
    return build_dsn(host, port, database, user, password)


def _running_job() -> Job | None:
    with _jobs_lock:
        for job in _jobs.values():
            if job.status == "running":
                return job
    return None


def _system_status(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    from generators.load_guard import is_load_in_progress

    job = _running_job()
    load_in_progress = False
    if payload:
        if _is_dameng(payload):
            from generators.dameng_load_guard import is_load_in_progress as dm_load_busy

            try:
                load_in_progress = dm_load_busy(_dameng_conn_from_payload(payload))
            except Exception:
                load_in_progress = False
        else:
            try:
                load_in_progress = is_load_in_progress(_dsn_from_payload(payload))
            except Exception:
                load_in_progress = False
    busy = job is not None or load_in_progress
    return {
        "busy": busy,
        "runningAction": job.action if job else None,
        "runningJobId": job.id if job else None,
        "loadInProgress": load_in_progress,
        "dialect": _payload_dialect(payload),
    }


def _dameng_conn_from_payload(payload: dict[str, Any]):
    from generators.dameng_conn import DamengConn
    from generators.dialect import normalize_schema

    host, port, _database, user, password = _resolved_conn_from_payload(payload)
    return DamengConn(
        host=host,
        port=port,
        user=user,
        password=password,
        schema=normalize_schema(str(payload.get("schema") or "perf"), "dameng"),
    )


class DamengRuntimeBlockedError(RuntimeError):
    """达梦运行时能力不可用（如缺少 dmPython / disql）。"""


def _reject_if_load_busy(payload: dict[str, Any], action: str) -> None:
    from generators.load_guard import LoadInProgressError, is_load_in_progress

    if _is_dameng(payload):
        from generators.dameng_load_guard import is_load_in_progress as dm_load_busy

        try:
            if dm_load_busy(_dameng_conn_from_payload(payload)):
                raise LoadInProgressError(
                    f"造数进行中（达梦造数锁已占用），请等待造数完成后再{action}"
                )
        except LoadInProgressError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"无法检测造数状态: {exc}") from exc
    else:
        try:
            if is_load_in_progress(_dsn_from_payload(payload)):
                raise LoadInProgressError(
                    f"造数进行中（库内造数锁已占用），请等待造数完成后再{action}"
                )
        except LoadInProgressError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"无法检测造数状态: {exc}") from exc
    job = _running_job()
    if job and job.action == "load":
        raise LoadInProgressError(
            f"造数任务执行中（job={job.id}），请等待完成后再{action}"
        )


def _preflight_for_payload(payload: dict[str, Any]) -> dict[str, Any]:
    from generators.preflight import run_preflight

    host, port, database, user, password = _resolved_conn_from_payload(payload)
    dsn = _dsn_from_payload(payload)
    return run_preflight(
        dsn=dsn,
        schema=str(payload.get("schema") or "perf"),
        config_dir=PYTHON_DIR / "config",
        selected_stage=str(payload.get("stage")) if payload.get("stage") else None,
        truncate=bool(payload.get("truncate")),
        dialect=_payload_dialect(payload),
        host=host,
        port=port,
        user=user,
        password=password,
    )


def _build_report(payload: dict[str, Any], run_validate: bool = True) -> dict[str, Any]:
    stage = str(payload.get("stage", "S0"))
    config_dir = PYTHON_DIR / "config"
    if _is_dameng(payload):
        from generators.dameng_report import build_test_report_dameng

        host, port, _database, user, password = _resolved_conn_from_payload(payload)
        return build_test_report_dameng(
            stage=stage,
            conn=_dameng_conn_from_payload(payload),
            config_dir=config_dir,
            truncate=bool(payload.get("truncate")),
            run_validate=run_validate,
            host=host,
            port=port,
            user=user,
            password=password,
        )

    from generators.report import build_test_report

    dsn = _dsn_from_payload(payload)
    schema = str(payload.get("schema") or "perf")
    report = build_test_report(
        stage=stage,
        dsn=dsn,
        schema=schema,
        config_dir=config_dir,
        truncate=bool(payload.get("truncate")),
        run_validate=run_validate,
    )
    report["dialect"] = _payload_dialect(payload)
    return report


def _persist_report(stage: str, report: dict[str, Any]) -> None:
    try:
        records_store.merge_stage_report(
            stage,
            report,
            dialect=report.get("dialect", "postgres"),
        )
    except Exception as exc:  # noqa: BLE001
        print(f"WARN: 持久化测试记录失败 — {exc}", flush=True)


def _run_validate_for_payload(payload: dict[str, Any]):
    from generators.validate import validate_stage

    stage = str(payload.get("stage", "S0"))
    config_dir = PYTHON_DIR / "config"
    if _is_dameng(payload):
        from generators.dameng_validate import validate_stage_dameng

        return validate_stage_dameng(
            stage=stage,
            conn=_dameng_conn_from_payload(payload),
            config_dir=config_dir,
        )

    from generators.db import build_dsn

    host, port, database, user, password = _resolved_conn_from_payload(payload)
    dsn = build_dsn(host, port, database, user, password)
    schema = str(payload.get("schema") or "perf")
    return validate_stage(stage=stage, dsn=dsn, schema=schema, config_dir=config_dir)


def _validate_and_attach(job: Job, payload: dict[str, Any]) -> None:
    stage = str(payload.get("stage", "S0"))
    job.append_log("")
    job.append_log(f"--- 自动校验 stage={stage} [{_payload_dialect(payload)}] ---")
    try:
        results = _run_validate_for_payload(payload)
    except DamengRuntimeBlockedError as exc:
        job.status = "failed"
        job.exit_code = 2
        job.error = str(exc)
        job.append_log(f"BLOCKED: {exc}")
        return
    job.validation = [asdict(r) for r in results]
    failed = sum(1 for r in results if not r.passed)
    job.append_log(f"校验完成：{len(results) - failed}/{len(results)} 项通过")
    try:
        job.report = _build_report(payload, run_validate=True)
        if job.report:
            _persist_report(stage, job.report)
    except Exception as exc:  # noqa: BLE001
        job.append_log(f"WARN: 生成 §11 报告失败 — {exc}")
    if failed:
        job.status = "failed"
        job.exit_code = 1


def _execute_job(job: Job, payload: dict[str, Any]) -> None:
    job.status = "running"
    env = os.environ.copy()
    if payload.get("password"):
        if _payload_dialect(payload) == "dameng":
            env["DMPASSWORD"] = str(payload["password"])
        else:
            env["PGPASSWORD"] = str(payload["password"])

    try:
        action = job.action
        if action == "init-schema":
            from generators.load_guard import LoadInProgressError

            try:
                _reject_if_load_busy(payload, "初始化 Schema")
            except LoadInProgressError as exc:
                job.status = "failed"
                job.exit_code = 1
                job.error = str(exc)
                job.append_log(f"BLOCKED: {exc}")
                return
            pf = _preflight_for_payload(payload)
            if not pf.get("canInitSchema") and not payload.get("forceInit"):
                job.status = "failed"
                job.exit_code = 1
                job.error = pf.get("initBlockReason") or "禁止重复初始化 Schema"
                job.append_log(f"BLOCKED: {job.error}")
                return
            if not pf.get("canInitSchema") and payload.get("forceInit"):
                job.append_log(f"WARN: 强制重复 init-schema — {pf.get('initBlockReason')}")

            args = ["init-schema", *_db_args(payload)]
            if payload.get("forceInit"):
                args.append("--force")
            code = _run_subprocess(job, args, env)
            job.exit_code = code
            job.status = "success" if code == 0 else "failed"
            if code == 0:
                job.append_log("")
                job.append_log("--- init-schema 完成，建议执行「检查前置条件」---")

        elif action == "load":
            stage = str(payload.get("stage", "S0"))

            from generators.load_guard import LoadInProgressError, is_load_in_progress

            if _is_dameng(payload):
                from generators.dameng_load_guard import is_load_in_progress as dm_load_busy

                try:
                    if dm_load_busy(_dameng_conn_from_payload(payload)):
                        job.status = "failed"
                        job.exit_code = 1
                        job.error = "已有造数任务在运行（达梦造数锁未释放）"
                        job.append_log(f"BLOCKED: {job.error}")
                        return
                except Exception as exc:  # noqa: BLE001
                    job.append_log(f"WARN: 达梦造数锁检测失败 — {exc}")
            else:
                try:
                    if is_load_in_progress(_dsn_from_payload(payload)):
                        job.status = "failed"
                        job.exit_code = 1
                        job.error = "已有造数任务在运行（造数锁未释放）"
                        job.append_log(f"BLOCKED: {job.error}")
                        return
                except Exception as exc:  # noqa: BLE001
                    job.append_log(f"WARN: 造数锁检测失败 — {exc}")
            pf = _preflight_for_payload(payload)
            if not pf.get("readyForLoad") and not payload.get("forceLoad"):
                job.status = "failed"
                job.exit_code = 1
                job.error = pf.get("loadBlockReason") or "前置检查未通过"
                job.append_log(f"BLOCKED: {job.error}")
                job.append_log("提示: 点击「检查前置条件」查看详情，或先执行 init-schema")
                return
            if not pf.get("readyForLoad") and payload.get("forceLoad"):
                job.append_log(f"WARN: 跳过前置拦截 — {pf.get('loadBlockReason')}")

            args = ["load", "--stage", stage, *_db_args(payload)]
            if payload.get("truncate"):
                args.append("--truncate")
            if payload.get("t0"):
                args.extend(["--t0", str(payload["t0"])])
            if payload.get("seed") is not None:
                args.extend(["--seed", str(payload["seed"])])
            code = _run_subprocess(job, args, env)
            job.exit_code = code
            if code != 0:
                job.status = "failed"
                return
            job.status = "success"
            if payload.get("autoValidate", True):
                _validate_and_attach(job, payload)

        elif action == "validate":
            _validate_and_attach(job, payload)
            if job.status != "failed":
                job.status = "success"
                job.exit_code = 0

        elif action == "benchmark":
            from generators.load_guard import LoadInProgressError

            try:
                _reject_if_load_busy(payload, "执行 SQL 压测")
            except LoadInProgressError as exc:
                job.status = "failed"
                job.exit_code = 1
                job.error = str(exc)
                job.append_log(f"BLOCKED: {exc}")
                return

            stage = str(payload.get("stage", "S0"))
            scenarios = payload.get("scenarios")
            if isinstance(scenarios, str):
                scenarios = [s.strip() for s in scenarios.split(",") if s.strip()]

            job.append_log(f"--- 直连 SQL 压测 stage={stage} [{_payload_dialect(payload)}] ---")
            query_concurrency = None
            if payload.get("queryConcurrency") is not None:
                query_concurrency = int(payload["queryConcurrency"])
                job.append_log(f"查询场景并发: {query_concurrency}")
            write_iterations = None
            if payload.get("writeIterations") is not None:
                write_iterations = int(payload["writeIterations"])
                job.append_log(f"写入每线程次数: {write_iterations}")
            query_iterations = None
            if payload.get("queryIterations") is not None:
                query_iterations = int(payload["queryIterations"])
                job.append_log(f"查询每线程次数: {query_iterations}")
            slow_sql_threshold_ms = None
            if payload.get("slowSqlThresholdMs") is not None:
                slow_sql_threshold_ms = float(payload["slowSqlThresholdMs"])
                job.append_log(f"慢SQL阈值: ≥{int(slow_sql_threshold_ms)}ms")
            perf05_agg_bucket_minutes = None
            if payload.get("perf05AggBucketMinutes") is not None:
                from generators.sql_bench import normalize_perf05_agg_bucket_minutes

                perf05_agg_bucket_minutes = normalize_perf05_agg_bucket_minutes(
                    payload["perf05AggBucketMinutes"]
                )
                job.append_log(f"PERF-05-AGG 聚合间隔: {perf05_agg_bucket_minutes} 分钟")
            try:
                if _is_dameng(payload):
                    from generators.dameng_sql_bench import run_sql_benchmark_dameng

                    result = run_sql_benchmark_dameng(
                        stage=stage,
                        conn=_dameng_conn_from_payload(payload),
                        config_dir=PYTHON_DIR / "config",
                        scenarios=scenarios,
                        concurrency=int(payload["concurrency"]) if payload.get("concurrency") else None,
                        query_concurrency=query_concurrency,
                        iterations=int(payload["iterations"]) if payload.get("iterations") else None,
                        write_iterations=write_iterations,
                        query_iterations=query_iterations,
                        slow_sql_threshold_ms=slow_sql_threshold_ms,
                        perf05_agg_bucket_minutes=perf05_agg_bucket_minutes,
                        log=job.append_log,
                    )
                else:
                    from generators.sql_bench import run_sql_benchmark

                    dsn = _dsn_from_payload(payload)
                    schema = str(payload.get("schema") or "perf")
                    result = run_sql_benchmark(
                        stage=stage,
                        dsn=dsn,
                        schema=schema,
                        config_dir=PYTHON_DIR / "config",
                        scenarios=scenarios,
                        concurrency=int(payload["concurrency"]) if payload.get("concurrency") else None,
                        query_concurrency=query_concurrency,
                        iterations=int(payload["iterations"]) if payload.get("iterations") else None,
                        write_iterations=write_iterations,
                        query_iterations=query_iterations,
                        slow_sql_threshold_ms=slow_sql_threshold_ms,
                        perf05_agg_bucket_minutes=perf05_agg_bucket_minutes,
                        log=job.append_log,
                    )
                job.benchmark = result
                if result.get("section11_4"):
                    doc = records_store.append_benchmark_run(
                        stage,
                        result["section11_4"],
                        scenarios=scenarios,
                        iterations=int(payload["iterations"]) if payload.get("iterations") else None,
                        write_iterations=write_iterations,
                        query_iterations=query_iterations,
                        passed=result.get("passed"),
                        run_id=job.id,
                        scenario_results=result.get("results"),
                        dialect=_payload_dialect(payload),
                    )
                    result["benchmarkHistory"] = (
                        doc.get("dialects", {})
                        .get(_payload_dialect(payload), {})
                        .get("stages", {})
                        .get(stage, {})
                        .get("benchmarkHistory", [])
                    )
                    job.append_log(
                        f"已追加压测历史（共 {len(result['benchmarkHistory'])} 轮）"
                    )
                job.exit_code = 0 if result.get("passed") is not False else 1
                job.status = "success" if job.exit_code == 0 else "failed"
            except Exception as exc:  # noqa: BLE001
                from generators.dameng_db import DamengDriverNotFoundError

                if isinstance(exc, DamengDriverNotFoundError):
                    job.status = "failed"
                    job.exit_code = 2
                    job.error = str(exc)
                    job.append_log(f"BLOCKED: {exc}")
                else:
                    job.status = "failed"
                    job.exit_code = 1
                    job.error = str(exc)
                    job.append_log(f"ERROR: {exc}")

        else:
            job.status = "failed"
            job.error = f"unknown action: {action}"
    except Exception as exc:  # noqa: BLE001
        job.status = "failed"
        job.error = str(exc)
        job.append_log(f"ERROR: {exc}")
    finally:
        job.finished_at = time.time()


def _start_job(payload: dict[str, Any]) -> Job:
    action = str(payload.get("action", ""))
    job = Job(id=uuid.uuid4().hex[:12], action=action)
    with _jobs_lock:
        _jobs[job.id] = job
    thread = threading.Thread(target=_execute_job, args=(job, payload), daemon=True)
    thread.start()
    return job


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _send_json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(raw) if raw.strip() else {}

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/defaults":
            qs = parse_qs(parsed.query)
            req_dialect = (qs.get("dialect") or [None])[0]
            dialect = (
                str(req_dialect).strip().lower()
                if req_dialect
                else os.environ.get("PERF_DB_DIALECT", "postgres").strip().lower()
            )
            if dialect not in ("postgres", "dameng"):
                dialect = "postgres"
            if dialect == "dameng":
                defaults = {
                    "host": os.environ.get("DMHOST", "192.168.1.41"),
                    "port": os.environ.get("DMPORT", "5236"),
                    "database": os.environ.get("DMSERVICE", "LEIDIAN_PERF"),
                    "user": os.environ.get("DMUSER", "LEIDIAN_APP"),
                    "password": os.environ.get("DMPASSWORD", "Leidian@2026!"),
                    "schema": os.environ.get("DMSCHEMA", "PERF"),
                }
            else:
                defaults = {
                    "host": os.environ.get("PGHOST", "192.168.1.41"),
                    "port": os.environ.get("PGPORT", "5432"),
                    "database": os.environ.get("PGDATABASE", "leidian_perf"),
                    "user": os.environ.get("PGUSER", "leidian"),
                    "password": os.environ.get("PGPASSWORD", "leidian"),
                    "schema": "perf",
                }
            self._send_json(
                {
                    **defaults,
                    "dialect": dialect,
                    "stage": "S0",
                    "seed": 42,
                    "truncate": True,
                    "autoValidate": True,
                    "envProfile": _load_env_profile(dialect),
                    "prometheusUrl": os.environ.get(
                        "PROMETHEUS_URL", "http://host.docker.internal:9090"
                    ),
                    "prometheusInstance": os.environ.get(
                        "PROMETHEUS_INSTANCE", "192.168.1.41:9100"
                    ),
                    "pythonDir": str(PYTHON_DIR),
                    "pythonExe": _python_exe(),
                }
            )
            return

        if path == "/api/stages":
            from generators.stage_catalog import load_stage_catalog

            self._send_json({"stages": load_stage_catalog(PYTHON_DIR / "config")})
            return

        if path == "/api/bench/scenarios":
            import yaml

            cfg_path = PYTHON_DIR / "config" / "sql-bench.yaml"
            with cfg_path.open(encoding="utf-8") as f:
                cfg = yaml.safe_load(f)
            self._send_json(cfg)
            return

        if path == "/api/records":
            self._send_json(records_store.load_records())
            return

        if path == "/api/volume-matrix":
            from generators.volume_matrix import all_stages_volume_matrix, build_word_volume_rows, raw_breakdown

            qs = parse_qs(parsed.query)
            stage = (qs.get("stage") or [None])[0]
            config_dir = PYTHON_DIR / "config"
            if stage:
                self._send_json(
                    {
                        "stage": stage,
                        "rows": build_word_volume_rows(stage, None, config_dir),
                        "rawBreakdown": raw_breakdown(stage, config_dir),
                    }
                )
            else:
                self._send_json({"stages": all_stages_volume_matrix(config_dir)})
            return

        if path.startswith("/api/jobs/"):
            job_id = path.split("/")[-1]
            with _jobs_lock:
                job = _jobs.get(job_id)
            if not job:
                self._send_json({"error": "job not found"}, 404)
                return
            self._send_json(job.to_dict())
            return

        if path == "/" or path == "/index.html":
            return self._serve_file(WEB_ROOT / "index.html", "text/html; charset=utf-8")
        if path.endswith(".css"):
            return self._serve_file(WEB_ROOT / path.lstrip("/"), "text/css; charset=utf-8")
        if path.endswith(".js"):
            return self._serve_file(WEB_ROOT / path.lstrip("/"), "application/javascript; charset=utf-8")
        self.send_error(404)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/status":
            payload = self._read_json()
            self._send_json(_system_status(payload))
            return

        if path == "/api/preflight":
            payload = self._read_json()
            try:
                self._send_json(_preflight_for_payload(payload))
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc)}, 500)
            return

        if path == "/api/report":
            payload = self._read_json()
            try:
                run_validate = payload.get("validate", True)
                if run_validate:
                    _reject_if_load_busy(payload, "执行校验")
                report = _build_report(payload, run_validate=bool(run_validate))
                persist = payload.get("persist", bool(run_validate))
                if persist and report.get("section11_2"):
                    stage = str(payload.get("stage", "S0"))
                    _persist_report(stage, report)
                self._send_json(report)
            except Exception as exc:  # noqa: BLE001
                from generators.load_guard import LoadInProgressError

                if isinstance(exc, DamengRuntimeBlockedError):
                    status = 501
                elif isinstance(exc, LoadInProgressError):
                    status = 409
                else:
                    status = 500
                self._send_json({"error": str(exc)}, status)
            return

        if path == "/api/resources/collect":
            payload = self._read_json()
            try:
                _reject_if_load_busy(payload, "采集资源与执行计划")
                stage = str(payload.get("stage", "S0"))
                prometheus_url = str(
                    payload.get("prometheusUrl")
                    or os.environ.get("PROMETHEUS_URL", "http://host.docker.internal:9090")
                )
                instance = str(
                    payload.get("prometheusInstance")
                    or os.environ.get("PROMETHEUS_INSTANCE", "192.168.1.41:9100")
                )
                dialect = _payload_dialect(payload)
                doc = records_store.load_records()
                entry = (
                    doc.get("dialects", {})
                    .get(dialect, {})
                    .get("stages", {})
                    .get(stage, {})
                )
                history = entry.get("benchmarkHistory") or []
                run_id = payload.get("runId")
                run = None
                if run_id:
                    run = next((r for r in history if r.get("runId") == run_id), None)
                elif history:
                    run = history[-1]
                if not run or not run.get("results"):
                    self._send_json(
                        {"error": "无压测记录，请先执行 SQL 压测（需新版带时间窗口）"},
                        400,
                    )
                    return
                slow_sql_ms = float(payload.get("slowSqlThresholdMs") or 500)
                if _is_dameng(payload):
                    from generators.dameng_resource_collect import collect_section11_5_for_run_dameng

                    rows = collect_section11_5_for_run_dameng(
                        prometheus_url=prometheus_url,
                        instance=instance,
                        scenario_results=run["results"],
                        conn=_dameng_conn_from_payload(payload),
                        slow_sql_ms=slow_sql_ms,
                        run_explain=bool(payload.get("runExplain", True)),
                    )
                else:
                    from generators.resource_collect import collect_section11_5_for_run

                    dsn = _dsn_from_payload(payload)
                    database = str(payload.get("database") or "leidian_perf")
                    schema = str(payload.get("schema") or "perf")
                    rows = collect_section11_5_for_run(
                        prometheus_url=prometheus_url,
                        instance=instance,
                        scenario_results=run["results"],
                        dsn=dsn,
                        database=database,
                        slow_sql_ms=slow_sql_ms,
                        schema=schema,
                        run_explain=bool(payload.get("runExplain", True)),
                    )
                doc = records_store.append_resource_collect(
                    stage,
                    rows,
                    run_id=run.get("runId"),
                    dialect=dialect,
                )
                stage_entry = (
                    doc.get("dialects", {})
                    .get(dialect, {})
                    .get("stages", {})
                    .get(stage, {})
                )
                self._send_json(
                    {
                        "stage": stage,
                        "runId": run.get("runId"),
                        "section11_5": stage_entry["section11_5"],
                        "resourceHistory": stage_entry.get("resourceHistory", []),
                    }
                )
            except Exception as exc:  # noqa: BLE001
                from generators.load_guard import LoadInProgressError

                if isinstance(exc, DamengRuntimeBlockedError):
                    status = 501
                elif isinstance(exc, LoadInProgressError):
                    status = 409
                else:
                    status = 500
                self._send_json({"error": str(exc)}, status)
            return

        if path == "/api/slow-sql/details":
            payload = self._read_json()
            try:
                if not _is_dameng(payload):
                    self._send_json({"error": "慢 SQL 明细当前仅支持达梦 DM8"}, 400)
                    return
                stage = str(payload.get("stage", "S0"))
                dialect = _payload_dialect(payload)
                doc = records_store.load_records()
                entry = (
                    doc.get("dialects", {})
                    .get(dialect, {})
                    .get("stages", {})
                    .get(stage, {})
                )
                history = entry.get("benchmarkHistory") or []
                run_id = payload.get("runId")
                run = None
                if run_id:
                    run = next((r for r in history if r.get("runId") == run_id), None)
                elif history:
                    run = history[-1]
                if not run or not run.get("results"):
                    self._send_json({"error": "无压测记录，请先执行 SQL 压测"}, 400)
                    return
                from generators.dameng_sql_bench import refresh_run_slow_sql_details

                conn = _dameng_conn_from_payload(payload)
                updated = refresh_run_slow_sql_details(conn, run["results"])
                doc = records_store.patch_benchmark_run_results(
                    stage,
                    str(run["runId"]),
                    updated,
                    dialect=dialect,
                )
                detail_rows = []
                for row in updated:
                    sid = row.get("id") or ""
                    name = row.get("name") or ""
                    for item in row.get("slowSqlDetails") or row.get("slow_sql_details") or []:
                        detail_rows.append(
                            {
                                "scenarioId": sid,
                                "scenarioName": name,
                                **item,
                            }
                        )
                self._send_json(
                    {
                        "stage": stage,
                        "runId": run.get("runId"),
                        "details": detail_rows,
                        "results": updated,
                    }
                )
            except Exception as exc:  # noqa: BLE001
                from generators.load_guard import LoadInProgressError

                if isinstance(exc, DamengRuntimeBlockedError):
                    status = 501
                elif isinstance(exc, LoadInProgressError):
                    status = 409
                else:
                    status = 500
                self._send_json({"error": str(exc)}, status)
            return

        if path == "/api/records/benchmark":
            payload = self._read_json()
            try:
                stage = str(payload.get("stage", "S0"))
                dialect = _payload_dialect(payload)
                section11_4 = payload.get("section11_4") or []
                if not section11_4:
                    self._send_json({"error": "section11_4 is required"}, 400)
                    return
                scenarios = payload.get("scenarios")
                if isinstance(scenarios, str):
                    scenarios = [s.strip() for s in scenarios.split(",") if s.strip()]
                doc = records_store.append_benchmark_run(
                    stage,
                    section11_4,
                    scenarios=scenarios,
                    iterations=int(payload["iterations"]) if payload.get("iterations") else None,
                    write_iterations=int(payload["writeIterations"])
                    if payload.get("writeIterations")
                    else None,
                    query_iterations=int(payload["queryIterations"])
                    if payload.get("queryIterations")
                    else None,
                    passed=payload.get("passed"),
                    run_id=payload.get("runId") or payload.get("run_id"),
                    scenario_results=payload.get("results"),
                    dialect=dialect,
                )
                history = (
                    doc.get("dialects", {})
                    .get(dialect, {})
                    .get("stages", {})
                    .get(stage, {})
                    .get("benchmarkHistory", [])
                )
                run_id = payload.get("runId") or payload.get("run_id")
                if not run_id and history:
                    run_id = history[-1].get("runId")
                self._send_json(
                    {
                        "ok": True,
                        "stage": stage,
                        "dialect": dialect,
                        "runId": run_id,
                        "benchmarkHistory": history,
                    }
                )
            except ValueError as exc:
                self._send_json({"error": str(exc)}, 400)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc)}, 500)
            return

        if path == "/api/resources/delete":
            payload = self._read_json()
            try:
                stage = str(payload.get("stage", "S0"))
                before = len(
                    records_store.load_records()
                    .get("dialects", {})
                    .get(_payload_dialect(payload), {})
                    .get("stages", {})
                    .get(stage, {})
                    .get("resourceHistory", [])
                )
                if payload.get("deleteAll"):
                    doc = records_store.delete_all_resource_collects(
                        stage, dialect=_payload_dialect(payload)
                    )
                    collect_ids = []
                else:
                    collect_ids = payload.get("collectIds") or payload.get("collect_ids") or []
                    if isinstance(collect_ids, str):
                        collect_ids = [s.strip() for s in collect_ids.split(",") if s.strip()]
                    doc = records_store.delete_resource_collects(
                        stage,
                        list(collect_ids),
                        dialect=_payload_dialect(payload),
                    )
                after = (
                    doc.get("dialects", {})
                    .get(_payload_dialect(payload), {})
                    .get("stages", {})
                    .get(stage, {})
                    .get("resourceHistory", [])
                )
                self._send_json(
                    {
                        "stage": stage,
                        "deletedCollectIds": collect_ids,
                        "deletedCount": before - len(after),
                        "resourceHistory": after,
                        "section11_5": (
                            doc.get("dialects", {})
                            .get(_payload_dialect(payload), {})
                            .get("stages", {})
                            .get(stage, {})
                            .get("section11_5", [])
                        ),
                    }
                )
            except ValueError as exc:
                self._send_json({"error": str(exc)}, 400)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc)}, 500)
            return

        if path == "/api/benchmark/delete":
            payload = self._read_json()
            try:
                stage = str(payload.get("stage", "S0"))
                before = len(
                    records_store.load_records()
                    .get("dialects", {})
                    .get(_payload_dialect(payload), {})
                    .get("stages", {})
                    .get(stage, {})
                    .get("benchmarkHistory", [])
                )
                if payload.get("deleteAll"):
                    doc = records_store.delete_all_benchmark_runs(
                        stage, dialect=_payload_dialect(payload)
                    )
                    run_ids = []
                else:
                    run_ids = payload.get("runIds") or payload.get("run_ids") or []
                    if isinstance(run_ids, str):
                        run_ids = [s.strip() for s in run_ids.split(",") if s.strip()]
                    doc = records_store.delete_benchmark_runs(
                        stage,
                        list(run_ids),
                        dialect=_payload_dialect(payload),
                    )
                after = (
                    doc.get("dialects", {})
                    .get(_payload_dialect(payload), {})
                    .get("stages", {})
                    .get(stage, {})
                    .get("benchmarkHistory", [])
                )
                self._send_json(
                    {
                        "stage": stage,
                        "deletedRunIds": run_ids,
                        "deletedCount": before - len(after),
                        "benchmarkHistory": after,
                    }
                )
            except ValueError as exc:
                self._send_json({"error": str(exc)}, 400)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc)}, 500)
            return

        if path.startswith("/api/records/") and path.endswith("/env"):
            stage = path.split("/")[3]
            payload = self._read_json()
            try:
                dialect = _payload_dialect(payload)
                doc = records_store.patch_stage_section(
                    stage, "section11_1", payload, dialect=dialect
                )
                self._send_json(doc)
            except ValueError as exc:
                self._send_json({"error": str(exc)}, 400)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc)}, 500)
            return

        if path != "/api/jobs":
            self.send_error(404)
            return
        payload = self._read_json()
        action = str(payload.get("action", ""))
        with _jobs_lock:
            running = any(j.status == "running" for j in _jobs.values())
        if running:
            self._send_json({"error": "已有任务在执行，请等待完成后再操作"}, 409)
            return
        if action in ("load", "validate", "benchmark"):
            try:
                if action in ("benchmark", "validate"):
                    _reject_if_load_busy(payload, "执行该任务")
            except Exception as exc:  # noqa: BLE001
                from generators.load_guard import LoadInProgressError

                if isinstance(exc, DamengRuntimeBlockedError):
                    status = 501
                elif isinstance(exc, LoadInProgressError):
                    status = 409
                else:
                    status = 500
                self._send_json({"error": str(exc)}, status)
                return
        job = _start_job(payload)
        self._send_json(job.to_dict())

    def _serve_file(self, target: Path, content_type: str) -> None:
        if not target.exists() or not str(target.resolve()).startswith(str(WEB_ROOT.resolve())):
            self.send_error(404)
            return
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    host = os.environ.get("PERF_WEB_HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, DEFAULT_PORT), Handler)
    print(f"PERF 压测操作台: http://{host}:{DEFAULT_PORT}")
    print(f"Python: {_python_exe()}")
    server.serve_forever()


if __name__ == "__main__":
    main()

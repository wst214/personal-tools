"""Docker Compose orchestration for local mytools stacks."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from stacks_config import (
    LEIDIAN_BACKEND_HOST_PATH,
    LEIDIAN_BACKEND_ROOT,
    LEIDIAN_LOCAL_JAR_MODULES,
    MYTOOLS_ROOT,
    OPS_LOCAL_COMPOSE,
    STACKS,
)

OPS_LEIDIAN_OVERRIDES = Path(
    os.environ.get("OPS_LEIDIAN_OVERRIDES", OPS_LOCAL_COMPOSE.parent)
).resolve()


def _expected_jar_path(service_name: str) -> Path:
    return (
        LEIDIAN_BACKEND_ROOT
        / "services"
        / service_name
        / "target"
        / f"{service_name}-0.0.1-SNAPSHOT.jar"
    )


def _missing_local_jars(service_names: list[str]) -> list[str]:
    missing: list[str] = []
    for name in service_names:
        if name not in LEIDIAN_LOCAL_JAR_MODULES:
            continue
        if not _expected_jar_path(name).is_file():
            missing.append(name)
    return missing


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stack_by_id(stack_id: str) -> dict[str, Any]:
    for stack in STACKS:
        if stack["id"] == stack_id:
            return stack
    raise KeyError(f"Unknown stack: {stack_id}")


def _service_meta(stack: dict[str, Any], service_name: str) -> dict[str, Any]:
    for item in stack.get("services", []):
        if item["name"] == service_name:
            return item
    return {"name": service_name, "label": service_name}


def _resolve_build_mode(stack: dict[str, Any], build_mode: str | None) -> dict[str, Any] | None:
    modes = stack.get("build_modes") or []
    if not modes:
        return None
    if build_mode:
        for mode in modes:
            if mode["id"] == build_mode:
                return mode
        raise ValueError(f"Unknown build mode: {build_mode}")
    return next((mode for mode in modes if mode.get("default")), modes[0])


def _compose_context(
    stack: dict[str, Any],
    service: dict[str, Any] | None = None,
    build_mode: str | None = None,
) -> dict[str, Any]:
    """Resolve compose dir/files/project/env for a stack or a specific service."""
    source = service or {}
    mode = _resolve_build_mode(stack, build_mode)
    compose_dir = source.get("compose_dir") or stack.get("compose_dir")
    if source.get("compose_files"):
        compose_files = [str(item) for item in source["compose_files"]]
    elif source.get("compose_file"):
        compose_files = [str(source["compose_file"])]
    elif mode and mode.get("compose_files"):
        compose_files = [str(item) for item in mode["compose_files"]]
    elif stack.get("compose_files"):
        compose_files = [str(item) for item in stack["compose_files"]]
    else:
        compose_files = [str(stack.get("compose_file") or "docker-compose.yml")]
    project = source.get("project") or stack["project"]
    env_file = source.get("env_file") or stack.get("env_file")
    if not compose_dir:
        raise ValueError(f"Missing compose_dir for stack {stack['id']}")
    return {
        "compose_dir": Path(compose_dir),
        "compose_files": compose_files,
        "project": str(project),
        "env_file": str(env_file) if env_file else None,
        "build_mode": mode["id"] if mode else None,
    }


@dataclass
class Task:
    id: str
    stack_id: str
    action: str
    command: str
    status: str = "running"
    exit_code: int | None = None
    logs: list[str] = field(default_factory=list)
    started_at: str = field(default_factory=_utc_now)
    finished_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "stack_id": self.stack_id,
            "action": self.action,
            "command": self.command,
            "status": self.status,
            "exit_code": self.exit_code,
            "logs": self.logs,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


class StackManager:
    def __init__(self) -> None:
        self._tasks: dict[str, Task] = {}
        self._lock = threading.Lock()

    def list_stacks(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for stack in STACKS:
            services = self.inspect_stack(stack["id"])
            running = sum(1 for svc in services if svc.get("state") == "running")
            compose_dir = stack.get("compose_dir")
            modes = stack.get("build_modes") or []
            package_services: list[str] = []
            for mode in modes:
                modules = (mode.get("maven") or {}).get("modules") or {}
                for name in modules:
                    if name not in package_services:
                        package_services.append(name)
            items.append(
                {
                    "id": stack["id"],
                    "label": stack["label"],
                    "group": stack["group"],
                    "description": stack["description"],
                    "project": stack["project"],
                    "compose_dir": str(compose_dir) if compose_dir else "",
                    "service_count": len(services),
                    "running_count": running,
                    "services": services,
                    "package_services": package_services,
                    "build_modes": [
                        {
                            "id": mode["id"],
                            "label": mode["label"],
                            "hint": mode.get("hint", ""),
                            "default": bool(mode.get("default")),
                            "has_maven": bool(mode.get("maven")),
                        }
                        for mode in modes
                    ],
                }
            )
        return items

    def inspect_stack(self, stack_id: str) -> list[dict[str, Any]]:
        stack = _stack_by_id(stack_id)
        services: list[dict[str, Any]] = []
        # Cache ps results per compose root so shared projects are only queried once.
        live_cache: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
        for meta in stack.get("services", []):
            ctx = _compose_context(stack, meta)
            cache_key = (
                str(ctx["compose_dir"]),
                tuple(ctx["compose_files"]),
                ctx["project"],
                ctx["env_file"],
            )
            if cache_key not in live_cache:
                live_cache[cache_key] = self._compose_ps(ctx)
            live = live_cache[cache_key]
            live_item = next((item for item in live if item["name"] == meta["name"]), None)
            services.append(self._merge_service(meta, live_item))
        return services

    def _merge_service(self, meta: dict[str, Any], live: dict[str, Any] | None) -> dict[str, Any]:
        state = "stopped"
        status = "未运行"
        container_id = ""
        image = ""
        health = ""
        if live:
            state = live.get("state") or "stopped"
            status = live.get("status") or status
            container_id = live.get("id") or ""
            image = live.get("image") or ""
            health = live.get("health") or ""
        return {
            "name": meta["name"],
            "label": meta.get("label", meta["name"]),
            "port": meta.get("port"),
            "url": meta.get("url"),
            "state": state,
            "status": status,
            "container_id": container_id,
            "image": image,
            "health": health,
        }

    def _compose_ps(self, ctx: dict[str, Any]) -> list[dict[str, Any]]:
        compose_dir = ctx["compose_dir"]
        command = self._compose_command(ctx, ["ps", "--format", "json"])
        try:
            result = subprocess.run(
                command,
                cwd=compose_dir,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                env=self._command_env(),
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            return []

        if result.returncode != 0:
            return []

        items: list[dict[str, Any]] = []
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            items.append(self._normalize_ps(payload))
        return items

    def _normalize_ps(self, payload: dict[str, Any]) -> dict[str, Any]:
        service = payload.get("Service") or payload.get("Name") or ""
        state = (payload.get("State") or "").lower()
        health = payload.get("Health") or ""
        if state not in {"running", "restarting", "paused"}:
            state = "stopped"
        return {
            "name": service,
            "state": state,
            "status": payload.get("Status") or "",
            "id": payload.get("ID") or payload.get("Id") or "",
            "image": payload.get("Image") or "",
            "health": health,
        }

    def _compose_command(self, ctx: dict[str, Any], args: list[str]) -> list[str]:
        compose_dir: Path = ctx["compose_dir"]
        command = ["docker", "compose"]
        env_file = ctx.get("env_file")
        if env_file:
            command.extend(["--env-file", str(compose_dir / env_file)])
        for compose_file in ctx["compose_files"]:
            file_path = Path(compose_file)
            if not file_path.is_absolute():
                file_path = compose_dir / compose_file
            command.extend(["-f", str(file_path)])
        command.extend(["-p", ctx["project"], *args])
        return command

    def _command_env(self) -> dict[str, str]:
        env = os.environ.copy()
        env.setdefault("COMPOSE_CONVERT_WINDOWS_PATHS", "1")
        # Used by stack-panel/leidian-overrides/docker-compose.ops-local.yml
        env.setdefault("LEIDIAN_BACKEND_ROOT", str(LEIDIAN_BACKEND_ROOT))
        env.setdefault("OPS_LEIDIAN_OVERRIDES", str(OPS_LEIDIAN_OVERRIDES))
        return env

    def _build_cmd_args(self, action: str, service_args: list[str], tail: int) -> list[str]:
        if action == "up":
            return ["up", "-d", "--build", *service_args]
        if action == "build":
            args = ["build", *service_args]
            if not service_args:
                args.append("--pull")
            return args
        if action == "restart":
            return ["restart", *service_args]
        if action == "stop":
            return ["stop", *service_args]
        if action == "down":
            return ["down"]
        if action == "logs":
            return ["logs", "--tail", str(tail), *service_args]
        if action == "pull":
            return ["pull", *service_args]
        raise ValueError(f"Unsupported action: {action}")

    def _maven_prebuild_job(
        self,
        stack: dict[str, Any],
        mode: dict[str, Any],
        service_names: list[str],
    ) -> tuple[Path, list[str]] | None:
        maven = mode.get("maven") or {}
        module_map: dict[str, str] = maven.get("modules") or {}
        modules = [module_map[name] for name in service_names if name in module_map]
        # Preserve order, drop duplicates.
        ordered: list[str] = []
        for module in modules:
            if module not in ordered:
                ordered.append(module)
        if not ordered:
            return None

        image = maven.get("image") or "maven:3.9-eclipse-temurin-17"
        host_path = LEIDIAN_BACKEND_HOST_PATH
        compose_dir = Path(stack["compose_dir"])
        command = [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{host_path}:/app",
            "-w",
            "/app",
            image,
            "mvn",
            "-pl",
            ",".join(ordered),
            "-am",
            "package",
            "-DskipTests",
            "-ntp",
        ]
        return compose_dir, command

    def start_action(
        self,
        stack_id: str,
        action: str,
        services: list[str] | None = None,
        tail: int = 120,
        build_mode: str | None = None,
    ) -> Task:
        stack = _stack_by_id(stack_id)
        mode = _resolve_build_mode(stack, build_mode)
        selected = list(services or [])
        metas = stack.get("services", [])
        if selected:
            metas = [meta for meta in metas if meta["name"] in selected]
            if not metas:
                raise ValueError("No matching services in stack")

        # Group by compose root so one stack can span multiple compose files.
        groups: dict[tuple[Any, ...], dict[str, Any]] = {}
        for meta in metas:
            ctx = _compose_context(stack, meta, build_mode=mode["id"] if mode else None)
            key = (
                str(ctx["compose_dir"]),
                tuple(ctx["compose_files"]),
                ctx["project"],
                ctx["env_file"],
            )
            bucket = groups.setdefault(key, {"ctx": ctx, "names": []})
            bucket["names"].append(meta["name"])

        jobs: list[tuple[Path, list[str]]] = []
        command_labels: list[str] = []

        service_names = [meta["name"] for meta in metas]

        if action == "package":
            # Prefer the selected mode's maven config; fall back to any mode that has it.
            maven_mode = mode if mode and mode.get("maven") else None
            if not maven_mode:
                maven_mode = next(
                    (item for item in (stack.get("build_modes") or []) if item.get("maven")),
                    None,
                )
            if not maven_mode:
                raise ValueError("当前栈不支持 Maven 打包")
            maven_job = self._maven_prebuild_job(
                stack,
                maven_mode,
                service_names,
            )
            if not maven_job:
                raise ValueError("所选服务没有可 Maven 打包的模块")
            jobs.append(maven_job)
            command_labels.append(" ".join(maven_job[1]))
        else:
            if mode and mode.get("maven") and action in {"up", "build"}:
                missing = _missing_local_jars(service_names)
                if missing:
                    raise ValueError(
                        "本机构建缺少 JAR，请先对以下服务执行「Maven 打包」: "
                        + ", ".join(missing)
                    )
            for bucket in groups.values():
                ctx = bucket["ctx"]
                names = bucket["names"]
                compose_dir: Path = ctx["compose_dir"]
                # Avoid compose down on shared projects (would tear down infra).
                if action == "down":
                    cmd_args = ["stop", *names]
                else:
                    cmd_args = self._build_cmd_args(action, names, tail)
                command = self._compose_command(ctx, cmd_args)
                jobs.append((compose_dir, command))
                command_labels.append(" ".join(command))

        task = Task(
            id=uuid.uuid4().hex[:12],
            stack_id=stack_id,
            action=f"{action}:{mode['id']}" if mode else action,
            command=" && ".join(command_labels),
        )
        with self._lock:
            self._tasks[task.id] = task
        thread = threading.Thread(
            target=self._run_jobs,
            args=(task, jobs),
            daemon=True,
        )
        thread.start()
        return task

    def _run_jobs(self, task: Task, jobs: list[tuple[Path, list[str]]]) -> None:
        exit_code = 0
        try:
            for index, (compose_dir, command) in enumerate(jobs):
                if len(jobs) > 1:
                    task.logs.append(f"$ ({index + 1}/{len(jobs)}) {' '.join(command)}")
                process = subprocess.Popen(
                    command,
                    cwd=compose_dir,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    env=self._command_env(),
                )
                assert process.stdout is not None
                for line in process.stdout:
                    task.logs.append(line.rstrip())
                code = process.wait()
                if code != 0:
                    exit_code = code
                    break
            task.exit_code = exit_code
            task.status = "done" if exit_code == 0 else "error"
        except Exception as exc:  # noqa: BLE001
            task.logs.append(f"[error] {exc}")
            task.exit_code = 1
            task.status = "error"
        finally:
            task.finished_at = _utc_now()

    def get_task(self, task_id: str) -> Task | None:
        with self._lock:
            return self._tasks.get(task_id)

    def recent_tasks(self, limit: int = 12) -> list[dict[str, Any]]:
        with self._lock:
            tasks = sorted(self._tasks.values(), key=lambda item: item.started_at, reverse=True)
        return [task.to_dict() for task in tasks[:limit]]

    def info(self) -> dict[str, Any]:
        docker_ok = False
        compose_ok = False
        version = ""
        try:
            result = subprocess.run(
                ["docker", "version", "--format", "{{.Server.Version}}"],
                capture_output=True,
                text=True,
                timeout=8,
                env=self._command_env(),
            )
            docker_ok = result.returncode == 0
            version = (result.stdout or "").strip()
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            docker_ok = False

        try:
            result = subprocess.run(
                ["docker", "compose", "version", "--short"],
                capture_output=True,
                text=True,
                timeout=8,
                env=self._command_env(),
            )
            compose_ok = result.returncode == 0
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            compose_ok = False

        return {
            "mytools_root": str(MYTOOLS_ROOT),
            "leidian_backend_root": str(LEIDIAN_BACKEND_ROOT),
            "leidian_backend_host_path": LEIDIAN_BACKEND_HOST_PATH,
            "leidian_backend_ready": (
                LEIDIAN_BACKEND_ROOT / "deployments" / "docker-compose" / "docker-compose.yml"
            ).is_file(),
            "docker_ok": docker_ok,
            "compose_ok": compose_ok,
            "docker_version": version,
            "stack_count": len(STACKS),
        }

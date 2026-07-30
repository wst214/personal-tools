"""Configurable server deployment workflow with visible per-step progress."""

from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import shlex
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

try:
    import paramiko
except ImportError:  # pragma: no cover - surfaced by preflight in minimal installs
    paramiko = None


APP_ROOT = Path(__file__).resolve().parent
DATA_DIR = APP_ROOT / "data"
ENVIRONMENTS_FILE = DATA_DIR / "environments.json"
ARTIFACTS_DIR = DATA_DIR / "artifacts"
SECRET_FIELDS = {"password", "private_key_passphrase", "sudo_password"}
HOST_PROJECT_PATH_ENV = "DEPLOY_PROJECT_HOST_PATH"
CONTAINER_PROJECT_PATH_ENV = "DEPLOY_PROJECT_ROOT"
DEFAULT_LOCAL_IMAGE_DIR = "exports"
DEFAULT_LOCAL_BUILD_COMPOSE_FILE = "deployments/docker-compose/docker-compose.local-build.yml"
DEFAULT_PATH_FIELDS = (
    "local_compose_file",
    "local_env_file",
    "local_image_dir",
    "remote_deploy_root",
    "remote_image_dir",
    "remote_compose_file",
    "remote_env_file",
)
ANSI_ESCAPE_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")


def _default_archive_file(service_name: str) -> str:
    base_name = service_name[:-8] if service_name.endswith("-service") else service_name
    return f"leidian-{base_name}-image.tar"

STEP_DEFINITIONS = [
    ("preflight", "环境检查", "校验本机构建条件、SSH、Docker、Compose 与远端目录"),
    ("build", "构建镜像", "按所选服务执行 Maven 打包，并用本地 jar 快速构建镜像"),
    ("package_upload", "上传镜像包", "默认直接上传 exports 中已有 tar；勾选构建时才重新 docker save"),
    ("sync_config", "同步 Compose / .env", "可选；默认不上传，覆盖前先由你勾选"),
    ("load", "加载镜像", "在服务器执行 docker load"),
    ("migration", "执行 db-migration", "可选；仅在有迁移变更时执行"),
    ("restart", "重启业务服务", "用远端 Compose 更新所选业务服务"),
    ("verify", "验证服务", "检查容器状态和已配置的健康检查地址"),
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def default_environment() -> dict[str, Any]:
    project_path = os.environ.get(HOST_PROJECT_PATH_ENV) or os.environ.get(
        CONTAINER_PROJECT_PATH_ENV, r"D:\workspace\leidian\leidan-pgsql"
    )
    return {
        "id": "leidian-current",
        "name": "雷电当前环境",
        "host": "150.158.98.85",
        "port": 22,
        "username": "ubuntu",
        "auth_method": "password",
        "password": "",
        "private_key_path": "",
        "private_key_passphrase": "",
        "use_sudo": False,
        "sudo_password": "",
        "project_path": project_path,
        "local_compose_file": "deployments/docker-compose/docker-compose.yml",
        "local_env_file": "deployments/docker-compose/.env",
        "local_image_dir": DEFAULT_LOCAL_IMAGE_DIR,
        "remote_deploy_root": "/opt/leidian/deploy",
        "remote_compose_file": "compose/s3/docker-compose.yml",
        "remote_env_file": "compose/s3/.env",
        "remote_image_dir": "/opt/leidian/deploy/images",
        "maven_command": "mvn -T 1C package -DskipTests -ntp",
        "migration_service": "db-migration",
        "services": [
            {
                "name": "gateway-service",
                "label": "Gateway",
                "image": "leidian/gateway-service:local",
                "archive_file": _default_archive_file("gateway-service"),
                "maven_module": "services/gateway-service",
                "health_url": "http://127.0.0.1:8080/actuator/health",
                "default_selected": True,
                "restart": True,
            },
            {
                "name": "system-service",
                "label": "System",
                "image": "leidian/system-service:local",
                "archive_file": _default_archive_file("system-service"),
                "maven_module": "services/system-service",
                "health_url": "http://127.0.0.1:8081/actuator/health",
                "default_selected": True,
                "restart": True,
            },
            {
                "name": "data-service",
                "label": "Data",
                "image": "leidian/data-service:local",
                "archive_file": _default_archive_file("data-service"),
                "maven_module": "services/data-service",
                "health_url": "http://127.0.0.1:8082/actuator/health",
                "default_selected": True,
                "restart": True,
            },
            {
                "name": "biz-service",
                "label": "Biz",
                "image": "leidian/biz-service:local",
                "archive_file": _default_archive_file("biz-service"),
                "maven_module": "services/biz-service",
                "health_url": "http://127.0.0.1:8083/actuator/health",
                "default_selected": True,
                "restart": True,
            },
            {
                "name": "task-service",
                "label": "Task",
                "image": "leidian/task-service:local",
                "archive_file": _default_archive_file("task-service"),
                "maven_module": "services/task-service",
                "health_url": "http://127.0.0.1:8084/actuator/health",
                "default_selected": True,
                "restart": True,
            },
            {
                "name": "db-migration",
                "label": "DB Migration",
                "image": "leidian/db-migration:local",
                "archive_file": _default_archive_file("db-migration"),
                "maven_module": "services/db-migration",
                "health_url": "",
                "default_selected": False,
                "restart": False,
            },
        ],
    }


def _copy_default() -> dict[str, Any]:
    return json.loads(json.dumps(default_environment()))


def _safe_id(value: str) -> str:
    normalized = "".join(char.lower() if char.isalnum() else "-" for char in value).strip("-")
    return normalized[:48] or uuid.uuid4().hex[:12]


def _redact(value: str, secrets: list[str]) -> str:
    result = value
    for secret in secrets:
        if secret:
            result = result.replace(secret, "***")
    return result


def _strip_ansi(value: str) -> str:
    return ANSI_ESCAPE_RE.sub("", value).replace("\r", "")


def _host_visible_project_path(path: str) -> str:
    """Return the host path that should be shown on the settings page.

    The panel runs in Docker. A Windows project such as
    D:/workspace/leidian/leidan-pgsql is mounted inside the panel container as
    /deploy-project. Users should see and edit the Windows path; the container
    path is only an execution detail.
    """
    candidate = str(path or "").strip()
    host_root = os.environ.get(HOST_PROJECT_PATH_ENV, "").strip()
    container_root = os.environ.get(CONTAINER_PROJECT_PATH_ENV, "").strip()
    if not candidate or not host_root or not container_root:
        return candidate
    candidate_norm = candidate.replace("\\", "/").rstrip("/")
    container_norm = container_root.replace("\\", "/").rstrip("/")
    if candidate_norm == container_norm:
        return host_root
    if candidate_norm.startswith(container_norm + "/"):
        suffix = candidate_norm[len(container_norm):].lstrip("/")
        return host_root.rstrip("\\/") + "/" + suffix
    return candidate


class EnvironmentStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()

    def _read(self) -> list[dict[str, Any]]:
        if not ENVIRONMENTS_FILE.is_file():
            return [_copy_default()]
        try:
            payload = json.loads(ENVIRONMENTS_FILE.read_text(encoding="utf-8"))
            environments = payload.get("environments", payload) if isinstance(payload, dict) else payload
            if not isinstance(environments, list):
                raise ValueError("environment list must be an array")
            return [self._normalize(item) for item in environments if isinstance(item, dict)] or [_copy_default()]
        except (OSError, ValueError, json.JSONDecodeError):
            return [_copy_default()]

    def _write(self, environments: list[dict[str, Any]]) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        temporary = ENVIRONMENTS_FILE.with_suffix(".tmp")
        temporary.write_text(
            json.dumps({"environments": environments}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.replace(ENVIRONMENTS_FILE)

    def _normalize(self, raw: dict[str, Any], existing: dict[str, Any] | None = None) -> dict[str, Any]:
        defaults = _copy_default()
        merged = json.loads(json.dumps(defaults))
        merged.update({key: value for key, value in raw.items() if key != "services"})
        merged["id"] = _safe_id(str(merged.get("id") or merged.get("name") or "environment"))
        merged["name"] = str(merged.get("name") or merged["id"])
        merged["host"] = str(merged.get("host") or "").strip()
        merged["username"] = str(merged.get("username") or "").strip()
        merged["project_path"] = _host_visible_project_path(str(merged.get("project_path") or defaults["project_path"]).strip())
        merged["port"] = int(merged.get("port") or 22)
        merged["use_sudo"] = bool(merged.get("use_sudo"))
        merged["auth_method"] = str(merged.get("auth_method") or "password")
        for field_name in DEFAULT_PATH_FIELDS:
            merged[field_name] = str(merged.get(field_name) or "").strip() or defaults[field_name]
        for field_name in SECRET_FIELDS:
            if not str(raw.get(field_name) or "") and existing:
                merged[field_name] = existing.get(field_name, "")
            else:
                merged[field_name] = str(merged.get(field_name) or "")
        services = raw.get("services")
        if not isinstance(services, list) or not services:
            services = existing.get("services") if existing else merged["services"]
        merged["services"] = [self._normalize_service(item) for item in services if isinstance(item, dict)]
        if not merged["services"]:
            raise ValueError("至少配置一个服务")
        return merged

    @staticmethod
    def _normalize_service(raw: dict[str, Any]) -> dict[str, Any]:
        name = str(raw.get("name") or "").strip()
        if not name:
            raise ValueError("服务名称不能为空")
        return {
            "name": name,
            "label": str(raw.get("label") or name),
            "image": str(raw.get("image") or "").strip(),
            "archive_file": str(raw.get("archive_file") or _default_archive_file(name)).strip() or _default_archive_file(name),
            "maven_module": str(raw.get("maven_module") or "").strip(),
            "health_url": str(raw.get("health_url") or "").strip(),
            "default_selected": bool(raw.get("default_selected")),
            "restart": bool(raw.get("restart", True)),
        }

    def list(self, masked: bool = True) -> list[dict[str, Any]]:
        with self._lock:
            items = self._read()
        return [self._public(item) if masked else item for item in items]

    def get(self, environment_id: str, masked: bool = False) -> dict[str, Any]:
        with self._lock:
            for item in self._read():
                if item["id"] == environment_id:
                    return self._public(item) if masked else item
        raise KeyError(environment_id)

    def save(self, raw: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            items = self._read()
            requested_id = _safe_id(str(raw.get("id") or raw.get("name") or "environment"))
            existing_index = next((index for index, item in enumerate(items) if item["id"] == requested_id), None)
            existing = items[existing_index] if existing_index is not None else None
            normalized = self._normalize({**raw, "id": requested_id}, existing)
            if existing_index is None:
                items.append(normalized)
            else:
                items[existing_index] = normalized
            self._write(items)
        return self._public(normalized)

    def delete(self, environment_id: str) -> None:
        with self._lock:
            items = self._read()
            remaining = [item for item in items if item["id"] != environment_id]
            if len(remaining) == len(items):
                raise KeyError(environment_id)
            self._write(remaining or [_copy_default()])

    @staticmethod
    def _public(environment: dict[str, Any]) -> dict[str, Any]:
        payload = json.loads(json.dumps(environment))
        payload["project_path"] = _host_visible_project_path(str(payload.get("project_path") or ""))
        for field_name in SECRET_FIELDS:
            payload[f"{field_name}_configured"] = bool(payload.get(field_name))
            payload[field_name] = ""
        return payload


@dataclass
class DeploymentStep:
    id: str
    label: str
    description: str
    optional: bool
    status: str = "pending"
    logs: list[str] = field(default_factory=list)
    started_at: str | None = None
    finished_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "optional": self.optional,
            "status": self.status,
            "logs": self.logs,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


@dataclass
class DeploymentTask:
    id: str
    environment_id: str
    environment_name: str
    services: list[str]
    selected_steps: list[str]
    steps: list[DeploymentStep]
    status: str = "running"
    error: str = ""
    archive_paths: list[str] = field(default_factory=list)
    archive_path: str = ""
    started_at: str = field(default_factory=utc_now)
    finished_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "environment_id": self.environment_id,
            "environment_name": self.environment_name,
            "services": self.services,
            "selected_steps": self.selected_steps,
            "steps": [step.to_dict() for step in self.steps],
            "status": self.status,
            "error": self.error,
            "archive_paths": self.archive_paths,
            "archive_path": self.archive_path,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


class RemoteSession:
    def __init__(self, environment: dict[str, Any], log: Callable[[str], None]) -> None:
        self.environment = environment
        self.log = log
        self.client: Any = None

    def __enter__(self) -> "RemoteSession":
        if paramiko is None:
            raise RuntimeError("缺少 paramiko，请执行 pip install -r requirements.txt")
        parameters: dict[str, Any] = {
            "hostname": self.environment["host"],
            "port": self.environment["port"],
            "username": self.environment["username"],
            "timeout": 15,
            "banner_timeout": 15,
            "auth_timeout": 15,
            "allow_agent": False,
            "look_for_keys": False,
        }
        if self.environment.get("auth_method") == "key":
            key_path = str(self.environment.get("private_key_path") or "")
            if not key_path:
                raise RuntimeError("已选择密钥登录，但未填写私钥路径")
            parameters["key_filename"] = key_path
            if self.environment.get("private_key_passphrase"):
                parameters["passphrase"] = self.environment["private_key_passphrase"]
        elif self.environment.get("password"):
            parameters["password"] = self.environment["password"]
        else:
            raise RuntimeError("请为当前环境配置 SSH 密码或私钥")
        self.client = paramiko.SSHClient()
        self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self.client.connect(**parameters)
        return self

    def __exit__(self, *_: Any) -> None:
        if self.client:
            self.client.close()

    def run(self, command: str, sudo: bool = False, timeout: int = 1800) -> str:
        if not self.client:
            raise RuntimeError("SSH 尚未连接")
        wrapped = f"bash -lc {shlex.quote(command)}"
        if sudo or self.environment.get("use_sudo"):
            if not self.environment.get("sudo_password"):
                raise RuntimeError("远程操作需要 sudo，请填写 sudo 密码或关闭使用 sudo")
            wrapped = f"sudo -S -p '' {wrapped}"
        self.log(f"$ {command}")
        stdin, stdout, _ = self.client.exec_command(wrapped, timeout=timeout)
        channel = stdout.channel
        channel.set_combine_stderr(True)
        if sudo or self.environment.get("use_sudo"):
            stdin.write(f"{self.environment['sudo_password']}\n")
            stdin.flush()
        started = time.monotonic()
        pending = ""
        output_lines: list[str] = []
        while not channel.exit_status_ready() or channel.recv_ready():
            if time.monotonic() - started > timeout:
                channel.close()
                raise RuntimeError(f"远程命令超时（{timeout}s）")
            if channel.recv_ready():
                pending += channel.recv(4096).decode("utf-8", errors="replace")
                while "\n" in pending:
                    line, pending = pending.split("\n", 1)
                    clean_line = _strip_ansi(line.rstrip())
                    output_lines.append(clean_line)
                    self.log(clean_line)
            else:
                time.sleep(0.08)
        if pending.strip():
            clean_pending = _strip_ansi(pending.rstrip())
            output_lines.append(clean_pending)
            self.log(clean_pending)
        exit_code = channel.recv_exit_status()
        if exit_code != 0:
            raise RuntimeError(f"远程命令退出码：{exit_code}")
        return "\n".join(output_lines)

    def upload(self, local_path: Path, remote_path: str) -> None:
        if not self.client:
            raise RuntimeError("SSH 尚未连接")
        self.log(f"上传 {local_path.name} → {remote_path}")
        sent_percent = -1

        def callback(sent: int, total: int) -> None:
            nonlocal sent_percent
            percent = int(sent * 100 / total) if total else 100
            if percent in {0, 100} or percent - sent_percent >= 10:
                sent_percent = percent
                self.log(f"上传进度：{percent}% ({sent}/{total} bytes)")

        sftp = self.client.open_sftp()
        try:
            sftp.put(str(local_path), remote_path, callback=callback)
        finally:
            sftp.close()


class DeploymentManager:
    def __init__(self, store: EnvironmentStore | None = None) -> None:
        self.store = store or EnvironmentStore()
        self._tasks: dict[str, DeploymentTask] = {}
        self._lock = threading.Lock()

    def info(self) -> dict[str, Any]:
        return {
            "project_root": str(APP_ROOT),
            "data_path": str(DATA_DIR),
            "docker_available": shutil.which("docker") is not None,
            "paramiko_available": paramiko is not None,
            "environment_count": len(self.store.list()),
        }

    def start(self, environment_id: str, services: list[str], selected_steps: list[str]) -> DeploymentTask:
        environment = self.store.get(environment_id)
        known_steps = {item[0] for item in STEP_DEFINITIONS}
        selected_steps = [step for step in selected_steps if step in known_steps]
        if not selected_steps:
            raise ValueError("至少选择一个部署步骤")
        service_map = {item["name"]: item for item in environment["services"]}
        selected_services = [name for name in services if name in service_map]
        if not selected_services:
            selected_services = [item["name"] for item in environment["services"] if item["default_selected"]]
        if not selected_services:
            raise ValueError("至少选择一个服务")
        steps = [
            DeploymentStep(step_id, label, description, step_id in {"sync_config", "migration"})
            for step_id, label, description in STEP_DEFINITIONS
        ]
        task = DeploymentTask(
            id=uuid.uuid4().hex[:12],
            environment_id=environment_id,
            environment_name=environment["name"],
            services=selected_services,
            selected_steps=selected_steps,
            steps=steps,
        )
        with self._lock:
            if any(item.status == "running" for item in self._tasks.values()):
                raise ValueError("已有部署任务正在执行，请等待完成后再开始")
            self._tasks[task.id] = task
        threading.Thread(
            target=self._run_task,
            args=(task, environment, service_map),
            daemon=True,
        ).start()
        return task

    def get_task(self, task_id: str) -> DeploymentTask | None:
        with self._lock:
            return self._tasks.get(task_id)

    def recent_tasks(self, limit: int = 12) -> list[dict[str, Any]]:
        with self._lock:
            tasks = sorted(self._tasks.values(), key=lambda item: item.started_at, reverse=True)
        return [task.to_dict() for task in tasks[:limit]]

    def _run_task(self, task: DeploymentTask, environment: dict[str, Any], service_map: dict[str, Any]) -> None:
        secrets = [str(environment.get(field) or "") for field in SECRET_FIELDS]

        def log(step: DeploymentStep, message: str) -> None:
            clean = _strip_ansi(_redact(str(message), secrets))
            step.logs.append(clean)

        context = {"remote_archives": [], "local_archives": []}
        try:
            for step in task.steps:
                if step.id not in task.selected_steps:
                    step.status = "skipped"
                    continue
                step.status = "running"
                step.started_at = utc_now()
                log(step, f"开始：{step.label}")
                self._execute_step(step, task, environment, service_map, context, log)
                step.status = "done"
                step.finished_at = utc_now()
                log(step, f"完成：{step.label}")
            task.status = "done"
        except Exception as exc:  # noqa: BLE001
            task.status = "error"
            task.error = _redact(str(exc), secrets)
            current = next((step for step in task.steps if step.status == "running"), None)
            if current:
                current.status = "error"
                current.finished_at = utc_now()
                log(current, f"[失败] {task.error}")
            for step in task.steps:
                if step.status == "pending" and step.id in task.selected_steps:
                    step.status = "skipped"
                    step.logs.append("前序步骤失败，未执行")
        finally:
            task.finished_at = utc_now()

    def _execute_step(
        self,
        step: DeploymentStep,
        task: DeploymentTask,
        environment: dict[str, Any],
        service_map: dict[str, Any],
        context: dict[str, Any],
        log: Callable[[DeploymentStep, str], None],
    ) -> None:
        selected = [service_map[name] for name in task.services]
        step_log = lambda message: log(step, message)
        if step.id == "preflight":
            self._preflight(environment, task, step_log)
        elif step.id == "build":
            self._build(environment, selected, step_log)
        elif step.id == "package_upload":
            archives = self._package(environment, selected, task.id, step_log, rebuild="build" in task.selected_steps)
            task.archive_paths = [str(archive) for archive in archives]
            task.archive_path = task.archive_paths[0] if task.archive_paths else ""
            with RemoteSession(environment, step_log) as remote:
                remote.run(f"mkdir -p {shlex.quote(environment['remote_image_dir'])}")
                remote_archives: list[str] = []
                for archive in archives:
                    temporary = f"/tmp/{archive.name}.{task.id}"
                    remote.upload(archive, temporary)
                    remote_archive = self._remote_archive_path(environment, archive.name)
                    remote.run(f"mv {shlex.quote(temporary)} {shlex.quote(remote_archive)}")
                    remote_archives.append(remote_archive)
                context["remote_archives"] = remote_archives
        elif step.id == "sync_config":
            self._sync_config(environment, task.id, step_log)
        elif step.id == "load":
            with RemoteSession(environment, step_log) as remote:
                for remote_archive in context.get("remote_archives", []):
                    remote.run(f"docker load -i {shlex.quote(remote_archive)}")
        elif step.id == "migration":
            self._migration(environment, step_log)
        elif step.id == "restart":
            restartable = [item["name"] for item in selected if item.get("restart")]
            if not restartable:
                step_log("所选服务均不是常驻业务服务，跳过重启")
                return
            with RemoteSession(environment, step_log) as remote:
                remote.run(f"{self._remote_compose(environment)} up -d --no-deps {' '.join(shlex.quote(name) for name in restartable)}")
        elif step.id == "verify":
            self._verify(environment, selected, step_log)

    def _preflight(self, environment: dict[str, Any], task: DeploymentTask, log: Callable[[str], None]) -> None:
        project = self._project_root(environment)
        configured_project = _host_visible_project_path(str(environment.get("project_path") or ""))
        if not project.is_dir():
            raise RuntimeError(f"本地项目目录不存在：{project}")
        log(f"本机项目目录：{configured_project}")
        if str(project) != configured_project:
            log(f"容器执行目录：{project}（Docker 挂载映射自动使用）")
        if "build" in task.selected_steps:
            self._local_command(["docker", "version", "--format", "{{.Server.Version}}"], project, log)
            self._local_command(["docker", "compose", "version", "--short"], project, log)
        for relative in (environment["local_compose_file"], environment["local_env_file"]):
            path = self._project_path(environment, relative)
            if not path.is_file():
                log(f"[提示] 本地配置文件不存在：{path}")
            else:
                log(f"本地文件可用：{path}")
        with RemoteSession(environment, log) as remote:
            remote.run("docker version --format '{{.Server.Version}}'")
            remote.run("docker compose version --short")
            remote.run(f"test -d {shlex.quote(environment['remote_deploy_root'])}")
            remote.run(f"test -f {shlex.quote(self._remote_path(environment, environment['remote_compose_file']))}")
            remote.run(f"test -f {shlex.quote(self._remote_path(environment, environment['remote_env_file']))}")
            self._log_config_difference(environment, remote, log)

    def _build(self, environment: dict[str, Any], services: list[dict[str, Any]], log: Callable[[str], None]) -> None:
        project = self._project_root(environment)
        modules = [item["maven_module"] for item in services if item.get("maven_module")]
        if environment.get("maven_command"):
            command = environment["maven_command"]
            if modules:
                module_arg = ",".join(dict.fromkeys(modules))
                if command.startswith("mvn clean package") or command.startswith("mvn package") or command.startswith("mvn -T"):
                    command = f"mvn -T 1C -pl {module_arg} -am package -DskipTests -ntp"
            self._local_shell(command, project, log)
        compose_command = self._local_compose(environment, ["build", *[item["name"] for item in services]], include_local_build=True)
        self._local_command(compose_command, project, log)

    def _package(self, environment: dict[str, Any], services: list[dict[str, Any]], task_id: str, log: Callable[[str], None], rebuild: bool) -> list[Path]:
        if not services:
            raise RuntimeError("所选服务没有配置镜像名称")
        export_dir = self._project_path(environment, environment["local_image_dir"])
        if rebuild:
            export_dir.mkdir(parents=True, exist_ok=True)
        archives: list[Path] = []
        for service in services:
            archive_file = str(service.get("archive_file") or _default_archive_file(service["name"]))
            archive = export_dir / archive_file
            if rebuild:
                image = str(service.get("image") or "").strip()
                if not image:
                    raise RuntimeError(f"服务 {service['name']} 没有配置镜像名称")
                self._local_command(["docker", "save", "-o", str(archive), image], self._project_root(environment), log)
                log(f"{service['name']} 镜像包已生成：{archive}")
            else:
                if not archive.is_file():
                    raise RuntimeError(f"未找到已有镜像包：{archive}。如果需要重新生成，请勾选“构建镜像”。")
                log(f"{service['name']} 使用已有镜像包：{archive}")
            archives.append(archive)
        return archives

    def _sync_config(self, environment: dict[str, Any], task_id: str, log: Callable[[str], None]) -> None:
        entries = [
            (environment["local_compose_file"], environment["remote_compose_file"]),
            (environment["local_env_file"], environment["remote_env_file"]),
        ]
        with RemoteSession(environment, log) as remote:
            for local_relative, remote_relative in entries:
                local_path = self._project_path(environment, local_relative)
                if not local_path.is_file():
                    raise RuntimeError(f"待同步文件不存在：{local_path}")
                destination = self._remote_path(environment, remote_relative)
                temporary = f"/tmp/{local_path.name}.{task_id}"
                remote.upload(local_path, temporary)
                remote.run(f"mkdir -p {shlex.quote(posixpath.dirname(destination))}")
                remote.run(f"mv {shlex.quote(temporary)} {shlex.quote(destination)}")

    def _migration(self, environment: dict[str, Any], log: Callable[[str], None]) -> None:
        service = str(environment.get("migration_service") or "db-migration")
        with RemoteSession(environment, log) as remote:
            remote.run(f"{self._remote_compose(environment)} up {shlex.quote(service)}")
            remote.run(f"{self._remote_compose(environment)} ps -a {shlex.quote(service)}")

    def _verify(self, environment: dict[str, Any], services: list[dict[str, Any]], log: Callable[[str], None]) -> None:
        restartable = [item["name"] for item in services if item.get("restart")]
        with RemoteSession(environment, log) as remote:
            if restartable:
                remote.run(f"{self._remote_compose(environment)} ps {' '.join(shlex.quote(name) for name in restartable)}")
            for service in services:
                health_url = service.get("health_url")
                if health_url:
                    try:
                        self._verify_health(remote, service, health_url, log)
                    except RuntimeError:
                        remote.run(f"{self._remote_compose(environment)} logs --tail 120 {shlex.quote(service['name'])} || true", timeout=60)
                        raise

    @staticmethod
    def _verify_health(remote: RemoteSession, service: dict[str, Any], health_url: str, log: Callable[[str], None]) -> None:
        label = str(service.get("label") or service.get("name") or health_url)
        log(f"等待健康检查：{label} ({health_url})")
        remote.run(
            "for i in $(seq 1 18); do "
            f"if curl -fsS --max-time 5 {shlex.quote(health_url)}; then exit 0; fi; "
            "echo '等待服务启动中... 第 '$i'/18 次'; "
            "sleep 5; "
            "done; "
            "exit 1",
            timeout=120,
        )
        log(f"健康检查通过：{label} ({health_url})")

    def _log_config_difference(self, environment: dict[str, Any], remote: RemoteSession, log: Callable[[str], None]) -> None:
        for local_relative, remote_relative, label in [
            (environment["local_compose_file"], environment["remote_compose_file"], "Compose"),
            (environment["local_env_file"], environment["remote_env_file"], ".env"),
        ]:
            local_path = self._project_path(environment, local_relative)
            if not local_path.is_file():
                continue
            digest = hashlib.sha256(local_path.read_bytes()).hexdigest()
            remote_path = self._remote_path(environment, remote_relative)
            remote_output = remote.run(f"sha256sum {shlex.quote(remote_path)}", timeout=30)
            remote_digest = remote_output.strip().split()[0] if remote_output.strip() else ""
            if remote_digest == digest:
                log(f"{label} 与远端一致，无需同步。")
            else:
                log(f"[提示] {label} 与远端不同；如需覆盖远端，请勾选“同步 Compose / .env”。")

    def _local_compose(self, environment: dict[str, Any], args: list[str], include_local_build: bool = False) -> list[str]:
        command = ["docker", "compose"]
        env_file = self._project_path(environment, environment["local_env_file"])
        compose_file = self._project_path(environment, environment["local_compose_file"])
        if env_file.is_file():
            command.extend(["--env-file", str(env_file)])
        command.extend(["-f", str(compose_file)])
        if include_local_build:
            local_build_file = self._project_path(environment, DEFAULT_LOCAL_BUILD_COMPOSE_FILE)
            if local_build_file.is_file():
                command.extend(["-f", str(local_build_file)])
            else:
                command.append("--progress=plain")
        command.extend(args)
        return command

    @staticmethod
    def _local_command(command: list[str], cwd: Path, log: Callable[[str], None]) -> None:
        log("$ " + " ".join(shlex.quote(part) for part in command))
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env={**os.environ, "NO_COLOR": "1", "TERM": "dumb", "CLICOLOR": "0"},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert process.stdout is not None
        for line in process.stdout:
            log(line.rstrip())
        if process.wait() != 0:
            raise RuntimeError(f"本地命令退出码：{process.returncode}")

    @staticmethod
    def _local_shell(command: str, cwd: Path, log: Callable[[str], None]) -> None:
        log(f"$ {command}")
        process = subprocess.Popen(
            command,
            cwd=cwd,
            shell=True,
            env={**os.environ, "NO_COLOR": "1", "TERM": "dumb", "CLICOLOR": "0"},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert process.stdout is not None
        for line in process.stdout:
            log(line.rstrip())
        if process.wait() != 0:
            raise RuntimeError(f"本地命令退出码：{process.returncode}")

    @staticmethod
    def _project_path(environment: dict[str, Any], path: str) -> Path:
        candidate_text = str(path or "").strip()
        if not candidate_text:
            return Path(environment["project_path"])
        if DeploymentManager._looks_like_windows_absolute(candidate_text):
            host_root = os.environ.get(HOST_PROJECT_PATH_ENV, "").strip()
            container_root = os.environ.get(CONTAINER_PROJECT_PATH_ENV, "").strip()
            if host_root:
                candidate_norm = candidate_text.replace("/", "\\").rstrip("\\")
                host_norm = host_root.replace("/", "\\").rstrip("\\")
                if candidate_norm.lower() == host_norm.lower():
                    return Path(container_root or candidate_text)
                if candidate_norm.lower().startswith(host_norm.lower() + "\\"):
                    suffix = candidate_norm[len(host_norm):].lstrip("\\/")
                    relative = suffix.replace("\\", "/")
                    base = Path(container_root or candidate_text)
                    return base / Path(relative) if relative else base
            return Path(candidate_text)
        candidate = Path(candidate_text)
        if candidate.is_absolute():
            return candidate
        project_path = str(environment.get("project_path") or "").strip()
        if project_path and project_path != candidate_text:
            return DeploymentManager._project_path(environment, project_path) / candidate
        return Path(project_path or ".") / candidate

    @staticmethod
    def _looks_like_windows_absolute(path: str) -> bool:
        return bool(re.match(r"^[A-Za-z]:[\\/]", path))

    def _project_root(self, environment: dict[str, Any]) -> Path:
        return self._project_path(environment, environment["project_path"])

    @staticmethod
    def _remote_path(environment: dict[str, Any], path: str) -> str:
        return path if path.startswith("/") else f"{environment['remote_deploy_root'].rstrip('/')}/{path.lstrip('/')}"

    def _remote_archive_path(self, environment: dict[str, Any], archive_name: str) -> str:
        return f"{environment['remote_image_dir'].rstrip('/')}/{archive_name}"

    def _remote_compose(self, environment: dict[str, Any]) -> str:
        compose_file = self._remote_path(environment, environment["remote_compose_file"])
        env_file = self._remote_path(environment, environment["remote_env_file"])
        return (
            f"cd {shlex.quote(environment['remote_deploy_root'])} && "
            f"docker compose --env-file {shlex.quote(env_file)} -f {shlex.quote(compose_file)}"
        )

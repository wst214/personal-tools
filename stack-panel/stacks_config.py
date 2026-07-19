"""Compose project definitions for the local stack panel."""

from __future__ import annotations

import os
from pathlib import Path

MYTOOLS_ROOT = Path(os.environ.get("MYTOOLS_ROOT", Path(__file__).resolve().parent.parent)).resolve()


def _default_leidian_backend() -> Path:
    env = os.environ.get("LEIDIAN_BACKEND_ROOT")
    if env:
        return Path(env).resolve()
    candidates = [
        Path("/leidian-backend"),
        Path(r"D:\workspace\leidian\leidian-backend"),
        MYTOOLS_ROOT.parent / "workspace" / "leidian" / "leidian-backend",
        MYTOOLS_ROOT.parent / "leidian" / "leidian-backend",
    ]
    for path in candidates:
        compose = path / "deployments" / "docker-compose" / "docker-compose.yml"
        if compose.is_file():
            return path.resolve()
    return candidates[1]


LEIDIAN_BACKEND_ROOT = _default_leidian_backend()
LEIDIAN_BACKEND_HOST_PATH = os.environ.get(
    "LEIDIAN_BACKEND_HOST_PATH",
    r"D:/workspace/leidian/leidian-backend",
)
LEIDIAN_COMPOSE_DIR = LEIDIAN_BACKEND_ROOT / "deployments" / "docker-compose"

# Services that need prebuilt jars in "本机构建" mode.
# system/data/biz: leidian docker-compose.local-build.yml
# gateway/task: stack-panel/leidian-overrides/docker-compose.ops-local.yml
LEIDIAN_LOCAL_JAR_MODULES = {
    "system-service": "services/system-service",
    "data-service": "services/data-service",
    "biz-service": "services/biz-service",
    "gateway-service": "services/gateway-service",
    "task-service": "services/task-service",
}

OPS_LOCAL_COMPOSE = Path(__file__).resolve().parent / "leidian-overrides" / "docker-compose.ops-local.yml"

STACKS = [
    {
        "id": "mytools-stack",
        "label": "MyTools 主栈",
        "group": "core",
        "compose_dir": MYTOOLS_ROOT,
        "compose_file": "docker-compose.yml",
        "project": "mytools-stack",
        "description": "个人工作台、Linux 远程面板、隧道面板与本面板",
        "services": [
            {
                "name": "mytools-personal-dev-site",
                "label": "个人开发工作台",
                "port": 8090,
                "url": "http://localhost:8090",
            },
            {
                "name": "mytools-linux-remote-panel",
                "label": "Linux 远程面板",
                "port": 5757,
                "url": "http://localhost:5757",
            },
            {
                "name": "mytools-tunnel-panel",
                "label": "隧道控制面板",
                "port": 5760,
                "url": "http://localhost:5760",
            },
            {
                "name": "mytools-ops-panel",
                "label": "Stack 运维面板",
                "port": 5770,
                "url": "http://localhost:5770",
            },
        ],
    },
    {
        "id": "leidian-tools",
        "label": "雷电工具台",
        "group": "leidian",
        "project": "leidian-tools",
        "description": "PERF 压测与协议解析，统一管理",
        "services": [
            {
                "name": "perf-web",
                "label": "PERF Web",
                "port": 8100,
                "url": "http://localhost:8100",
                "compose_dir": MYTOOLS_ROOT / "leidian-perf-web",
                "compose_file": "docker-compose.yml",
            },
            {
                "name": "leidian-protocol-parse",
                "label": "协议解析服务",
                "port": 9000,
                "url": "http://localhost:9000",
                "compose_dir": MYTOOLS_ROOT / "leidian-protocol-parse",
                "compose_file": "docker-compose.yml",
            },
        ],
    },
    {
        "id": "leidian-p0",
        "label": "雷电后端 P0",
        "group": "leidian",
        "compose_dir": LEIDIAN_COMPOSE_DIR,
        "compose_files": [
            "docker-compose.yml",
            "docker-compose.local-build.yml",
        ],
        "env_file": ".env",
        "project": "leidian-p0",
        "description": "Gateway / System / Data / Biz / Task 五个后端服务",
        "build_modes": [
            {
                "id": "local",
                "label": "本机构建",
                "hint": "用 local-build + 面板叠层构建；5 个服务均需先「Maven 打包」",
                "default": True,
                "compose_files": [
                    "docker-compose.yml",
                    "docker-compose.local-build.yml",
                    # Absolute path: ops-panel overlay for gateway/task local JAR builds
                    str(OPS_LOCAL_COMPOSE),
                ],
                "maven": {
                    "image": "maven:3.9-eclipse-temurin-17",
                    "modules": LEIDIAN_LOCAL_JAR_MODULES,
                },
            },
            {
                "id": "docker",
                "label": "容器构建",
                "hint": "Dockerfile 内完整 Maven 构建（慢，无需本机 JAR）",
                "compose_files": [
                    "docker-compose.yml",
                ],
            },
        ],
        "services": [
            {
                "name": "gateway-service",
                "label": "Gateway",
                "port": 8080,
                "url": "http://localhost:8080",
            },
            {
                "name": "system-service",
                "label": "System",
                "port": 8081,
                "url": "http://localhost:8081/actuator/health",
            },
            {
                "name": "data-service",
                "label": "Data",
                "port": 8082,
                "url": "http://localhost:8082/actuator/health",
            },
            {
                "name": "biz-service",
                "label": "Biz",
                "port": 8083,
                "url": "http://localhost:8083/actuator/health",
            },
            {
                "name": "task-service",
                "label": "Task",
                "port": 8084,
                "url": "http://localhost:8084/actuator/health",
            },
        ],
    },
]

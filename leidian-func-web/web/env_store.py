"""被测环境：网关根地址 + 多服务前缀 + 启用环境 + 登录取凭证。"""
from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

TOOL_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_PATH = TOOL_ROOT / "data" / "env.json"

DEFAULT_LOGIN_PATH = "data.accessToken"
DEFAULT_LOGIN_API = "/auth/login"

# 网关前缀（与项目路由一致）
SERVICE_DEFS = [
    {"id": "system", "name": "system-service", "prefix": "/api/system"},
    {"id": "data", "name": "data-service", "prefix": "/api/data"},
    {"id": "biz", "name": "biz-service", "prefix": "/api/biz"},
    {"id": "task", "name": "task-service", "prefix": "/api/task"},
    {"id": "radar", "name": "雷达帧", "prefix": "/api/v1/radar"},
    {"id": "open", "name": "开放接口", "prefix": "/api/open"},
]

DEFAULT_PREFIXES = {s["id"]: s["prefix"] for s in SERVICE_DEFS}
SERVICE_IDS = tuple(DEFAULT_PREFIXES.keys())

_IN_DOCKER = Path("/.dockerenv").exists()


def _rewrite_gateway_for_runtime(gateway: str) -> str:
    """Docker 内 localhost/127.0.0.1 指向容器自身；改为 host.docker.internal 访问宿主机。"""
    text = str(gateway or "").strip().rstrip("/")
    if not text or not _IN_DOCKER:
        return text
    parsed = urlparse(text)
    host = (parsed.hostname or "").lower()
    if host not in ("localhost", "127.0.0.1", "::1"):
        return text
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme or 'http'}://host.docker.internal{port}"


def _new_id() -> str:
    return uuid.uuid4().hex[:8]


def _norm_prefix(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if not text.startswith("/"):
        text = "/" + text
    return text.rstrip("/") or ""


def _default_prefixes() -> dict[str, str]:
    return dict(DEFAULT_PREFIXES)


def _normalize_prefixes(raw: Any) -> dict[str, str]:
    src = raw if isinstance(raw, dict) else {}
    out = _default_prefixes()
    for key in SERVICE_IDS:
        if key in src:
            out[key] = _norm_prefix(str(src.get(key) or ""))
    return out


def _split_legacy_base(base_url: str) -> tuple[str, dict[str, str]]:
    """把旧 baseUrl（常带 /api/biz）拆成 gateway + prefixes。"""
    prefixes = _default_prefixes()
    text = str(base_url or "").rstrip("/")
    if not text:
        return "", prefixes
    for sid, prefix in DEFAULT_PREFIXES.items():
        if text.endswith(prefix):
            return text[: -len(prefix)].rstrip("/"), {**prefixes, sid: prefix}
    # 未匹配已知前缀：整体当作 gateway，前缀保持默认
    return text, prefixes


def _blank_env(name: str = "新环境") -> dict[str, Any]:
    return {
        "id": _new_id(),
        "name": name,
        "gateway": "",
        "prefixes": _default_prefixes(),
        "credential": "",
        "username": "",
        "password": "",
        "loginApi": DEFAULT_LOGIN_API,
        "tokenPath": DEFAULT_LOGIN_PATH,
        "kafkaBrokers": "127.0.0.1:9092",
        # Docker 同网默认连 leidian-minio:9000；宿主机可改 http://127.0.0.1:19000
        "minioEndpoint": "http://leidian-minio:9000",
        "minioAccessKey": "minioadmin",
        "minioSecretKey": "minioadmin",
        "minioRadarBucket": "leidian-frame",
    }


def _normalize_env(raw: dict[str, Any] | None) -> dict[str, Any]:
    src = raw or {}
    env = _blank_env(str(src.get("name") or "未命名"))
    if src.get("id"):
        env["id"] = str(src["id"])

    gateway = str(src.get("gateway") or "").rstrip("/")
    prefixes = _normalize_prefixes(src.get("prefixes"))

    # 兼容旧字段 baseUrl / loginUrl
    if not gateway and src.get("baseUrl"):
        gateway, migrated = _split_legacy_base(str(src.get("baseUrl") or ""))
        if not src.get("prefixes"):
            prefixes = migrated

    env["gateway"] = gateway
    env["prefixes"] = prefixes
    env["credential"] = str(src.get("credential") or "")
    env["username"] = str(src.get("username") or "")
    env["password"] = str(src.get("password") or "")
    env["loginApi"] = str(src.get("loginApi") or DEFAULT_LOGIN_API)
    if not env["loginApi"].startswith("/"):
        env["loginApi"] = "/" + env["loginApi"]
    env["tokenPath"] = str(src.get("tokenPath") or DEFAULT_LOGIN_PATH)
    env["kafkaBrokers"] = str(src.get("kafkaBrokers") or "127.0.0.1:9092").strip()
    env["minioEndpoint"] = str(src.get("minioEndpoint") or "http://leidian-minio:9000").strip()
    env["minioAccessKey"] = str(src.get("minioAccessKey") or "minioadmin").strip()
    env["minioSecretKey"] = str(src.get("minioSecretKey") or "minioadmin").strip()
    env["minioRadarBucket"] = str(src.get("minioRadarBucket") or "leidian-frame").strip()

    # 兼容展示：baseUrl 指向 biz（旧测试/UI 过渡）
    env["baseUrl"] = service_base(env, "biz")
    env["loginUrl"] = login_url(env)
    return env


def service_base(env: dict[str, Any], service: str = "biz") -> str:
    """gateway + 指定服务前缀。"""
    gateway = _rewrite_gateway_for_runtime(str(env.get("gateway") or ""))
    prefixes = env.get("prefixes") if isinstance(env.get("prefixes"), dict) else None
    if prefixes is None and not gateway and env.get("baseUrl"):
        # 极旧数据兜底（无 prefixes 字段）
        return str(env.get("baseUrl") or "").rstrip("/")
    if prefixes is None:
        prefixes = DEFAULT_PREFIXES
    sid = service if service in prefixes else "biz"
    prefix = _norm_prefix(str(prefixes.get(sid) or ""))
    return f"{gateway}{prefix}" if gateway else prefix


def login_url(env: dict[str, Any]) -> str:
    api = str(env.get("loginApi") or DEFAULT_LOGIN_API)
    if not api.startswith("/"):
        api = "/" + api
    if not str(env.get("gateway") or "").strip():
        return ""
    base = service_base(env, "system")
    if not base:
        return ""
    return base.rstrip("/") + api


def resolve_step_url(env: dict[str, Any], step: dict[str, Any], path: str) -> str:
    """拼最终请求 URL：禁止绝对 URL，统一走已配置网关，避免 SSRF。"""
    path = path or "/"
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", path):
        raise ValueError("用例 path 禁止绝对 URL，请使用相对路径 + service")
    gateway = _rewrite_gateway_for_runtime(str(env.get("gateway") or ""))
    if path.startswith("/api/") or path.startswith("/api?"):
        # 已写全网关路径
        if not gateway:
            raise ValueError("未配置网关根地址")
        return gateway + path
    service = str(step.get("service") or "biz").strip() or "biz"
    base = service_base(env, service)
    if not base:
        raise ValueError(f"未配置网关根地址（服务 {service}）")
    if not path.startswith("/"):
        path = "/" + path
    return base.rstrip("/") + path


def _migrate_legacy(data: dict[str, Any]) -> dict[str, Any]:
    """兼容旧版单环境 {baseUrl, credential}。"""
    if "environments" in data:
        return data
    env = _blank_env("默认环境")
    env["id"] = "default"
    gateway, prefixes = _split_legacy_base(str(data.get("baseUrl") or ""))
    env["gateway"] = gateway
    env["prefixes"] = prefixes
    env["credential"] = str(data.get("credential") or "")
    return {"activeId": "default", "environments": [env]}


def _default_doc() -> dict[str, Any]:
    dev = _blank_env("开发环境")
    dev["id"] = "dev"
    test = _blank_env("测试环境")
    test["id"] = "test"
    return {"activeId": "dev", "environments": [dev, test]}


def load_doc(path: Path | None = None) -> dict[str, Any]:
    p = path or DEFAULT_ENV_PATH
    if not p.exists():
        return _default_doc()
    data = json.loads(p.read_text(encoding="utf-8"))
    data = _migrate_legacy(data)
    envs = [_normalize_env(e) for e in (data.get("environments") or [])]
    if not envs:
        return _default_doc()
    active = str(data.get("activeId") or "")
    ids = {e["id"] for e in envs}
    if active not in ids:
        active = envs[0]["id"]
    return {"activeId": active, "environments": envs}


def save_doc(doc: dict[str, Any], path: Path | None = None) -> dict[str, Any]:
    p = path or DEFAULT_ENV_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    envs = [_normalize_env(e) for e in (doc.get("environments") or [])]
    if not envs:
        raise ValueError("至少保留一个环境")
    active = str(doc.get("activeId") or "")
    ids = {e["id"] for e in envs}
    if active not in ids:
        active = envs[0]["id"]
    # 落盘去掉派生字段
    stored = []
    for e in envs:
        stored.append(
            {
                "id": e["id"],
                "name": e["name"],
                "gateway": e["gateway"],
                "prefixes": e["prefixes"],
                "credential": e["credential"],
                "username": e["username"],
                "password": e["password"],
                "loginApi": e["loginApi"],
                "tokenPath": e["tokenPath"],
                "kafkaBrokers": e["kafkaBrokers"],
                "minioEndpoint": e.get("minioEndpoint") or "http://leidian-minio:9000",
                "minioAccessKey": e.get("minioAccessKey") or "minioadmin",
                "minioSecretKey": e.get("minioSecretKey") or "minioadmin",
                "minioRadarBucket": e.get("minioRadarBucket") or "leidian-frame",
            }
        )
    out = {"activeId": active, "environments": stored}
    p.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"activeId": active, "environments": [_normalize_env(e) for e in stored]}


def load_env(path: Path | None = None) -> dict[str, Any]:
    """跑批用：返回当前启用环境。"""
    doc = load_doc(path)
    for e in doc["environments"]:
        if e["id"] == doc["activeId"]:
            return e
    return doc["environments"][0]


def public_view(doc: dict[str, Any] | None = None, path: Path | None = None) -> dict[str, Any]:
    d = doc if doc is not None else load_doc(path)
    envs = [_public_env(e) for e in d["environments"]]
    active = next((e for e in envs if e["id"] == d["activeId"]), envs[0])
    return {
        "activeId": d["activeId"],
        "environments": envs,
        "active": active,
        "services": SERVICE_DEFS,
    }


def _public_env(env: dict[str, Any]) -> dict[str, Any]:
    """对外视图脱敏密码；保留 hasPassword 供前端提示。"""
    out = dict(env)
    has_password = bool(out.get("password"))
    out["password"] = ""
    out["hasPassword"] = has_password
    return out


def upsert_env(payload: dict[str, Any], path: Path | None = None) -> dict[str, Any]:
    doc = load_doc(path)
    env = _normalize_env(payload)
    found = False
    for i, e in enumerate(doc["environments"]):
        if e["id"] == env["id"]:
            if not env["password"] and e.get("password"):
                env["password"] = e["password"]
            doc["environments"][i] = env
            found = True
            break
    if not found:
        doc["environments"].append(env)
    return public_view(save_doc(doc, path), path)


def delete_env(env_id: str, path: Path | None = None) -> dict[str, Any]:
    doc = load_doc(path)
    envs = [e for e in doc["environments"] if e["id"] != env_id]
    if not envs:
        raise ValueError("至少保留一个环境")
    doc["environments"] = envs
    if doc["activeId"] == env_id:
        doc["activeId"] = envs[0]["id"]
    return public_view(save_doc(doc, path), path)


def activate_env(env_id: str, path: Path | None = None) -> dict[str, Any]:
    doc = load_doc(path)
    ids = {e["id"] for e in doc["environments"]}
    if env_id not in ids:
        raise ValueError("环境不存在")
    doc["activeId"] = env_id
    return public_view(save_doc(doc, path), path)


def create_env(name: str = "新环境", path: Path | None = None) -> dict[str, Any]:
    doc = load_doc(path)
    env = _blank_env(name or "新环境")
    doc["environments"].append(env)
    return public_view(save_doc(doc, path), path)


def set_credential(env_id: str, credential: str, path: Path | None = None) -> dict[str, Any]:
    doc = load_doc(path)
    for e in doc["environments"]:
        if e["id"] == env_id:
            e["credential"] = str(credential or "")
            return public_view(save_doc(doc, path), path)
    raise ValueError("环境不存在")


def clear_credential(env_id: str, path: Path | None = None) -> dict[str, Any]:
    return set_credential(env_id, "", path)


def inspect_credential(credential: str, now_ts: float | None = None) -> dict[str, Any]:
    """检查登录凭证是否缺失 / JWT 是否过期。

    返回：
      status: missing | ok | expired | unknown
      exp: JWT exp 秒级时间戳（如可解析）
      message: 给人看的说明
    """
    text = str(credential or "").strip()
    if text.lower().startswith("bearer "):
        text = text[7:].strip()
    if not text:
        return {
            "status": "missing",
            "exp": None,
            "message": "未配置登录凭证，请先在环境配置中点击「获取凭证」",
        }

    # 非 JWT：无法判断过期，交给后端接口本身校验
    parts = text.split(".")
    if len(parts) != 3:
        return {
            "status": "unknown",
            "exp": None,
            "message": "已设置凭证（非 JWT，无法预判过期）",
        }

    try:
        import base64
        import time

        payload_b64 = parts[1]
        padding = "=" * (-len(payload_b64) % 4)
        raw = base64.urlsafe_b64decode(payload_b64 + padding)
        payload = json.loads(raw.decode("utf-8"))
        exp = payload.get("exp")
        if exp is None:
            return {
                "status": "unknown",
                "exp": None,
                "message": "已设置凭证（JWT 无 exp，无法预判过期）",
            }
        exp_i = int(exp)
        now = float(now_ts if now_ts is not None else time.time())
        # 预留 30 秒余量，避免刚好边界误跑
        if now >= exp_i - 30:
            return {
                "status": "expired",
                "exp": exp_i,
                "message": "登录凭证已过期，请先在环境配置中点击「获取凭证」后再执行",
            }
        return {
            "status": "ok",
            "exp": exp_i,
            "message": "凭证有效",
        }
    except Exception:  # noqa: BLE001
        return {
            "status": "unknown",
            "exp": None,
            "message": "已设置凭证（JWT 解析失败，无法预判过期）",
        }


def assert_credential_runnable(credential: str, now_ts: float | None = None) -> None:
    """执行前校验：缺失或过期直接抛 ValueError，供 API / 跑批拦截。"""
    info = inspect_credential(credential, now_ts=now_ts)
    if info["status"] in ("missing", "expired"):
        raise ValueError(info["message"])


def _dig(data: Any, path: str) -> Any:
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


def fetch_token(env_id: str | None = None, path: Path | None = None) -> dict[str, Any]:
    """调用 system 登录接口，把 token 写入对应环境。"""
    doc = load_doc(path)
    target_id = env_id or doc["activeId"]
    env = next((e for e in doc["environments"] if e["id"] == target_id), None)
    if not env:
        raise ValueError("环境不存在")
    url = login_url(env)
    if not url:
        raise ValueError("请先填写网关根地址")
    username = env.get("username") or ""
    password = env.get("password") or ""
    if not username:
        raise ValueError("请先填写用户名")

    body = json.dumps({"username": username, "password": password}, ensure_ascii=False).encode("utf-8")
    req = Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            status = resp.status
    except HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise ValueError(f"登录失败 HTTP {e.code}: {raw[:300]}") from e
    except URLError as e:
        reason = str(e.reason)
        tip = ""
        if "Connection refused" in reason or "111" in reason:
            tip = "；请确认网关/system 已启动。Docker 下网关请用 host.docker.internal 而非 localhost"
        raise ValueError(f"登录请求失败: {reason}{tip}") from e

    try:
        parsed = json.loads(raw) if raw else {}
    except json.JSONDecodeError as e:
        raise ValueError(f"登录响应不是 JSON: {raw[:200]}") from e

    token_path = env.get("tokenPath") or DEFAULT_LOGIN_PATH
    token = _dig(parsed, token_path)
    if not token:
        for alt in ("data.accessToken", "accessToken", "data.token", "token"):
            token = _dig(parsed, alt)
            if token:
                break
    if not token:
        raise ValueError(f"未在响应中找到 token（路径 {token_path}），HTTP {status}")

    env["credential"] = str(token)
    for i, e in enumerate(doc["environments"]):
        if e["id"] == target_id:
            doc["environments"][i] = env
            break
    view = public_view(save_doc(doc, path), path)
    view["fetched"] = True
    return view


def save_env(payload: dict[str, Any], path: Path | None = None) -> dict[str, Any]:
    """兼容：整包保存；或把字段写到当前启用环境。"""
    if "environments" in payload:
        return public_view(save_doc(payload, path), path)
    doc = load_doc(path)
    active = next(e for e in doc["environments"] if e["id"] == doc["activeId"])
    if "gateway" in payload:
        active["gateway"] = str(payload.get("gateway") or "").rstrip("/")
    if "prefixes" in payload:
        active["prefixes"] = payload.get("prefixes")
    if "baseUrl" in payload and "gateway" not in payload:
        gateway, prefixes = _split_legacy_base(str(payload.get("baseUrl") or ""))
        active["gateway"] = gateway
        # 单测 mock 常把 baseUrl 设为 http://127.0.0.1:port（无前缀）
        # 此时 prefixes 保持空 biz，便于 path 直接拼
        parsed = urlparse(str(payload.get("baseUrl") or ""))
        path_part = (parsed.path or "").rstrip("/")
        if not path_part or path_part == "/":
            active["prefixes"] = {k: "" for k in SERVICE_IDS}
        else:
            active["prefixes"] = prefixes
    if "credential" in payload:
        active["credential"] = str(payload.get("credential") or "")
    for k in ("name", "username", "password", "tokenPath", "loginApi"):
        if k in payload:
            active[k] = payload[k]
    return upsert_env(active, path)

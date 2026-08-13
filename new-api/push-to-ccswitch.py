# -*- coding: utf-8 -*-
"""把本机 New API 的令牌写入 CC Switch（Codex 供应商），供一键切换。"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path

NEWAPI_DB = Path(__file__).resolve().parent / "data" / "one-api.db"
CC_DB = Path(os.environ.get("CC_SWITCH_DB", Path.home() / ".cc-switch" / "cc-switch.db"))
BASE_URL = "http://localhost:5780/v1"
APP_TYPE = "codex"


def sk_of(key: str) -> str:
    key = (key or "").strip()
    if not key:
        return ""
    return key if key.startswith("sk-") else f"sk-{key}"


def default_model_for(group: str, name: str) -> str:
    g = group or ""
    n = name or ""
    if "火山" in g or "火山" in n:
        return "ark-code-latest"
    if "基元" in g or "基元" in n:
        return "deepseek-v4-flash-0731"
    return "deepseek-v4-flash-0731"


def display_name(group: str, name: str) -> str:
    g = (group or "").strip()
    if g:
        return f"New API · {g}"
    n = (name or "").strip()
    if n and "unified" in n.lower():
        return "New API · 默认"
    return f"New API · {n or '默认'}"


def stable_id(group: str, name: str) -> str:
    raw = (group or name or "default").strip() or "default"
    # keep readable ascii-ish id
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in raw)
    return f"mytools-newapi-{safe}"[:80]


def build_settings(api_key: str, model: str, label: str) -> dict:
    # 与现有「基元律动」条目同结构；wire_api=responses 与 Codex 一致
    config = "\n".join(
        [
            'model_provider = "custom"',
            f'model = "{model}"',
            'model_catalog_json = "cc-switch-model-catalog.json"',
            "disable_response_storage = true",
            'model_reasoning_effort = "high"',
            "",
            "[model_providers.custom]",
            f'name = "{label}"',
            'wire_api = "responses"',
            "requires_openai_auth = true",
            f'base_url = "{BASE_URL}"',
            "",
        ]
    )
    return {
        "auth": {
            "auth_mode": "apikey",
            "OPENAI_API_KEY": api_key,
        },
        "config": config,
    }


def load_newapi_tokens() -> list[dict]:
    if not NEWAPI_DB.is_file():
        raise FileNotFoundError(f"找不到 New API 数据库：{NEWAPI_DB}")
    con = sqlite3.connect(str(NEWAPI_DB))
    con.row_factory = sqlite3.Row
    rows = con.execute(
        'SELECT id, name, "group", key, status, unlimited_quota FROM tokens WHERE status = 1 ORDER BY id'
    ).fetchall()
    con.close()
    out = []
    for r in rows:
        key = sk_of(r["key"])
        if not key:
            continue
        out.append(
            {
                "token_id": r["id"],
                "name": r["name"] or "",
                "group": r["group"] or "",
                "key": key,
            }
        )
    return out


def upsert_providers(activate: str | None = None) -> dict:
    if not CC_DB.is_file():
        raise FileNotFoundError(f"找不到 CC Switch 数据库：{CC_DB}（请先安装并打开过 CC Switch）")

    tokens = load_newapi_tokens()
    if not tokens:
        return {"ok": False, "message": "New API 里没有可用的 API 密钥", "providers": []}

    now = int(time.time() * 1000)
    con = sqlite3.connect(str(CC_DB))
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    providers = []
    activate_match = None
    for t in tokens:
        pid = stable_id(t["group"], t["name"])
        label = display_name(t["group"], t["name"])
        model = default_model_for(t["group"], t["name"])
        settings = build_settings(t["key"], model, label)
        meta = {
            "commonConfigEnabled": True,
            "endpointAutoSelect": True,
            "apiFormat": "openai_responses",
            "mytoolsNewApi": True,
            "newApiTokenName": t["name"],
            "newApiGroup": t["group"],
        }
        existing = cur.execute(
            "SELECT id FROM providers WHERE id = ? AND app_type = ?",
            (pid, APP_TYPE),
        ).fetchone()
        if existing:
            cur.execute(
                """
                UPDATE providers
                SET name = ?, settings_config = ?, website_url = ?, meta = ?, notes = ?
                WHERE id = ? AND app_type = ?
                """,
                (
                    label,
                    json.dumps(settings, ensure_ascii=False),
                    BASE_URL,
                    json.dumps(meta, ensure_ascii=False),
                    f"由 DevToolbox New API 一键接入 · {t['name']}",
                    pid,
                    APP_TYPE,
                ),
            )
            action = "updated"
        else:
            cur.execute(
                """
                INSERT INTO providers (
                    id, app_type, name, settings_config, website_url, category,
                    created_at, sort_index, notes, icon, icon_color, meta,
                    is_current, in_failover_queue, cost_multiplier, provider_type
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    pid,
                    APP_TYPE,
                    label,
                    json.dumps(settings, ensure_ascii=False),
                    BASE_URL,
                    "custom",
                    now,
                    50,
                    f"由 DevToolbox New API 一键接入 · {t['name']}",
                    None,
                    "#0d9488",
                    json.dumps(meta, ensure_ascii=False),
                    0,
                    0,
                    "1.0",
                    None,
                ),
            )
            action = "created"

        ep = cur.execute(
            "SELECT id FROM provider_endpoints WHERE provider_id = ? AND app_type = ?",
            (pid, APP_TYPE),
        ).fetchone()
        if not ep:
            cur.execute(
                "INSERT INTO provider_endpoints (provider_id, app_type, url, added_at) VALUES (?,?,?,?)",
                (pid, APP_TYPE, BASE_URL, now),
            )
        else:
            cur.execute(
                "UPDATE provider_endpoints SET url = ? WHERE provider_id = ? AND app_type = ?",
                (BASE_URL, pid, APP_TYPE),
            )

        providers.append(
            {
                "id": pid,
                "name": label,
                "group": t["group"],
                "token": t["name"],
                "model": model,
                "action": action,
            }
        )

        if activate and activate_match is None:
            if activate in (pid, t["group"], t["name"], label):
                activate_match = pid

    activated = None
    if activate_match:
        cur.execute("UPDATE providers SET is_current = 0 WHERE app_type = ?", (APP_TYPE,))
        cur.execute(
            "UPDATE providers SET is_current = 1 WHERE id = ? AND app_type = ?",
            (activate_match, APP_TYPE),
        )
        activated = activate_match
        settings_path = CC_DB.parent / "settings.json"
        if settings_path.is_file():
            try:
                sj = json.loads(settings_path.read_text(encoding="utf-8"))
                sj["currentProviderCodex"] = activated
                settings_path.write_text(
                    json.dumps(sj, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
            except Exception:
                pass

    con.commit()
    con.close()
    hint = (
        f"已设为当前：{activated}。若 Codex 已开，用 CC Switch 再点一次该供应商以写入 config。"
        if activated
        else "打开 CC Switch，在 Codex 列表点选「New API · …」即可切换（未自动改当前供应商）。"
    )
    return {
        "ok": True,
        "message": f"已写入 CC Switch {len(providers)} 个 Codex 供应商（Base URL={BASE_URL}）",
        "base_url": BASE_URL,
        "activated": activated,
        "providers": providers,
        "hint": hint,
    }


def main():
    activate = None
    if len(sys.argv) > 1 and sys.argv[1] not in ("", "-", "none"):
        activate = sys.argv[1]
    try:
        result = upsert_providers(activate=activate)
    except Exception as e:
        result = {"ok": False, "message": str(e), "providers": []}
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

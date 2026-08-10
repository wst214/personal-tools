"""多环境：网关 + 服务前缀 + 启用 + 凭证。"""
import json
import sys
from pathlib import Path
from unittest.mock import patch

WEB = Path(__file__).resolve().parents[1] / "web"
sys.path.insert(0, str(WEB))

import env_store  # noqa: E402


def test_default_has_dev_and_test(tmp_path):
    doc = env_store.load_doc(path=tmp_path / "missing.json")
    names = {e["name"] for e in doc["environments"]}
    assert "开发环境" in names
    assert "测试环境" in names
    assert doc["activeId"] == "dev"
    assert doc["environments"][0]["prefixes"]["biz"] == "/api/biz"
    assert doc["environments"][0]["prefixes"]["radar"] == "/api/v1/radar"


def test_legacy_baseurl_splits_gateway(tmp_path):
    path = tmp_path / "env.json"
    path.write_text(
        json.dumps({"baseUrl": "http://127.0.0.1:9/api/biz/", "credential": "tok-1"}),
        encoding="utf-8",
    )
    loaded = env_store.load_env(path=path)
    assert loaded["gateway"] == "http://127.0.0.1:9"
    assert loaded["prefixes"]["biz"] == "/api/biz"
    assert loaded["credential"] == "tok-1"
    assert loaded["baseUrl"] == "http://127.0.0.1:9/api/biz"


def test_save_mock_host_clears_prefixes(tmp_path):
    path = tmp_path / "env.json"
    view = env_store.save_env(
        {"baseUrl": "http://127.0.0.1:9", "credential": "tok-1"},
        path=path,
    )
    assert view["active"]["gateway"] == "http://127.0.0.1:9"
    assert view["active"]["prefixes"]["biz"] == ""
    assert env_store.load_env(path=path)["credential"] == "tok-1"


def test_resolve_step_url_by_service(tmp_path):
    path = tmp_path / "env.json"
    env_store.save_env(
        {
            "gateway": "http://gw:8080",
            "prefixes": {
                "system": "/api/system",
                "biz": "/api/biz",
                "radar": "/api/v1/radar",
            },
        },
        path=path,
    )
    env = env_store.load_env(path=path)
    assert env_store.resolve_step_url(env, {"service": "biz"}, "/warning/rules") == (
        "http://gw:8080/api/biz/warning/rules"
    )
    assert env_store.resolve_step_url(env, {"service": "radar"}, "/frames/recent") == (
        "http://gw:8080/api/v1/radar/frames/recent"
    )
    assert env_store.resolve_step_url(env, {}, "/api/open/lightning") == (
        "http://gw:8080/api/open/lightning"
    )


def test_create_activate_delete(tmp_path):
    path = tmp_path / "env.json"
    view = env_store.create_env("预发环境", path=path)
    new_id = view["environments"][-1]["id"]
    view = env_store.activate_env(new_id, path=path)
    assert view["activeId"] == new_id
    view = env_store.delete_env(new_id, path=path)
    assert view["activeId"] != new_id


def test_inspect_credential_jwt_expiry():
    import base64
    import json as _json
    import time

    def make_jwt(exp: int) -> str:
        header = base64.urlsafe_b64encode(b'{"alg":"none"}').decode().rstrip("=")
        payload = base64.urlsafe_b64encode(
            _json.dumps({"exp": exp}).encode()
        ).decode().rstrip("=")
        return f"{header}.{payload}.sig"

    now = time.time()
    assert env_store.inspect_credential("")["status"] == "missing"
    assert env_store.inspect_credential(make_jwt(int(now) + 3600), now_ts=now)["status"] == "ok"
    assert env_store.inspect_credential(make_jwt(int(now) - 10), now_ts=now)["status"] == "expired"
    try:
        env_store.assert_credential_runnable(make_jwt(int(now) - 10), now_ts=now)
        assert False, "should raise"
    except ValueError as e:
        assert "过期" in str(e)


def test_fetch_token_uses_system_prefix(tmp_path):
    path = tmp_path / "env.json"
    view = env_store.public_view(path=path)
    eid = view["activeId"]
    env_store.upsert_env(
        {
            "id": eid,
            "name": "开发环境",
            "gateway": "http://login.test",
            "username": "admin",
            "password": "x",
        },
        path=path,
    )

    class FakeResp:
        status = 200

        def read(self):
            return json.dumps({"code": 0, "data": {"accessToken": "jwt-xyz"}}).encode()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    with patch("env_store.urlopen", return_value=FakeResp()) as mocked:
        view = env_store.fetch_token(eid, path=path)
    assert view["active"]["credential"] == "jwt-xyz"
    req = mocked.call_args[0][0]
    assert req.full_url == "http://login.test/api/system/auth/login"

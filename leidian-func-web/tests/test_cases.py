"""用例仓库：一级能力导航 + 二级模块存储。"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
sys.path.insert(0, str(WEB))

import case_store  # noqa: E402


def test_capabilities_are_l1():
    caps = {c["id"]: c for c in case_store.list_capabilities()}
    assert list(caps) == ["lightning-ingest", "device-ingest", "warn-rule", "warn-suppress", "warn-runtime"]
    assert caps["warn-rule"]["name"] == "预警规则管理"
    assert caps["device-ingest"]["name"] == "设备解析接入"
    device_ids = [m["id"] for m in caps["device-ingest"]["modules"]]
    assert device_ids == [
        "device-ingest-smoke",
        "device-ingest-monitor",
        "device-ingest-attachment",
        "device-ingest-biz-query",
        "device-ingest-e2e",
    ]
    assert caps["lightning-ingest"]["name"] == "闪电定位接入"
    lightning_ids = [m["id"] for m in caps["lightning-ingest"]["modules"]]
    assert lightning_ids == [
        "lightning-ingest-smoke",
        "lightning-ingest-monitor",
        "lightning-ingest-attachment",
        "lightning-ingest-e2e",
    ]
    li_smoke = case_store.list_cases("lightning-ingest-smoke")
    assert any(c["id"] == "li-01-lightning-status" and not c.get("expandByNetwork") for c in li_smoke)
    li_mon = case_store.list_cases("lightning-ingest-monitor")
    assert any(c["id"] == "li-10-page-network" and c.get("expandByNetwork") for c in li_mon)
    li_e2e = case_store.list_cases("lightning-ingest-e2e")
    assert any(c["id"] == "li-41-e2e-dedup" for c in li_e2e)
    assert any(c["id"] == "li-50-future-reject" for c in li_e2e)
    assert any(c["id"] == "li-51-low-quality" and c.get("expandByNetwork") for c in li_e2e)
    di_e2e = case_store.list_cases("device-ingest-e2e")
    assert any(c["id"] == "di-50-reject-grounding" for c in di_e2e)
    assert any(c["id"] == "di-51-low-quality-grounding" for c in di_e2e)
    assert any(c["id"] == "di-60-e2e-crc-reject" and not c.get("skip") for c in di_e2e)
    assert any(c["id"] == "di-62-e2e-fragment-reassemble" and not c.get("skip") for c in di_e2e)
    assert any(t["id"] == "ATMOSPHERE_ELECTRIC_FIELD" and t.get("deviceHex") for t in case_store.DEVICE_TYPES)
    missing_hex = [t["id"] for t in case_store.DEVICE_TYPES if not str(t.get("deviceHex") or "").strip()]
    assert not missing_hex, f"勾选类型必须具备 deviceHex: {missing_hex}"
    from runner import expand_case_refs as _expand_li

    li_expanded = _expand_li(
        [{"module": "lightning-ingest-monitor", "id": "li-10-page-network"}], []
    )
    assert len(li_expanded) == 3
    assert li_expanded[0]["network"] == "CMB"
    assert li_expanded[1]["network"] == "LOCATOR"
    assert li_expanded[2]["network"] == "RADAR"
    types = case_store.list_device_types()
    assert len(types) == 10
    assert types[0]["id"] == "ATMOSPHERE_ELECTRIC_FIELD"
    assert types[3]["hasBizQuery"] is True
    assert types[4]["hasBizQuery"] is False
    mon = case_store.list_cases("device-ingest-monitor")
    assert any(c["id"] == "di-20-monitor-recent" and c.get("expandByDeviceType") for c in mon)
    assert any(c["id"] == "di-39-monitor-type-invalid" and not c.get("expandByDeviceType") for c in mon)
    from runner import expand_case_refs

    expanded = expand_case_refs(
        [{"module": "device-ingest-monitor", "id": "di-20-monitor-recent"}],
        ["ATMOSPHERE_ELECTRIC_FIELD", "GROUNDING_RESISTANCE"],
    )
    assert len(expanded) == 2
    assert expanded[0]["deviceType"] == "ATMOSPHERE_ELECTRIC_FIELD"
    assert caps["warn-suppress"]["name"] == "预警抑制管理"
    assert caps["warn-runtime"]["name"] == "预警运行"
    assert "warn-factor" not in caps
    assert "warn-notify" not in caps
    assert "warn-gen" not in caps
    rule_ids = [m["id"] for m in caps["warn-rule"]["modules"]]
    assert rule_ids[:6] == [
        "warn-rule-draft",
        "warn-rule-publish",
        "warn-rule-lifecycle",
        "warn-rule-query",
        "warn-rule-audit",
        "warn-rule-e2e",
    ]
    assert "warn-factor-query" in rule_ids
    assert "warn-backtest-run" in rule_ids
    runtime_ids = [m["id"] for m in caps["warn-runtime"]["modules"]]
    assert runtime_ids[0] == "warn-gen-smoke"
    assert "warn-notify-confirm" in runtime_ids
    assert case_store.UI_LABELS["caseFile"] == "用例文件"


def test_list_modules_are_l2_flat():
    mods = {m["id"]: m["name"] for m in case_store.list_modules()}
    assert mods["warn-rule-draft"] == "草稿配置"
    assert mods["warn-suppress-e2e"] == "端到端"
    assert "warn-rule" not in mods


def test_capability_cases_grouped():
    tree = case_store.list_capability_cases("warn-rule")
    assert tree["id"] == "warn-rule"
    assert tree["caseCount"] > 0
    names = [g["name"] for g in tree["groups"]]
    assert names[0] == "草稿配置"
    draft = next(g for g in tree["groups"] if g["id"] == "warn-rule-draft")
    assert draft["cases"]
    assert draft["cases"][0]["module"] == "warn-rule-draft"


def test_list_cases_include_card_fields():
    rows = case_store.list_cases("warn-rule-draft")
    assert rows
    row = rows[0]
    assert "sub" in row and row["sub"]
    assert "flow" in row and row["flow"].startswith("前置:")
    assert "stepCount" in row


def test_suppress_capability_has_cases():
    tree = case_store.list_capability_cases("warn-suppress")
    assert tree["caseCount"] >= 18
    draft = next(g for g in tree["groups"] if g["id"] == "warn-suppress-draft")
    assert any(r["id"] == "ws-01-create-draft" for r in draft["cases"])
    assert any(r["id"] == "ws-17-create-device-only" for r in draft["cases"])
    life = next(g for g in tree["groups"] if g["id"] == "warn-suppress-lifecycle")
    assert any(r["id"] == "ws-18-terminate-reason-required" for r in life["cases"])


def test_warn_gen_smoke_case_exists():
    rows = case_store.list_cases("warn-gen-smoke")
    assert any(r["id"] == "wg-00-mock-list" and not r["skip"] for r in rows)
    tree = case_store.list_capability_cases("warn-runtime")
    assert tree["caseCount"] >= 25
    # 旧一级 id 仍可解析
    assert case_store.list_capability_cases("warn-gen")["id"] == "warn-runtime"


def test_gap_fill_packages_registered():
    rule_tree = case_store.list_capability_cases("warn-rule")
    assert rule_tree["caseCount"] >= 40
    assert any(g["id"] == "warn-factor-query" for g in rule_tree["groups"])
    runtime = case_store.list_capability_cases("warn-runtime")
    assert any(g["id"] == "warn-notify-confirm" for g in runtime["groups"])
    draft = case_store.list_cases("warn-rule-draft")
    assert any(r["id"] == "wr-24-broadcast-action" for r in draft)
    assert any(r["id"] == "wr-23-update-attach-draft" for r in draft)
    pub = case_store.list_cases("warn-suppress-publish")
    assert any(r["id"] == "ws-20-suppress-approve" for r in pub)


def test_render_now_offset():
    from runner import _render

    text = _render("${now+1d}|${now-1d}|${rand}", {})
    parts = text.split("|")
    assert "T" in parts[0] and len(parts[0]) >= 19
    assert "T" in parts[1]
    assert len(parts[2]) == 8


def test_render_now_uses_shanghai_timezone():
    """容器 UTC 下 ${now} 仍应按东八区生成，避免未来时间用例失效。"""
    from datetime import datetime, timedelta, timezone
    from runner import _render

    text = _render("${now+10m}", {})
    rendered = datetime.strptime(text, "%Y-%m-%dT%H:%M:%S")
    shanghai_now = datetime.now(timezone(timedelta(hours=8))).replace(tzinfo=None)
    # 允许几秒误差；且必须明显接近东八区，而不是 UTC（差约 8 小时）
    assert abs((rendered - shanghai_now).total_seconds() - 600) < 120


def test_render_nested_kafka_json_templates():
    """${kafkaJsonDedup} 内嵌 ${now-1m} 必须二次展开，否则入库解析失败。"""
    from runner import _render

    ctx = {
        "kafkaJsonDedup": '{"strikeTime":"${now-1m}","strikeId":"cmb_e2e_fixed_strike"}',
    }
    text = _render("${kafkaJsonDedup}", ctx)
    assert "${" not in text
    assert "cmb_e2e_fixed_strike" in text
    assert "T" in text


def test_legacy_aliases_resolve():
    rule_rows = case_store.list_cases("warn-rule")
    assert rule_rows
    assert all(r["module"] == "warn-rule-draft" for r in rule_rows)


def test_crud_persists_yaml(tmp_path, monkeypatch):
    monkeypatch.setattr(case_store, "CASES_ROOT", tmp_path)
    saved = case_store.save_case(
        "warn-rule-draft",
        {
            "id": "t-1",
            "name": "临时用例",
            "steps": [{"method": "GET", "path": "/x", "expect": {"status": 200}}],
        },
    )
    assert saved["file"] == "t-1.yaml"
    assert (tmp_path / "warn-rule-draft" / "t-1.yaml").is_file()

    rows = case_store.list_cases("warn-rule-draft")
    assert any(r["id"] == "t-1" for r in rows)

    got = case_store.get_case("warn-rule-draft", "t-1")
    assert got["name"] == "临时用例"

    case_store.save_case(
        "warn-rule-draft",
        {"id": "t-1", "name": "已改名", "steps": got["steps"]},
    )
    assert case_store.get_case("warn-rule-draft", "t-1")["name"] == "已改名"

    case_store.delete_case("warn-rule-draft", "t-1")
    assert case_store.list_cases("warn-rule-draft") == []


def test_case_id_rejects_path_traversal(tmp_path, monkeypatch):
    monkeypatch.setattr(case_store, "CASES_ROOT", tmp_path)
    for bad in ("../x", "a/b", "a\\b", "", ".."):
        try:
            case_store.save_case("warn-rule-draft", {"id": bad, "name": "x", "steps": []})
            assert False, f"should reject {bad!r}"
        except ValueError:
            pass


def test_resolve_step_url_rejects_absolute():
    import env_store

    env = {"gateway": "http://127.0.0.1:8080", "prefixes": {"biz": "/api/biz"}}
    try:
        env_store.resolve_step_url(env, {"service": "biz"}, "http://169.254.169.254/latest")
        assert False, "should reject absolute url"
    except ValueError:
        pass
    url = env_store.resolve_step_url(env, {"service": "biz"}, "/warning/rules")
    assert url == "http://127.0.0.1:8080/api/biz/warning/rules"


def test_public_view_redacts_password(tmp_path):
    import env_store

    p = tmp_path / "env.json"
    doc = {
        "activeId": "dev",
        "environments": [
            {
                "id": "dev",
                "name": "开发环境",
                "gateway": "http://127.0.0.1:8080",
                "prefixes": {},
                "credential": "",
                "username": "u1",
                "password": "secret-pass",
                "loginApi": "/auth/login",
                "tokenPath": "data.accessToken",
            }
        ],
    }
    env_store.save_doc(doc, p)
    view = env_store.public_view(path=p)
    assert view["environments"][0]["password"] == ""
    assert view["environments"][0]["hasPassword"] is True
    assert view["active"]["password"] == ""
    # 落盘仍保留明文供本地登录
    stored = json.loads(p.read_text(encoding="utf-8"))
    assert stored["environments"][0]["password"] == "secret-pass"

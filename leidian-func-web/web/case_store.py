"""用例文件仓库：按模块读写 YAML/JSON。

存储按二级功能模块目录（如 warn-rule-draft）；
操作台导航按一级能力（如 warn-rule），右侧按二级分组展示。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import yaml

TOOL_ROOT = Path(__file__).resolve().parent.parent
CASES_ROOT = TOOL_ROOT / "cases"

# 用例 / 文件名安全 id：禁止路径分隔与穿越
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

# 一级能力 → 二级功能模块（目录名 = module id）
# 一级：规则 / 抑制 / 运行（生成+通知）/ 设备解析接入；因子、回测并入规则侧
CAPABILITIES: list[dict[str, Any]] = [
    {
        "id": "lightning-ingest",
        "name": "闪电定位接入",
        "modules": [
            {"id": "lightning-ingest-smoke", "name": "接入烟测"},
            {"id": "lightning-ingest-monitor", "name": "三网查询"},
            {"id": "lightning-ingest-attachment", "name": "原文附件"},
            {"id": "lightning-ingest-e2e", "name": "全链路端到端"},
        ],
    },
    {
        "id": "device-ingest",
        "name": "设备解析接入",
        "modules": [
            {"id": "device-ingest-smoke", "name": "接入烟测"},
            {"id": "device-ingest-monitor", "name": "Monitor 入库"},
            {"id": "device-ingest-attachment", "name": "附件映射"},
            {"id": "device-ingest-biz-query", "name": "业务监测查询"},
            {"id": "device-ingest-e2e", "name": "全链路端到端"},
        ],
    },
    {
        "id": "warn-rule",
        "name": "预警规则管理",
        "modules": [
            {"id": "warn-rule-draft", "name": "草稿配置"},
            {"id": "warn-rule-publish", "name": "提交生效"},
            {"id": "warn-rule-lifecycle", "name": "启停删除"},
            {"id": "warn-rule-query", "name": "查询筛选"},
            {"id": "warn-rule-audit", "name": "审核流转"},
            {"id": "warn-rule-e2e", "name": "端到端"},
            {"id": "warn-factor-query", "name": "因子查询"},
            {"id": "warn-factor-seed", "name": "因子种子"},
            {"id": "warn-factor-crud", "name": "因子维护"},
            {"id": "warn-backtest-run", "name": "回测执行"},
            {"id": "warn-backtest-result", "name": "回测结果"},
        ],
    },
    {
        "id": "warn-suppress",
        "name": "预警抑制管理",
        "modules": [
            {"id": "warn-suppress-draft", "name": "草稿配置"},
            {"id": "warn-suppress-publish", "name": "提交生效"},
            {"id": "warn-suppress-lifecycle", "name": "终止删除"},
            {"id": "warn-suppress-query", "name": "查询筛选"},
            {"id": "warn-suppress-e2e", "name": "端到端"},
        ],
    },
    {
        "id": "warn-runtime",
        "name": "预警运行",
        "modules": [
            {"id": "warn-gen-smoke", "name": "占位烟测"},
            {"id": "warn-gen-eval", "name": "评估命中"},
            {"id": "warn-gen-suppress-rt", "name": "运行时抑制"},
            {"id": "warn-gen-lifecycle", "name": "事件生命周期"},
            {"id": "warn-gen-query", "name": "事件查询"},
            {"id": "warn-gen-e2e", "name": "生成端到端"},
            {"id": "warn-notify-confirm", "name": "确认任务"},
            {"id": "warn-notify-dispatch", "name": "通知投递"},
            {"id": "warn-notify-retry", "name": "通知重试"},
        ],
    },

]


def list_device_types() -> list[dict[str, Any]]:
    return [
        {"id": t["id"], "name": t["name"], "hasBizQuery": bool(t.get("bizPath"))}
        for t in DEVICE_TYPES
    ]

def list_lightning_networks() -> list[dict[str, Any]]:
    """雷电三网列表(CMB / LOCATOR / RADAR)。"""
    return [
        {"id": n["id"], "name": n["name"], "hasBizQuery": bool(n.get("bizPath"))}
        for n in LIGHTNING_NETWORKS
    ]


def _normalize_device_types(raw: Any) -> list[str]:
    """用例绑定的设备类型；空列表表示公共用例（不随类型过滤）。"""
    if raw is None:
        return []
    if isinstance(raw, str):
        text = raw.strip()
        return [text] if text else []
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    known = {t["id"] for t in DEVICE_TYPES}
    for item in raw:
        tid = str(item or "").strip()
        if tid and tid in known and tid not in out:
            out.append(tid)
    return out


def require_safe_id(value: str, label: str = "id") -> str:
    text = str(value or "").strip()
    if not text or not _SAFE_ID_RE.fullmatch(text):
        raise ValueError(f"非法{label}（仅允许字母数字 . _ -）")
    return text


def _ensure_under(base: Path, path: Path) -> Path:
    base_r = base.resolve()
    path_r = path.resolve()
    if not path_r.is_relative_to(base_r):
        raise ValueError("非法路径")
    return path_r


def _capability(capability_id: str) -> dict[str, Any]:
    cid = CAPABILITY_ALIASES.get(capability_id, capability_id)
    for cap in CAPABILITIES:
        if cap["id"] == cid:
            return cap
    raise ValueError(f"unknown capability: {capability_id}")


MODULES: dict[str, str] = {
    m["id"]: m["name"] for cap in CAPABILITIES for m in cap["modules"]
}

# 旧一级 id → 现一级 id（查询 capability 树时兼容）
CAPABILITY_ALIASES = {
    "warn-gen": "warn-runtime",
    "warn-factor": "warn-rule",
    "warn-notify": "warn-runtime",
    "warn-backtest": "warn-rule",
}

# 旧调用若仍传一级 id 当 module，落到该能力下第一个二级（仅兼容读写单目录）
LEGACY_MODULE_ALIASES = {
    "warn-rule": "warn-rule-draft",
    "warn-suppress": "warn-suppress-draft",
    "warn-gen": "warn-gen-smoke",
    "warn-runtime": "warn-gen-smoke",
    "warn-factor": "warn-factor-query",
    "warn-notify": "warn-notify-confirm",
    "warn-backtest": "warn-backtest-run",
    "device-ingest": "device-ingest-smoke",
    "lightning-ingest": "lightning-ingest-smoke",
}

UI_LABELS = {
    "caseFile": "用例文件",
    "assertion": "判定条件",
    "suppress": "预警抑制管理",
}

# 雷电三网类型(CMB / LOCATOR / RADAR)
LIGHTNING_NETWORKS: list[dict[str, Any]] = [
    {
        "id": "CMB",
        "name": "lightning-strike-cmb",
        "bizPath": "/monitor/lightning/cmb/lightnings?pageNum=1&pageSize=10",
        "otherBizPath": "/monitor/lightning/locator/lightnings?pageNum=1&pageSize=10",
        "recentPath": "/ingest/standard/cmb/recent",
        "kafkaTopic": "lightning-strike-cmb",
        "fixedStrikeId": "cmb_e2e_fixed_strike",
        "lowQualityRuleCode": "LIGHTNING_CMB_QUALITY",
        "kafkaJson": "{\"lightningType\":\"0\",\"strikeTime\":\"2026-07-30T10:27:47.9532218\",\"pushTime\":\"2026-07-30T10:32:58\",\"longitude\":104.24623,\"latitude\":30.634212,\"peakCurrent\":-29.948872,\"height\":5.93854,\"province\":\"四川省\",\"city\":\"成都市\",\"county\":\"龙泉驿区\",\"provinceCode\":510000,\"cityCode\":510100,\"countyCode\":510112,\"strikeId\":\"cmb_e2e_${rand}\"}",
        "kafkaJsonDedup": "{\"lightningType\":\"0\",\"strikeTime\":\"${now-1m}\",\"pushTime\":\"${now-1m}\",\"longitude\":104.24623,\"latitude\":30.634212,\"peakCurrent\":-29.948872,\"height\":5.93854,\"province\":\"四川省\",\"city\":\"成都市\",\"county\":\"龙泉驿区\",\"provinceCode\":510000,\"cityCode\":510100,\"countyCode\":510112,\"strikeId\":\"cmb_e2e_fixed_strike\"}",
        "kafkaJsonFuture": "{\"lightningType\":\"0\",\"strikeTime\":\"${now+10m}\",\"pushTime\":\"${now+1m}\",\"longitude\":104.24623,\"latitude\":30.634212,\"peakCurrent\":-29.9,\"height\":5.9,\"province\":\"四川省\",\"city\":\"成都市\",\"county\":\"龙泉驿区\",\"provinceCode\":510000,\"cityCode\":510100,\"countyCode\":510112,\"strikeId\":\"cmb_future_${rand}\"}",
        "kafkaJsonLowQuality": "{\"lightningType\":\"0\",\"strikeTime\":\"${now-1m}\",\"pushTime\":\"${now-1m}\",\"longitude\":104.24623,\"latitude\":30.634212,\"peakCurrent\":450,\"height\":5.9,\"province\":\"四川省\",\"city\":\"成都市\",\"county\":\"龙泉驿区\",\"provinceCode\":510000,\"cityCode\":510100,\"countyCode\":510112,\"strikeId\":\"cmb_peak_${rand}\"}",
    },
    {
        "id": "LOCATOR",
        "name": "lightning-strike-locator",
        "bizPath": "/monitor/lightning/locator/lightnings?pageNum=1&pageSize=10",
        "otherBizPath": "/monitor/lightning/cmb/lightnings?pageNum=1&pageSize=10",
        "recentPath": "/ingest/standard/locator/recent",
        "kafkaTopic": "lightning-strike-locator",
        "fixedStrikeId": "loc_e2e_fixed_strike",
        "lowQualityRuleCode": "LIGHTNING_LOCATOR_QUALITY",
        "kafkaJson": "{\"strikeId\":\"loc_e2e_${rand}\",\"strikeTime\":\"2026-07-23T11:57:17\",\"pushTime\":\"2026-07-23T12:00:01\",\"longitude\":103.13191,\"latitude\":31.09037,\"lightningType\":0,\"siteCount\":5,\"province\":\"四川省\",\"city\":\"阿坝藏族羌族自治州\",\"county\":\"汶川县\"}",
        "kafkaJsonDedup": "{\"strikeId\":\"loc_e2e_fixed_strike\",\"strikeTime\":\"${now-1m}\",\"pushTime\":\"${now-1m}\",\"longitude\":103.13191,\"latitude\":31.09037,\"lightningType\":0,\"siteCount\":5,\"province\":\"四川省\",\"city\":\"阿坝藏族羌族自治州\",\"county\":\"汶川县\"}",
        "kafkaJsonFuture": "{\"strikeId\":\"loc_future_${rand}\",\"strikeTime\":\"${now+10m}\",\"pushTime\":\"${now+1m}\",\"longitude\":103.13191,\"latitude\":31.09037,\"lightningType\":0,\"siteCount\":5,\"province\":\"四川省\",\"city\":\"阿坝藏族羌族自治州\",\"county\":\"汶川县\"}",
        "kafkaJsonLowQuality": "{\"strikeId\":\"loc_site_${rand}\",\"strikeTime\":\"${now-1m}\",\"pushTime\":\"${now-1m}\",\"longitude\":103.13191,\"latitude\":31.09037,\"lightningType\":0,\"siteCount\":2,\"province\":\"四川省\",\"city\":\"阿坝藏族羌族自治州\",\"county\":\"汶川县\"}",
    },
    {
        "id": "RADAR",
        "name": "lightning-strike-radar",
        "bizPath": "/monitor/lightning/radar/lightnings?pageNum=1&pageSize=10",
        "otherBizPath": "/monitor/lightning/cmb/lightnings?pageNum=1&pageSize=10",
        "recentPath": "/ingest/standard/radar/recent",
        "kafkaTopic": "lightning-strike-radar",
        "fixedStrikeId": "radar_e2e_fixed_strike",
        "lowQualityRuleCode": "LIGHTNING_RADAR_QUALITY",
        "kafkaJson": "{\"lightningType\":\"0\",\"strikeTime\":\"2026-07-27T13:56:44.031840\",\"pushTime\":\"2026-07-27T14:10:42\",\"longitude\":107.327846,\"latitude\":21.992617,\"peakCurrent\":40.946095,\"height\":11.621,\"province\":\"广西壮族自治区\",\"city\":\"崇左市\",\"county\":\"宁明县\",\"provinceCode\":450000,\"cityCode\":451400,\"countyCode\":451422,\"strikeId\":\"radar_e2e_${rand}\",\"dataSource\":\"3\"}",
        "kafkaJsonDedup": "{\"lightningType\":\"0\",\"strikeTime\":\"${now-1m}\",\"pushTime\":\"${now-1m}\",\"longitude\":107.327846,\"latitude\":21.992617,\"peakCurrent\":40.946095,\"height\":11.621,\"province\":\"广西壮族自治区\",\"city\":\"崇左市\",\"county\":\"宁明县\",\"provinceCode\":450000,\"cityCode\":451400,\"countyCode\":451422,\"strikeId\":\"radar_e2e_fixed_strike\",\"dataSource\":\"3\"}",
        "kafkaJsonFuture": "{\"lightningType\":\"0\",\"strikeTime\":\"${now+10m}\",\"pushTime\":\"${now+1m}\",\"longitude\":107.327846,\"latitude\":21.992617,\"peakCurrent\":40.9,\"height\":11.6,\"province\":\"广西壮族自治区\",\"city\":\"崇左市\",\"county\":\"宁明县\",\"provinceCode\":450000,\"cityCode\":451400,\"countyCode\":451422,\"strikeId\":\"radar_future_${rand}\",\"dataSource\":\"3\"}",
        "kafkaJsonLowQuality": "{\"lightningType\":\"0\",\"strikeTime\":\"${now-1m}\",\"pushTime\":\"${now-1m}\",\"longitude\":10.0,\"latitude\":30.0,\"peakCurrent\":40.9,\"height\":11.6,\"province\":\"广西壮族自治区\",\"city\":\"崇左市\",\"county\":\"宁明县\",\"provinceCode\":450000,\"cityCode\":451400,\"countyCode\":451422,\"strikeId\":\"radar_coord_${rand}\",\"dataSource\":\"3\"}",
    },
]

# 设备解析能力：全部设备类型（对齐 data-service DeviceMonitorType）
# bizPath 为空表示暂无 biz BFF 列表接口，仅有 monitor 验收用例
# deviceHex：全链路注入用合法 HEX（CRC 有效）；勾选类型必须具备夹具
DEVICE_TYPES: list[dict[str, Any]] = [
    {
        "id": "ATMOSPHERE_ELECTRIC_FIELD",
        "name": "大气电场",
        "bizPath": "/monitor/atmosphere/atmospheres?pageNum=1&pageSize=10",
        # 19 型 GPS 样例（scripts/tcp-test.py）
        "deviceHex": "5A4B411900190004000100520050FFFF04B703960000000207EA0005000D000B001500340045CD6CD442004E39C519423839383630343436313032353730353231383139AEFC0D0A",
    },
    {
        "id": "GROUNDING_RESISTANCE",
        "name": "接地电阻",
        "bizPath": "/monitor/grounding/groundings?pageNum=1&pageSize=10",
        # 5A4B len=0x11 type=03 addr=1 cmd=0001 + 5×uint16 + CRC + 0D0A
        "deviceHex": "5A4B1103000000010001000A0014001E00280032E3CC0D0A",
    },
    {
        "id": "SURGE_CURRENT",
        "name": "浪涌/雷击电流",
        "bizPath": "/monitor/surge-current/surge-currents?pageNum=1&pageSize=10",
        "deviceHex": "5A4B140500000001000103E807EA030F0C1E2D00010E7493E20D0A",
    },
    {
        "id": "ISPD_PDU",
        "name": "智能SPD/PDU",
        "bizPath": "/monitor/ispd-pdu/ispd-pdus?pageNum=1&pageSize=10",
        "deviceHex": "5A4B170F00000001000100010064138809C409C4089803E8000131450D0A",
    },
    {"id": "SURGE_MONITOR", "name": "浪涌监测", "bizPath": "", "deviceHex": "5A4B0B14000000010001000A0E74B87E0D0A"},
    {"id": "DISCONNECT_CARD", "name": "脱离卡", "bizPath": "", "deviceHex": "5A4B0A090000000100010001724F3A0D0A"},
    {"id": "REMOTE_TERMINAL", "name": "远程终端", "bizPath": "", "deviceHex": "5A4B2C1000000001000101435C00003FC0000043A500003F73333342480000447A000000000000096004B0025801F4050D0D0A"},
    {"id": "POWER_BOARD", "name": "电源板", "bizPath": "", "deviceHex": "5A4B22170000000100013A985DC02EE01770050000000000000000000000FA281E01000001BB220D0A"},
    {"id": "SPD_WAVEFORM_HEARTBEAT", "name": "SPD波形心跳", "bizPath": "", "deviceHex": "5A4B231800000001000138393836303434363130323537303532313831390507EA030F0C1E2DE6340D0A"},
    {"id": "SPD_WAVEFORM_SUMMARY", "name": "SPD波形摘要", "bizPath": "", "deviceHex": "5A4BAA1800000001000107F30100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006400500000000A000000080007EA030F0C1E2DD6FE0D0A"},
]

# 接地电阻行为夹具（拒收/低质/CRC/粘包），供非 expand 用例直接引用
DEVICE_GROUNDING_FIXTURES: dict[str, str] = {
    "ok": "5A4B1103000000010001000A0014001E00280032E3CC0D0A",
    "reject": "5A4B110300000001000100C80014001E00280032AAA90D0A",  # resistance=200 > 100
    "lowQuality": "5A4B1103000000010001000A0014001E0004003222050D0A",  # ph=4 < 5
    "badCrc": "5A4B1103000000010001000A0014001E0028003200000D0A",
    "frag1": "5A4B1103000000010001000A",
    "frag2": "0014001E00280032E3CC0D0A",
}


def _resolve_module(module: str) -> str:
    if module in MODULES:
        return module
    if module in LEGACY_MODULE_ALIASES:
        return LEGACY_MODULE_ALIASES[module]
    raise ValueError(f"unknown module: {module}")


def _module_dir(module: str) -> Path:
    mid = _resolve_module(module)
    d = CASES_ROOT / mid
    d.mkdir(parents=True, exist_ok=True)
    return d


def list_capabilities() -> list[dict[str, Any]]:
    """操作台左侧：一级能力及其二级模块元数据。"""
    return [
        {
            "id": cap["id"],
            "name": cap["name"],
            "modules": [{"id": m["id"], "name": m["name"]} for m in cap["modules"]],
        }
        for cap in CAPABILITIES
    ]


def list_modules() -> list[dict[str, str]]:
    """扁平二级模块列表（兼容旧调用 / 测试）。"""
    return [{"id": mid, "name": name} for mid, name in MODULES.items()]


def list_cases(module: str) -> list[dict[str, Any]]:
    d = _module_dir(module)
    mid = _resolve_module(module)
    rows: list[dict[str, Any]] = []
    for f in sorted(d.glob("*.yaml")) + sorted(d.glob("*.yml")) + sorted(d.glob("*.json")):
        if f.name.startswith("_"):
            continue
        case = _read_file(f)
        steps = case.get("steps") or []
        if not isinstance(steps, list):
            steps = []
        rows.append(
            {
                "id": case.get("id") or f.stem,
                "module": mid,
                "name": case.get("name") or f.stem,
                "description": case.get("description") or "",
                "skip": bool(case.get("skip")),
                "skipReason": case.get("skipReason") or "",
                "expandByDeviceType": bool(case.get("expandByDeviceType")),
                "expandByNetwork": bool(case.get("expandByNetwork")),
                "expandRequiresBiz": bool(case.get("expandRequiresBiz")),
                "deviceTypes": _normalize_device_types(case.get("deviceTypes")),
                "file": f.name,
                "stepCount": len(steps),
                "sub": _case_sub(case, steps),
                "flow": _case_flow(case, steps),
            }
        )
    return rows


def list_capability_cases(capability_id: str) -> dict[str, Any]:
    """一级能力下按二级分组的用例树。"""
    cap = _capability(capability_id)
    groups = []
    for m in cap["modules"]:
        cases = list_cases(m["id"])
        groups.append(
            {
                "id": m["id"],
                "name": m["name"],
                "caseCount": len(cases),
                "cases": cases,
            }
        )
    return {
        "id": cap["id"],
        "name": cap["name"],
        "groups": groups,
        "caseCount": sum(g["caseCount"] for g in groups),
    }


def _case_sub(case: dict[str, Any], steps: list[Any]) -> str:
    methods = []
    for step in steps:
        if isinstance(step, dict) and step.get("method"):
            methods.append(str(step["method"]).upper())
    method_txt = "/".join(dict.fromkeys(methods)) if methods else "HTTP"
    skip = "跳过" if case.get("skip") else "可执行"
    expand = "按类型展开" if case.get("expandByDeviceType") else "通用"
    return f"{method_txt} · {len(steps)} 步 · {skip} · {expand}"


def _case_flow(case: dict[str, Any], steps: list[Any]) -> str:
    if case.get("skip"):
        reason = case.get("skipReason") or "用例标记为跳过"
        return f"前置: {reason}"
    parts: list[str] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        method = str(step.get("method") or "GET").upper()
        path = str(step.get("path") or "/")
        expect = step.get("expect") or {}
        status = expect.get("status")
        bit = f"{method} {path}"
        if status is not None:
            bit += f" → 期望 {status}"
        parts.append(bit)
    if not parts:
        return "前置: 无步骤"
    return "前置: " + " → ".join(parts)


def get_case(module: str, case_id: str) -> dict[str, Any]:
    mid = _resolve_module(module)
    case_id = require_safe_id(case_id, "用例 id")
    path = _find_path(mid, case_id)
    if path is None:
        raise FileNotFoundError(case_id)
    case = _read_file(path)
    case["id"] = case.get("id") or case_id
    case["module"] = mid
    case["file"] = path.name
    return case


def save_case(module: str, case: dict[str, Any]) -> dict[str, Any]:
    mid = _resolve_module(module)
    case_id = require_safe_id(str(case.get("id") or ""), "用例 id")
    name = str(case.get("name") or case_id).strip()
    device_types = _normalize_device_types(case.get("deviceTypes"))
    payload = {
        "id": case_id,
        "name": name,
        "description": str(case.get("description") or "").strip(),
        "skip": bool(case.get("skip")),
        "skipReason": case.get("skipReason") or "",
        "expandByDeviceType": bool(case.get("expandByDeviceType")),
        "expandRequiresBiz": bool(case.get("expandRequiresBiz")),
        "deviceTypes": device_types,
        "steps": case.get("steps") or [],
    }
    base = _module_dir(mid)
    path = _ensure_under(base, base / f"{case_id}.yaml")
    path.write_text(
        yaml.safe_dump(payload, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    payload["module"] = mid
    payload["file"] = path.name
    return payload


def delete_case(module: str, case_id: str) -> None:
    mid = _resolve_module(module)
    case_id = require_safe_id(case_id, "用例 id")
    path = _find_path(mid, case_id)
    if path is None:
        raise FileNotFoundError(case_id)
    path.unlink()


def _find_path(module: str, case_id: str) -> Path | None:
    case_id = require_safe_id(case_id, "用例 id")
    d = _module_dir(module)
    for ext in (".yaml", ".yml", ".json"):
        p = _ensure_under(d, d / f"{case_id}{ext}")
        if p.exists():
            return p
    for f in d.iterdir():
        if not f.is_file() or f.name.startswith("_"):
            continue
        try:
            data = _read_file(f)
        except Exception:
            continue
        if str(data.get("id")) == case_id:
            return f
    return None


def _read_file(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        data = json.loads(text)
    else:
        data = yaml.safe_load(text) or {}
    if not isinstance(data, dict):
        raise ValueError(f"invalid case file: {path}")
    return data

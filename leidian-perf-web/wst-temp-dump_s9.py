import json
from pathlib import Path

s9 = json.loads(
    Path("/app/data/stage-records.postgres.json").read_text(encoding="utf-8")
)["dialects"]["postgres"]["stages"]["S9"]

print("=== updatedAt", s9["updatedAt"])
print("=== env")
print(json.dumps(s9["section11_1"], ensure_ascii=False, indent=2)[:1000])
print()

bh = s9["benchmarkHistory"][-1]
print(
    "=== run",
    bh.get("runId"),
    bh.get("runAt"),
    "passed",
    bh.get("passed"),
)
print(
    "iters write",
    bh.get("writeIterations"),
    "query",
    bh.get("queryIterations"),
    "scenarios",
    bh.get("scenarios"),
)
print()
print("=== section11_4 (summary table) ===")
for r in s9["section11_4"]:
    note = (r.get("note") or "")[:100]
    print(
        f"{r['id']:16} pass={r.get('passed')} conc={r.get('concurrency')} "
        f"exec={r.get('executions')} ok={r.get('successOps')} err={r.get('errorCount')} "
        f"rate={r.get('successRate')} avg={r.get('avgMs')} p95={r.get('p95')} "
        f"p99={r.get('p99')} lim95={r.get('p95LimitMs')} tps={r.get('tps')} note={note}"
    )

print()
print("=== detailed results ===")
for r in bh.get("results", []):
    sid = r.get("id") or r.get("scenarioId") or r.get("scenario")
    print("---", sid)
    for k in [
        "name",
        "passed",
        "concurrency",
        "executions",
        "successOps",
        "errorCount",
        "successRate",
        "avgMs",
        "p50",
        "p95",
        "p99",
        "p95LimitMs",
        "p99LimitMs",
        "tps",
        "durationSec",
        "startedAt",
        "finishedAt",
        "connPeak",
        "slowSqlCount",
        "note",
        "errorSamples",
        "errors",
        "subQueries",
    ]:
        if k not in r or r[k] in (None, "", [], {}):
            continue
        v = r[k]
        if k == "subQueries" and isinstance(v, dict):
            print("  subQueries:")
            for sk, sv in v.items():
                print(
                    f"    {sk}: pass={sv.get('passed')} ok={sv.get('successOps')} "
                    f"err={sv.get('errorCount')} avg={sv.get('avgMs')} p95={sv.get('p95')} "
                    f"p99={sv.get('p99')} lim95={sv.get('p95LimitMs')} tps={sv.get('tps')}"
                )
        elif k in ("errorSamples", "errors") and isinstance(v, list):
            print(f"  {k}:", v[:5])
        else:
            print(f"  {k}:", str(v)[:300])

print()
print("=== section11_5 resources ===")
for r in s9["section11_5"]:
    print(
        f"{r['id']:20} cpuAvg={r.get('cpuAvg')} cpuPeak={r.get('cpuPeak')} "
        f"mem={r.get('memAvg')} io={r.get('diskIoWait')} conn={r.get('connPeak')} "
        f"slow={r.get('slowSqlCount')} idx={r.get('indexHit')} part={r.get('partitionPrune')}"
    )

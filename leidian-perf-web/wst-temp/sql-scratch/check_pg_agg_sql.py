from datetime import datetime
import sys
sys.path.insert(0, r"D:\mytools\leidian-perf-web\python")
from generators.sql_bench import BenchContext, _sql_perf05_agg
ctx = BenchContext(
    mine_code="M1", lon=100.0, lat=30.0,
    device_addrs=["ATM-DS-STD-001", "ATM-DS-STD-002"],
    query_start=datetime(2025, 6, 1, 0, 0, 0),
    query_end=datetime(2025, 6, 2, 0, 0, 0),
    process_id=1,
    process_strike_start=datetime(2025, 6, 1, 12, 0, 0),
    process_strike_end=datetime(2025, 6, 1, 14, 0, 0),
    process_data_window_start=datetime(2025, 6, 1, 12, 0, 0),
    process_data_window_end=datetime(2025, 6, 1, 14, 0, 0),
    atmosphere_count=1, raw_count=1, lightning_count=1,
    perf05_agg_bucket_minutes=1,
    curve_device_addrs=["ATM-DS-STD-001", "ATM-DS-STD-002"],
)
sql, _ = _sql_perf05_agg(ctx, 0, 0)
assert "WITH base" not in sql
assert "date_trunc(" in sql and "minute" in sql
print("bucket1 ok")
ctx.perf05_agg_bucket_minutes = 5
sql5, _ = _sql_perf05_agg(ctx, 0, 0)
assert "WITH base" not in sql5
assert "floor(extract(minute" in sql5
print("bucket5 ok")
print(sql)

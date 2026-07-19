"""S2 校验失败项诊断（一次性脚本）。"""
from generators.db import build_dsn, pg_connection
from generators.raw_budget import abnormal_raw_count
from generators.validate import _check_std_biz_1_1, LIGHTNING_STD_BIZ_PAIRS

dsn = build_dsn("192.168.1.41", "5432", "leidian_perf", "leidian", "leidian")
schema = "perf"
target_raw = 9029049

with pg_connection(dsn, schema=schema) as conn:
    with conn.cursor() as cur:
        print("=== 1. 大气 standard ↔ biz ===")
        m, o, d = _check_std_biz_1_1(
            cur, schema, "standard_atmosphere_electric_field", "biz_atmosphere_electric_field_event"
        )
        print(f"missing={m}, orphan={o}, duplicate_key={d}")

        cur.execute(
            f"""
            SELECT count(*) FROM {schema}.standard_atmosphere_electric_field
            WHERE quality_status = 'PERF_BENCH'
            """
        )
        bench_std = cur.fetchone()[0]
        cur.execute(
            f"""
            SELECT count(*) FROM {schema}.biz_atmosphere_electric_field_event b
            LEFT JOIN {schema}.standard_atmosphere_electric_field s ON s.id = b.standard_record_id
            WHERE s.id IS NULL
            LIMIT 5
            """
        )
        print(f"PERF_BENCH standard 行: {bench_std}")
        print(f"orphan biz 总数: {o}")

        cur.execute(
            f"""
            SELECT b.source_type, count(*) FROM {schema}.biz_atmosphere_electric_field_event b
            LEFT JOIN {schema}.standard_atmosphere_electric_field s ON s.id = b.standard_record_id
            WHERE s.id IS NULL
            GROUP BY b.source_type
            """
        )
        print("orphan biz 按 source_type:", cur.fetchall())

        print("\n=== 2. 闪电 standard ↔ biz ===")
        for std_table, source_type in LIGHTNING_STD_BIZ_PAIRS:
            m, o, d = _check_std_biz_1_1(cur, schema, std_table, "biz_lightning_event", source_type)
            print(f"{std_table} / {source_type}: missing={m}, orphan={o}, dup={d}")

        cur.execute(f"SELECT count(*) FROM {schema}.biz_lightning_event WHERE source_type='PERF_BENCH'")
        print(f"PERF_BENCH biz 闪电: {cur.fetchone()[0]}")

        print("\n=== 3. raw 异常报文 ===")
        cur.execute(
            f"SELECT count(*) FROM {schema}.raw_kafka_message WHERE process_status <> 'SUCCESS'"
        )
        abnormal = int(cur.fetchone()[0])
        expected = abnormal_raw_count(target_raw)
        cur.execute(f"SELECT count(*) FROM {schema}.raw_kafka_message WHERE topic = 'perf-sql-bench'")
        bench_raw = int(cur.fetchone()[0])
        print(f"abnormal={abnormal}, expected={expected}, diff={abnormal - expected}")
        print(f"perf-sql-bench raw 残留: {bench_raw}")
        print(f"ratio={abnormal/target_raw:.6f}")

        print("\n=== 4. 行数快照 ===")
        for t in (
            "standard_atmosphere_electric_field",
            "biz_atmosphere_electric_field_event",
            "raw_kafka_message",
            "biz_lightning_event",
        ):
            cur.execute(f"SELECT count(*) FROM {schema}.{t}")
            print(f"{t}: {cur.fetchone()[0]:,}")

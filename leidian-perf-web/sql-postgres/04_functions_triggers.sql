-- PERF 辅助函数：月分区创建、空间点同步触发器

SET search_path TO perf, public;

-- ============================================================
-- 按月创建 RANGE 分区（左闭右开 [month_start, month_end)）
-- p_parent_table：父表 regclass，如 'perf.raw_kafka_message'::regclass
-- p_start_month / p_end_month：含起止月份，格式 YYYY-MM-01
-- ============================================================
CREATE OR REPLACE FUNCTION create_monthly_partitions(
    p_parent_table   regclass,
    p_start_month    date,
    p_end_month      date
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_parent_schema  text;
    v_parent_name    text;
    v_month          date;
    v_next           date;
    v_part_name      text;
    v_sql            text;
BEGIN
    IF p_start_month > p_end_month THEN
        RAISE EXCEPTION 'p_start_month (%) must be <= p_end_month (%)', p_start_month, p_end_month;
    END IF;

    SELECT n.nspname, c.relname
      INTO v_parent_schema, v_parent_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid = p_parent_table;

    IF v_parent_name IS NULL THEN
        RAISE EXCEPTION 'Parent table % not found', p_parent_table;
    END IF;

    v_month := date_trunc('month', p_start_month)::date;

    WHILE v_month <= p_end_month LOOP
        v_next := (v_month + INTERVAL '1 month')::date;
        v_part_name := format('%s_y%sm%s', v_parent_name, to_char(v_month, 'YYYY'), to_char(v_month, 'MM'));
        v_sql := format(
            'CREATE TABLE IF NOT EXISTS %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
            v_parent_schema,
            v_part_name,
            v_parent_schema,
            v_parent_name,
            v_month,
            v_next
        );
        EXECUTE v_sql;
        v_month := v_next;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION create_monthly_partitions(regclass, date, date) IS
    '为 perf 分区父表批量创建按月子分区';

-- ============================================================
-- mine_site.dispatch_room_point ← dispatch_room_lon/lat
-- ============================================================
CREATE OR REPLACE FUNCTION trg_sync_dispatch_room_point()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.dispatch_room_lon IS NOT NULL AND NEW.dispatch_room_lat IS NOT NULL THEN
        NEW.dispatch_room_point := ST_SetSRID(
            ST_MakePoint(NEW.dispatch_room_lon::double precision, NEW.dispatch_room_lat::double precision),
            4326
        )::geography;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mine_site_dispatch_room_point ON mine_site;
CREATE TRIGGER trg_mine_site_dispatch_room_point
    BEFORE INSERT OR UPDATE OF dispatch_room_lon, dispatch_room_lat ON mine_site
    FOR EACH ROW
    EXECUTE FUNCTION trg_sync_dispatch_room_point();

-- ============================================================
-- lightning_point ← longitude/latitude（大网 / 小网 / biz）
-- ============================================================
CREATE OR REPLACE FUNCTION trg_sync_lightning_point()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.longitude IS NOT NULL AND NEW.latitude IS NOT NULL THEN
        NEW.lightning_point := ST_SetSRID(
            ST_MakePoint(NEW.longitude::double precision, NEW.latitude::double precision),
            4326
        )::geography;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_std_cmb_lightning_point ON standard_lightning_strike_cmb;
CREATE TRIGGER trg_std_cmb_lightning_point
    BEFORE INSERT OR UPDATE OF longitude, latitude ON standard_lightning_strike_cmb
    FOR EACH ROW
    EXECUTE FUNCTION trg_sync_lightning_point();

DROP TRIGGER IF EXISTS trg_std_locator_lightning_point ON standard_lightning_strike_locator;
CREATE TRIGGER trg_std_locator_lightning_point
    BEFORE INSERT OR UPDATE OF longitude, latitude ON standard_lightning_strike_locator
    FOR EACH ROW
    EXECUTE FUNCTION trg_sync_lightning_point();

DROP TRIGGER IF EXISTS trg_biz_lightning_point ON biz_lightning_event;
CREATE TRIGGER trg_biz_lightning_point
    BEFORE INSERT OR UPDATE OF longitude, latitude ON biz_lightning_event
    FOR EACH ROW
    EXECUTE FUNCTION trg_sync_lightning_point();

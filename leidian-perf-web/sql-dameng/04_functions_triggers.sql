-- PERF procedures and triggers (DM8 DMGEO2)

ALTER SESSION SET CURRENT_SCHEMA = "PERF";

-- ============================================================
-- 按月创建 RANGE 分区（左闭右开 [month_start, month_end)）
-- p_parent_table：父表名，如 'RAW_KAFKA_MESSAGE'
-- p_start_month / p_end_month：含起止月份，格式 YYYY-MM-01
-- ============================================================
CREATE OR REPLACE PROCEDURE create_monthly_partitions(
    p_parent_table   VARCHAR(128),
    p_start_month    DATE,
    p_end_month      DATE
)
AS
    v_month          DATE;
    v_next           DATE;
    v_part_name      VARCHAR(128);
    v_sql            VARCHAR(4000);
    v_parent_upper   VARCHAR(128);
BEGIN
    IF p_start_month > p_end_month THEN
        RAISE_APPLICATION_ERROR(-20001, 'p_start_month must be <= p_end_month');
    END IF;

    v_parent_upper := UPPER(TRIM(p_parent_table));
    v_month := TRUNC(p_start_month, 'MM');

    WHILE v_month <= p_end_month LOOP
        v_next := ADD_MONTHS(v_month, 1);
        v_part_name := v_parent_upper || '_Y' || TO_CHAR(v_month, 'YYYY') || 'M' || TO_CHAR(v_month, 'MM');
        v_sql := 'ALTER TABLE ' || v_parent_upper ||
                 ' ADD PARTITION ' || v_part_name ||
                 ' VALUES LESS THAN (TO_TIMESTAMP(''' ||
                 TO_CHAR(v_next, 'YYYY-MM-DD') || ' 00:00:00'', ''YYYY-MM-DD HH24:MI:SS''))';
        BEGIN
            EXECUTE IMMEDIATE v_sql;
        EXCEPTION
            WHEN OTHERS THEN
                IF SQLCODE NOT IN (-2106, -2124, -2260, -2730) THEN
                    RAISE;
                END IF;
        END;
        v_month := v_next;
    END LOOP;

    v_sql := 'ALTER TABLE ' || v_parent_upper ||
             ' ADD PARTITION ' || v_parent_upper || '_P_MAX' ||
             ' VALUES LESS THAN (TO_TIMESTAMP(''2099-01-01 00:00:00'', ''YYYY-MM-DD HH24:MI:SS''))';
    BEGIN
        EXECUTE IMMEDIATE v_sql;
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLCODE NOT IN (-2106, -2124, -2260, -2730) THEN
                RAISE;
            END IF;
    END;
END;
/

-- ============================================================
-- mine_site.dispatch_room_point <- dispatch_room_lon/lat
-- ============================================================
CREATE OR REPLACE TRIGGER trg_mine_site_dispatch_room_point
BEFORE INSERT OR UPDATE OF dispatch_room_lon, dispatch_room_lat ON mine_site
FOR EACH ROW
BEGIN
    IF :NEW.dispatch_room_lon IS NOT NULL AND :NEW.dispatch_room_lat IS NOT NULL THEN
        :NEW.dispatch_room_point := DMGEO2.ST_PointFromText(
            'POINT(' || TO_CHAR(:NEW.dispatch_room_lon) || ' ' || TO_CHAR(:NEW.dispatch_room_lat) || ')',
            4326
        );
    END IF;
END;
/

-- ============================================================
-- lightning_point <- longitude/latitude（大网 / 小网 / biz）
-- ============================================================
CREATE OR REPLACE TRIGGER trg_std_cmb_lightning_point
BEFORE INSERT OR UPDATE OF longitude, latitude ON standard_lightning_strike_cmb
FOR EACH ROW
BEGIN
    IF :NEW.longitude IS NOT NULL AND :NEW.latitude IS NOT NULL THEN
        :NEW.lightning_point := DMGEO2.ST_PointFromText(
            'POINT(' || TO_CHAR(:NEW.longitude) || ' ' || TO_CHAR(:NEW.latitude) || ')',
            4326
        );
    END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_std_locator_lightning_point
BEFORE INSERT OR UPDATE OF longitude, latitude ON standard_lightning_strike_locator
FOR EACH ROW
BEGIN
    IF :NEW.longitude IS NOT NULL AND :NEW.latitude IS NOT NULL THEN
        :NEW.lightning_point := DMGEO2.ST_PointFromText(
            'POINT(' || TO_CHAR(:NEW.longitude) || ' ' || TO_CHAR(:NEW.latitude) || ')',
            4326
        );
    END IF;
END;
/

CREATE OR REPLACE TRIGGER trg_biz_lightning_point
BEFORE INSERT OR UPDATE OF longitude, latitude ON biz_lightning_event
FOR EACH ROW
BEGIN
    IF :NEW.longitude IS NOT NULL AND :NEW.latitude IS NOT NULL THEN
        :NEW.lightning_point := DMGEO2.ST_PointFromText(
            'POINT(' || TO_CHAR(:NEW.longitude) || ' ' || TO_CHAR(:NEW.latitude) || ')',
            4326
        );
    END IF;
END;
/

-- PERF 高频分区表（父表定义）
-- 分区键：raw.receive_time / 大气电场 device_upload_time / 闪电 strike_time
-- 子分区由 05_default_partitions.sql 或 create_monthly_partitions() 创建

SET search_path TO perf, public;

-- ============================================================
-- raw_kafka_message：按月 RANGE(receive_time)
-- 去重：topic + partition_no + offset_no（分区表约束须含 receive_time）
-- ============================================================
CREATE TABLE IF NOT EXISTS raw_kafka_message (
    id                BIGINT        NOT NULL,
    topic             VARCHAR(128)  NOT NULL,
    partition_no      INT           NOT NULL,
    offset_no         BIGINT        NOT NULL,
    message_key       VARCHAR(256),
    message_timestamp BIGINT,
    headers_json      TEXT,
    raw_value         TEXT,
    raw_value_type    VARCHAR(32),
    source_type       VARCHAR(32),
    trace_id          VARCHAR(64),
    dedup_key         VARCHAR(256),
    process_status    VARCHAR(32),
    error_message     TEXT,
    receive_time      TIMESTAMP     NOT NULL,
    create_time       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ext_json          TEXT,
    schema_version    VARCHAR(16),
    data_version      VARCHAR(16),
    CONSTRAINT pk_raw_kafka_message PRIMARY KEY (id, receive_time),
    CONSTRAINT uq_raw_kafka_message_tpo UNIQUE (topic, partition_no, offset_no, receive_time)
) PARTITION BY RANGE (receive_time);

CREATE INDEX IF NOT EXISTS idx_raw_kafka_message_topic_time ON raw_kafka_message (topic, receive_time);
CREATE INDEX IF NOT EXISTS idx_raw_kafka_message_source_time ON raw_kafka_message (source_type, receive_time);
CREATE INDEX IF NOT EXISTS idx_raw_kafka_message_status_time ON raw_kafka_message (process_status, receive_time);

COMMENT ON TABLE raw_kafka_message IS 'Kafka 原始报文（PERF 按月分区，receive_time 为分区键）';
COMMENT ON CONSTRAINT uq_raw_kafka_message_tpo ON raw_kafka_message IS
    'Kafka 去重键；分区表 UNIQUE 须包含 receive_time，同一 offset 的 receive_time 在造数/Kafka 重放中应稳定';

-- ============================================================
-- standard_atmosphere_electric_field：按月 RANGE(device_upload_time)
-- ============================================================
CREATE TABLE IF NOT EXISTS standard_atmosphere_electric_field (
    id                  BIGINT        NOT NULL,
    raw_message_id      BIGINT[],
    device_addr         VARCHAR(64)   NOT NULL,
    type_id             VARCHAR(16)   NOT NULL,
    command_type        VARCHAR(8)    NOT NULL,
    device_upload_time  TIMESTAMP     NOT NULL,
    instantaneous_value NUMERIC(12, 2),
    average_value       NUMERIC(12, 2),
    rate_change         NUMERIC(12, 2),
    equipment_voltage   NUMERIC(12, 2),
    voltage_state       VARCHAR(8),
    motor_speed         INTEGER,
    warning_level       INTEGER,
    circuit_number      VARCHAR(50),
    time_category       VARCHAR(10),
    longitude_direction VARCHAR(10),
    longitude           NUMERIC(12, 6),
    latitude_direction  VARCHAR(10),
    latitude            NUMERIC(12, 6),
    card                VARCHAR(64),
    quality_status      VARCHAR(16),
    create_time         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ext_json            TEXT,
    schema_version      VARCHAR(16),
    data_version        VARCHAR(16),
    CONSTRAINT pk_standard_atmosphere_electric_field PRIMARY KEY (id, device_upload_time)
) PARTITION BY RANGE (device_upload_time);

CREATE INDEX IF NOT EXISTS idx_std_atm_field_addr_time ON standard_atmosphere_electric_field (device_addr, device_upload_time);
CREATE INDEX IF NOT EXISTS idx_std_atm_field_upload_time ON standard_atmosphere_electric_field (device_upload_time);

COMMENT ON TABLE standard_atmosphere_electric_field IS '大气电场标准层（PERF 按月分区，device_upload_time 非空连续）';

-- ============================================================
-- biz_atmosphere_electric_field_event：按月 RANGE(device_upload_time)
-- ============================================================
CREATE TABLE IF NOT EXISTS biz_atmosphere_electric_field_event (
    id                  BIGINT        NOT NULL,
    standard_record_id  BIGINT        NOT NULL,
    source_topic        VARCHAR(128),
    source_type         VARCHAR(32)   NOT NULL,
    device_addr         VARCHAR(64)   NOT NULL,
    type_id             VARCHAR(16)   NOT NULL,
    command_type        VARCHAR(8)    NOT NULL,
    device_upload_time  TIMESTAMP     NOT NULL,
    instantaneous_value NUMERIC(12, 2),
    average_value       NUMERIC(12, 2),
    rate_change         NUMERIC(12, 2),
    equipment_voltage   NUMERIC(12, 2),
    voltage_state       VARCHAR(8),
    motor_speed         INTEGER,
    warning_level       INTEGER,
    circuit_number      VARCHAR(50),
    time_category       VARCHAR(10),
    longitude_direction VARCHAR(10),
    longitude           NUMERIC(12, 6),
    latitude_direction  VARCHAR(10),
    latitude            NUMERIC(12, 6),
    card                VARCHAR(64),
    risk_level          INT           NOT NULL DEFAULT 0,
    event_status        VARCHAR(16),
    create_time         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ext_json            TEXT,
    schema_version      VARCHAR(16),
    data_version        VARCHAR(16),
    CONSTRAINT pk_biz_atmosphere_electric_field_event PRIMARY KEY (id, device_upload_time),
    CONSTRAINT uq_biz_atm_field_event_standard UNIQUE (standard_record_id, device_upload_time)
) PARTITION BY RANGE (device_upload_time);

CREATE INDEX IF NOT EXISTS idx_biz_atm_field_addr_time ON biz_atmosphere_electric_field_event (device_addr, device_upload_time);
-- PERF-05-AGG 覆盖时间索引：优化器在满密档(全设备)时本就走时间索引，
-- 改 INCLUDE 让该扫描变 Index Only Scan、免回表（S9 500 台实测从 1GB 堆 I/O 降到仅扫索引）。
-- device_addr + 5 个度量列放 INCLUDE：不参与排序、但满足 WHERE device_addr=ANY 过滤与 AVG/MAX 取列。
CREATE INDEX IF NOT EXISTS idx_biz_atm_field_upload_time ON biz_atmosphere_electric_field_event (
    device_upload_time
)
INCLUDE (
    device_addr,
    instantaneous_value,
    average_value,
    warning_level,
    rate_change,
    risk_level
);
-- PERF-05-AGG 瘦覆盖索引（与达梦对齐）
CREATE INDEX IF NOT EXISTS idx_biz_atm_field_agg_cover ON biz_atmosphere_electric_field_event (
    device_addr,
    device_upload_time,
    instantaneous_value,
    average_value,
    warning_level,
    rate_change,
    risk_level
);

-- ============================================================
-- standard_lightning_strike_cmb：按月 RANGE(strike_time) + lightning_point
-- ============================================================
CREATE TABLE IF NOT EXISTS standard_lightning_strike_cmb (
    id               BIGINT             NOT NULL,
    raw_message_id   BIGINT,
    source_type      VARCHAR(32)        NOT NULL,
    lightning_type   VARCHAR(8),
    strike_time      TIMESTAMP          NOT NULL,
    longitude        DECIMAL(10, 6)     NOT NULL,
    latitude         DECIMAL(10, 6)     NOT NULL,
    lightning_point  GEOGRAPHY(Point, 4326),
    peak_current     DECIMAL(12, 6),
    height           DECIMAL(12, 6),
    province         VARCHAR(64),
    city             VARCHAR(64),
    county           VARCHAR(64),
    province_code    BIGINT,
    city_code        BIGINT,
    county_code      BIGINT,
    quality_status   VARCHAR(16),
    create_time      TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time      TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ext_json         TEXT,
    schema_version   VARCHAR(16),
    data_version     VARCHAR(16),
    CONSTRAINT pk_standard_lightning_strike_cmb PRIMARY KEY (id, strike_time),
    CONSTRAINT uq_std_cmb_dedup UNIQUE (source_type, strike_time, longitude, latitude)
) PARTITION BY RANGE (strike_time);

CREATE INDEX IF NOT EXISTS idx_std_cmb_strike_time ON standard_lightning_strike_cmb (strike_time);
CREATE INDEX IF NOT EXISTS idx_std_cmb_lightning_point_gist ON standard_lightning_strike_cmb USING GIST (lightning_point);

-- ============================================================
-- standard_lightning_strike_locator：按月 RANGE(strike_time) + lightning_point
-- ============================================================
CREATE TABLE IF NOT EXISTS standard_lightning_strike_locator (
    id               BIGINT             NOT NULL,
    raw_message_id   BIGINT,
    source_type      VARCHAR(32)        NOT NULL,
    lightning_type   VARCHAR(8),
    strike_time      TIMESTAMP          NOT NULL,
    longitude        DECIMAL(10, 6)     NOT NULL,
    latitude         DECIMAL(10, 6)     NOT NULL,
    lightning_point  GEOGRAPHY(Point, 4326),
    site_count       INT,
    province         VARCHAR(64),
    city             VARCHAR(64),
    county           VARCHAR(64),
    address          VARCHAR(256),
    province_code    BIGINT,
    city_code        BIGINT,
    county_code      BIGINT,
    quality_status   VARCHAR(16),
    create_time      TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time      TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ext_json         TEXT,
    schema_version   VARCHAR(16),
    data_version     VARCHAR(16),
    CONSTRAINT pk_standard_lightning_strike_locator PRIMARY KEY (id, strike_time),
    CONSTRAINT uq_std_locator_dedup UNIQUE (source_type, strike_time, longitude, latitude)
) PARTITION BY RANGE (strike_time);

CREATE INDEX IF NOT EXISTS idx_std_locator_strike_time ON standard_lightning_strike_locator (strike_time);
CREATE INDEX IF NOT EXISTS idx_std_locator_lightning_point_gist ON standard_lightning_strike_locator USING GIST (lightning_point);

-- ============================================================
-- biz_lightning_event：按月 RANGE(strike_time) + lightning_point
-- 50km 查询：lightning_point + mine_site.dispatch_room_point
-- ============================================================
CREATE TABLE IF NOT EXISTS biz_lightning_event (
    id                 BIGINT             NOT NULL,
    standard_record_id BIGINT,
    source_topic       VARCHAR(128),
    source_type        VARCHAR(32)        NOT NULL,
    lightning_type     VARCHAR(8),
    strike_time        TIMESTAMP          NOT NULL,
    longitude          DECIMAL(10, 6)     NOT NULL,
    latitude           DECIMAL(10, 6)     NOT NULL,
    lightning_point    GEOGRAPHY(Point, 4326),
    peak_current       DECIMAL(12, 6),
    height             DECIMAL(12, 6),
    site_count         INT,
    province           VARCHAR(64),
    city               VARCHAR(64),
    county             VARCHAR(64),
    address            VARCHAR(256),
    display_name       VARCHAR(128),
    risk_level         INT                NOT NULL DEFAULT 0,
    event_status       VARCHAR(16),
    create_time        TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time        TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ext_json           TEXT,
    schema_version     VARCHAR(16),
    data_version       VARCHAR(16),
    CONSTRAINT pk_biz_lightning_event PRIMARY KEY (id, strike_time),
    CONSTRAINT uq_biz_lightning_event_dedup UNIQUE (source_type, strike_time, longitude, latitude)
) PARTITION BY RANGE (strike_time);

CREATE INDEX IF NOT EXISTS idx_biz_lightning_strike_time ON biz_lightning_event (strike_time);
CREATE INDEX IF NOT EXISTS idx_biz_lightning_source ON biz_lightning_event (source_type);
CREATE INDEX IF NOT EXISTS idx_biz_lightning_point_gist ON biz_lightning_event USING GIST (lightning_point);
CREATE INDEX IF NOT EXISTS idx_biz_lightning_time_lon_lat ON biz_lightning_event (strike_time, longitude, latitude);
-- PERF-06 bbox 路径 GROUP BY 覆盖索引（与达梦对齐）
CREATE INDEX IF NOT EXISTS idx_biz_lightning_perf06_cover
ON biz_lightning_event (strike_time, longitude, latitude, source_type, lightning_type);

COMMENT ON COLUMN biz_lightning_event.lightning_point IS '入库时由 longitude/latitude 生成，PERF-06 50km 统计直接使用';

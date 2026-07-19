-- PERF 高频分区表（达梦 DM8 RANGE 分区父表）
-- 分区键：raw.receive_time / 大气电场 device_upload_time / 闪电 strike_time
-- 子分区由 05_default_partitions.sql 通过存储过程批量添加
-- lightning_point: SYSGEO2.ST_GEOMETRY, populated by trigger from lon/lat

ALTER SESSION SET CURRENT_SCHEMA = "PERF";

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
    headers_json      CLOB,
    raw_value         CLOB,
    raw_value_type    VARCHAR(32),
    source_type       VARCHAR(32),
    trace_id          VARCHAR(64),
    dedup_key         VARCHAR(256),
    process_status    VARCHAR(32),
    error_message     CLOB,
    receive_time      TIMESTAMP     NOT NULL,
    create_time       TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time       TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json          CLOB,
    schema_version    VARCHAR(16),
    data_version      VARCHAR(16),
    CONSTRAINT pk_raw_kafka_message PRIMARY KEY (id, receive_time),
    CONSTRAINT uq_raw_kafka_message_tpo UNIQUE (topic, partition_no, offset_no, receive_time)
)
PARTITION BY RANGE (receive_time)
(
    PARTITION raw_kafka_message_p_init VALUES LESS THAN (TO_TIMESTAMP('2025-03-01 00:00:00', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE INDEX IF NOT EXISTS idx_raw_kafka_message_topic_time ON raw_kafka_message (topic, receive_time);
CREATE INDEX IF NOT EXISTS idx_raw_kafka_message_source_time ON raw_kafka_message (source_type, receive_time);
CREATE INDEX IF NOT EXISTS idx_raw_kafka_message_status_time ON raw_kafka_message (process_status, receive_time);

-- raw_kafka_message: monthly partitioned by receive_time

-- ============================================================
-- standard_atmosphere_electric_field：按月 RANGE(device_upload_time)
-- ============================================================
CREATE TABLE IF NOT EXISTS standard_atmosphere_electric_field (
    id                  BIGINT        NOT NULL,
    raw_message_id      VARCHAR(4000),
    device_addr         VARCHAR(64)   NOT NULL,
    type_id             VARCHAR(16)   NOT NULL,
    command_type        VARCHAR(8)    NOT NULL,
    device_upload_time  TIMESTAMP     NOT NULL,
    instantaneous_value NUMERIC(12, 2),
    average_value       NUMERIC(12, 2),
    rate_change         NUMERIC(12, 2),
    equipment_voltage   NUMERIC(12, 2),
    voltage_state       VARCHAR(8),
    motor_speed         INT,
    warning_level       INT,
    circuit_number      VARCHAR(50),
    time_category       VARCHAR(10),
    longitude_direction VARCHAR(10),
    longitude           NUMERIC(12, 6),
    latitude_direction  VARCHAR(10),
    latitude            NUMERIC(12, 6),
    card                VARCHAR(64),
    quality_status      VARCHAR(16),
    create_time         TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time         TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json            CLOB,
    schema_version      VARCHAR(16),
    data_version        VARCHAR(16),
    CONSTRAINT pk_standard_atmosphere_electric_field PRIMARY KEY (id, device_upload_time)
)
PARTITION BY RANGE (device_upload_time)
(
    PARTITION std_atm_field_p_init VALUES LESS THAN (TO_TIMESTAMP('2025-03-01 00:00:00', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE INDEX IF NOT EXISTS idx_std_atm_field_addr_time ON standard_atmosphere_electric_field (device_addr, device_upload_time);
CREATE INDEX IF NOT EXISTS idx_std_atm_field_upload_time ON standard_atmosphere_electric_field (device_upload_time);

-- standard_atmosphere_electric_field: monthly partitioned

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
    motor_speed         INT,
    warning_level       INT,
    circuit_number      VARCHAR(50),
    time_category       VARCHAR(10),
    longitude_direction VARCHAR(10),
    longitude           NUMERIC(12, 6),
    latitude_direction  VARCHAR(10),
    latitude            NUMERIC(12, 6),
    card                VARCHAR(64),
    risk_level          INT           NOT NULL DEFAULT 0,
    event_status        VARCHAR(16),
    create_time         TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time         TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json            CLOB,
    schema_version      VARCHAR(16),
    data_version        VARCHAR(16),
    CONSTRAINT pk_biz_atmosphere_electric_field_event PRIMARY KEY (id, device_upload_time),
    CONSTRAINT uq_biz_atm_field_event_standard UNIQUE (standard_record_id, device_upload_time)
)
PARTITION BY RANGE (device_upload_time)
(
    PARTITION biz_atm_field_p_init VALUES LESS THAN (TO_TIMESTAMP('2025-03-01 00:00:00', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE INDEX IF NOT EXISTS idx_biz_atm_field_addr_time ON biz_atmosphere_electric_field_event (device_addr, device_upload_time);
CREATE INDEX IF NOT EXISTS idx_biz_atm_field_upload_time ON biz_atmosphere_electric_field_event (device_upload_time);

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
    lightning_point  SYSGEO2.ST_GEOMETRY,
    peak_current     DECIMAL(12, 6),
    height           DECIMAL(12, 6),
    province         VARCHAR(64),
    city             VARCHAR(64),
    county           VARCHAR(64),
    province_code    BIGINT,
    city_code        BIGINT,
    county_code      BIGINT,
    quality_status   VARCHAR(16),
    create_time      TIMESTAMP          NOT NULL DEFAULT SYSDATE,
    update_time      TIMESTAMP          NOT NULL DEFAULT SYSDATE,
    ext_json         CLOB,
    schema_version   VARCHAR(16),
    data_version     VARCHAR(16),
    CONSTRAINT pk_standard_lightning_strike_cmb PRIMARY KEY (id, strike_time),
    CONSTRAINT uq_std_cmb_dedup UNIQUE (source_type, strike_time, longitude, latitude)
)
PARTITION BY RANGE (strike_time)
(
    PARTITION std_cmb_p_init VALUES LESS THAN (TO_TIMESTAMP('2025-03-01 00:00:00', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE INDEX IF NOT EXISTS idx_std_cmb_strike_time ON standard_lightning_strike_cmb (strike_time);
CREATE SPATIAL INDEX idx_std_cmb_lightning_point_sp ON standard_lightning_strike_cmb (lightning_point);

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
    lightning_point  SYSGEO2.ST_GEOMETRY,
    site_count       INT,
    province         VARCHAR(64),
    city             VARCHAR(64),
    county           VARCHAR(64),
    address          VARCHAR(256),
    province_code    BIGINT,
    city_code        BIGINT,
    county_code      BIGINT,
    quality_status   VARCHAR(16),
    create_time      TIMESTAMP          NOT NULL DEFAULT SYSDATE,
    update_time      TIMESTAMP          NOT NULL DEFAULT SYSDATE,
    ext_json         CLOB,
    schema_version   VARCHAR(16),
    data_version     VARCHAR(16),
    CONSTRAINT pk_standard_lightning_strike_locator PRIMARY KEY (id, strike_time),
    CONSTRAINT uq_std_locator_dedup UNIQUE (source_type, strike_time, longitude, latitude)
)
PARTITION BY RANGE (strike_time)
(
    PARTITION std_locator_p_init VALUES LESS THAN (TO_TIMESTAMP('2025-03-01 00:00:00', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE INDEX IF NOT EXISTS idx_std_locator_strike_time ON standard_lightning_strike_locator (strike_time);
CREATE SPATIAL INDEX idx_std_locator_lightning_point_sp ON standard_lightning_strike_locator (lightning_point);

-- ============================================================
-- biz_lightning_event：按月 RANGE(strike_time) + lightning_point
-- 50km query: ST_GeomToGeog + DMGEO2.ST_DWithin（米）
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
    lightning_point    SYSGEO2.ST_GEOMETRY,
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
    create_time        TIMESTAMP          NOT NULL DEFAULT SYSDATE,
    update_time        TIMESTAMP          NOT NULL DEFAULT SYSDATE,
    ext_json           CLOB,
    schema_version     VARCHAR(16),
    data_version       VARCHAR(16),
    CONSTRAINT pk_biz_lightning_event PRIMARY KEY (id, strike_time),
    CONSTRAINT uq_biz_lightning_event_dedup UNIQUE (source_type, strike_time, longitude, latitude)
)
PARTITION BY RANGE (strike_time)
(
    PARTITION biz_lightning_p_init VALUES LESS THAN (TO_TIMESTAMP('2025-03-01 00:00:00', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE INDEX IF NOT EXISTS idx_biz_lightning_strike_time ON biz_lightning_event (strike_time);
CREATE INDEX IF NOT EXISTS idx_biz_lightning_source ON biz_lightning_event (source_type);
CREATE SPATIAL INDEX idx_biz_lightning_point_sp ON biz_lightning_event (lightning_point);

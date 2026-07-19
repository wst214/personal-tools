-- PERF planning tables. Spatial columns use DMGEO2 (SYSGEO2.ST_GEOMETRY).

ALTER SESSION SET CURRENT_SCHEMA = "PERF";

-- ============================================================
-- mine_site：矿区主数据
-- ============================================================
CREATE TABLE IF NOT EXISTS mine_site (
    id                          BIGINT          NOT NULL,
    mine_code                   VARCHAR(64)     NOT NULL,
    mine_name                   VARCHAR(128)    NOT NULL,
    unified_social_credit_code  VARCHAR(64),
    province_code               VARCHAR(32),
    city_code                   VARCHAR(32),
    county_code                 VARCHAR(32),
    address                     VARCHAR(256),
    dispatch_room_lon           NUMERIC(12, 6)  NOT NULL,
    dispatch_room_lat           NUMERIC(12, 6)  NOT NULL,
    dispatch_room_point         SYSGEO2.ST_GEOMETRY,
    fence_geom                  SYSGEO2.ST_GEOMETRY,
    status                      VARCHAR(32)     NOT NULL DEFAULT 'ACTIVE',
    create_time                 TIMESTAMP       NOT NULL DEFAULT SYSDATE,
    CONSTRAINT pk_mine_site PRIMARY KEY (id),
    CONSTRAINT uq_mine_site_code UNIQUE (mine_code)
);

CREATE INDEX IF NOT EXISTS idx_mine_site_credit_code ON mine_site (unified_social_credit_code);
CREATE INDEX IF NOT EXISTS idx_mine_site_status ON mine_site (status);
CREATE SPATIAL INDEX idx_mine_site_dispatch_room_sp ON mine_site (dispatch_room_point);
CREATE SPATIAL INDEX idx_mine_site_fence_sp ON mine_site (fence_geom);

-- mine_site: PERF planning table; dispatch_room_point is spatial baseline

-- ============================================================
-- thunderstorm_process：雷暴过程主表（无动态中心点）
-- ============================================================
CREATE TABLE IF NOT EXISTS thunderstorm_process (
    id                   BIGINT        NOT NULL,
    mine_code            VARCHAR(64)   NOT NULL,
    process_start_time   TIMESTAMP     NOT NULL,
    process_end_time     TIMESTAMP,
    strike_start_time    TIMESTAMP,
    strike_end_time      TIMESTAMP,
    data_window_start    TIMESTAMP,
    data_window_end      TIMESTAMP,
    process_status       VARCHAR(32)   NOT NULL DEFAULT 'ACTIVE',
    create_time          TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    CONSTRAINT pk_thunderstorm_process PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_process_mine_time ON thunderstorm_process (mine_code, process_start_time);
CREATE INDEX IF NOT EXISTS idx_process_status_time ON thunderstorm_process (process_status, process_start_time);
CREATE INDEX IF NOT EXISTS idx_process_time_range ON thunderstorm_process (process_start_time, process_end_time);
CREATE INDEX IF NOT EXISTS idx_process_strike_window ON thunderstorm_process (strike_start_time, strike_end_time);

-- thunderstorm_process: no dynamic center point; use mine_site.dispatch_room_point

-- ============================================================
-- thunderstorm_warning_event：预警事件（1 过程 : 1 预警事件）
-- ============================================================
CREATE TABLE IF NOT EXISTS thunderstorm_warning_event (
    id                      BIGINT        NOT NULL,
    thunderstorm_process_id BIGINT        NOT NULL,
    mine_code               VARCHAR(64)   NOT NULL,
    event_start_time        TIMESTAMP     NOT NULL,
    event_end_time          TIMESTAMP,
    current_warning_level   INT           NOT NULL DEFAULT 0,
    max_warning_level       INT           NOT NULL DEFAULT 0,
    event_status            VARCHAR(32)   NOT NULL DEFAULT 'ACTIVE',
    create_time             TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    CONSTRAINT pk_thunderstorm_warning_event PRIMARY KEY (id),
    CONSTRAINT uq_warning_event_process UNIQUE (thunderstorm_process_id),
    CONSTRAINT fk_warning_event_process FOREIGN KEY (thunderstorm_process_id)
        REFERENCES thunderstorm_process (id)
);

CREATE INDEX IF NOT EXISTS idx_warning_event_mine_time ON thunderstorm_warning_event (mine_code, event_start_time);
CREATE INDEX IF NOT EXISTS idx_warning_event_status_time ON thunderstorm_warning_event (event_status, event_start_time);
CREATE INDEX IF NOT EXISTS idx_warning_event_level_time ON thunderstorm_warning_event (max_warning_level, event_start_time);

-- ============================================================
-- thunderstorm_warning_message：预警信息时间线
-- ============================================================
CREATE TABLE IF NOT EXISTS thunderstorm_warning_message (
    id                      BIGINT        NOT NULL,
    warning_event_id        BIGINT        NOT NULL,
    thunderstorm_process_id BIGINT        NOT NULL,
    mine_code               VARCHAR(64)   NOT NULL,
    rule_code               VARCHAR(64),
    rule_name               VARCHAR(128),
    rule_summary            CLOB,
    data_source             VARCHAR(64),
    data_source_ref_id      BIGINT,
    warning_time            TIMESTAMP     NOT NULL,
    warning_level           INT           NOT NULL,
    warning_action          VARCHAR(32)   NOT NULL,
    create_time             TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    CONSTRAINT pk_thunderstorm_warning_message PRIMARY KEY (id),
    CONSTRAINT fk_warning_msg_event FOREIGN KEY (warning_event_id)
        REFERENCES thunderstorm_warning_event (id),
    CONSTRAINT fk_warning_msg_process FOREIGN KEY (thunderstorm_process_id)
        REFERENCES thunderstorm_process (id)
);

CREATE INDEX IF NOT EXISTS idx_warning_msg_event_time ON thunderstorm_warning_message (warning_event_id, warning_time);
CREATE INDEX IF NOT EXISTS idx_warning_msg_process_time ON thunderstorm_warning_message (thunderstorm_process_id, warning_time);
CREATE INDEX IF NOT EXISTS idx_warning_msg_mine_time ON thunderstorm_warning_message (mine_code, warning_time);
CREATE INDEX IF NOT EXISTS idx_warning_msg_rule_time ON thunderstorm_warning_message (rule_code, warning_time);
CREATE INDEX IF NOT EXISTS idx_warning_msg_level_time ON thunderstorm_warning_message (warning_level, warning_time);

-- ============================================================
-- device_alarm_event：设备告警
-- ============================================================
CREATE TABLE IF NOT EXISTS device_alarm_event (
    id                      BIGINT        NOT NULL,
    thunderstorm_process_id BIGINT,
    mine_code               VARCHAR(64)   NOT NULL,
    device_addr             VARCHAR(64)   NOT NULL,
    alarm_time              TIMESTAMP     NOT NULL,
    alarm_level             INT,
    alarm_code              VARCHAR(64)   NOT NULL,
    alarm_name              VARCHAR(128),
    alarm_status            VARCHAR(32),
    source_table            VARCHAR(128),
    source_record_id        BIGINT,
    create_time             TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    CONSTRAINT pk_device_alarm_event PRIMARY KEY (id),
    CONSTRAINT fk_device_alarm_process FOREIGN KEY (thunderstorm_process_id)
        REFERENCES thunderstorm_process (id)
);

CREATE INDEX IF NOT EXISTS idx_device_alarm_process_time ON device_alarm_event (thunderstorm_process_id, alarm_time);
CREATE INDEX IF NOT EXISTS idx_device_alarm_addr_time ON device_alarm_event (device_addr, alarm_time);
CREATE INDEX IF NOT EXISTS idx_device_alarm_status ON device_alarm_event (alarm_status);

-- ============================================================
-- thunderstorm_notice_event：工况联动 / 通知
-- ============================================================
CREATE TABLE IF NOT EXISTS thunderstorm_notice_event (
    id                      BIGINT        NOT NULL,
    thunderstorm_process_id BIGINT        NOT NULL,
    warning_event_id        BIGINT,
    warning_message_id      BIGINT,
    mine_code               VARCHAR(64)   NOT NULL,
    notice_time             TIMESTAMP     NOT NULL,
    notice_channel          VARCHAR(32),
    receiver                VARCHAR(128),
    receiver_role           VARCHAR(64),
    notice_title            VARCHAR(256),
    notice_content          CLOB,
    notice_status           VARCHAR(32),
    trigger_type            VARCHAR(32),
    trigger_event_id        BIGINT,
    create_time             TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    CONSTRAINT pk_thunderstorm_notice_event PRIMARY KEY (id),
    CONSTRAINT fk_notice_process FOREIGN KEY (thunderstorm_process_id)
        REFERENCES thunderstorm_process (id),
    CONSTRAINT fk_notice_warning_event FOREIGN KEY (warning_event_id)
        REFERENCES thunderstorm_warning_event (id),
    CONSTRAINT fk_notice_warning_msg FOREIGN KEY (warning_message_id)
        REFERENCES thunderstorm_warning_message (id)
);

CREATE INDEX IF NOT EXISTS idx_notice_process_time ON thunderstorm_notice_event (thunderstorm_process_id, notice_time);
CREATE INDEX IF NOT EXISTS idx_notice_warning_msg ON thunderstorm_notice_event (warning_message_id);
CREATE INDEX IF NOT EXISTS idx_notice_status ON thunderstorm_notice_event (notice_status);

-- ============================================================
-- inspection_task：巡检任务
-- ============================================================
CREATE TABLE IF NOT EXISTS inspection_task (
    id                      BIGINT        NOT NULL,
    thunderstorm_process_id BIGINT,
    device_alarm_event_id   BIGINT,
    mine_code               VARCHAR(64),
    device_addr             VARCHAR(64),
    task_status             VARCHAR(32),
    plan_time               TIMESTAMP,
    finish_time             TIMESTAMP,
    assignee                VARCHAR(128),
    create_time             TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time             TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json                CLOB,
    schema_version          VARCHAR(16),
    data_version            VARCHAR(16),
    CONSTRAINT pk_inspection_task PRIMARY KEY (id),
    CONSTRAINT fk_inspection_process FOREIGN KEY (thunderstorm_process_id)
        REFERENCES thunderstorm_process (id),
    CONSTRAINT fk_inspection_alarm FOREIGN KEY (device_alarm_event_id)
        REFERENCES device_alarm_event (id)
);

CREATE INDEX IF NOT EXISTS idx_inspection_process_time ON inspection_task (thunderstorm_process_id, plan_time);
CREATE INDEX IF NOT EXISTS idx_inspection_alarm ON inspection_task (device_alarm_event_id);
CREATE INDEX IF NOT EXISTS idx_inspection_status ON inspection_task (task_status);

-- ============================================================
-- hidden_risk：隐患记录
-- ============================================================
CREATE TABLE IF NOT EXISTS hidden_risk (
    id                      BIGINT        NOT NULL,
    thunderstorm_process_id BIGINT,
    inspection_task_id      BIGINT,
    mine_code               VARCHAR(64),
    device_addr             VARCHAR(64),
    risk_level              INT,
    risk_desc               CLOB,
    rectify_status          VARCHAR(32),
    discover_time           TIMESTAMP,
    create_time             TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    CONSTRAINT pk_hidden_risk PRIMARY KEY (id),
    CONSTRAINT fk_hidden_risk_process FOREIGN KEY (thunderstorm_process_id)
        REFERENCES thunderstorm_process (id),
    CONSTRAINT fk_hidden_risk_task FOREIGN KEY (inspection_task_id)
        REFERENCES inspection_task (id)
);

CREATE INDEX IF NOT EXISTS idx_hidden_risk_process_time ON hidden_risk (thunderstorm_process_id, create_time);
CREATE INDEX IF NOT EXISTS idx_hidden_risk_task ON hidden_risk (inspection_task_id);
CREATE INDEX IF NOT EXISTS idx_hidden_risk_status ON hidden_risk (rectify_status);

-- ============================================================
-- repair_order：维修工单
-- ============================================================
CREATE TABLE IF NOT EXISTS repair_order (
    id                      BIGINT        NOT NULL,
    thunderstorm_process_id BIGINT,
    hidden_risk_id          BIGINT,
    mine_code               VARCHAR(64),
    device_addr             VARCHAR(64),
    repair_status           VARCHAR(32),
    repair_desc             CLOB,
    start_time              TIMESTAMP,
    close_time              TIMESTAMP,
    create_time             TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    CONSTRAINT pk_repair_order PRIMARY KEY (id),
    CONSTRAINT fk_repair_process FOREIGN KEY (thunderstorm_process_id)
        REFERENCES thunderstorm_process (id),
    CONSTRAINT fk_repair_hidden_risk FOREIGN KEY (hidden_risk_id)
        REFERENCES hidden_risk (id)
);

CREATE INDEX IF NOT EXISTS idx_repair_process_time ON repair_order (thunderstorm_process_id, create_time);
CREATE INDEX IF NOT EXISTS idx_repair_hidden_risk ON repair_order (hidden_risk_id);
CREATE INDEX IF NOT EXISTS idx_repair_status ON repair_order (repair_status);

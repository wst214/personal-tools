-- PERF low-frequency device standard/biz tables (no partition)
-- raw_message_id: VARCHAR(4000) comma-separated IDs (PG uses BIGINT array)

ALTER SESSION SET CURRENT_SCHEMA = "PERF";


-- ============================================================
-- standard_grounding_resistance / biz_grounding_resistance_event
-- ============================================================
CREATE TABLE IF NOT EXISTS standard_grounding_resistance (
    id                       BIGINT        NOT NULL,
    raw_message_id           VARCHAR(4000),
    device_addr              VARCHAR(64)   NOT NULL,
    type_id                  VARCHAR(16)   NOT NULL,
    command_type             VARCHAR(8)    NOT NULL,
    resistance_value         NUMERIC(12, 2),
    temperature              NUMERIC(12, 2),
    humidity                 NUMERIC(12, 2),
    ph_value                 NUMERIC(12, 2),
    soil_resistivity         NUMERIC(12, 2),
    standby_battery_voltage  NUMERIC(12, 2),
    measure_battery_voltage  NUMERIC(12, 2),
    quality_status           VARCHAR(16),
    create_time              TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time              TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json                 CLOB,
    schema_version           VARCHAR(16),
    data_version             VARCHAR(16),
    CONSTRAINT pk_standard_grounding_resistance PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_std_grounding_addr ON standard_grounding_resistance (device_addr);
CREATE INDEX IF NOT EXISTS idx_std_grounding_type ON standard_grounding_resistance (type_id);

CREATE TABLE IF NOT EXISTS biz_grounding_resistance_event (
    id                      BIGINT        NOT NULL,
    standard_record_id      BIGINT        NOT NULL,
    source_topic            VARCHAR(128),
    source_type             VARCHAR(32)   NOT NULL,
    device_addr             VARCHAR(64)   NOT NULL,
    type_id                 VARCHAR(16)   NOT NULL,
    command_type            VARCHAR(8)    NOT NULL,
    resistance_value        NUMERIC(12, 2),
    temperature             NUMERIC(12, 2),
    humidity                NUMERIC(12, 2),
    ph_value                NUMERIC(12, 2),
    soil_resistivity        NUMERIC(12, 2),
    standby_battery_voltage NUMERIC(12, 2),
    measure_battery_voltage NUMERIC(12, 2),
    risk_level              INT           NOT NULL DEFAULT 0,
    event_status            VARCHAR(16),
    create_time             TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time             TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json                CLOB,
    schema_version          VARCHAR(16),
    data_version            VARCHAR(16),
    CONSTRAINT pk_biz_grounding_resistance_event PRIMARY KEY (id),
    CONSTRAINT uq_biz_grounding_event_standard UNIQUE (standard_record_id)
);
CREATE INDEX IF NOT EXISTS idx_biz_grounding_addr ON biz_grounding_resistance_event (device_addr);
CREATE INDEX IF NOT EXISTS idx_biz_grounding_source ON biz_grounding_resistance_event (source_type);
CREATE INDEX IF NOT EXISTS idx_biz_grounding_create ON biz_grounding_resistance_event (create_time);

-- ============================================================
-- standard_surge_current / biz_surge_current_event
-- ============================================================
CREATE TABLE IF NOT EXISTS standard_surge_current (
    id                       BIGINT        NOT NULL,
    raw_message_id           VARCHAR(4000),
    device_addr              VARCHAR(64)   NOT NULL,
    type_id                  VARCHAR(16)   NOT NULL,
    command_type             VARCHAR(8)    NOT NULL,
    lightning_strike_current NUMERIC(12, 2),
    lightning_strike_time    TIMESTAMP,
    lightning_strike_num     INTEGER,
    battery_voltage          NUMERIC(12, 2),
    voltage_state            VARCHAR(8),
    real_time                TIMESTAMP,
    longitude                NUMERIC(12, 6),
    longitude_direction      VARCHAR(8),
    latitude                 NUMERIC(12, 6),
    latitude_direction       VARCHAR(8),
    card                     VARCHAR(64),
    quality_status           VARCHAR(16),
    create_time              TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time              TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json                 CLOB,
    schema_version           VARCHAR(16),
    data_version             VARCHAR(16),
    CONSTRAINT pk_standard_surge_current PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_std_surge_current_addr_time ON standard_surge_current (device_addr, lightning_strike_time);
CREATE INDEX IF NOT EXISTS idx_std_surge_current_type ON standard_surge_current (type_id);

CREATE TABLE IF NOT EXISTS biz_surge_current_event (
    id                       BIGINT        NOT NULL,
    standard_record_id       BIGINT        NOT NULL,
    source_topic             VARCHAR(128),
    source_type              VARCHAR(32)   NOT NULL,
    device_addr              VARCHAR(64)   NOT NULL,
    type_id                  VARCHAR(16)   NOT NULL,
    command_type             VARCHAR(8)    NOT NULL,
    lightning_strike_time    TIMESTAMP,
    lightning_strike_current NUMERIC(12, 2),
    lightning_strike_num     INTEGER,
    battery_voltage          NUMERIC(12, 2),
    voltage_state            VARCHAR(8),
    real_time                TIMESTAMP,
    longitude                NUMERIC(12, 6),
    longitude_direction      VARCHAR(8),
    latitude                 NUMERIC(12, 6),
    latitude_direction       VARCHAR(8),
    card                     VARCHAR(64),
    risk_level               INT           NOT NULL DEFAULT 0,
    event_status             VARCHAR(16),
    create_time              TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time              TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json                 CLOB,
    schema_version           VARCHAR(16),
    data_version             VARCHAR(16),
    CONSTRAINT pk_biz_surge_current_event PRIMARY KEY (id),
    CONSTRAINT uq_biz_surge_current_event_standard UNIQUE (standard_record_id)
);
CREATE INDEX IF NOT EXISTS idx_biz_surge_current_addr_time ON biz_surge_current_event (device_addr, lightning_strike_time);
CREATE INDEX IF NOT EXISTS idx_biz_surge_current_source ON biz_surge_current_event (source_type);
CREATE INDEX IF NOT EXISTS idx_biz_surge_current_create ON biz_surge_current_event (create_time);

-- ============================================================
-- standard_remote_terminal / biz_remote_terminal_event
-- ============================================================
CREATE TABLE IF NOT EXISTS standard_remote_terminal (
    id                  BIGINT        NOT NULL,
    raw_message_id      VARCHAR(4000),
    device_addr         VARCHAR(64)   NOT NULL,
    type_id             VARCHAR(16)   NOT NULL,
    command_type        VARCHAR(8)    NOT NULL,
    power_supply_type   VARCHAR(16),
    voltage             NUMERIC(12, 2),
    "current"           NUMERIC(12, 2),
    active_power        NUMERIC(12, 2),
    power_factor        NUMERIC(12, 4),
    frequency           NUMERIC(12, 2),
    total_active_energy NUMERIC(16, 4),
    relay_nc            VARCHAR(1),
    relay_24v           VARCHAR(1),
    relay_12v           VARCHAR(1),
    relay_6v            VARCHAR(1),
    dc_voltage_24v      NUMERIC(12, 2),
    dc_voltage_12v      NUMERIC(12, 2),
    dc_voltage_6v       NUMERIC(12, 2),
    dc_voltage_5v       NUMERIC(12, 2),
    quality_status      VARCHAR(16),
    create_time         TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time         TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json            CLOB,
    schema_version      VARCHAR(16),
    data_version        VARCHAR(16),
    CONSTRAINT pk_standard_remote_terminal PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_std_remote_terminal_addr ON standard_remote_terminal (device_addr);
CREATE INDEX IF NOT EXISTS idx_std_remote_terminal_type ON standard_remote_terminal (type_id);

CREATE TABLE IF NOT EXISTS biz_remote_terminal_event (
    id                  BIGINT        NOT NULL,
    standard_record_id  BIGINT        NOT NULL,
    source_topic        VARCHAR(128),
    source_type         VARCHAR(32)   NOT NULL,
    device_addr         VARCHAR(64)   NOT NULL,
    type_id             VARCHAR(16)   NOT NULL,
    command_type        VARCHAR(8)    NOT NULL,
    power_supply_type   VARCHAR(16),
    voltage             NUMERIC(12, 2),
    "current"           NUMERIC(12, 2),
    active_power        NUMERIC(12, 2),
    power_factor        NUMERIC(12, 4),
    frequency           NUMERIC(12, 2),
    total_active_energy NUMERIC(16, 4),
    relay_nc            VARCHAR(1),
    relay_24v           VARCHAR(1),
    relay_12v           VARCHAR(1),
    relay_6v            VARCHAR(1),
    dc_voltage_24v      NUMERIC(12, 2),
    dc_voltage_12v      NUMERIC(12, 2),
    dc_voltage_6v       NUMERIC(12, 2),
    dc_voltage_5v       NUMERIC(12, 2),
    risk_level          INT           NOT NULL DEFAULT 0,
    event_status        VARCHAR(16),
    create_time         TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time         TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json            CLOB,
    schema_version      VARCHAR(16),
    data_version        VARCHAR(16),
    CONSTRAINT pk_biz_remote_terminal_event PRIMARY KEY (id),
    CONSTRAINT uq_biz_remote_terminal_event_standard UNIQUE (standard_record_id)
);
CREATE INDEX IF NOT EXISTS idx_biz_remote_terminal_addr ON biz_remote_terminal_event (device_addr);
CREATE INDEX IF NOT EXISTS idx_biz_remote_terminal_source ON biz_remote_terminal_event (source_type);
CREATE INDEX IF NOT EXISTS idx_biz_remote_terminal_create ON biz_remote_terminal_event (create_time);

-- ============================================================
-- standard_power_board / biz_power_board_event
-- ============================================================
CREATE TABLE IF NOT EXISTS standard_power_board (
    id                    BIGINT        NOT NULL,
    raw_message_id        VARCHAR(4000),
    device_addr           VARCHAR(64)   NOT NULL,
    type_id               VARCHAR(16)   NOT NULL,
    command_type          VARCHAR(8)    NOT NULL,
    voltage_15v           NUMERIC(12, 2),
    voltage_24v           NUMERIC(12, 2),
    voltage_12v           NUMERIC(12, 2),
    voltage_6v            NUMERIC(12, 2),
    upload_frequency      INTEGER,
    card                  VARCHAR(64),
    device_temperature    NUMERIC(12, 2),
    fan_start_temperature INTEGER,
    fan_stop_temperature  INTEGER,
    fan_control_status    VARCHAR(32),
    version               VARCHAR(16),
    quality_status        VARCHAR(16),
    create_time           TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time           TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json              CLOB,
    schema_version        VARCHAR(16),
    data_version          VARCHAR(16),
    CONSTRAINT pk_standard_power_board PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_std_power_board_addr ON standard_power_board (device_addr);
CREATE INDEX IF NOT EXISTS idx_std_power_board_type ON standard_power_board (type_id);

CREATE TABLE IF NOT EXISTS biz_power_board_event (
    id                    BIGINT        NOT NULL,
    standard_record_id    BIGINT        NOT NULL,
    source_topic          VARCHAR(128),
    source_type           VARCHAR(32)   NOT NULL,
    device_addr           VARCHAR(64)   NOT NULL,
    type_id               VARCHAR(16)   NOT NULL,
    command_type          VARCHAR(8)    NOT NULL,
    voltage_15v           NUMERIC(12, 2),
    voltage_24v           NUMERIC(12, 2),
    voltage_12v           NUMERIC(12, 2),
    voltage_6v            NUMERIC(12, 2),
    upload_frequency      INTEGER,
    card                  VARCHAR(64),
    device_temperature    NUMERIC(12, 2),
    fan_start_temperature INTEGER,
    fan_stop_temperature  INTEGER,
    fan_control_status    VARCHAR(32),
    version               VARCHAR(16),
    risk_level            INT           NOT NULL DEFAULT 0,
    event_status          VARCHAR(16),
    create_time           TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time           TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json              CLOB,
    schema_version        VARCHAR(16),
    data_version          VARCHAR(16),
    CONSTRAINT pk_biz_power_board_event PRIMARY KEY (id),
    CONSTRAINT uq_biz_power_board_event_standard UNIQUE (standard_record_id)
);
CREATE INDEX IF NOT EXISTS idx_biz_power_board_addr ON biz_power_board_event (device_addr);
CREATE INDEX IF NOT EXISTS idx_biz_power_board_source ON biz_power_board_event (source_type);
CREATE INDEX IF NOT EXISTS idx_biz_power_board_create ON biz_power_board_event (create_time);

-- ============================================================
-- standard_disconnect_card / biz_disconnect_card_event
-- ============================================================
CREATE TABLE IF NOT EXISTS standard_disconnect_card (
    id                BIGINT        NOT NULL,
    raw_message_id    VARCHAR(4000),
    device_addr       VARCHAR(64)   NOT NULL,
    type_id           VARCHAR(16)   NOT NULL,
    command_type      VARCHAR(8)    NOT NULL,
    disconnect_status VARCHAR(16),
    battery_voltage   NUMERIC(12, 2),
    quality_status    VARCHAR(16),
    create_time       TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time       TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json          CLOB,
    schema_version    VARCHAR(16),
    data_version      VARCHAR(16),
    CONSTRAINT pk_standard_disconnect_card PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_std_disconnect_card_addr ON standard_disconnect_card (device_addr);
CREATE INDEX IF NOT EXISTS idx_std_disconnect_card_type ON standard_disconnect_card (type_id);

CREATE TABLE IF NOT EXISTS biz_disconnect_card_event (
    id                 BIGINT        NOT NULL,
    standard_record_id BIGINT        NOT NULL,
    source_topic       VARCHAR(128),
    source_type        VARCHAR(32)   NOT NULL,
    device_addr        VARCHAR(64)   NOT NULL,
    type_id            VARCHAR(16)   NOT NULL,
    command_type       VARCHAR(8)    NOT NULL,
    disconnect_status  VARCHAR(16),
    battery_voltage    NUMERIC(12, 2),
    risk_level         INT           NOT NULL DEFAULT 0,
    event_status       VARCHAR(16),
    create_time        TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time        TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json           CLOB,
    schema_version     VARCHAR(16),
    data_version       VARCHAR(16),
    CONSTRAINT pk_biz_disconnect_card_event PRIMARY KEY (id),
    CONSTRAINT uq_biz_disconnect_card_event_standard UNIQUE (standard_record_id)
);
CREATE INDEX IF NOT EXISTS idx_biz_disconnect_card_addr ON biz_disconnect_card_event (device_addr);
CREATE INDEX IF NOT EXISTS idx_biz_disconnect_card_source ON biz_disconnect_card_event (source_type);
CREATE INDEX IF NOT EXISTS idx_biz_disconnect_card_create ON biz_disconnect_card_event (create_time);

-- ============================================================
-- standard_spd_waveform_heartbeat / biz_spd_waveform_heartbeat_event
-- ============================================================
CREATE TABLE IF NOT EXISTS standard_spd_waveform_heartbeat (
    id                          BIGINT        NOT NULL,
    raw_message_id              VARCHAR(4000),
    device_addr                 VARCHAR(64)   NOT NULL,
    type_id                     VARCHAR(16)   NOT NULL,
    command_type                VARCHAR(8)    NOT NULL,
    heartbeat_time              TIMESTAMP,
    heartbeat_frequency_minutes INTEGER,
    card                        VARCHAR(64),
    quality_status              VARCHAR(16),
    create_time                 TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time                 TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json                    CLOB,
    schema_version              VARCHAR(16),
    data_version                VARCHAR(16),
    CONSTRAINT pk_standard_spd_waveform_heartbeat PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_std_spd_hb_addr_time ON standard_spd_waveform_heartbeat (device_addr, heartbeat_time);
CREATE INDEX IF NOT EXISTS idx_std_spd_hb_type ON standard_spd_waveform_heartbeat (type_id);

CREATE TABLE IF NOT EXISTS biz_spd_waveform_heartbeat_event (
    id                          BIGINT        NOT NULL,
    standard_record_id          BIGINT        NOT NULL,
    source_topic                VARCHAR(128),
    source_type                 VARCHAR(32)   NOT NULL,
    device_addr                 VARCHAR(64)   NOT NULL,
    type_id                     VARCHAR(16)   NOT NULL,
    command_type                VARCHAR(8)    NOT NULL,
    heartbeat_time              TIMESTAMP,
    heartbeat_frequency_minutes INTEGER,
    card                        VARCHAR(64),
    risk_level                  INT           NOT NULL DEFAULT 0,
    event_status                VARCHAR(16),
    create_time                 TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time                 TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json                    CLOB,
    schema_version              VARCHAR(16),
    data_version                VARCHAR(16),
    CONSTRAINT pk_biz_spd_waveform_hb_event PRIMARY KEY (id),
    CONSTRAINT uq_biz_spd_waveform_hb_event_standard UNIQUE (standard_record_id)
);
CREATE INDEX IF NOT EXISTS idx_biz_spd_wave_hb_addr_time ON biz_spd_waveform_heartbeat_event (device_addr, heartbeat_time);
CREATE INDEX IF NOT EXISTS idx_biz_spd_wave_hb_source ON biz_spd_waveform_heartbeat_event (source_type);
CREATE INDEX IF NOT EXISTS idx_biz_spd_wave_hb_create ON biz_spd_waveform_heartbeat_event (create_time);

-- ============================================================
-- standard_spd_waveform_summary / biz_spd_waveform_summary_event
-- ============================================================
CREATE TABLE IF NOT EXISTS standard_spd_waveform_summary (
    id                         BIGINT        NOT NULL,
    raw_message_id             VARCHAR(4000),
    device_addr                VARCHAR(64)   NOT NULL,
    type_id                    VARCHAR(16)   NOT NULL,
    command_type               VARCHAR(8)    NOT NULL,
    range_type                 VARCHAR(16),
    positive_peak_current      NUMERIC(12, 2),
    negative_peak_current      NUMERIC(12, 2),
    positive_accumulated_value NUMERIC(16, 4),
    negative_accumulated_value NUMERIC(16, 4),
    strike_time                TIMESTAMP,
    waveform_hex               CLOB,
    quality_status             VARCHAR(16),
    create_time                TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time                TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json                   CLOB,
    schema_version             VARCHAR(16),
    data_version               VARCHAR(16),
    CONSTRAINT pk_standard_spd_waveform_summary PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_std_spd_wave_addr_time ON standard_spd_waveform_summary (device_addr, strike_time);
CREATE INDEX IF NOT EXISTS idx_std_spd_wave_type ON standard_spd_waveform_summary (type_id);

CREATE TABLE IF NOT EXISTS biz_spd_waveform_summary_event (
    id                         BIGINT        NOT NULL,
    standard_record_id         BIGINT        NOT NULL,
    source_topic               VARCHAR(128),
    source_type                VARCHAR(32)   NOT NULL,
    device_addr                VARCHAR(64)   NOT NULL,
    type_id                    VARCHAR(16)   NOT NULL,
    command_type               VARCHAR(8)    NOT NULL,
    strike_time                TIMESTAMP,
    positive_peak_current      NUMERIC(12, 2),
    negative_peak_current      NUMERIC(12, 2),
    positive_accumulated_value NUMERIC(16, 4),
    negative_accumulated_value NUMERIC(16, 4),
    range_type                 VARCHAR(16),
    waveform_hex               CLOB,
    risk_level                 INT           NOT NULL DEFAULT 0,
    event_status               VARCHAR(16),
    create_time                TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time                TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json                   CLOB,
    schema_version             VARCHAR(16),
    data_version               VARCHAR(16),
    CONSTRAINT pk_biz_spd_waveform_summary_event PRIMARY KEY (id),
    CONSTRAINT uq_biz_spd_waveform_summary_event_standard UNIQUE (standard_record_id)
);
CREATE INDEX IF NOT EXISTS idx_biz_spd_wave_sum_addr_time ON biz_spd_waveform_summary_event (device_addr, strike_time);
CREATE INDEX IF NOT EXISTS idx_biz_spd_wave_sum_source ON biz_spd_waveform_summary_event (source_type);
CREATE INDEX IF NOT EXISTS idx_biz_spd_wave_sum_create ON biz_spd_waveform_summary_event (create_time);

-- ============================================================
-- standard_ispd_pdu / biz_ispd_pdu_event锛圴6锛?
-- ============================================================
CREATE TABLE IF NOT EXISTS standard_ispd_pdu (
    id                        BIGINT        NOT NULL,
    raw_message_id            VARCHAR(4000),
    device_addr               VARCHAR(64)   NOT NULL,
    type_id                   VARCHAR(16)   NOT NULL DEFAULT '0F',
    command_type              VARCHAR(8)    NOT NULL,
    lightning_strikes_number  INTEGER,
    lightning_strikes_current NUMERIC(12, 2),
    environmental_humidity    NUMERIC(12, 2),
    ambient_temperature       NUMERIC(12, 2),
    target_temperature        NUMERIC(12, 2),
    working_voltage           NUMERIC(12, 2),
    leakage_current           NUMERIC(12, 2),
    switch_status             VARCHAR(128),
    quality_status            VARCHAR(16),
    create_time               TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time               TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json                  CLOB,
    schema_version            VARCHAR(16),
    data_version              VARCHAR(16),
    CONSTRAINT pk_standard_ispd_pdu PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_std_ispd_pdu_addr ON standard_ispd_pdu (device_addr);

CREATE TABLE IF NOT EXISTS biz_ispd_pdu_event (
    id                        BIGINT        NOT NULL,
    standard_record_id        BIGINT        NOT NULL,
    source_topic              VARCHAR(128),
    source_type               VARCHAR(32)   NOT NULL,
    device_addr               VARCHAR(64)   NOT NULL,
    type_id                   VARCHAR(16)   NOT NULL DEFAULT '0F',
    command_type              VARCHAR(8)    NOT NULL,
    lightning_strikes_number  INTEGER,
    lightning_strikes_current NUMERIC(12, 2),
    environmental_humidity    NUMERIC(12, 2),
    ambient_temperature       NUMERIC(12, 2),
    target_temperature        NUMERIC(12, 2),
    working_voltage           NUMERIC(12, 2),
    leakage_current           NUMERIC(12, 2),
    switch_status             VARCHAR(128),
    risk_level                INT           NOT NULL DEFAULT 0,
    event_status              VARCHAR(16),
    create_time               TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time               TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json                  CLOB,
    schema_version            VARCHAR(16),
    data_version              VARCHAR(16),
    CONSTRAINT pk_biz_ispd_pdu_event PRIMARY KEY (id),
    CONSTRAINT uq_biz_ispd_pdu_event_standard UNIQUE (standard_record_id)
);
CREATE INDEX IF NOT EXISTS idx_biz_ispd_pdu_addr ON biz_ispd_pdu_event (device_addr);
CREATE INDEX IF NOT EXISTS idx_biz_ispd_pdu_source ON biz_ispd_pdu_event (source_type);
CREATE INDEX IF NOT EXISTS idx_biz_ispd_pdu_create ON biz_ispd_pdu_event (create_time);

-- ============================================================
-- standard_surge_monitor / biz_surge_monitor_event锛圴6锛?
-- ============================================================
CREATE TABLE IF NOT EXISTS standard_surge_monitor (
    id                        BIGINT        NOT NULL,
    raw_message_id            VARCHAR(4000),
    device_addr               VARCHAR(64)   NOT NULL,
    type_id                   VARCHAR(16)   NOT NULL DEFAULT '14',
    command_type              VARCHAR(8)    NOT NULL,
    leakage_current           NUMERIC(12, 2),
    battery_voltage           NUMERIC(12, 2),
    lightning_strikes_number  INTEGER,
    lightning_strikes_current NUMERIC(12, 2),
    strike_time               TIMESTAMP(3),
    quality_status            VARCHAR(16),
    create_time               TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time               TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json                  CLOB,
    schema_version            VARCHAR(16),
    data_version              VARCHAR(16),
    CONSTRAINT pk_standard_surge_monitor PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_std_surge_monitor_addr_time ON standard_surge_monitor (device_addr, strike_time);
CREATE INDEX IF NOT EXISTS idx_std_surge_monitor_cmd ON standard_surge_monitor (command_type);

CREATE TABLE IF NOT EXISTS biz_surge_monitor_event (
    id                        BIGINT        NOT NULL,
    standard_record_id        BIGINT        NOT NULL,
    source_topic              VARCHAR(128),
    source_type               VARCHAR(32)   NOT NULL,
    device_addr               VARCHAR(64)   NOT NULL,
    type_id                   VARCHAR(16)   NOT NULL DEFAULT '14',
    command_type              VARCHAR(8)    NOT NULL,
    leakage_current           NUMERIC(12, 2),
    battery_voltage           NUMERIC(12, 2),
    lightning_strikes_number  INTEGER,
    lightning_strikes_current NUMERIC(12, 2),
    strike_time               TIMESTAMP(3),
    risk_level                INT           NOT NULL DEFAULT 0,
    event_status              VARCHAR(16),
    create_time               TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    update_time               TIMESTAMP     NOT NULL DEFAULT SYSDATE,
    ext_json                  CLOB,
    schema_version            VARCHAR(16),
    data_version              VARCHAR(16),
    CONSTRAINT pk_biz_surge_monitor_event PRIMARY KEY (id),
    CONSTRAINT uq_biz_surge_monitor_event_standard UNIQUE (standard_record_id)
);
CREATE INDEX IF NOT EXISTS idx_biz_surge_monitor_addr_time ON biz_surge_monitor_event (device_addr, strike_time);
CREATE INDEX IF NOT EXISTS idx_biz_surge_monitor_source ON biz_surge_monitor_event (source_type);
CREATE INDEX IF NOT EXISTS idx_biz_surge_monitor_create ON biz_surge_monitor_event (create_time);


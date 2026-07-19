-- PERF 造数后校验 SQL（对齐性能测试开展方案.docx）
-- 推荐：python run_load.py validate --stage S0（按阶段读取 volume-profiles 预期行数）
-- 本文件：psql 手工快速检查，行数预期需自行对照当前档位

SET search_path TO perf, public;

\echo '=== 行数快照（请对照 volume-profiles.yaml 当前档位）==='
SELECT 'mine_site' AS table_name, count(*) AS row_count FROM mine_site
UNION ALL SELECT 'standard_atmosphere_electric_field', count(*) FROM standard_atmosphere_electric_field
UNION ALL SELECT 'biz_atmosphere_electric_field_event', count(*) FROM biz_atmosphere_electric_field_event
UNION ALL SELECT 'raw_kafka_message', count(*) FROM raw_kafka_message
UNION ALL SELECT 'thunderstorm_process', count(*) FROM thunderstorm_process
UNION ALL SELECT 'biz_lightning_event', count(*) FROM biz_lightning_event
UNION ALL SELECT 'standard_lightning_strike_cmb', count(*) FROM standard_lightning_strike_cmb
UNION ALL SELECT 'standard_lightning_strike_locator', count(*) FROM standard_lightning_strike_locator
UNION ALL SELECT 'thunderstorm_warning_event', count(*) FROM thunderstorm_warning_event
UNION ALL SELECT 'thunderstorm_warning_message', count(*) FROM thunderstorm_warning_message
UNION ALL SELECT 'device_alarm_event', count(*) FROM device_alarm_event
UNION ALL SELECT 'thunderstorm_notice_event', count(*) FROM thunderstorm_notice_event
ORDER BY table_name;

\echo '=== 经纬度合法 ==='
SELECT count(*) AS invalid_lightning
FROM biz_lightning_event
WHERE longitude NOT BETWEEN 73 AND 135
   OR latitude NOT BETWEEN 3 AND 54;

\echo '=== 矿区调度机房 PostGIS 点 ==='
SELECT count(*) AS invalid_mine_site
FROM mine_site
WHERE dispatch_room_lon NOT BETWEEN 73 AND 135
   OR dispatch_room_lat NOT BETWEEN 3 AND 54
   OR dispatch_room_point IS NULL;

\echo '=== 大气电场 device_upload_time 非空 ==='
SELECT count(*) AS null_upload_time
FROM standard_atmosphere_electric_field
WHERE device_upload_time IS NULL;

\echo '=== standard/biz 1:1（大气电场）==='
SELECT
    (SELECT count(*) FROM standard_atmosphere_electric_field) AS std_cnt,
    (SELECT count(*) FROM biz_atmosphere_electric_field_event) AS biz_cnt,
    (SELECT count(*) FROM standard_atmosphere_electric_field s
      LEFT JOIN biz_atmosphere_electric_field_event b ON b.standard_record_id = s.id
     WHERE b.id IS NULL) AS missing_biz,
    (SELECT count(*) FROM biz_atmosphere_electric_field_event b
      LEFT JOIN standard_atmosphere_electric_field s ON s.id = b.standard_record_id
     WHERE s.id IS NULL) AS orphan_biz,
    (SELECT count(*) - count(DISTINCT standard_record_id)
       FROM biz_atmosphere_electric_field_event) AS duplicate_biz_key;

\echo '=== raw 去重键 ==='
SELECT topic, partition_no, offset_no, count(*) AS duplicate_count
FROM raw_kafka_message
GROUP BY topic, partition_no, offset_no
HAVING count(*) > 1
LIMIT 10;

\echo '=== 50km 闪电关联（每过程）==='
SELECT p.id,
       count(l.id) AS lightning_count
FROM thunderstorm_process p
JOIN mine_site m ON m.mine_code = p.mine_code
LEFT JOIN biz_lightning_event l
  ON l.strike_time BETWEEN p.strike_start_time AND p.strike_end_time
 AND l.lightning_point IS NOT NULL
 AND ST_DWithin(l.lightning_point, m.dispatch_room_point, 50000)
GROUP BY p.id
ORDER BY p.id
LIMIT 20;

\echo '=== 时间窗合法 ==='
SELECT count(*) AS invalid_window
FROM thunderstorm_process
WHERE process_start_time > process_end_time
   OR strike_start_time > strike_end_time
   OR data_window_start > data_window_end;

\echo '=== 预警 PUBLISH/LIFT 时间线 ==='
SELECT count(*) AS invalid_warning_timeline
FROM thunderstorm_warning_event e
WHERE NOT EXISTS (
        SELECT 1 FROM thunderstorm_warning_message m
        WHERE m.warning_event_id = e.id
          AND m.warning_action = 'PUBLISH'
          AND m.warning_time = e.event_start_time
      )
   OR NOT EXISTS (
        SELECT 1 FROM thunderstorm_warning_message m
        WHERE m.warning_event_id = e.id
          AND m.warning_action = 'LIFT'
          AND m.warning_time = e.event_end_time
      );

\echo '=== 雷暴过程闭环聚合（抽样前 10 条）==='
SELECT p.id,
       count(DISTINCT w.id) AS warning_event_count,
       count(DISTINCT msg.id) AS warning_message_count,
       count(DISTINCT a.id) AS alarm_count,
       count(DISTINCT n.id) AS notice_count,
       count(DISTINCT i.id) AS inspection_count,
       count(DISTINCT h.id) AS risk_count,
       count(DISTINCT r.id) AS repair_count
FROM thunderstorm_process p
LEFT JOIN thunderstorm_warning_event w ON w.thunderstorm_process_id = p.id
LEFT JOIN thunderstorm_warning_message msg ON msg.thunderstorm_process_id = p.id
LEFT JOIN device_alarm_event a ON a.thunderstorm_process_id = p.id
LEFT JOIN thunderstorm_notice_event n ON n.thunderstorm_process_id = p.id
LEFT JOIN inspection_task i ON i.thunderstorm_process_id = p.id
LEFT JOIN hidden_risk h ON h.thunderstorm_process_id = p.id
LEFT JOIN repair_order r ON r.thunderstorm_process_id = p.id
GROUP BY p.id
ORDER BY p.id
LIMIT 10;

\echo '=== 低频设备 standard/biz 1:1（接地电阻示例）==='
SELECT
    (SELECT count(*) FROM standard_grounding_resistance) AS std_cnt,
    (SELECT count(*) FROM biz_grounding_resistance_event) AS biz_cnt,
    (SELECT count(*) FROM standard_grounding_resistance s
      LEFT JOIN biz_grounding_resistance_event b ON b.standard_record_id = s.id
     WHERE b.id IS NULL) AS missing_biz,
    (SELECT count(*) FROM biz_grounding_resistance_event b
      LEFT JOIN standard_grounding_resistance s ON s.id = b.standard_record_id
     WHERE s.id IS NULL) AS orphan_biz;

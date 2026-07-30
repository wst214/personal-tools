# 02 — 优化过程

## 阶段 A — 扁平化 + 1 分钟 TRUNC

- 去掉 CTE；`GROUP BY` 直接写在基表上  
- 1 分钟桶：`TRUNC(device_upload_time, 'MI')`（替代 TO_CHAR/整除拼接）  
- 非 1 分钟桶仍用小时截断 + 分钟整除表达式  

## 阶段 B — page_cover 试探

曾 hint `idx_biz_atm_field_page_cover`（偏分页覆盖列）。  
复测 `5d4352d7`：P95 **494**，TPS ~151，slowB 1124（相对 1021 约 2×）。

## 阶段 C — 瘦覆盖索引 agg_cover

```sql
CREATE INDEX IF NOT EXISTS idx_biz_atm_field_agg_cover
ON biz_atmosphere_electric_field_event (
  device_addr,
  device_upload_time,
  instantaneous_value,
  average_value,
  warning_level,
  rate_change,
  risk_level
);
```

相对 page_cover 去掉 id/event_status 等与本聚合无关的列，减小叶块。  
hint 改为 `idx_biz_atm_field_agg_cover`。

复测 `b12fa15d`：P95 **391**，TPS **172**，slowB **78**。  
EXPLAIN：走 `agg_cover`。

## 阶段 D — 收尾

用户确认场景维持：**只按时间桶聚合、跨设备合成一条**；不按 `device_addr` 分桶；预聚合表暂缓。  
全场景验收 `b59ea1a8` 中 AGG P95 **455**（与其它读写同轮，略高于单独压 AGG，仍远好于基线）。

# 规则回测 — 功能测试用例设计清单

> 一级能力：规则回测  
> 设计：§6.4 `POST /warning/rules/{id}/test`（二期，历史因子重建）  
> 全部 skip，待回测 API 落地。

## 二级模块

| 模块 ID | 名称 | 用例数 |
|---------|------|--------|
| warn-backtest-run | 回测 / 执行 | 3 |
| warn-backtest-result | 回测 / 结果 | 2 |

## 用例

| ID | 名称 | 可执行 |
|----|------|--------|
| wb-01-test-enabled-rule | 对启用规则发起回测 | skip |
| wb-02-test-time-range-required | 缺时间窗失败 | skip |
| wb-03-test-draft-rejected | 草稿规则不可回测 | skip |
| wb-10-result-hits | 回测结果含命中摘要 | skip |
| wb-11-result-no-side-effect | 回测不落正式 warn_event | skip |

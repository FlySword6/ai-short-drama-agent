# 产品自动化测试与常设汇报

## 生效口径

三项体验门阈值已由 DC 于 2026-08-01 批准：

| 断言 | 默认门槛 | 环境变量 |
| --- | ---: | --- |
| 通用资产首屏 | 3000 ms | `SGOAL07_ASSET_FIRST_SCREEN_MAX_MS` |
| 媒体版本读取 | 1500 ms | `SGOAL07_MEDIA_READ_MAX_MS` |
| 媒体版本切换 | 500 ms | `SGOAL07_MEDIA_SWITCH_MAX_MS` |

它们是发布前体验门，不是线上 SLO。红项只汇报给 Fable，由 Fable 判断、统筹和派活；
测试执行者不得因为一条红项自动扩大修复范围。

## 一条命令

同时运行产品冒烟与体验门：

```bash
E2E_TRIGGER_REASON=post-release \
E2E_TARGET_ENVIRONMENT=test \
npm run e2e:product:report
```

也可单独运行：

```bash
E2E_TRIGGER_REASON=daily-patrol npm run e2e:sgoal06:midscene
E2E_TRIGGER_REASON=daily-patrol npm run e2e:sgoal07:asset-experience
```

公开命令都经过报告包装器；`e2e:raw:*` 只供包装器内部调用，不作为验收命令。

冒烟包含一次真实付费生图，所以不设置无人值守 cron。当前常设执行方式采用 DC 允许的
“Fable 每日巡检显式点名”：

1. 每次发版后，由发版值守显式运行一次完整命令；
2. Fable 每日至少点名运行一次；
3. 大合流后，由合流值守显式加跑一次。

人的显式命令是本次付费任务的授权；脚本没有自动重试或批量生成。若未来要改成 cron，
必须先把付费生成从无人值守套件拆开并重新裁决，不能把“日报”当成自动付费授权。

## 固定报告

每次运行都会把独立小节追加到：

```text
outputs/e2e-reports/e2e-<日期>-<环境>.md
```

同一天同环境不覆盖前一次结果。每个小节固定包含：

- 跑的时间与触发原因；
- 目标环境与基线 commit；
- 断言表、毫秒实测和门槛；
- 红项与明确标注为“猜想”的根因方向；
- Playwright JSON、Midscene HTML、摘要与失败截图路径。

`outputs/` 和 `artifacts/` 均为本地忽略目录。报告生成后，执行者必须把报告绝对路径和
红绿结论直连发给 Fable；聊天通知不能由文件落盘替代。

## 安全

- 报告不写账号密码、模型 Key、会话 token 或 Playwright trace；
- 包装器对常见凭据字段和长 token 做二次脱敏；
- 若本轮未产生新 JSON 摘要，报告标红并拒绝复用旧结果；
- production 域名仍由现有 E2E 测试 fail-closed 拒绝。

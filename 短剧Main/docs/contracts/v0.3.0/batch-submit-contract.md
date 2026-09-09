# 本集生成的确认与提交合同(2026-07-23 冻结,可执行)

回应 generation contract gaps #1。语义:生产页「一键生成本集(已就绪 N/M)」=
批量估价 → **一次人工确认** → 逐项创建任务。不建旁路:每一项的任务创建复用
单个生成的既有流程与校验。

## 端点

`POST /api/v1/episodes/:episode_id/generations/batch-submit`

请求:

```jsonc
{
  "idempotency_key": "<客户端生成 uuid>",     // 幂等键,必填
  "items": [
    { "shot_id": "<uuid>", "quote_id": "<uuid>" }   // quote 来自 batch-estimate
  ]
}
```

- items 上限 50;quote 必须属于该 shot、状态 pending_confirmation 且未过期;
- 后端**不校验就绪状态**(就绪是人工判断+前端筛选,不做机器门禁,D75 口径);
- 本端点本身即"一次人工确认"动作——前端在确认卡展示清单合计后才调用。

## 响应(200,部分失败不整体回滚)

```jsonc
{
  "succeeded": [ { "shot_id": "…", "request_id": "…", "quote_id": "…" } ],
  "failed":    [ { "shot_id": "…", "quote_id": "…", "error_code": "quote_expired|quote_not_found|shot_not_found|insufficient_budget|…", "message": "人话" } ],
  "summary":   { "total": 8, "succeeded": 6, "failed": 2, "total_points": 4800 }
}
```

- 每项独立:成功项任务照跑,失败项不影响其他;
- **quote 过期即 failed,禁止静默重估重价**(价格快照是确认的对象);
- summary.total_points 只计成功项。

## 幂等

同 idempotency_key 重放 → 返回首次执行的完整结果,不重复建任务不重复扣费;
幂等记录保存 ≥24h。不同 key 同 quote:quote 已 consumed → 该项 failed(quote_consumed)。

## 红线(逐字)

先估价后人工确认;一次确认对应一次提交;禁止跳过确认;超复核阈值的单项仍走
现有服务端复核逻辑,被拒项落 failed 不阻塞他项。

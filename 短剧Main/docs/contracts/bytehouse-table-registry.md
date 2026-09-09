# ByteHouse 表登记与血缘

状态：S55 主卡 v2，2026-08-10。2026-08-03 基础域表 + 2026-08-10 资产混合检索表。

目标固定为 ByteHouse `dev` environment 的 `shortdrama_analytics`。业务事实真源始终是
PostgreSQL；ByteHouse 只保存可重放的分析投影。`shortdrama_entity` 与 test/prod 均不在本次
范围。S55-HW 的 `s55_hello_world` 只是兼容通路证明，不计入领域表清单。

## 1. 登记规则

每张表必须登记“PostgreSQL 真源 → 同步任务 → ByteHouse 表 → 消费视图”四元组。任何没有
真实源、消费面或重放语义的表都不得进入 ledger。反馈、审核、权限或业务状态不得从
ByteHouse 反写 PostgreSQL，必须回应用 API。

统一规则：

- 同步任务：`scripts/bytehouse-sync.mts`，dev 手动批同步；
- 物理引擎：`CnchMergeTree`，按业务时间月分区；
- dev 保留期：同步器写入 `retention_until = synced_at + 90 天`，DDL 通过
  `toDateTime(retention_until)` 兼容转换后执行 TTL 删除；
- 重放：同一批允许物理追加，消费视图按稳定业务键选择最新 `source_version` 或
  `projection_version`；
- 凭据、prompt/output、原始供应商响应、错误正文、签名 URL、个人资料不得进入投影；
- readonly 只依赖视图，不依赖底表结构。

## 2. 七张领域表

| 域 / 表 | 一行粒度 | PostgreSQL 真源 | 消费视图 | 首版水位与质量边界 |
| --- | --- | --- | --- | --- |
| events / `events_product_fact` | 一条去标识产品事件的一个源版本 | `app.events` | `v_events_product_latest`、`v_events_funnel_base` | `(received_at,id)`；props 只允许固定字段并强制 `props_redacted=1` |
| cost / `cost_ledger_fact` | 一条报价或 AI 调用的一个源版本 | `app.generation_quotes` + `app.user_credit_ledger_entries` + `app.provider_costs`；`app.ai_calls` | `v_cost_ledger_latest`、`v_cost_daily` | `(updated_at,id)`；待确认报价只表示估算，不得冒充扣费或实际供应商成本 |
| radar / `radar_fetch_runs` | 一次雷达上游调用的一个版本 | `app.topic_radar_upstream_calls` + `app.topic_radar_snapshots` | `v_radar_fetch_runs_latest` | `(started_at,id)`；保留 `resource_scope`、状态、计数、稳定错误码与 payload 摘要，不存正文 |
| radar / `radar_rank_items` | 一个雷达快照条目的一个版本 | `app.topic_radar_items` + `app.topic_radar_snapshots` | `v_radar_rank_items_latest` | `(fetched_at,id)`；公开 URL 去凭据/query/fragment，原始 item 不复制 |
| asset_vec / `asset_vec_documents` | 一个资产 entity 或 variant 的安全文档版本 | `app.asset_entities` + `app.asset_variants` + `app.project_asset_refs` + `app.asset_tags` + `app.tag_vocabulary` | `v_asset_vec_documents_latest` | `(updated_at,id)`；安全文本确定性编译，checksum 可重算，最终授权仍回应用 API |
| asset_vec / `asset_vec_embeddings` | 一个文档×媒体×模型的向量版本 | 获批的持久 PostgreSQL 向量 ledger（当前不存在） | `v_asset_vec_embeddings_latest` | 无持久真源时保持空表；禁止现场调用模型、伪造或重算向量来凑验收 |
| asset search / `asset_vector_index` | 一个已确认且已治理放行的 asset entity 或 variant 索引版本 | `app.asset_entities` + `app.asset_variants` + `app.project_asset_refs` + 后续 #77 分级/rights/clearance/review/publication/transfer/retention 真源 + 获批持久向量 ledger | `v_asset_vector_index_latest` | `source_revision + index_version`；S3、待审、未授权、未发布均 fail-closed；当前前置不完整所以保持空表 |

## 3. 控制表

| 表 | 一行粒度 | 来源 | 消费视图 | 纪律 |
| --- | --- | --- | --- | --- |
| `sync_watermarks` | 一域一次稳定同步批次 | 同步器对当批内容、版本和游标的确定性摘要 | `v_sync_watermarks_latest` | `domain` 仅四域；同批重放沿用 `batch_id`；不保存凭据和源内容正文 |

## 4. 首次 dev 真实源盘点

2026-08-03 首次联调前只读盘点：

| 域 | 可用真实源 | 处理 |
| --- | --- | --- |
| events | `events` 有真实产品事件 | 可同步 |
| cost | `generation_quotes` 有真实待确认报价；扣费 ledger、provider cost 与 ai_calls 为空 | 可同步估算事实；实际成本/积分保持空值 |
| radar | 三张 radar 真源表均为空；52API 是付费且默认关闭 | BLOCKED；需已有抓取产物或新的付费调用/PG 写入授权 |
| asset_vec | `asset_entities` 有真实资产；variant 与持久向量 ledger 为空 | 文档可同步；embedding 表保持空 |
| asset search | PG 尚无 #77 全字段、人工确认和持久 1024 维向量 ledger | 表和视图已实建；禁止从旧 `approved` 布尔或现场模型调用伪造可检索行 |

这张盘点表是运行时事实，不降低 DONE 标准。Fable 要求“每域至少一条真实 PostgreSQL 源数据”
时，radar 为空就不能创建 `S55-DOMAINS-DONE` 标签。

## 5. 质量检查

1. 稳定键为空、同键最新版本不唯一；
2. `source_version/projection_version` 与源更新时间不一致；
3. `retention_until <= synced_at`；
4. events 出现未列入 allowlist 的 props 或 `props_redacted != 1`；
5. cost 把待确认报价写成已扣费、把积分换算成人民币、或用零冒充未知实际成本；
6. radar 缺 `resource_scope`、条目孤儿、热度解析状态缺失、原始 payload/item 泄漏；
7. asset 文档 checksum 不可重算、项目授权预过滤扩大范围、embedding 无持久源；
8. asset search 出现 S3/未确认分类、非人工通过、rights/clearance/publication 未放行、
   敏感级无证据降低、非 1024 向量或原始敏感证据；
9. 同一批重放两次后任一消费视图行数或去除同步时间后的内容发生变化。

质量工具只读；发现问题后提交数据问题单，不直接 DML 修业务事实。

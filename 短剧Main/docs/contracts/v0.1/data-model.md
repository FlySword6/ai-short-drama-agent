# V0.1 数据合同

状态：冻结第一版。后续修改必须同时更新迁移、Drizzle schema、接口合同和验证用例。

## 核心关系

```text
user
  ├─ session
  ├─ project
  │    ├─ episode
  │    │    ├─ scene
  │    │    └─ shot
  │    │          ├─ generation_quote ─ generation_request ─ generation_attempt ─ media_result
  │    │          └─ project_asset_ref
  │    ├─ storyboard_import
  │    ├─ project_asset_ref ─ asset_entity ─ asset_variant ─ asset_media
  │    └─ generation_attempt（预估费用明细）
  └─ agent_session ─ agent_message
```

## 新表

| 表 | 用途 | 关键约束 |
|---|---|---|
| `users` | 简单账号 | `username` 唯一；只存密码哈希 |
| `sessions` | 登录会话 | 只存 token 哈希；过期时间必填 |
| `projects` | 业务项目 | 必须有 `owner_user_id`；软删除 |
| `episodes` | 集 | 同一项目的 `episode_no` 唯一；软删除 |
| `scenes` | 场 | 同一集的 `scene_no` 唯一；软删除 |
| `shots` | 分镜 | 同一集的 `shot_no` 唯一；可关联场；软删除 |
| `storyboard_imports` | 分镜 Excel 预览和确认 | 预览内容以 JSON 保存；只能确认一次 |
| `project_asset_refs` | 项目引用个人或通用资产 | 保存实体引用和可选的锁定版本；软删除 |
| `generation_requests` | 一次用户生成意图 | 用户和幂等键联合唯一；相同键不同请求返回冲突 |
| `generation_quotes` | 一次可确认、可追溯的生成费用报价 | 绑定用户、来源、操作、完整请求哈希、单价快照和10分钟过期时间；消费后唯一绑定 request/attempt |
| `generation_attempts` | 每次真实提交和重试 | 同一请求的 `attempt_no` 唯一；重试幂等键在同一请求内唯一；保存状态、租约和预估费用 |
| `media_results` | 生成媒体及版本 | 成功媒体必须有 TOS 路径；同一远端结果不能重复落库 |
| `pricing_rules` | 可配置单价 | 模型、媒体类型、计费单位和生效时间可追溯 |
| `agent_sessions` | 小龙虾会话 | 必须绑定当前用户，可选绑定项目和分镜 |
| `agent_messages` | 小龙虾消息和工具记录 | 工具调用只记录经过清理的参数和结果摘要 |

## 现有表新增字段

### `asset_entities`

- `owner_user_id uuid null`：个人资产所有者；通用资产可为空。
- `visibility varchar(16) not null default 'personal'`：只允许 `personal/common`。
- `deleted_at timestamp null`、`deleted_by_user_id uuid null`：回收站。

### `asset_variants`、`asset_media`

- `deleted_at timestamp null`、`deleted_by_user_id uuid null`。
- 主版本写入必须在事务中先清空同组其他 `is_primary`，再设目标版本为主版本。

## 分镜和主版本

- `shots.shot_code` 使用字符串，兼容 `1`、`1A`、`TJ1-2` 等真实镜号。
- `shots` 直接保存 `selected_image_result_id` 和 `selected_video_result_id`，每类最多一个主版本。
- 选主版本必须核实结果属于当前分镜、媒体类型正确、任务已成功并且 TOS 地址存在。

## 生成请求、尝试和状态机

权威状态只有：

```text
pending -> running -> succeeded
    |          |
    |          └-> failed
    ├-> failed
    └-> cancelled
```

- `pending`：本地请求和尝试已落库，可能尚未向方舟提交。
- `running`：方舟已接受，正在生成或轮询。
- `succeeded`：媒体已下载并成功持久化到 TOS，数据库中已有永久地址。
- `failed`：方舟明确失败、参数不合法，或持久化失败；必须保存可读原因。
- `cancelled`：本地不再继续处理；不能把查询失败写成任务失败。

内部 `phase` 细分为：`created/submitting/provider_queued/provider_running/provider_succeeded/persisting/complete`。查询网络失败只记录最近查询错误和下次轮询时间，不改变终态。服务启动时恢复所有 `pending/running` 尝试。

处于 `submitting` 且没有远端任务号的尝试，说明方舟可能已经计费但本地没有收到响应。此时标记 `failed + SUBMISSION_OUTCOME_UNKNOWN`，禁止自动再次付费提交。

## 重试、幂等和费用预留

- 完整估价写入 `generation_quotes`。`source` 只允许 `web/assistant/cli`，`action` 只允许 `submit/retry`；助手来源可选绑定当前用户的 `assistant_session_id`。
- 报价保存不含幂等键的完整规范化生成请求、`request_hash`、`pricing_rule_id`、完整 `price_snapshot`、`estimated_cost_fen` 和 `expires_at`。幂等键不改变生成内容，因此不进入请求哈希。
- 报价状态只允许 `pending_confirmation -> confirmed -> consumed`。仅确认且未过期的报价可以消费。报价确认和消费都只允许所有者操作。
- 消费报价时，提交入口必须与 `source` 严格一致。`web`、`assistant` 和 `cli` 报价不能串用；不一致时返回 `GENERATION_QUOTE_SOURCE_MISMATCH`，不消费报价。
- 报价消费、当前单价快照和金额核对、预算检查、request/attempt 创建在同一 PostgreSQL 事务和 advisory lock（事务锁）中完成。单价配置修改与报价创建、消费共用单价事务锁，避免核对后到提交前发生单价漂移。单价或金额变化返回 `quote_stale`，不消费报价。
- 重试报价额外绑定 `original_request_id`、`base_attempt_id` 和 `base_attempt_no`。消费时如果最新 attempt 已变化，该报价失效并返回 `quote_stale`。
- 同一报价和同一规范化输入重放时返回第一次绑定的 attempt，不重复预留费用或排队；同一报价换用于其他输入返回 `409`。
- 客户端每次“第一次提交”必须传 `client_idempotency_key`。同一个用户、同一个键、相同请求返回原请求；同一个键但请求内容不同返回 `409 IDEMPOTENCY_CONFLICT`。
- 用户主动重试只在原 `generation_request` 下新建 `generation_attempt`，不覆盖旧尝试。
- 每次重试必须传 `client_idempotency_key`，持久化到 `generation_attempts.retry_idempotency_key`。同一请求重复使用相同重试键时返回原 attempt，不重复付费提交。
- 网页、助手和 CLI 只有在付费开关、Ark、TOS、`TOS_PUBLIC_BASE_URL` 和报价来源检查通过后，才能写入 `pending` 尝试。拿到远端任务号后更新为 `running`；检查失败时不创建尝试。
- Worker 使用数据库租约领取到期尝试，避免同一任务被两个进程同时处理。
- 付费提交前按已确认报价和当前单价双重核对后预留 `estimated_cost_fen`。已预留金额加本次预估不得超过运行时预算。
- 生成成功后把远端临时地址下载并上传到 TOS。只有 TOS 写入成功后才能标记 `succeeded`。

## 资产边界

- `personal`：只有所有者可查看、编辑、引用和删除。
- `common`：所有已登录用户可查看和引用；普通用户不能修改或删除。
- 项目资产不是复制资产，而是 `project_asset_refs`。生成时保存所用实体、变体和媒体版本快照，后续资产更新不能改变历史生成记录。
- 删除被项目引用的资产时只允许进入回收站。永久删除前必须确认没有有效项目引用、分镜引用、生成任务或交付记录。

## 回收站规则

- 删除默认只写 `deleted_at` 和 `deleted_by_user_id`。
- 恢复清空软删除字段，并重新检查名称或编号冲突。
- 永久删除按“业务引用 -> PostgreSQL 记录 -> Milvus 向量 -> TOS 对象”的顺序预检查，任何一步不能安全完成就整体拒绝。
- V0.1 不对历史生成任务和费用记录做物理删除；它们是验收和费用追溯依据。

## 时间和金额

- 所有时间在数据库保存 UTC，接口返回 ISO 8601。
- 金额在数据库和接口中使用整数分 `*_cost_fen`，避免浮点累计误差。
- V0.1 费用看板直接汇总 `generation_attempts.estimated_cost_fen`；方舟没有返回真实账单时，`actual_cost_status` 必须写 `unavailable`，不能把实际费用填成 0。
- 页面统一标注“预估费用，非云平台实际账单”。

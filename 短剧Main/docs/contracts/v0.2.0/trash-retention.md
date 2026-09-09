# 回收站保留期与自动清理合同

> 状态：`READY_FOR_IMPLEMENTATION`
>
> 产品裁决：DC 已确认保留期为 180 天。
>
> 目标：让回收站文案、服务端判断和自动清理只读取一个事实；到期清理仍必须经过引用检查，
> 不能为了满足天数承诺制造孤儿或删除审计事实。

## 1. 范围

首期只覆盖当前真实回收站已经支持的对象：

- 已软删除的项目；
- 已软删除的个人资产。

首期不覆盖：

- 通用资产；
- 分集、场、分镜；
- 媒体产物。

这些对象即使存在 `deleted_at`，也不能在没有恢复、引用检查和永久删除完整合同前被 TTL
任务顺带清除。

## 2. 唯一配置

服务端配置：

```dotenv
TRASH_RETENTION_DAYS=180
```

规则：

- 类型：正整数；
- 合法范围：`1..3650`；
- 默认值：`180`；
- 生产环境与本地环境使用同一个配置名；
- 禁止新增 `VITE_TRASH_RETENTION_DAYS` 或在前端写死天数。

服务端以 `settings.trashRetentionDays` 读取。前端只从回收站接口的
`retention_days` 读取，不接触环境变量。

## 3. 回收站读取接口

现有接口：

```http
GET /api/v1/trash?kind=project|asset
```

响应增加两个只增不改字段：

```ts
{
  ok: true;
  data: {
    items: Array<{
      id: string;
      kind: "project" | "asset";
      name: string;
      owner_user_id: string;
      deleted_at: string;
      expires_at: string;
    }>;
    count: number;
    retention_days: number;
  };
}
```

`expires_at` 由服务端按 `deleted_at + retention_days` 计算。它表示“最早进入自动清理的时间”，
不承诺该时刻一定物理删除：存在引用、生成、费用或审计保留要求时，记录会继续保留。

推荐用户文案：

> 项目和个人资产可恢复 180 天；到期后进入自动清理。存在引用或审计保留要求时不会删除。

## 4. TTL 清理任务

### 4.1 运行方式

- 在现有 Node 应用内增加 `TrashRetentionWorker`，不新增服务。
- 应用启动后延迟执行一次，之后每 24 小时执行一次。
- 每轮先获取 PostgreSQL 全局 advisory lock；未获得锁就跳过本轮。
- lock 必须覆盖候选领取、外部 TOS/Milvus 清理和最终数据库删除，避免滚动发布时两个实例
  同时清理同一对象。
- 候选按 `deleted_at ASC, id ASC` 稳定分页，每批最多 50 条。
- 同一轮串行处理；单项失败不阻止其余候选。

调度间隔是运维实现细节，不是产品保留期，不对前端暴露第二个配置。

### 4.2 候选条件

数据库候选条件：

```text
deleted_at IS NOT NULL
AND deleted_at <= now() - TRASH_RETENTION_DAYS
```

只查：

- `projects`；
- `asset_entities.visibility <> 'common'` 且有 owner 的个人资产。

候选查询只是初筛，不能直接删除。

### 4.3 删除链

每条候选必须复用现有永久删除链：

```text
重新锁定并校验 cutoff
→ preparePermanentDeletion
→ 引用与审计 blocker 检查
→ deleteExternalObjects
→ hardDelete
```

硬要求：

1. `preparePermanentDeletion` 在同一事务内重新读取 `deleted_at`、owner 与 cutoff。
2. 候选查询后被恢复的对象必须停止，不得清理外部对象。
3. `preparePermanentDeletion` 返回 blocker 时保留对象，不绕过保护。
4. 外部对象删除失败时不得执行数据库 `hardDelete`；下轮可重试。
5. 继续复用现有可重放 purge plan，不另写平行删除逻辑。

### 4.4 持久审计

增加 `trash_purge_attempts`，记录自动与手动永久删除的结果：

```text
id uuid primary key
source varchar(16) check manual|retention
target_kind varchar(16) check project|asset
target_id uuid
owner_user_id uuid nullable
actor_user_id uuid nullable
status varchar(24) check started|blocked|failed|deleted
retention_days integer nullable
deleted_at_snapshot timestamptz nullable
blockers jsonb
error_code varchar(128) nullable
started_at timestamptz
completed_at timestamptz nullable
```

说明：

- `target_id` 不设外键，因为成功后目标行已经物理删除。
- `actor_user_id`：手动删除为当前用户，自动清理为 `null`。
- 不保存 TOS URL、供应商响应、密钥或错误堆栈。
- 一次尝试一行，状态可从 `started` 更新为终态。

## 5. 数据库改动

迁移编号暂定为合流时的下一可用编号，由 Fable 落位。迁移包含：

1. `trash_purge_attempts`；
2. `projects(deleted_at, id)` 的已删除行部分索引；
3. `asset_entities(deleted_at, id)` 的个人已删除行部分索引。

迁移必须：

- 使用 `{{schema}}`；
- 前向执行；
- 不回填、不删除存量行；
- 纳入 migration ledger；
- 在一次性 PostgreSQL 14 容器执行。

## 6. API 与错误

现有手动恢复与永久删除接口保持：

```http
POST   /api/v1/trash/:kind/:id/restore
DELETE /api/v1/trash/:kind/:id
```

既有错误保持：

- `404 not_found`：对象不在回收站；
- `403 forbidden`：当前用户不是 owner；
- `409 trash_item_referenced`：存在引用或审计 blocker；
- `409 project_purge_in_progress` / `asset_purge_in_progress`：已开始外部清理，只能重试删除。

TTL worker 不制造新的对外接口。它的 blocked/failed 结果进入持久审计和结构化日志。

## 7. 测试门禁

### 单元测试

- 配置缺失默认 180；
- 非法配置启动失败；
- 接口返回 `retention_days` 与 `expires_at`；
- 候选分页稳定；
- advisory lock 未获得时不处理；
- blocker 保留对象并记录 `blocked`；
- 外部删除失败记录 `failed` 且不 hard delete；
- 单项失败后继续下一项；
- 被恢复或 `deleted_at` 变化后不会删除。

### 真 PostgreSQL 测试

在一次性 PostgreSQL 14 容器中验证：

1. 迁移前向执行；
2. 未到期对象不入候选；
3. 到期无引用对象被删除；
4. 到期有引用对象保留；
5. 两个 worker 竞争时只有一个执行；
6. 每条尝试均有正确终态审计；
7. 手动永久删除仍经过同一引用检查。

真库演练脚本必须接入 `npm test`，默认不 skip。

## 8. 前后端接缝

K 主线可以先删除“30 天后自动删除”的旧文案，不必等待本包。

完成接口新增后：

1. 前端 `api.trash()` 不再使用会丢列表元数据的通用 `normaliseList()`；
2. 页面使用 `data.retention_days` 与 `items[].expires_at`；
3. 空态也读取同一个 `retention_days`；
4. 不把“进入自动清理”写成“保证在当天物理删除”。

## 9. 非目标

- 不为分集/场/分镜补第二套回收站；
- 不为了准时删除绕过费用、生成、引用和审计保护；
- 不创建独立 cron 服务或第二套队列；
- 不把天数复制到前端构建配置；
- 不自动删除通用资产。

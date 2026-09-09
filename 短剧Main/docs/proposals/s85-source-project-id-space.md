# S85：资产来源项目 ID 空间裁决提案

- 日期：2026-07-28
- 状态：`APPROVED_OPTION_B_READY_FOR_FABLE_INTEGRATION`
- Owner：DC
- 裁决与集成：Fable
- 实现方：Sol 主线

它避免项目内“提升为资产”在数据库外键生效后直接失败，也避免通用待审资产被迁移误删；
用户不需要重新上传或重做审核。

## 1. 需要裁决的问题

`asset_entities.source_project_id` 的正式语义是“资产来源项目”，应指向
`asset_source_projects.id`，还是直接指向业务项目 `projects.id`？

这不是只改一条外键。当前三条事实同时存在：

1. Excel、图片和历史素材把 `asset_source_projects` 当作来源血缘；
2. 项目内 JSON 入库把业务 `projects.id` 原样写进 `source_project_id`；
3. S85 的 039 迁移准备把 `source_project_id` 外键指向
   `asset_source_projects.id`，并隔离没有父行的数据。

如果不先统一 ID 空间，S88 的项目内“提升为资产”等入口会在外键生效后报 500，
而旧 039 在一次 2026-07-28 盘点中会从 8080 数据库隔离 132 条资产，
其中包括当时通用库全部 121 条待审资产。这些数字是时点证据，不是迁移时可写死的库状态。

## 2. 两个方案

### 方案 A：直接指向业务项目

```text
asset_entities.source_project_id → projects.id
```

优点是项目内 JSON 入库不需要转换。

不能采用的原因：

- 现有 652 条非空来源引用中，只有 11 条能命中 `projects`；
- 外部采购、Excel 导入和历史资产并不一定来自本平台业务项目；
- 项目可用资产已经由 `project_asset_refs` 表达，把“来源”再改成“归属”会混淆两种关系；
- 项目永久删除可能反向阻塞资产血缘，或迫使系统删除仍需保留的资产来源记录。

### 方案 B：保留来源项目，并显式映射业务项目

```text
projects.id
   │ 0..1
   ▼
asset_source_projects.business_project_id  UNIQUE
asset_source_projects.id
   │
   ▼
asset_entities.source_project_id
```

项目内入库先按业务项目 ID 找到或建立来源项目，再把来源项目 ID 写入资产。
外部导入继续使用独立来源项目，不要求它对应本平台项目。

## 3. 建议裁决

**采用方案 B。**

它保留现有来源血缘，同时修正项目内入库写错 ID 空间的问题。两类事实的职责为：

- `asset_source_projects`：资产从哪里来；
- `project_asset_refs`：当前哪个项目可以使用该资产；
- `assets.owner_user_id` 与 `visibility`：资产归谁、谁能看；
- `projects`：实际生产项目，不充当所有外部来源的父表。

## 4. 最小数据形状

在 `asset_source_projects` 增加：

```sql
business_project_id uuid null
  references projects(id) on delete set null
```

并建立非空唯一索引：

```sql
create unique index ... on asset_source_projects(business_project_id)
where business_project_id is not null;
```

说明：

- 业务项目存在时，一项目最多映射一个来源项目；
- 项目永久删除时只清除映射，不删除资产来源记录；
- 外部来源的 `business_project_id` 保持空；
- 不再按全局 `name` 判断两个来源项目是否相同。
- `metadata` 需要保留最初观察到的业务项目 ID、名称和映射时间；即使业务项目后来硬删除，
  来源身份仍可追溯。

## 5. 039 的安全迁移顺序

039 不能继续“先隔离、再删除、后加外键”。来源 ID 修复与其余外键治理必须在同一
零删除事务中按两个有序阶段执行：第一阶段只修来源 ID 空间并验证守恒；第二阶段再逐类
预检其余外键，只有全部 dangling 为 0 才加约束。任何阶段失败都整体回滚，不能借来源修复
顺手删除、隔离或静默改写业务数据。

第一阶段建议改成：

1. 给 `asset_source_projects` 增加 `business_project_id` 和唯一索引；
2. 按不同 `source_project_id` 对全量非空引用分成四类并输出计数：
   - 只命中 `asset_source_projects.id`：已经是正确来源 ID，不改；
   - 只命中 `projects.id`：建立业务项目到来源项目的显式映射；
   - 两边都命中：UUID 空间发生歧义，迁移立即失败，交人工证据裁决；
   - 两边都不命中：建立 `unresolved_legacy_source` 来源父行，只表达“历史上观察到此来源 ID”，
     不伪装成已经验证的业务项目来源。
3. 禁止用 UUID 是否存在自动推断 API 入参属于哪个空间；分类只用于受控存量迁移；
4. 若发现同一业务项目对应多个互相冲突的来源，迁移立即失败；
5. 在事务内记录资产、媒体、版本、项目引用及审核状态的迁移前集合，迁移后逐集合断言相同；
   唯一允许增加的是预期的 `asset_source_projects` 父行；
6. 确认没有悬空引用后，再添加外键；
7. 禁止为了通过外键而删除或隔离现有资产。

来源父行可以沿用原悬空 UUID，从而不改资产主表；是否沿用必须先检查目标
`asset_source_projects.id` 没有语义冲突。

## 6. API 与写路径修复

对外请求必须把两个 ID 空间写成两个互斥字段：

```json
{
  "business_project_id": "业务 projects.id，项目内提升为资产时使用",
  "source_project_id": "已经存在的 asset_source_projects.id，外部入库时使用"
}
```

规则：

1. 两者至多提供一个；同时提供时返回 422；普通个人资产或没有来源项目的入库允许两者皆空；
2. 项目内“提升为资产”和宫格切分入口只提交 `business_project_id`；
3. 通用外部入库只有在调用方已经持有来源父项时才提交 `source_project_id`；
4. 禁止继续把业务项目 ID 放进名为 `source_project_id` 的字段，也禁止服务端按 UUID
   落在哪张表来猜含义。

新增一个只处理业务项目的 repository 方法：

```ts
getOrCreateForBusinessProject({
  projectId,
  projectName,
  actorUserId,
}): Promise<AssetSourceProjectRow>
```

要求：

1. 调用前先走项目成员编辑权限；非成员或项目不存在返回 404，已知 viewer 无编辑权限
   返回 403；
2. 以 `business_project_id` 唯一键判定，不按名称；
3. 并发调用幂等，可用确定性 ID 加 `ON CONFLICT`，或事务锁后插入；
4. JSON 入库写入返回的 `asset_source_projects.id`；
5. Excel、采购等外部来源使用另一套明确命名的方法，不伪装成业务项目；
6. 显式 `source_project_id` 父项不存在时返回稳定 422；
7. 只对目标约束名对应的 `23503` 映射为人话业务错误，其他外键错误继续作为服务端
   完整性故障暴露给监控，不能全局吞成普通 4xx；
8. 项目硬删除前把原业务项目 ID、名称和映射时间留在来源 metadata，补真库用例证明
   来源事实仍可追溯。

## 7. 必须通过的真 PostgreSQL 用例

1. 业务项目 ID → 建立来源映射 → JSON 入库 → 外键有效；
2. S88“提升为资产”调用链能成功入库；
3. 同一项目重复、并发入库只产生一个映射；
4. 不同 owner 的同名项目不会串到同一来源；
5. 无项目权限的用户不能借入库接口建立映射；
6. 项目永久删除不删除资产来源事实；
7. 迁移前后资产、媒体、版本、项目引用和审核状态集合动态守恒；
8. 用盘点快照回放旧 8080/5173 场景，证明不会重现 132/1 条隔离以及 121 条待审消失；
9. “两边都存在”的 UUID 歧义会原子停止迁移，不自动选边；
10. 目标父行缺失时返回稳定 422，非成员返回 404、viewer 返回 403，不返回无解释 500；
11. 项目硬删除后，来源父行及原业务项目身份快照仍存在。

## 8. 裁决结果（2026-07-28）

DC 与 Fable 已批准方案 B，并明确拒绝方案 A。实现按以下边界执行：

1. 请求层区分 `business_project_id` 与 `source_project_id`，禁止 UUID 自动探测；
2. 映射字段采用 `business_project_id`；
3. 两边都不命中的存量 ID 建立可追溯、但不冒充已验证来源的父项；
4. 两边都命中时迁移原子失败；
5. 来源 ID 修复与其余外键治理分阶段；
6. 来源修复必须零隔离、零删除，资产、媒体、版本、项目引用与审核状态动态守恒；
7. 039 必须先完成映射和回填，再断言 dangling 为 0，最后才能加外键。

方案 B 已在官方 S85 工作树完成，尚未进入集成线：

- 工作树：`/Users/user/Workspace/02_AI工具开发/.worktrees/terra-s85`
- 分支：`feature/v011-s85`
- 最终提交：`9eae134 fix(s85): harden source identity and JSON ingest`
- 本地验收标签：`S85-DONE`，peeled commit 为 `9eae134`
- 回执：`docs/validation/v011-s85-terra-handoff.md`

S85 最终只使用一个未发布迁移 `039_s85_foreign_keys.sql`。它在同一事务中完成业务项目
映射、旧来源身份回填、8 条外键的 dangling 预检与验证，以及资产、待审资产、媒体、版本、
项目引用和审核动作的成员级守恒断言；不创建 S85 的 040/041，也不删除或隔离任何事实。
`040` 留给回收站保留期，`041` 留给 Seed Audio。

项目调用方统一传 `business_project_id`，外部来源才传 `source_project_id`。仅有
`source_project_name` 的 JSON 入库也会按 owner 范围的完整 `source_identity`
get-or-create 来源父项；两个 ID 同时提供时在权限检查和写入前稳定返回 422。JSON 资产按
现有业务键做幂等冲突回读，真 PostgreSQL 的 8 路并发只保留一个来源父项和一个资产真源。

本地验证为聚焦测试 23/23、临时 PostgreSQL 14 真库 2/2、7/7 父项删除均被
`ON DELETE RESTRICT` 拒绝；回放场景中 132 条资产和其中 121 条待审资产及其关系成员级
守恒。typecheck、架构门禁、build 与 `git diff --check` 通过。唯一已知迁移体检前置是该
独立工作树没有并行包 038；Fable 集成 038 后须在完整序列重跑。

集成纪律：

- 只以 `feature/v011-s85@9eae134` 和 `S85-DONE` 为本包代码真源，不取
  `/private/tmp` 下的竞争快照；
- S85 固定为单一 039；Fable 集成时先确认 038 已在基线，再按
  `039 S85 -> 040 TTL -> 041 Seed Audio` 编排；
- `docs/design/version-plan.md` / `docs/planning/orchestration.md` 的迁移台账仍写到 038，
  由单写区负责人更新到最终编号后重跑完整门禁；
- 在此之前不对生产或共享数据库执行迁移。

# Lite 版后端多用户并发：缺口与补台方案

> 状态：调研完成，方案待拍板后实施（G1 已给出实施方案，未写代码）
> 范围：Lite 版**所有页面、所有写操作**的多用户并发安全盘点
> 事实基线：行号均按当前仓库源码实测（2026-08-14 快照）；引用格式 `文件:行`。函数级归属标注沿用 `docs/lite-oneclick-generate-episode.md` 约定：✓ = Lite 已有 / ✗ = 仅完整版 / ⚠ = 未接线 / 建议新增用「补」。

---

## 0. 结论速览（TL;DR）

Lite 后端**有**并发防护，但**覆盖面不全**，存在 4 个真实缺口 + 4 个弱防护。逐条结论：

| 编号 | 操作 | 并发判定 | 影响 | 需改后端 | 需改数据库 |
|---|---|---|---|---|---|
| G1 | 一键生成本集（submitScript） | 🔴 缺口 | 同集双 run、双倍 AI 成本；后确认者静默顶掉先确认内容 | 是 | **是** |
| G2 | 整部导入（import-bulk） | 🔴 缺口 | 并发导入交叉软删、互相覆盖；与确认/落资产并发残留旧集资产 | 是 | 否（应用层锁） |
| G3 | 候选落资产（Lite materialize） | 🔴 缺口 | 并发落同候选 → 双份资产 | 是 | 可选 |
| G4 | 资产关联分镜 增/删（usages） | 🔴 缺口 | metadata 读-改-写 → lost update 互相吞条目 | 是 | 可选（拆表） |
| G5 | 设主图 / 资产更新（名/简介/备注） | 🟡 弱 | last-write-wins，用户「我改的被覆盖」 | 可选 | 可选 |
| G6 | 集名 / 项目名 / 分镜字段（共享 production） | 🟡 弱 | last-write-wins，无冲突提示 | 产品决策 | 可选 |
| G7 | 提示词模板同名并发改名 | 🟡 弱 | 撞唯一索引裸 500（非干净 409） | 是 | 否 |
| G8 | 删项目时有人正在项目里工作 | 🟡 弱 | 他人操作统一 404；在途生成照跑照扣费 | 产品决策 | 否 |

**受保护、无需改动**：确认草稿（episode 行锁）、放弃草稿（run 行锁）、续跑（executionToken 闸）、成员增删改（项目行锁）、生成单发链 quote→confirm→submit（报价行锁+幂等键+账本唯一索引）、分镜媒体设主版/删版本（分镜行锁）、建集/场/镜（部分唯一索引 409）、档位保存（`expected_version` 乐观锁 409）、seedance 素材登记（DB 唯一约束）。

**数据库改动结论**：只需 **1 处必须**（`script_breakdown_runs` 加集级活跃 run 部分唯一索引，G1）；其余为可选加固（G3 同名唯一、G5/G6 版本列、G4 usages 拆表）。

**建议实施顺序**：P0 = G1、G2、G3（数据一致性/成本）；P1 = G4、G7（丢数据/裸错）；P2 = G5、G6、G8（产品决策/体验）。

---

## 1. 范围与并发模型

### 1.1 并发场景

平台为多人使用：同一项目可有多名成员（owner/editor/viewer，`project_members`），所有写操作经 `ProjectAccessService.require(actor, projectId, action)` 权限门禁（如 `lite/service.ts:51`、`project-access/service.ts`）。**并发 = 同项目多成员几乎同时点同一按钮**（或同用户多标签页）。前端 `busy` 态只防单标签页，挡不住另一用户；轮询 3s 窗口同理。

### 1.2 Lite 后端架构

Lite 是**薄编排层 + 直连 DB repository**，叠在共享事实模块之上：

- **Lite 专用**：`src/modules/lite/`（routes/service/repository）——剧本提交、整部导入、资产落库与维护
- **共享复用**：`script-breakdown`（草稿区状态机）、`production`（项目/集/场/镜 CRUD）、`generation`（报价→确认→提交付费链）、`shot-media`、`generation/prompt-templates`、`operations`（成员）、`seedance-assets`（素材登记）

因此并发安全 = Lite 专用路径 + 共享模块两条线都要覆盖。

### 1.3 全部页面 × 写操作总矩阵

| Lite 页面 | 写操作 | 端点 | 后端守卫 | 判定 |
|---|---|---|---|---|
| lite-projects-page / lite-project-dialog | 建项目 | POST /projects（production/routes.ts:134） | 无共享冲突资源（各建各的） | 🟢 |
| | 改项目名/简介 | PATCH /projects（:145） | 无版本号 | 🟡 G6 |
| | 删项目→回收站 | DELETE /projects/:id（production/routes.ts:197） | 软删，无在途守卫 | 🟡 G8 |
| | 加/改/删成员 | operations/routes.ts:146/162/182 | 项目行锁 lockProject + upsert | 🟢 |
| lite-project-config-page | 保存档位 | PUT /projects/:id/generation-defaults | `expected_version` 乐观锁 409 | 🟢 |
| | 提示词模板 增/改/删 | prompt-templates/routes.ts:60/72/85 | 建=唯一约束；改/删=无锁 | 🟡 G7 |
| lite-workspace-page | 建集 | POST /projects/:id/episodes（production/routes.ts:209） | `episodes_project_number_active_unique` → 409 | 🟢 |
| | 改集名 | PATCH /episodes/:id（:224） | 无版本号 | 🟡 G6 |
| | 删集（软删） | DELETE /episodes/:id（:236） | 无在途守卫 | 🟡 |
| | 剧本粘贴→一键生成 | POST lite/script（lite/routes.ts:79） | 成片锁+幂等键 | 🔴 G1 |
| | 从文件导入文本 | POST lite/script/extract-text | 纯提取不落库 | 🟢 |
| | 整部导入 | POST lite/script/import-bulk | 无项目级锁 | 🔴 G2 |
| | 确认草稿 | POST /script-breakdowns/:id/confirm | episode 行锁 | 🟢 |
| | 放弃草稿 | POST /script-breakdowns/:id/discard | run 行锁 | 🟢 |
| | 续跑失败 run | POST /script-breakdowns/:id/resume | resetStagesForResume 并发闸 | 🟢 |
| | 设分镜主版/删分镜媒体 | shot-media/routes.ts:37/79 | 分镜行锁 | 🟢 |
| lite-assets-page | 候选落资产 | POST lite/assets/materialize | 无命名空间锁/无唯一约束 | 🔴 G3 |
| | 手动新建资产 | POST lite/assets | 无同名唯一 | 🟡 G5 |
| lite-asset-detail-page | 更新资产（名/简介/备注） | PATCH lite/assets/:id | 无版本号 | 🟡 G5 |
| | 设主图 | PATCH lite/assets/:id/primary-media | 事务内翻转，无冲突检测 | 🟡 G5 |
| | 加关联分镜 | POST lite/assets/:id/usages | metadata 读-改-写 | 🔴 G4 |
| | 删关联分镜 | DELETE lite/assets/:id/usages/:uid | metadata 读-改-写 | 🔴 G4 |
| | 删变体 / 删媒体（软删，无整条删资产端点） | DELETE lite/assets/:id/variants/:vid、/media/:mid | 单事务软删；删主变体有晋升逻辑 | 🟢 |
| lite-asset-add-image-dialog / lite-asset-create-dialog | 上传资产媒体 | POST uploadAssetMedia | 主图 flag 翻转 last-write-wins | 🟡 |
| | 建资产变体 | POST createAssetVariant | 无 | 🟢（低风险） |
| | 生成候选图（单发链） | estimate→confirm→submit | 报价行锁+幂等键+账本唯一 | 🟢 |
| lite-shot-detail-page | 生成媒体（单发链） | estimate→confirm→submit | 同上 | 🟢 |
| | 删媒体/设主版/版本标注 | shot-media | 分镜行锁 | 🟢 |
| | 分镜字段/参考资产增删改 | updateShot / shotAssetRefs | 无版本号；refs 有唯一约束 | 🟡 G6 |
| lite-registration.ts | seedance 素材登记/刷新 | seedance-assets | DB 唯一约束 | 🟢 |

🟢 受保护 / 🟡 弱防护（last-write-wins 或产品决策）/ 🔴 真实缺口。

---

## 2. 现状：Lite 后端已有的并发防护（六类）

1. **幂等键**：`(created_by_user_id, client_idempotency_key)` 唯一索引 —— 版本表（migrations/021 `episode_script_versions_creator_idem_unique`）、run 表（`script_breakdown_runs_creator_idem_unique`）、生成请求（`(userId, clientIdempotencyKey)` 去重，generation/repository.ts:481-496）、整部导入每集 `bulk-ep-<episodeId>`。**只防「同一客户端键重放」，不防「不同键并发」**。
2. **成片锁**：`hasPersistedMedia`（lite/repository.ts:93-104）—— 有未软删 media_results（含候选图，无 mediaKind 过滤）的集 → 409 `lite_script_locked`。只挡「有成片」，不挡「无成片但有活跃 run」。
3. **执行令牌**：`claimExecution`（script-breakdown/repository.ts:275-280）原子 `queued→running` + `executionToken`，保证单 run 单执行者。
4. **行锁**：
   - confirmRun：`SELECT id FROM episodes ... FOR UPDATE`（repository.ts:499）串行化同集确认，后确认者 supersede 旧 run；
   - discardRun：run 行 `FOR UPDATE`（repository.ts:777-779）；
   - 生成报价：`lockQuote` `FOR UPDATE`（generation/repository.ts:3186-3193）；
   - 成员：`lockProject` 项目行 `FOR UPDATE`（operations/repository.ts:1065-1068）；
   - 分镜媒体：`lockShotAccess` 分镜行 `FOR UPDATE`（shot-media/repository.ts:333）。
5. **咨询锁（advisory lock）**：`generationPricingLockKey`=1_724_017（generation/cost.ts:14）、`budgetLockKey`=1_724_016（generation/repository.ts:117）、`lockProjectAssetNamespace`（project-assets/repository.ts，**共享 confirmRun 落资产路径取，Lite 独立落资产路径未取**）、`lockProject`（operations/repository.ts:1065-1068）。
6. **部分唯一索引兜底**：集号 `episodes_project_number_active_unique`（migrations/001:55-56）、场号/镜号（001:73-74,100-101）、`scenes/shots` 分镜候选唯一（021）、账本单次扣费 `user_credit_ledger_generation_quote_once`（schema.ts:1011-1013）、模板同名（schema.ts:873-875）、成员单 owner（schema.ts:268-270）、seedance 登记（migrations/015:45-56）、media_results 去重。

**无乐观锁版本列**（唯一例外是档位保存的 `expected_version`）。全部写路径均无 FOR UPDATE/advisory lock/版本号的：资产 usages、资产同名查重、集/项目/模板更新。

---

## 3. 现有防护核对结论（回答「有没有考虑」）

**结论：有部分考虑，且核心付费/确认路径防护较严，但覆盖不完整。**

已严密覆盖：
- 确认草稿的并发安全（episode 行锁 + supersede 语义，见 §4.1 G1 竞态段）
- 放弃草稿 / 续跑（行锁 + 执行令牌闸）
- 生成单发链的**防重复扣费**（四重防线：报价行锁、单次消费 consumed、幂等键、账本唯一索引）—— 同用户双击/重放不会双扣
- 成员、分镜媒体（行锁串行化）
- 建集/场/镜（唯一索引 409）
- 档位保存（乐观锁 409，前端 lite-project-config-page:334-338 已处理）

未覆盖（真实缺口）集中在 **Lite 专用编排层的三处** + 资产 usages 一处 + 共享模块更新类 last-write-wins。逐一在 §4 详述。

---

## 4. 缺口详述与补台方案

### 4.1 G1 —— 一键生成本集：无「每集活跃 run」守卫 🔴

**现状**（`lite/service.ts:49-90` submitScript）：
1. `access.require(actor, projectId, "create")`（:51）
2. `findEpisode` 集归属校验（:57-60）
3. `hasPersistedMedia` 成片锁（:62-64，无成片则放行）
4. `createScriptVersion`（:66-70）
5. `createRun`（:72-76，幂等键派生 `lite-run:sha256(key)`）
6. `linkContainerEpisode`（:82-84）

**竞态**：两人用**不同** `client_idempotency_key` 并发提交同一集（都读到 hasPersistedMedia=false）→ 幂等键各不命中 → **同集建两条 queued run → 双倍 AI 拆解成本**。之后各自 confirm：confirmRun 有 episode 行锁所以不会并发脏写，但**后确认者把先确认者的分镜软删并标记其 run superseded**（repository.ts:555-584）—— 先确认者的内容被**静默顶掉**。前端 `busy`/3s 轮询均挡不住另一用户。

**补台**（实施方案，待拍板）：
- **后端**：在 `script-breakdown` 的 `createRun`（service.ts:127）加守卫——该集存在 `status IN ('queued','running','draft')` 的 run 则抛 409 `lite_run_in_flight`。Lite BFF 与模块公开路由共用此入口，一处生效。不拦 `failed`（续跑/重试路径）、不拦终态（confirmed/superseded/discarded，无媒体时走显式「重新生成本集」）。
- **数据库（必须）**：`script_breakdown_runs` 加部分唯一索引兜底防 TOCTOU：
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS script_breakdown_runs_episode_active_unique
    ON {{schema}}.script_breakdown_runs (episode_id)
    WHERE status IN ('queued', 'running', 'draft');
  ```
  service 层 catch 唯一违例 → 返回友好 409（与 `isPostgresUniqueViolation` 既有模式一致）。
- **前端**：catch `lite_run_in_flight` → 复用 `lockedMessage` 提示区（lite-workspace-page.tsx:784-787 同款），提示「这一集正在解析中」。

**产品需拍板**：`draft` 是否也拦。draft 已由前端 review 视图挡住同用户，但另一用户仍可在轮询间隙提交。**建议拦**（同集同时出现两个待确认草稿语义上就是错的）。

**工作量**：后端 1 个 service 守卫 + 1 处 catch；1 条迁移；前端 1 处 catch 分支。

---

### 4.2 G2 —— 整部导入：项目级重建无互斥 🔴

**现状**（`lite/service.ts:115-179` importBulkScript + `lite/repository.ts:82` softDeleteActiveEpisodes）：提取文本 → `parseEpisodes` 按集标题拆分 → **先软删项目下全部未软删集** → 逐集 `createEpisode`（集号恒从 1）+ `createScriptVersion`（幂等键 `bulk-ep-<episodeId>`，episodeId 每次随机、非真幂等）。覆盖语义 = 替换不是追加（R1 特许可逆）。

**竞态**：
- **两人同时整部导入同一项目**：A 软删全部集 → B 软删全部（含 A 刚建的新集）→ 各自重建 → 最终只剩后提交者一份，A 的新集被 B 误软删，`replaced` 计数把对方新集也算进去 → **交叉覆盖/lost update**。
- **整部导入 与 确认/落资产 并发**：导入软删了集，而并行的 `materializeAssetCandidates` 仍按 run 表读到该集 confirmed run → 在**已覆盖的旧集名下**生成资产，残留「覆盖导入后旧集候选资产」。
- **整部导入 与 生成媒体 并发**：软删分镜发生在生成请求命中之后，产物落到已软删分镜 → 成片判定口径漂移。

**补台**：给整个项目范围的重建加**项目级互斥**（二选一）：
- `pg_advisory_xact_lock(projectId 派生键)`（推荐，无 schema 改动，与 `lockProjectAssetNamespace` 同款），或
- 事务内 `SELECT id FROM projects WHERE id=... FOR UPDATE`（与 confirmRun/members 同款）。

导入、`submitScript`、Lite `materializeAssets` 三处写入口共用同一把项目锁，互斥彼此。前端加「导入中」禁用 + 提示。

**数据库**：不需要（应用层 advisory lock 即可）。可选：`projects` 加「导入中」状态列用于 UI 提示。

**工作量**：后端 1 个锁封装 + 3 处入口接入；前端 1 处禁用态。

---

### 4.3 G3 —— Lite 落资产：无命名空间锁 + 无同名唯一 🔴

**现状**（`lite/repository.ts:137-263` materializeAssetCandidates）：事务内按 `(project_id, asset_kind, name)` 内连查重（`SELECT ... LIMIT 1`，**无 FOR UPDATE**），查无才 insert。**未取 `lockProjectAssetNamespace`**（共享 confirmRun 路径 materializeAssetCandidates 取锁，script-breakdown/repository.ts:845；Lite 独立按钮路径没有）。

**竞态**：两人并发对同集点「候选落资产」、含同一候选名 → 都查无 → **双份同名资产**。共享路径有锁所以 confirm 时不会，但 Lite 素材页按钮是独立入口。

**补台**：
- 后端：Lite 路径与共享路径对齐——事务开头 `lockProjectAssetNamespace(db, projectId)` + 同名查询加 `FOR UPDATE`。
- 数据库（可选加固）：同名唯一约束无法直接跨 join 表建部分唯一索引（`projectAssetRefs` 内连 `assetEntities`）；如需 DB 兜底，需在 `asset_entities` 加生成列 `(source_project_id, asset_kind, lower(name))` 做部分唯一，或接受应用层锁即可。**建议先应用层锁，DB 唯一列为可选**。

**工作量**：后端 ~5 行（取锁 + FOR UPDATE）。

---

### 4.4 G4 —— 资产关联分镜：metadata 读-改-写 lost update 🔴

**现状**：`addAssetShotUsages`（lite/repository.ts:1156）/ `removeAssetShotUsage`（:1307）都在事务里 `SELECT metadata`（**无 FOR UPDATE**）→ 改 `lite.usages` 数组 → `UPDATE metadata`。

**竞态**：两个并发请求基于**同一 metadata 快照**各自追加/删除 → 后写者覆盖先写者 → **关联条目互相吞掉**（添加两条不同关联，最终只剩一条）。

**补台**：
- 方案 A（最小）：对 `asset_entities` 行 `FOR UPDATE`（与 usages 同一行锁），读-改-写被串行化。
- 方案 B（彻底）：usages 拆成子表 `asset_shot_usages`，消除 JSONB 并发写问题。改动大，建议 A 先行。

**数据库**：A 不需要；B 需新迁移。

---

### 4.5 G5 —— 设主图 / 资产更新：last-write-wins 🟡

**现状**（lite/repository.ts:958 setPrimaryMedia）：事务内读当前主图 → 清旧 → 设新，`rowCount=0` 才报错。**无冲突检测**——两用户并发设不同目标主图 → 都读到同一旧主图、各自翻转 → 后提交者赢，不报冲突（路由注释「冲突 409」与实现不符，实现只抛 400 目标不存在）。

**影响**：用户可见「我设的主图被覆盖」，无数据损坏。

**补台（可选）**：给 `asset_media`/`asset_entities` 加 `expected_primary_id` 式乐观锁或版本列，冲突返 409；或产品接受 last-write-wins（短剧协作里主图覆盖可接受）。

---

### 4.6 G6 —— 共享模块更新类：last-write-wins 🟡

**现状**：`updateEpisode`/`updateShot`（production/repository.ts:162/:304）/`updateProject`（:109）/提示词模板 `updateForActor`（prompt-templates/repository.ts:76）均为普通 `UPDATE ... WHERE id AND deleted_at IS NULL`，无版本号、无行锁。两人同时改同一集名 → 都 200，后提交者赢。

**影响**：低危；同 G5。**产品决策**：接受（短剧协作字段覆盖可接受）或加乐观锁（复用档位保存 `expected_version` 模式）。

---

### 4.7 G7 —— 提示词模板同名并发改名：裸 500 🟡

**现状**：`updateForActor`（prompt-templates/repository.ts:76）先 `SELECT` 查重（:84-95）再 `UPDATE`，**UPDATE 路径未包 `withConflict`**（创建路径 onConflictDoNothing 有）。两人并发把两个不同模板改成同名 → 各自过查重 → 后提交者撞唯一索引 → **裸唯一违例 500**，非干净 409。

**补台**：UPDATE 包 `withConflict` → 转 409 `prompt_template_name_conflict`。~5 行。

---

### 4.8 G8 —— 删项目：无在途守卫 🟡

**现状**：`deleteProject`（production/service.ts:103）仅要求 delete 权限（require 在 :105），软删无级联（repository.ts:120）。项目软删后所有读写查询带 `isNull(projects.deletedAt)` 过滤（project-access/repository.ts:24、shot-media/repository.ts:367、prompt-templates/repository.ts:170）→ 他人操作统一 404；**在途生成 worker 照跑照扣费**（无取消逻辑），产物仍写入但项目隐藏不可见。

**影响**：产品体验 + 轻微资源浪费；数据无损坏（R1 可逆，回收站可恢复）。

**补台（产品决策）**：可选——软删前检查该项目有无活跃 run / 在途生成并提示；或在 worker 侧加「项目已软删即跳过扣费产物落库」。

---

### 4.9 G9 —— 成片锁 TOCTOU（低概率边缘）🟡

**现状**：`hasPersistedMedia` 是读-判，`submitScript` 放行后若有并发生成媒体提交插入 media_results，新 run 的 confirm 会软删持有该媒体的分镜 → 媒体成孤儿。窗口极小（hasPersistedMedia 读到 media insert 提交之间）。

**缓解**：G1 锁后同一集只能有一个活跃 run；生成媒体的 shot 命中与确认的先后顺序已由 G1 之外的既有确认逻辑覆盖大部分。标注低优先级，可不处理。

---

## 5. 数据库改动清单

| 优先级 | 表 | 改动 | 目的 | 迁移 |
|---|---|---|---|---|
| **必须** | script_breakdown_runs | 部分唯一索引 `(episode_id) WHERE status IN ('queued','running','draft')` | G1：同集仅一个活跃 run | 新迁移 |
| 可选 | projectAssetRefs/asset_entities | 同名唯一（生成列方案） | G3：落资产防双份 | 新迁移 |
| 可选 | asset_entities（或子表） | version 列 / usages 拆表 | G4/G5 | 新迁移 |
| 可选 | episodes/projects/shots | version 列 | G6 乐观锁 | 新迁移 |
| — | 其余 | **无需改动** | G2 用 advisory lock；G7 纯应用层 | — |

数据库改动结论：**G1 必须加 1 条唯一索引**，其余全部可选。advisory lock / 行锁 / withConflict 均无需 schema 变更。

---

## 6. 实施顺序与风险

| 优先级 | 项 | 风险 | 验收 |
|---|---|---|---|
| P0 | G1 集级活跃 run 锁 | 双倍成本 + 静默顶内容（最高） | 两用户并发提交同集 → 第二个 409；单测覆盖不同键并发 |
| P0 | G2 整部导入互斥 | 交叉覆盖丢集 | 并发导入同项目 → 串行化，replaced 正确 |
| P0 | G3 落资产锁 | 双份资产 | 并发落同候选 → 单份 |
| P1 | G4 usages 行锁 | 丢关联条目 | 并发加两条关联 → 两条都在 |
| P1 | G7 模板改名 409 | 裸 500 | 同名冲突返回 409 |
| P2 | G5/G6/G8 | 产品决策 | — |

**实施注意**：
- G1 的锁粒度**按集**（不同集可并行），不全局。
- G1 加锁后 confirmRun 的 supersede 语义不再被并发触发，只走显式「重新生成本集」。
- 所有守卫返回码用既有 `ConflictError(code, ...)` 风格，前端按 code 分支而非 status 盲猜。

---

## 7. 附录：关键源码行号索引

**Lite 专用**
- `lite/service.ts:49-90` submitScript（成片锁 :62-64；幂等键 :72-76）；`:115-179` importBulkScript（软删重建 :170）；`:200+` LiteAssetService
- `lite/repository.ts:82` softDeleteActiveEpisodes；`:93-104` hasPersistedMedia；`:137-263` materializeAssetCandidates（**无锁**）；`:714` createAsset；`:789` updateAsset；`:958` setPrimaryMedia（无冲突检测）；`:1156/:1307` add/removeAssetShotUsages（无行锁）；`:1373` deleteAssetVariant；`:1455` deleteAssetMedia
- `lite/routes.ts`：script :79、extract-text :104、import-bulk :124、materialize :147、资产列表 :174、手动新建资产 :224、更新资产 :241、设主图 :294、加关联 :330、删关联 :356、删变体 :367、删媒体 :378

**script-breakdown**
- `service.ts:127` createRun（加守卫点）；`:177-191` resumeRun；`:195-201` discardRun；`:274+` executeRun
- `repository.ts:139-145` createRun 幂等去重；`:275-280` claimExecution；`:397-470` resetStagesForResume（并发闸）；`:499` confirmRun episode FOR UPDATE；`:555-584` supersede 旧 run；`:775-813` discardRun run 行锁；`:845` 共享 materialize 取命名空间锁
- `migrations/021`：runs 仅 `(created_by_user_id, client_idempotency_key)` 唯一（无集级活跃）

**共享模块**
- production：routes.ts:134 createProject、:145 patchProject、:197 deleteProject、:209 createEpisode、:224 updateEpisode、:236 deleteEpisode；service.ts:103 deleteProject（权限 require :105）、:118 createEpisode、:128 updateEpisode、:133 deleteEpisode、:332 withConflict；repository.ts:109 updateProject、:120 softDeleteProject、:162 updateEpisode、:174 softDeleteEpisode
- generation：routes.ts:368 estimate、:654 quote confirm、:674 create；repository.ts:117 budgetLockKey、:304 createSubmissionQuote、:423 confirmQuote、:457 createSubmission、:3186 lockQuote、:3363 consumeQuote；cost.ts:14 generationPricingLockKey
- prompt-templates：routes.ts:60 create、:72 update（PUT）、:85 delete；repository.ts:46 createForActor、:76 updateForActor（未包 withConflict）、:115 softDeleteForActor
- operations：repository.ts:189/265/328 add/update/removeProjectMember、:689 patchProjectOperations、:1065-1068 lockProject
- shot-media：repository.ts:165 setPrimary、:296 deleteMedia、:333 lockShotAccess
- seedance-assets：migrations/015:45-56（asset_media/source_result/remote_asset 三重唯一）、schema.ts:1542 attempts 唯一
- schema.ts：:268-270 成员单 owner、:873-875 模板同名、:1011-1013 账本单次扣费

**前端配合点**
- `lite-workspace-page.tsx:784-787` 409 catch → lockedMessage；`:1325` 重新生成本集；`:1346` 修改后重新生成；`:1562-1563` 锁定提示区
- `lite-project-config-page.tsx:334-338` 档位 409 乐观锁处理（已有范例）
- `lite-assets-page.tsx:668` 候选落资产按钮（G3 前端禁用/提示）

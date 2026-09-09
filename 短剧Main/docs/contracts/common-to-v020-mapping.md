# common → v0.2.0 数据映射契约

- 状态:v2 实证化版(2026-07-26,S25 工作包产出:在 S19 v1 草案基础上,对照他们真实源码逐条核对;Fable 架构与验收)
- 范围:合流施工图。源 = `common` schema(团队旧系统活数据,所称 2071 资产 / 23 项目 / 338 生成任务,行数未经核实);目标 = v0.2.0 主线 schema(定名 **`app`**,见 `docs/contracts/environment-governance.md` §2)
- 本包纪律(S25):本文档实证化 + 迁移 024 + ETL 脚本可写;**仍不连云库、不动真实数据、不执行真实迁移**(真实执行由 Fable 取得 DC 授权后进行)。

---

> ⚠️ **证据等级铁律(读本文前必读)**
>
> **本文中凡描述 common 侧(他们的表、列、值域、行数)的内容,默认不可直接施工;只有描述我方 v0.2.0 schema 的内容可以逐列照做。** 映射表每一行都标了证据等级,**标 C 的行必须先拿到指定证据再施工**——把 C 当确定结论执行,是本契约最禁止的用法。
>
> | 等级 | 含义 | 本文中的证据位置 |
> | --- | --- | --- |
> | **A** | 我方 migrations/schema 实证,可逐列核对 | `migrations/001`–`021`、`src/db/schema.ts`、`src/db/migrate.ts`(本仓当前分支) |
> | **B** | 他们源码确认 | 只读检出 **`a2e06dd`**(`.worktrees/their-nestjs`,已验证 = S19 pinned `53a3d6d` 的下游、领先 19 个提交),精确到文件路径 + 行号。DDL 级证据以 `backend/libs/infrastructure/src/database/sql/common-schema-v1.sql`(common 基表手工 DDL)与 `backend/libs/infrastructure/src/database/migrations/*.ts`(TypeORM 迁移)为准;**实体类文件普遍是表的子集映射(缺列已多处证实),不能作为列全集证据** |
> | **C** | 从分析文档推断、口头所称或 live 数据分布,**未经核对** | `docs/validation/v0.1.1-data-truth-plan-handoff.md`、`docs/proposals/script-breakdown-port.md`、`zhongwen-shortdrama-context/docs/specs/sql/manhua-cli-agentkit-schema-v1.sql`(下称"manhua 蓝图");**live 行数、空值率、实际值域分布一律仍为 C,即使表结构已升 B** |
>
> B 级三条保留:(1) TypeORM 实体 ≠ 表的全部列(已证实存在实体缺列,见 §2.6、§2.9);(2) live 库可能领先或落后 `a2e06dd`——`common-schema-v1.sql` 是**手工执行**的 DDL(他们文档自述"是否已手工执行"待确认),generation 域基表 DDL 不在仓内;(3) 值域的 B 级证据 = CHECK 约束 / 迁移 DDL / 代码字面量,**live 实际数据分布仍 C**。因此 **B 级行施工前仍建议用 live `information_schema` 只读导出做最终核对**(见 §6-Q1)。

## 0. 三套结构的关系(先分清再谈映射)

同一个 RDS `shortdrama` 库里实际并存/曾并存三套表结构,映射前必须分清,否则会把设计草案当成活数据:

1. **live `common`(迁移源,结构已 B 级实证 + live 数据分布仍 C)**:旧 NestJS + TypeORM 系统写入的活数据。`a2e06dd` 的实体、迁移与手工 DDL 给出了用户、组织、角色、项目、授权、模型目录、计费、生成、资产、剧本、剧本导入、分镜提示词、语音、Seedance 资产任务、上传历史共 25+ 张表的结构(B)。S25 实证要点:
   - common 基表 DDL 真源 = `backend/libs/infrastructure/src/database/sql/common-schema-v1.sql`(540 行,手工执行,**不在 TypeORM 账本内**;他们文档 `docs/admin-authorization-development-plan.md:84` 自述"数据库结构无法由现有 migration 命令完整重建")。
   - generation 域基表(`generation_tasks/calls/outputs`、`asset_media`)DDL **不在仓内**(`common-schema-v1.sql:3` 自述"Generation tables are managed by the existing generation schema separately"),仓内只有实体 + ALTER 迁移——这些表的 NOT NULL/默认值等库级细节只有下界证据。
   - `script_imports`、`seedance_asset_tasks` 在 S19 pinned `53a3d6d` 中不存在,**在 `a2e06dd` 中已存在**(迁移 `1784632000000`、`1784630000000`,B);`asset_media` 仓内已知 7 列(B),但**无实体关联列**,且基表 DDL 仓外,不排除 live 还有仓外列(C)。
2. **manhua 蓝图(设计草案,纯 C)**:`manhua-cli-agentkit-schema-v1.sql` 是一份文档级 DDL 草案(其文件头自述"不代表生产迁移授权")。它与 live 实体**命名和结构都不一致**(例:蓝图 `manhua_generation_attempts/artifacts` vs live `generation_calls/outputs`;蓝图 `manhua_users.current_team_id` vs live `common.users.current_organization_id`)。它是否落过库、落在哪个 schema,未知。蓝图表只进 §2.9 差异登记,不作为映射主源。
3. **我方 v0.2.0 主线 `app`(迁移目标,A)**:migrations 001–021 + Drizzle schema。账本表 `schema_migrations(version, checksum, applied_at)` 由 `src/db/migrate.ts` 维护,checksum 漂移即拒绝运行。

另需登记:他们同一套源码里还有 `public.manhua_users / manhua_user_credentials / manhua_organizations`(另一套 API 的表,B)。S25 实证补充:这三个 legacy 实体**未注册进任何 Nest 模块**(`backend/libs/users/src/users.module.ts:19-29` 只注册 9 个 common 实体),运行时认证已走 `common.*`;`manhua_users` 基表不由仓内任何 migration 创建(`1783908000000:47` 直接 ALTER 既有表)。迁移以 `common` 为源;`public.manhua_*` 只作身份匹配参考与红线登记(§5)。

口径锚点(以 `environment-governance.md` 为准):`common` **冻结**为合流迁移源;`app` 为运行 schema;读 common 用 `readonly` 账号,写 `app` 走专项窗口;迁移期间**不双写**;写前快照、旧 writer 冻结、每批独立事务。

## 1. 总览映射表

决策取值:**迁** = 列入 ETL;**暂缓** = 保留只读、等决策;**不迁** = 进 §5 不迁清单。证据列格式为「common 侧 / 我方侧」。

| 域 | common 表(源) | v0.2.0 表(目标) | 决策 | 证据 |
| --- | --- | --- | --- | --- |
| 用户身份 | `users` | `users`(+crosswalk) | **迁**(crosswalk 先行,人工确认) | B / A |
| 登录凭据 | `user_credentials` | —(无对应) | **不迁**(红线 R1) | B / A |
| 登录会话 | `user_sessions` | `sessions`(不写入) | **不迁**(红线 R2) | B / A |
| 组织 | `organizations`、`organization_members` | `teams`、`team_members` | **暂缓**(组织→团队映射待 DC 决策) | B / A |
| 角色权限 | `roles`、`user_roles`、`permissions`、`role_permissions`、`permission_policies`(S25 补登记) | `users.role`、`project_members` | **部分迁**(平台角色人工裁定;项目角色经 §2.3) | B / A |
| 项目 | `projects` | `projects` + `project_members` | **迁**(crosswalk 先行) | B / A |
| 项目授权 | `project_access_grants` | `project_members` | **迁**(role_type 值域已实证:owner/admin/collaborator/viewer,见 §2.3) | B / A |
| 项目指标 | `project_metrics`(S25 补登记) | —(无对应) | **不迁**(派生计数器,红线 R13) | B / A |
| 资产实体 | `asset_entities` | `asset_entities` | **迁**(ETL 复制、发新 ID、保留 lineage) | B / A |
| 资产变体 | —(无此概念) | `asset_variants` | 不建(无源) | B / A |
| 资产媒体 | `asset_media` | `asset_media` | **暂缓(施工阻塞)**:仓内已知 7 列、**无实体关联列/key/hash/尺寸/时间戳**,按原设计无法施工(§2.4) | B(已知 7 列)C(是否有仓外列) / A |
| 项目资产引用 | `project_asset_refs` | `project_asset_refs` | **迁**(依赖用户+项目 crosswalk) | B / A |
| 生成历史 | `generation_tasks`、`generation_calls`、`generation_outputs` | `generation_requests`、`generation_attempts`、`media_results`(不写入) | **不迁**(红线 R4;§2.5 仅作结构对照备查) | B / A |
| 模型目录 | `model_catalog` | —(无 catalog 层) | **暂缓**(开放问题 Q-11;`model_key` 随计费规则入 metadata) | B / A |
| 计费规则 | `model_pricing_rules` | `pricing_rules` | **迁**(计价模型转换已按代码实证修正,见 §2.6) | B / A |
| 剧本 | `scripts`、`script_breakdown_runs` | 无正式等价(S4 提案未冻结) | **暂缓**(旧表只读) | B / A |
| 剧本导入 | `script_imports` | — | **暂缓**(随剧本域;存在性已证实,`a2e06dd` 迁移 `1784632000000`) | B / A |
| 分镜提示词 | `project_director_storyboard_prompts`、`project_prompts` | `shots` 的 `director_prompt` / `image_prompt` / `video_prompt` | **迁**(合并入 `shots`;prompt_type 值域已实证修正,见 §2.7) | B / A |
| 语音音色 | `audio_voices` | —(无音色注册表) | **不迁**(我方无对应表;进开放问题) | B / A |
| 声音克隆任务 | `voice_clone_tasks` | — | **不迁**(生成历史类 + 红线字段) | B / A |
| 供应商资产任务 | `seedance_asset_tasks` | `seedance_asset_registrations` | 存在性已证实(`a2e06dd` 迁移 `1784630000000`);**不迁数据**,只保留 lineage 口径,不当资产(含红线字段 `create_response`/`status_response`) | B / A |
| 上传历史 | `file_uploads`(S25 补登记) | —(无对应) | **不迁**(上传行为历史,我方无对应表;红线 R13) | B / A |
| TypeORM 迁移账本 | `public.migrations`(默认表名/位置,已实证) | `schema_migrations`(不写入) | **不迁**(红线 R6/R7,两套账本分开) | B / A |
| manhua 蓝图草案 | `manhua_*`(18 张) | 见 §2.9 | **登记差异**,不作为映射主源 | C / A |

---

## 2. 逐表列级映射

列级表读法:「common 列(类型)」→「v0.2.0 列(类型)」;「转换 / 缺失默认值策略」含类型差异与缺失列处理;「证据」= common 侧 / 我方侧。我方列的约束(NOT NULL、CHECK、唯一)全部 A 级,出自 `migrations/001`–`021` 与 `src/db/schema.ts`,不再逐行引文件。

### 2.1 用户与认证:`common.users` → `app.users`

源结构(B:`backend/libs/users/src/entities/common-user.entity.ts`;DDL 真源 `backend/libs/infrastructure/src/database/sql/common-schema-v1.sql:10-25`)。S25 实证:**DDL 实际 11 列,比 v1 契约多 `metadata`**;另有 UNIQUE `(login_name)`(:23)、UNIQUE `(auth_subject_id)`(:24)、CHECK `status IN ('active','disabled','deleted')`(:22)——login_name 在源库唯一,是 crosswalk 人工匹配的可靠输入(但可 NULL,NULL 可多条)。

| common 列(类型) | app 列(类型) | 转换 / 缺失默认值策略 | 证据 |
| --- | --- | --- | --- |
| `id` uuid PK | `id` uuid PK | **不保留旧 ID**;发新 uuid,旧→新记 crosswalk(§3) | B / A |
| `login_name` varchar(128) NULL,UNIQUE | `username` varchar(64) NOT NULL,CHECK `^[a-z0-9][a-z0-9_.-]{2,63}$`,唯一 `lower(username)` | `lower(trim())`;为 NULL、不合正则、超长(>64)或冲突 → **进人工队列,不自动改名**(crosswalk 必须人工确认);空值率未知(C) | B(列+唯一)C(数据质量) / A |
| `display_name` varchar(128) NOT NULL | `display_name` varchar(128) NOT NULL | 直拷 | B / A |
| `email` varchar(255) NULL | —(无列) | **不迁**;写入 crosswalk `notes` 供人工匹配(PII 最小化) | B / A |
| `auth_subject_id` varchar(128) NULL,UNIQUE | —(无列) | **不迁**;如需 SSO 绑定另开决策 | B / A |
| `current_organization_id` uuid NULL,FK→organizations SET NULL(:277-278) | —(无直接列) | 组织决策未定(§6 Q-10);默认不落 | B / A |
| `status` varchar(20) default `'active'`,CHECK `('active','disabled','deleted')`(:22) + `is_disabled` bool | `active` bool NOT NULL | `active = (status = 'active' AND NOT is_disabled)`;值域已 B;live 实际分布仍 C | B(列+CHECK)C(live 分布) / A |
| `metadata` jsonb NOT NULL default `'{}'`(:19,**实体未映射,v1 契约漏列**) | —(无列) | **不迁**;非空原值进 crosswalk `notes`(JSON 摘要),不建 PII 超集 | B / A |
| —(密码在 `user_credentials`) | `password_hash` text NOT NULL | **绝不复制旧 hash**(红线 R1);写**不可解析哨兵值**(我方 hash 格式为 `scrypt:...`,`src/modules/auth/service.ts`;哨兵永远无法通过校验),配合强制重置流程 | B / A |
| —(无源) | `role` varchar(16) NOT NULL default `'member'`,CHECK `(admin, operator, member)` | 默认 `'member'`;`common.user_roles/roles` 到平台角色的映射**人工裁定**,结果记 crosswalk `notes`(对方角色值域见 §2.2,已 B) | B / A |
| `created_at` / `updated_at` timestamptz | `created_at` / `updated_at` timestamptz NOT NULL | 直拷 | B / A |

`common.user_credentials`(B:`common-user-credential.entity.ts`;DDL `common-schema-v1.sql:66-74` 全量 7 列):`user_id` PK、`password_hash` varchar(255)、`password_algorithm` varchar(32) default `'scrypt'`、`is_disabled`、`password_changed_at`、`created_at`、`updated_at` —— **整表不迁**(红线 R1)。服务层硬编码 `password_algorithm='scrypt'`(`users.service.ts:205,243`),live 是否只有 scrypt 仍 C。

`common.user_sessions`(B:`user-session.entity.ts`;DDL `common-schema-v1.sql:76-86`):`refresh_token_hash` varchar(255)(注意:DDL :79 可 NULL,实体声明 NOT NULL,以 DDL 为准)、`user_agent`、`ip_address` inet、`expires_at`、`revoked_at` —— **整表不迁**(红线 R2)。我方 `sessions.token_hash` varchar(64) 是我方自签会话的哈希,语义不兼容,不接收任何旧 token。

### 2.2 组织与角色:`common.organizations` / `organization_members` / `roles` 系列 → `app.teams` 系列(暂缓)

源结构(B:`common-organization.entity.ts`、`organization-member.entity.ts`、`role.entity.ts`、`user-role.entity.ts`、`permission.entity.ts`、`role-permission.entity.ts`;DDL 真源 `common-schema-v1.sql:29-167`)。S25 实证:**实体普遍是子集映射,DDL 每表多 `metadata`/`created_at`/`updated_at` 等列**(逐列清单以 schema SQL 为准)。

- `organizations`(`organization_code` UNIQUE :41、`organization_name`、`parent_organization_id`、`owner_user_id`、`status` CHECK `('active','archived','deleted')` :40)与我方 `teams`(`name`、`parent_team_id`)概念相近但**语义未核实**(对方是组织/公司,我方是成本归因单元,schema 注释明确"不是权限模型")→ **暂缓**,待 DC 决策(§6 Q-10);决策前 `projects.team_id` 一律置 NULL。
- `organization_members.member_role`:CHECK `('owner','admin','member','viewer')`(:59,**值域已 B**;服务层无枚举校验,admin API 原样透传,唯一强制点是 DB CHECK)→ 不落;项目级成员资格只从 `project_access_grants` 迁(§2.3)。另有 `source_type` CHECK `('explicit','implicit','system')`(:60)、UNIQUE `(organization_id, user_id, member_role, source_type)`(:61)。
- `roles`/`permissions`/`role_permissions`/`user_roles`:对方是资源-动作权限模型(`roles.scope_type` CHECK `('system','organization','project')` :102;`user_roles` 有 org/project 作用域互斥 CHECK :137 与三张部分唯一索引 :140-150);我方只有平台角色(admin/operator/member)+ 项目成员角色(owner/editor/viewer)二元模型,**无可机械映射的对应关系** → 细则不迁,平台角色人工裁定(§2.1),表本身只读保留。
- `permission_policies`(:152-167,**无任何实体映射,S25 补登记**):scope_type CHECK `('module','api','button','data','field')` :166 → 同属权限细则,**不迁**(R11)。

### 2.3 项目与授权:`common.projects` / `project_access_grants` → `app.projects` + `app.project_members`

源结构(B:`project.entity.ts`、`project-access-grant.entity.ts`;DDL 真源 `common-schema-v1.sql:171-191`(projects)与 `:207-229`(access_grants))。S25 实证:**v1 契约 projects 列集不全**——DDL 还有 `budget_amount`/`budget_spent_amount`/`budget_remaining_amount` numeric(18,4)(:177-179)、`cover_image_url`(:182)、`start_time`/`end_time`(:183-184)、`metadata`(:185);`status` 默认 `'draft'` 且 CHECK `('draft','active','paused','archived','closed')`(:188);`project_code` UNIQUE(:190)。FK:`owner_user_id → users RESTRICT`(:328-329)、`owner_organization_id → organizations RESTRICT`(:331-332)——live 每行 owner 必然存在于 users,跨 crosswalk 解析失败只会是"该用户被剔除/人工未确认"两类。注意 `owner_team_id`:**实体 NOT NULL(project.entity.ts:18)且 seed 实际写入,但 schema SQL 的 CREATE TABLE 未列**(SQL 陈旧,:274-275 的兼容 ALTER 只补 `owner_organization_id`)——列存在为 B,无 FK,live 空值率 C。

| common 列(类型) | app 列(类型) | 转换 / 缺失默认值策略 | 证据 |
| --- | --- | --- | --- |
| `id` uuid PK | `id` uuid PK | 不保留;新 uuid + crosswalk | B / A |
| `project_code` varchar(64) UNIQUE | —(无列) | **不迁**;记 crosswalk `notes` | B / A |
| `name` varchar(128) | `name` varchar(255) NOT NULL | 直拷;与唯一索引 `(owner_user_id, lower(name)) WHERE deleted_at IS NULL` 冲突 → 人工 | B / A |
| `owner_user_id` uuid NOT NULL,FK RESTRICT | `owner_user_id` uuid NOT NULL FK | 经用户 crosswalk 解析;解析失败 → **不迁该项目,记 conflict**(不允许换主);import owner 人选待批准(data-truth §4.A) | B / A |
| `owner_team_id` uuid NOT NULL(实体;无 FK) | `team_id` uuid NULL | 组织决策未定,默认 NULL(§6 Q-10) | B(列)C(live 空值率) / A |
| `owner_organization_id` uuid NOT NULL,FK RESTRICT | —(无列) | 不迁;记 crosswalk `notes` 供组织决策(§2.2)使用 | B / A |
| `status` varchar(20) default `'draft'`,CHECK `(draft,active,paused,archived,closed)`(:188) | `status` varchar(20) NOT NULL,CHECK `(active, archived)` | `'active'`→`'active'`;其余(`draft`/`paused`/`archived`/`closed`)一律 `'archived'` 并记 `notes`(值域已 B;live 实际分布仍 C) | B(列+CHECK)C(live 分布) / A |
| `description` text NULL | `description` text NULL | 直拷 | B / A |
| `budget_amount` / `budget_spent_amount` / `budget_remaining_amount` numeric(18,4)(:177-179,v1 契约漏列) | —(无列;我方预算在配额/能力层,不在项目行) | **不迁入正式列**;三值全非零时打包进 crosswalk `notes`(JSON),供 DC 评估是否需要预算初始化 | B / A |
| `cover_image_url` text / `start_time` / `end_time` timestamptz(:182-184,v1 契约漏列) | —(无列) | 不迁;非空进 crosswalk `notes` | B / A |
| `metadata` jsonb NOT NULL default `'{}'`(:185,v1 契约漏列) | —(无列) | 不迁;非空进 crosswalk `notes` | B / A |
| `created_at`/`updated_at` timestamptz | 同名 timestamptz NOT NULL | 直拷 | B / A |
| —(无源) | `genre` varchar(32) NULL | 默认 NULL | — / A |
| —(无源) | `deleted_at` / `deleted_by_user_id` | 默认 NULL | — / A |

每个迁入项目**同时写一行** `project_members`:`(project_id, user_id=新 owner, role='owner', added_by_user_id=import owner)`;唯一索引「每项目一个 owner」由 016 迁移保证(A)。

`project_access_grants` → `project_members`(S25 实证:DDL 全量 15 列,v1 契约漏 `id` PK 与 `created_at`/`updated_at`;`source_type` 在 **DB 无默认值**(:212),实体默认 `'explicit'` 只是应用侧行为;部分唯一索引 `(project_id, user_id) WHERE source_type='explicit' AND is_active` :227-229):

| common 列(类型) | app 列(类型) | 转换 / 缺失默认值策略 | 证据 |
| --- | --- | --- | --- |
| (抽取条件) | — | 只迁 `source_type='explicit' AND is_active AND NOT is_disabled AND revoked_at IS NULL` 的行(各默认值 B,实际数据分布 C;代码只写 `'explicit'`,`project-access.service.ts:118`) | B / A |
| `project_id` / `user_id` uuid | `project_id` / `user_id` uuid | 双双经 crosswalk 解析;任一失败 → quarantine | B / A |
| `role_type` varchar(32) | `role` varchar(16) CHECK `(owner, editor, viewer)` | **值域已实证(B)**:`owner`/`admin`/`collaborator`/`viewer`(`project-access.service.ts:49-51,185`;seed 同)。映射:`owner`→与 projects 表自动建的 owner 行去重(同人跳过,不同人→人工);`admin`/`collaborator`→`editor`;`viewer`→`viewer`;出现其他值 → 人工(live 分布 C) | B(列+代码值域)C(live 分布) / A |
| `role_level` int(代码:admin=80/collaborator=50/viewer=10,:193-195;**seed 写 collaborator=20,代码与种子不一致**) | —(无列) | 不迁;只作"保留高权限行"的排序依据(代码值域 B) | B / A |
| `source_scope_*`、`metadata`、`granted_at`、`revoked_at` | —(无列) | 不迁;`granted_at` 用于 `created_at` | B / A |
| `id` uuid PK、`created_at`/`updated_at`(:208,:221-222,v1 契约漏列) | —(无对应) | `id` 记 crosswalk `source_pk`;时间不迁 | B / A |
| — | `added_by_user_id` uuid NOT NULL | import owner | — / A |
| 冲突处理 | PK `(project_id, user_id)` | 同一 (project,user) 与 owner 行重复 → 保留高权限行(按 role_level),记 conflict;不双写 | B / A |

### 2.4 资产:`common.asset_entities` / `asset_media` / `project_asset_refs` → `app.asset_entities` / `asset_media` / `project_asset_refs`

源结构(B:`backend/libs/scripts/src/entities/asset-entity.entity.ts`、`project-asset-ref.entity.ts`;`asset_media` 仓内证据 = `backend/libs/assets/src/entities/asset-media.entity.ts` + 迁移 `1784710000000-add-seedance-fields-to-asset-media.ts`,基表 DDL 仓外)。**同名不同构**:两边都有 `asset_entities`/`asset_media` 表,严禁同名 ALTER 或整表覆盖;旧行只能经显式 ETL 复制进 `app` 并发放新 ID(data-truth §3 已定)。

`asset_entities` → `app.asset_entities`(S25 实证:v1 契约 18 列与实体完全一致,无漏列;值域按代码写入证据升级):

| common 列(类型) | app 列(类型) | 转换 / 缺失默认值策略 | 证据 |
| --- | --- | --- | --- |
| `id` uuid PK | `id` uuid PK | 新 uuid + crosswalk(`match_rule` 见 §3) | B / A |
| `asset_kind` varchar(32) | `asset_kind` varchar(20) NOT NULL(无 CHECK) | 值域已 B:代码只写 `character`/`scene`/`prop`(`script-breakdown.logic.ts:15,162-168`);直拷,长度 >20 或空或非三值 → quarantine(live 分布 C) | B(列+代码值域)C(live 分布) / A |
| `name` varchar(255) | `name` varchar(128) NOT NULL | 长度 ≤128 直拷;**>128 → quarantine,不静默截断** | B / A |
| `display_name` varchar(255) NULL | `display_name` varchar(128) NULL | ≤128 直拷;>128 → 置 NULL,原值存 `metadata.legacy_display_name` | B / A |
| `intro` / `appearance` text NULL | 同名 text NULL | 直拷 | B / A |
| `age_value` int NULL | `age_value` int NULL | 直拷 | B / A |
| `gender` varchar(64) NULL | `gender` varchar(16) NULL | 自由文本(LLM 产出,例 `'男'`,B:`script-breakdown.logic.ts:306`);长度 ≤16 直拷,否则置 NULL + `metadata.legacy_gender`;live 分布 C | B(列+代码证据)C(live 分布) / A |
| `category` varchar(255) NULL | `category` varchar(64) NULL | 同 `display_name` 超长策略;代码语义 = prop 类目 / 角色职业 / 场景内外景(B:`script-breakdown.logic.ts:308-310`) | B / A |
| `style_tags` jsonb default `'[]'` | `style_tags` jsonb NOT NULL | 校验为 string 数组;非数组/NULL → `'[]'` 并记 notes | B / A |
| `approved` bool NULL default `false`(:47) | `approved` bool NULL | 直拷(NULL 保持 NULL;代码恒写 `false`,:312) | B / A |
| `status` varchar(20) default `'active'` | `status` varchar(20) NOT NULL(我方为**审核态**:`automatic_review/pending_review/approved/rejected`,A:`migrations/007_review_domain.sql`) | **语义不同,不直拷**。建议:`approved = true` → `'approved'`;否则 `'pending_review'`;源 `status` 值存 `metadata.legacy_status`(代码只写 `'active'`,:314,B)。映射需 DC 确认 | B(列+代码值域)C(live 分布) / A |
| `reuse_scope` varchar(32) default `'all_projects'` | `reuse_scope` varchar(20) NOT NULL | 代码只写 `'all_projects'`(:313,B);≤20 直拷;其他/超长 → quarantine(live 分布 C) | B(列+代码值域)C(live 分布) / A |
| `source_project_id` uuid NULL(无 FK,**代码从不写入**) / `source_project_name` varchar NULL | `source_project_id` uuid NULL / `source_project_name` varchar(128) NULL | 直拷(我方 `source_project_id` 无 FK,语义指向 `asset_source_projects`;源 `source_project_id` 恒 NULL、只写 name,B:`script-breakdown.logic.ts:300`;原值同时进 metadata lineage) | B / A |
| `metadata` jsonb | `metadata` jsonb NOT NULL | 我方 metadata = `{ lineage: {source_system:'common', source_table:'asset_entities', source_pk, import_run_id}, legacy_metadata: <原值>, ...降级字段 }` | B / A |
| —(无 owner 列) | `owner_user_id` uuid NULL FK | 填**批准的 import owner**(data-truth §4.A);源表无 owner 概念(B) | B / A |
| —(无源) | `visibility` varchar(16) NOT NULL CHECK `(personal, common)` | 建议:`reuse_scope='all_projects'` → `'common'`,否则 `'personal'`;待 DC 确认 | — / A |
| —(无源) | `clearance` jsonb NOT NULL | 用我方保守默认 `{search:true, gen_reference:true, commercial_publish:false, model_training:false}` | — / A |
| —(无源) | `search_text` text NOT NULL | **ETL 不写**;017 触发器在 INSERT/UPDATE 时自动维护(仅 approved 人读字段) | — / A |
| —(无源) | `use_count` int NOT NULL | 默认 0 | — / A |
| —(无源) | `height_cm` / `hair_description` / `outfit_description` / `source_file_url` / `role` / `usage_mode` | 默认 NULL | — / A |
| —(无源) | `deleted_at` / `deleted_by_user_id` | 默认 NULL | — / A |
| `created_at`/`updated_at` timestamp(**无**时区,:64,:67) | `created_at`/`updated_at` timestamp(无时区) | 直拷;两侧同为 `timestamp without time zone`(001 实测),无时区换算问题 | B / A |

`asset_media` → `app.asset_media`(**决策变更:迁 → 暂缓(施工阻塞)**):

S25 实证结论(B):仓内可证列共 7 列——`id`、`media_kind`、`storage_bucket`、`storage_url`、`approved`(实体 `asset-media.entity.ts:7-20`)+ `seedance_asset_id` varchar(256)、`seedance_asset_status` varchar(32)(迁移 `1784710000000:10-12`,带部分唯一索引 :14-18 与 CHECK `('submitting','processing','active','failed')` :23-30)。**没有** `asset_entity_id` 或任何资产关联列、**没有** object key/`storage_path`、**没有** `sha256`、**没有**宽高/格式、**没有** `created_at`/`updated_at`;仓内**没有任何代码写入本表行**(只有两个 repository 的只读查询,行由仓外遗留流程产生);基表 CREATE TABLE 不在仓内(`common-schema-v1.sql:3` 自述 generation 域表另管)。

含义:v1 契约"媒体经 crosswalk 解析挂靠新实体"的设计**在现有证据下无法施工**——源行与新实体之间没有任何可解析的连接键。处理:

1. **默认路径(建议,待 DC 确认)**:本批不迁 `asset_media` 数据;资产媒体由业务侧按我方登记流程重新接入(`seedance_asset_registrations` / 上传流程),旧表只读保留。
2. **条件路径**:若 live `information_schema` 画像(§6 Q-6)发现仓外关联列或可用的 `(bucket, key)` 身份列,再回到 data-truth §4.C/§4.D 重新评估。
3. `seedance_asset_id`/`seedance_asset_status` 两列只作 lineage 参考,不构成迁移依据。

我方 `asset_variants` **无源不建**(对方无变体概念,B);后续如需变体由业务侧新建,不由 ETL 虚构。

`project_asset_refs` → `app.project_asset_refs`(S25 实证:DDL 全量 13 列,v1 契约漏 `id` PK 与 `updated_at`;`role_type` 实际存资产类别字面量,`created_at`/`updated_at` 为 **timestamptz**,:39-43):

| common 列(类型) | app 列(类型) | 转换 / 缺失默认值策略 | 证据 |
| --- | --- | --- | --- |
| `id` uuid PK(v1 契约漏列) | —(我方 PK 同 `(project_id, asset_entity_id)` 语义,见下行) | 记 crosswalk `source_pk` | B / A |
| `project_id` / `asset_entity_id` uuid | `project_id` / `asset_entity_id` uuid NOT NULL FK | 双双经 crosswalk 解析;失败 → quarantine | B / A |
| `project_name`、`asset_kind`、`role_type`(=资产类别 character/scene/prop,B:`script-breakdown.logic.ts:328`)、`role_name`、`character_name`、`usage_note`(代码从不写入,B) | `version_snapshot` jsonb NOT NULL | 无损打包进 `version_snapshot.legacy` | B / A |
| `status` varchar(20) default `'active'` | —(无 status 列;有软删) | 只迁 `'active'`(代码只写/只读 active,:331,:413,B);其余记 skip 清单(live 分布 C) | B(列+代码值域)C(live 分布) / A |
| `metadata` jsonb | — | 并入 `version_snapshot.legacy.metadata` | B / A |
| `updated_at` timestamptz(v1 契约漏列) | —(无列) | 不迁;进 `version_snapshot.legacy` | B / A |
| —(无源) | `created_by_user_id` uuid NOT NULL | import owner | — / A |
| `created_at` timestamptz | `created_at` timestamptz NOT NULL | 直拷 | B / A |
| 冲突 | 唯一 `(project_id, asset_entity_id) WHERE deleted_at IS NULL` | 重复引用 → 保留 `created_at` 最早行,其余记 conflict | B / A |

### 2.5 生成流程(结构对照备查,**历史不迁**)

源结构(B:`generation-task.entity.ts`、`generation-call.entity.ts`、`generation-output.entity.ts`;`1783941000000-align-generation-tables.ts`、`1783920000000-add-audio-generation-and-voice-tables.ts`)。本节只回答"两套模型怎么对应",**不授权任何数据搬运**(红线 R4)。S25 实证补充:v1 对照全部成立,另确认——`generation_calls` **无 `updated_at`**;`generation_tasks.created_by` 是 **varchar(128) 非 uuid**;`generation_tasks.status` 代码值域 `pending/queued/submitting/running/succeeded/failed/partially_succeeded`,**audio 流程收尾用 `'partial'` 而非 `'partially_succeeded'`**(`audio-generation.logic.ts:123` vs `image-generation.logic.ts:430`);`generation_calls.cost_status` ∈ `pending/estimated/actual`(SQL 注释另提 `adjusted`);基表 DDL 不在仓内,NOT NULL/默认值只有下界证据。

| 层级 | common(B) | v0.2.0(A) | 关键不兼容点 |
| --- | --- | --- | --- |
| 请求 | `generation_tasks`:provider/model/prompt/params/参考图 URL 全在一行;`parent_task_id`+`revision_no` 修版链;`project_shot_id` 指向旧分镜体系 | `generation_requests`:只含意图与归因;**无 provider/model/status 列**;CHECK 要求 `shot_id` 或 `target_asset_entity_id` 非空(指向我方生产体系);`client_idempotency_key`+`request_hash`+`charged_points` 无源 | 对方"任务=生命周期",我方"请求=意图/账目 + attempt=生命周期";旧 `project_shot_id` 无法解析进我方 `shots`,CHECK 直接不满足 |
| 尝试 | `generation_calls`:`call_no`/`retry_no`、成本 numeric(18,6) 元、`submit_response`/`latest_status_response` 完整供应商响应 | `generation_attempts`:`attempt_no`、成本 integer 分、`provider_response`(净化后)、轮询租约字段 | 金额单位与精度不同(元 numeric → 分 int);状态值域各自为政(对方无 CHECK 值域未知,我方 CHECK `pending/running/succeeded/failed/cancelled`);**完整 provider response 是红线字段** |
| 结果 | `generation_outputs`:`output_no`、`provider_result_url`、`result_tos_*`、`storage_status` | `media_results`:`result_index`、`provider_url`(+有效期)、`storage_*`、`persistence_status`、`review_status` | 我方 `review_status`(needs_review/accepted/rejected)与持久化状态机无源;对方 `result_media_id` 指向旧 `asset_media` |

成本口径差异(红线 R4 的实据):对方成本挂在 call 上(numeric 元、`cost_status` pending/…);我方账目是 `generation_requests.charged_points`(016 触发器维护)+ `cost_entries` UNION 视图。**迁入历史生成记录会让新旧两套成本口径混进同一账目视图,账目立即失真**——这是不迁的第一理由;状态机与 CHECK 不兼容是第二理由。

### 2.6 模型与计费:`common.model_catalog` / `model_pricing_rules` → `app.pricing_rules`

源结构(B:`model-catalog.entity.ts`、`model-pricing-rule.entity.ts`;DDL 真源 `common-schema-v1.sql:233-269`;种子 `1783942000000`、`1784633000000`)。S25 实证:

- **`model_catalog` 实体缺列持续**:实体仍只声明 8 列;DDL 另有 `metadata`/`created_at`/`updated_at`(:263-265),且种子迁移确实在写这三列(`1783942000000:17,45`、`1784633000000:34,62`)。CHECK `model_type IN ('image','video','audio','text')`(:266);UNIQUE `(model_key)`(:267)、UNIQUE `(provider_name, model_name)`(:268);FK `default_pricing_rule_id → model_pricing_rules SET NULL`(:343-344)。种子行(B):seedream image ×2、seedance video ×2、apimart image ×2、test image ×1。
- **`model_pricing_rules` DDL 比实体多 4 列**:`billing_formula`/`metadata`/`created_at`/`updated_at`(:245-248)。CHECK `status IN ('active','inactive')`(:249)、CHECK `pricing_unit IN ('token','char','sec','image','frame')`(:250)、UNIQUE `(provider_name, model_name, pricing_unit, effective_from)`(:251)——**源库已有唯一键,与下文幂等键同形,可直接复用**。
- **取价口径(代码实证,推翻 v1 猜测)**:计费读取点 = `ModelCatalogService.findActivePricing(provider, model)`(`model-catalog.service.ts:114-132`,过滤 `status='active'` + 生效窗口)。实际估价公式:**image = `fixed_fee + output_unit_price × 产出张数`**(`image-generation.logic.ts:249-250`)、**video = `fixed_fee + output_unit_price`**(`video-generation.logic.ts:180`)。**`input_unit_price` 从不参与任何计费计算;`pricing_unit` 从不被计费代码读取/分支**——它只是声明性标签。audio 流程无计费代码。

**我方缺 catalog 层**:`app` 没有模型目录表(`model_key` 只作为字符串约定出现在 `generation_default_strategies.model_key` 等处,A)。catalog 是否建表进开放问题(§6 Q-11);本契约只迁计费规则,`model_key` 随行进 metadata。

`model_pricing_rules` → `app.pricing_rules`:

| common 列(类型) | app 列(类型) | 转换 / 缺失默认值策略 | 证据 |
| --- | --- | --- | --- |
| `provider_name` varchar(64) | `provider` varchar(32) NOT NULL | ≤32 直拷;超长 → quarantine | B / A |
| `model_name` varchar(128) | `model` varchar(128) NOT NULL | 直拷 | B / A |
| —(取自 catalog) | `media_kind` varchar(16) NOT NULL CHECK `(image, video, audio)` | 按 `(provider_name, model_name)` join `model_catalog.model_type`(CHECK 四值 B);`text` → **不迁**(我方生成域不含文本计费);join 不上 → quarantine | B(结构+CHECK)C(join 数据) / A |
| `pricing_unit` varchar(20),CHECK 五值 | `billing_unit` varchar(32) NOT NULL | `image`→`image`、`sec`→`second`(我方 capability tiers 只认这两种,A:`src/modules/capability-tiers/repository.ts`);`token`/`char`/`frame` → 暂不迁(无消费方)。注意:**该列只是声明标签,计费代码从不读它**(B),映射口径因此按"我方消费方需要什么"而非"对方怎么算" | B(列+CHECK+代码证据) / A |
| `output_unit_price` numeric(18,6) | `unit_price_fen` int NOT NULL CHECK ≥0 | **唯一被计费代码使用的变量价**(B):`unit_price_fen = round(output_unit_price × 100)`;原值全量存 `metadata.legacy_prices` | B(列+代码实证) / A |
| `fixed_fee` numeric(18,6) | —(我方无"每调用平费"概念) | `= 0` → 无事;**`≠ 0` → quarantine 人工**(单行表达不了平费+变量价;原值存 `metadata.legacy_prices`) | B(列+代码实证) / A |
| `input_unit_price` numeric(18,6) | —(无列) | **代码证实从不使用**(B);不迁,原值存 `metadata.legacy_prices` 留痕 | B / A |
| `billing_formula` jsonb(DDL-only,:245) | —(无列) | 非空进 `metadata.legacy_prices.billing_formula` | B / A |
| `currency` varchar(16) default `'CNY'` | `currency` varchar(8) NOT NULL | 直拷(代码/种子均 CNY,B;live 分布 C) | B(列)C(live 分布) / A |
| `status` varchar(20) default `'active'`,CHECK 两值 | `active` bool NOT NULL | `'active'`→true,`'inactive'`→false(CHECK 值域 B) | B(列+CHECK) / A |
| `effective_from` timestamptz NULL | `effective_from` timestamptz NOT NULL | `coalesce(effective_from, 冻结时刻)`,被补值的行记 metadata | B / A |
| `effective_to` timestamptz NULL | `effective_to` timestamptz NULL(CHECK > from) | 直拷;越界 → quarantine | B / A |
| —(无源) | `source` varchar(512) NOT NULL | 常量 `'legacy:common.model_pricing_rules'` + 源行 uuid | — / A |
| —(catalog) | `metadata` jsonb NOT NULL | `{ legacy_model_key, legacy_rule_id, legacy_prices: {input_unit_price, output_unit_price, fixed_fee, billing_formula?}, import_run_id }` | B / A |
| 幂等 | (无唯一索引,A) | ETL 以 `(provider, model, media_kind, billing_unit, effective_from)` 做 `WHERE NOT EXISTS` 幂等(与源 UNIQUE `(provider_name, model_name, pricing_unit, effective_from)` :251 同形);建议实现包评估补唯一索引(决策) | B / A |

### 2.7 剧本与分镜提示词

**剧本域(暂缓)**:`common.scripts`(B:`script.entity.ts` + `1783930000000-add-scripts.ts` DDL:status CHECK `(active, archived, deleted)`、FK→`common.projects` cascade;`1784632000000:43-69` 新增 `source_import_id` uuid NULL + FK→`script_imports` SET NULL + 部分唯一索引 `(project_id, episode_no) WHERE status='active' AND episode_no IS NOT NULL` :91-94;注意 `source` 列默认值实体 `'script_breakdown_api'` 与迁移 `'manual'` 不一致)与 `common.script_breakdown_runs`(B:`script-breakdown-run.entity.ts`,基表 DDL 仓外:run_type 代码值域 `'assets'/'storyboards'`、status `'processing'/'succeeded'/'failed'`、`input_snapshot`、`output_summary`)。我方 **001–021 无正式等价**;S4 提案(`docs/proposals/script-breakdown-port.md` §2.3:`episode_script_versions` / `script_breakdown_runs` / `script_breakdown_revisions`)**未经 DC/Fable 冻结**,且其新结构与旧表并非简单改名。决策前旧表只读,不迁。

`common.script_imports`(S25 补登记,B:`script-import.entity.ts` + `1784632000000:9-42`):**存在性已证实**,13 列——`id`、`project_id`(FK cascade)、`title`、`original_text`、`preamble_text`、`episode_count`(CHECK ≥0)、`parser_version`(live 恒 `'rule-v2'`,`episode-parser.service.ts:25`)、`status` CHECK `('processing','completed','failed')`、`error_message`、`metadata`、`created_by`(FK→users SET NULL)、`created_at`、`updated_at`。每次导入写一行审计记录,分集结果落成 `scripts` 新版本(`source='episode_split'` + `source_import_id` 回链,`script-imports.service.ts:83-114`)→ 随剧本域一并**暂缓**,不单独迁移。

**分镜提示词(迁)**:`common.project_director_storyboard_prompts`(B:`storyboard.entity.ts`;`1784631000000` 新增 `script_id`/`breakdown_run_id` 两列 + FK SET NULL + 两索引,v1 契约"到 sound_instruction 为止"的列清单已过时)+ `common.project_prompts`(B:`project-prompt.entity.ts`;同迁移新增同样两列)→ `app.shots` 三类提示词字段(A:`migrations/001`)。

> ⚠️ **同名表警告**:我方 `app` schema **也有** `project_director_storyboard_prompts`(001 建的兼容表,服务我方 director 导入流水线,列集不同——多 `sound_effect`/`user_id`/`result_media_id`/`reference_file_url`/`storyboard_file_url`)。ETL 目标是 **`shots`**,严禁把 common 同名表数据灌进 app 同名兼容表。

前置:项目 crosswalk 已完成;episode 解析——`(新 project_id, episode_no)` 查 `app.episodes`;不存在时的策略(自动建 `episode_no` 对应 episode / 拒绝)**待 DC 决策**(建议自动建,`sort_order = episode_no`、`status='active'`);`episode_no` 为 NULL → quarantine。

| common 列(类型) | app.shots 列(类型) | 转换 / 缺失默认值策略 | 证据 |
| --- | --- | --- | --- |
| `shot_no` int NULL | `shot_code` varchar(64) NOT NULL + `sort_order` int NOT NULL | 建议 `shot_code = 'G' || lpad(shot_no::text, 2, '0')`(S4 建议格式);`sort_order = shot_no`;NULL/重复/冲突唯一索引 `(episode_id, shot_code)` → quarantine/人工 | B / A |
| `director_prompt_text` text NULL | `director_prompt` text NULL | 直拷 | B / A |
| `project_prompts.prompt_type` + `prompt_text` | `image_prompt` / `video_prompt` text NULL | **值域已实证(B,推翻 v1 猜测)**:实际写入只有 `'storyboard_image'` 与 `'shot_video'`(`script-breakdown.logic.ts:380-383`)——`'storyboard_image'`→`image_prompt`、`'shot_video'`→`video_prompt`;**链接键优先用 `metadata.project_director_storyboard_prompt_id`**(prompt 行 metadata 回链 storyboard 行 id,B:`script-breakdown.logic.ts:396-399`),退化方案才按 `(project_id, episode_no, shot_no)` 对齐;同镜头同类型多条 → 取 `updated_at` 最新,其余记 conflict;live 出现其他 prompt_type → quarantine | B(列+代码值域)C(live 分布) / A |
| `shot_description` text NULL | `title` varchar(255) NULL | ≤255 直拷,超长截断进 conflict 清单 | B / A |
| `scene_name` varchar NULL | —(无列) | 建议拼入 `director_prompt` 首行「场景:xxx」;**不自动建 `scenes`**(无场号),决策待确认 | B / A |
| `camera_movement` / `lighting` varchar、`sound_instruction` text | —(无列) | 建议结构化追加到 `director_prompt` 尾部(「运镜:…」「灯光:…」「声音:…」);决策待确认。实证:`lighting` 代码从不写入(恒 NULL,B);`camera_movement` 实际写的是 video_prompt 文本、`sound_instruction` 写的是 narration(:362-378) | B / A |
| `script_id` / `breakdown_run_id`(1784631000000 新增) | —(无对应) | 不迁;进 crosswalk `notes`(供剧本域决策后回查) | B / A |
| —(无源) | `script_text` / `duration_seconds` / `reference_asset_snapshots` / `selected_*_result_id` | 默认 NULL / `'[]'` | — / A |
| `status`(代码只写 `'active'`,:375,B)、`metadata`(含 shot_type/duration_sec/line_indices/character_names/scene_names/prop_names/video_prompt,:351-361,B)、`project_name`、`created_at`/`updated_at`(timestamp **无时区**,storyboard.entity.ts:51,:54) | — | 不进 `shots`;lineage 记 crosswalk(源行 uuid) | B / A |

注:对方该表现有 17 列(含 `script_id`/`breakdown_run_id`);`sound_effect`/`user_id`/`user_name`/`result_media_id`/`reference_file_url`/`storyboard_file_url` 只存在于**我方**同名兼容表(A),不是源列,不参与映射。`project_prompts` 时间为 timestamptz(B)。

### 2.8 语音(不迁)

`common.audio_voices`(B:`audio-voice.entity.ts` + `1783920000000:13-37` 全量 DDL,18 列,UNIQUE `(provider, voice_id)` :35;代码值域:`voice_type` premade/cloned、`clone_type` ivc、`visibility` public/private、`status` ready/processing/disabled、`provider` elevenlabs):音色注册表,我方 001–021 **无对应表**(020 只开放了 `media_kind='audio'`,未建音色表)→ 不迁,是否资产化进开放问题(§6 Q-12)。`common.voice_clone_tasks`(B:`voice-clone-task.entity.ts` + `1783920000000:38-56`,15 列):生成任务类 + 含 `provider_response` jsonb 红线字段(代码实证写入原始供应商响应,`voice-clone.logic.ts:55`)→ 不迁。

### 2.9 manhua 蓝图差异登记(纯 C,不施工)

manhua 蓝图(`manhua-cli-agentkit-schema-v1.sql`)与他们源码 live 对应的关键分歧,登记备查(S25 已用 `a2e06dd` 复核,分歧不变):

| 蓝图(C) | live 对应(B,`a2e06dd`) | 分歧 |
| --- | --- | --- |
| `manhua_users.current_team_id` | `common.users.current_organization_id` | 归属维度不同(团队 vs 组织) |
| `manhua_teams/team_members` | `common.organizations/organization_members` | 命名与角色值域不同 |
| `manhua_generation_intents`(意图表) | 无 | live 无意图层 |
| `manhua_generation_tasks/attempts/artifacts` | `generation_tasks/calls/outputs` | 重新设计,非同构 |
| `manhua_review_decisions`、`manhua_cost_records`、`manhua_cost_allocations`、`manhua_index_records`、`manhua_ledger_events`、`manhua_permission_policies`、`manhua_project_metrics` | 无(**注意**:`common` 侧另有 `permission_policies` 与 `project_metrics` 两张同名实体表,见 §2.10,与蓝图这两张并非同一物) | live 源码中不存在蓝图版本 |
| `manhua_model_catalog/model_pricing_rules` | `common.model_catalog/model_pricing_rules` | 近似,live 确有 `billing_formula` 列(DDL-only,`common-schema-v1.sql:245`) |

结论:蓝图是"AgentKit 目标设计",不是 live 现状证据。若 live 库里真存在 `manhua_*` 表(落过蓝图),其生成/成本/审核历史同样适用红线 R4;是否存在,进 §6 Q-1。另:他们仓内的 `public.manhua_users/manhua_user_credentials/manhua_organizations` 是 legacy 未注册实体(§0),与蓝图 18 表也不是同一套。

实体缺列实例(证明"实体 ≠ live 全部列",S25 复核仍在):`1783942000000` 种子迁移向 `common.model_catalog` 写 `metadata`/`updated_at`,而 `model-catalog.entity.ts` 至今未声明这两列(B)。同类缺列已遍布 common 各表(users.metadata、projects.budget_*、model_pricing_rules.billing_formula 等,见各节)——因此所有 B 级列集都以 **DDL/迁移为准**,实体只作下界。

### 2.10 S25 新发现表登记(v1 契约未覆盖)

对他们 libs 全部域(auth / users / projects / assets / generation / models / scripts / system / common / config / infrastructure)逐域扫描后,v1 契约之外补登记 3 张表(`libs/auth`、`libs/system`、`libs/config` 无任何实体,B):

| 表 | 结构证据(B) | 决策 | 理由 |
| --- | --- | --- | --- |
| `common.file_uploads` | 6 列:`id`、`organization_id`、`created_by`、`public_url` varchar(2048)、`file_type` default `'image'`、`created_at`;迁移 `1784720000000:9-18` 全量 DDL | **不迁**(R13) | 上传行为历史记录,我方无对应表;URL 本身仍可从 TOS 侧重新登记,不构成业务事实损失 |
| `common.permission_policies` | 13 列,`common-schema-v1.sql:152-167`,CHECK `scope_type IN ('module','api','button','data','field')`;**无任何实体映射** | **不迁**(R11) | 资源-动作权限细则,与我方二元模型不同构(§2.2) |
| `common.project_metrics` | 11 列计数器,`common-schema-v1.sql:193-205`,PK `project_id` FK cascade;**无任何实体映射、仓内无代码读写** | **不迁**(R13) | 派生计数器(生成次数/预算快照/最近活动),可由源事实重算,无独立迁移价值;`budget_*` 快照如需保留随 §2.3 projects 的 notes 口径 |

另登记:**`common.projects` 的 FK**(`owner_user_id`/`owner_organization_id` 均 RESTRICT,`common-schema-v1.sql:328-332`)与 **`user_roles.project_id` FK→projects cascade**(:316-317)已在相应章节吸收。

---

## 3. crosswalk 设计(「他们的 id ↔ 我们的 id」)

用户和项目**不做同名表 ALTER**;身份对应关系落独立 crosswalk 表。设计如下(**S25 已做成迁移 024**,表落 `app` schema,并新增 ETL 运行记录表;本节保持设计口径):

```sql
CREATE TABLE IF NOT EXISTS {{schema}}.legacy_identity_crosswalk (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system     varchar(32)  NOT NULL,            -- 本批固定 'common'
  source_schema     varchar(64)  NOT NULL,            -- 'common'
  source_table      varchar(64)  NOT NULL,            -- 'users' / 'projects' / 'asset_entities' / ...
  source_pk         text         NOT NULL,            -- 源主键文本(text 兼容非 uuid 源键)
  target_table      varchar(64)  NOT NULL,
  target_id         uuid,                             -- conflict/quarantined 时必为 NULL
  match_rule        varchar(32)  NOT NULL,            -- manual_confirmed / deterministic_key / content_hash / import_new
  decision          varchar(16)  NOT NULL,            -- matched / new / conflict / quarantined
  import_run_id     uuid         NOT NULL,
  decided_by_user_id uuid,                            -- manual_confirmed 时必填
  decided_at        timestamptz  NOT NULL DEFAULT now(),
  notes             text,                             -- 降级字段、旧标识(email/project_code 等)、人工裁断依据
  created_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT legacy_crosswalk_decision_check
    CHECK (decision IN ('matched', 'new', 'conflict', 'quarantined')),
  CONSTRAINT legacy_crosswalk_match_rule_check
    CHECK (match_rule IN ('manual_confirmed', 'deterministic_key', 'content_hash', 'import_new')),
  CONSTRAINT legacy_crosswalk_target_consistency_check
    CHECK ((decision IN ('matched', 'new') AND target_id IS NOT NULL)
        OR (decision IN ('conflict', 'quarantined') AND target_id IS NULL))
);
CREATE UNIQUE INDEX ... ON ... (source_system, source_schema, source_table, source_pk);
CREATE UNIQUE INDEX ... ON ... (source_system, target_table, target_id) WHERE target_id IS NOT NULL;
CREATE INDEX        ... ON ... (import_run_id);
```

使用规则:

- **users / projects 只允许 `match_rule = 'manual_confirmed'`**(data-truth §3 已定:不自动合并身份),`decided_by_user_id` 必填;匹配输入 = `login_name`/`display_name`/`email`(记 notes),批量自动建议只能产"候选",不落 matched。
- **资产**可用 `deterministic_key`(同 `(bucket, object_key)` 且内容一致)/ `content_hash`(sha256 相同);名称/标签/向量相似只能进人工候选(data-truth §4.D)。
- `decision` 四值与 data-truth §4.D 的验收公式对齐:`source = matched + new + conflict + quarantined`,每条源记录**有且仅有一行** crosswalk(唯一索引保证)。
- crosswalk 只记身份与决策,**不存凭据、不存 PII 超集**;notes 里的旧标识只为人工复核服务。
- 表设计刻意通用(users/projects/assets/未来域共用),避免每个域再起一套账本。

## 4. ETL 规格

### 4.0 通用规则(每表适用)

- **账号与窗口**:读 `common` 用 `readonly`;写 `app` 走获批维护窗口(migrator/专项账号);窗口内冻结旧 writer,写前有 `available` 手工快照(data-truth §4.A 硬闸门全适用)。
- **迁移单位**:**实体闭包,不是表**(DC 定的方向)。迁"一个项目" = 项目行 + 授权成员 + 资产引用 + 引用到的资产实体 + 分镜提示词,作为一个闭包一起迁、一起校验、一起回滚;**绝不先把 projects 全表迁完再迁 assets**。全局顺序只是闭包依赖的拓扑序(用户 crosswalk → 项目闭包 → 计费规则),同一闭包内成功/失败/回滚同生共死。
- **批次**:每表一个 `import_run_id`;每 N 行一个事务(建议 500,实现包可调);任一约束/计数/哈希检查失败 → **回滚该批并停止后续批次**。实体闭包粒度下,"批"= 一组闭包;单个闭包失败只回滚该闭包事务,记入运行记录表,不阻塞其他闭包(实现见 `scripts/legacy-merge-etl/`)。
- **顺序**:`users crosswalk(人工) → 项目闭包[projects(+owner project_members) → project_access_grants → project_asset_refs → asset_entities(被引用闭包) → 分镜提示词(待 §2.7 决策)] → pricing_rules`。`asset_media` 移出顺序(§2.4 决策变更,施工阻塞)。Milvus 重建永远排在 PostgreSQL 验证之后(data-truth §5)。
- **不双写**:迁移期间旧系统对 common 的写入必须冻结;冻结前跑只读 delta 审计。
- **回滚单元**:单闭包失败 = 回滚该闭包事务;已提交闭包的撤销 = 按 crosswalk 反查删除该闭包写入的目标行(同事务删 crosswalk 行),粒度到闭包;已切流后回滚 = 停 writer、记录 delta、切回旧 schema,人工对账(data-truth §6.1);**绝不跑 TypeORM `down()`**。

### 4.1 users(crosswalk 先行)

- 抽取:`common.users` 全量(剔除 `status='deleted'`;值域 `active/disabled/deleted` 已 B,`common-schema-v1.sql:22`)。
- 转换:见 §2.1;`password_hash` = 哨兵;`role` 默认 `member`。
- 幂等键:crosswalk `(source_table='users', source_pk)` 唯一 + `app.users.lower(username)` 唯一。
- 冲突:username 不合法/重复 → 人工队列;不自动改名合并。
- 回滚:删除该批 `app.users` + crosswalk 行(同事务)。
- 校验 SQL 形状:

```sql
-- 守恒:源行数 = 四种 decision 之和
SELECT count(*) FROM common.users;                                  -- 源(只读)
SELECT decision, count(*) FROM app.legacy_identity_crosswalk
 WHERE source_table='users' AND import_run_id = :run GROUP BY 1;   -- 决策
-- 落库一致:matched+new 行数 = 本批 app.users 行数,且每行口令都是哨兵
SELECT count(*) FROM app.users u
 JOIN app.legacy_identity_crosswalk x ON x.target_id = u.id AND x.target_table='users'
 WHERE x.import_run_id = :run;
SELECT count(*) FROM app.users u
 JOIN app.legacy_identity_crosswalk x ON x.target_id = u.id AND x.target_table='users'
 WHERE x.import_run_id = :run AND u.password_hash NOT LIKE '<哨兵前缀>%';   -- 必须 = 0
```

### 4.2 projects + project_members(+access_grants)

- 抽取:`common.projects`;`project_access_grants` 按 §2.3 条件。
- 幂等键:crosswalk 唯一 + `app.projects (owner_user_id, lower(name))` 活跃唯一。
- 冲突:owner 无法解析 → conflict 不迁;名称冲突 → 人工;members 重复 → 保留高权限。
- 校验 SQL 形状:

```sql
-- FK 无孤儿( members → projects/users )
SELECT (SELECT count(*) FROM app.project_members m
         LEFT JOIN app.projects p ON p.id = m.project_id WHERE p.id IS NULL) AS orphan_project,
       (SELECT count(*) FROM app.project_members m
         LEFT JOIN app.users u ON u.id = m.user_id WHERE u.id IS NULL) AS orphan_user;   -- 全 = 0
-- 每项目恰一个 owner
SELECT project_id FROM app.project_members WHERE role='owner'
 GROUP BY 1 HAVING count(*) <> 1;                                    -- 必须空集
```

### 4.3 asset_entities / project_asset_refs(`asset_media` 移出,见 §2.4 决策变更)

- 抽取:entities 全量;refs 只取 `status='active'`(代码实证只写/只读 active,B)。`asset_media` **不抽取**(仓内证据下无法挂靠实体,§2.4;待 live 画像再议)。
- 转换:见 §2.4;**去重与身份判定严格按 data-truth §4.D 五档优先级**;名称/标签/向量相似只进人工候选。
- 幂等键:entities = crosswalk;refs = `(project_id, asset_entity_id)` + crosswalk 源行 uuid。
- 冲突:同 legacy ID 指向不同对象、缺 lineage → `conflict/quarantined`,不猜合并。
- 校验 SQL 形状:

```sql
-- 守恒(含 data-truth §4.D 验收公式)
SELECT decision, count(*) FROM app.legacy_identity_crosswalk
 WHERE source_table IN ('asset_entities','project_asset_refs') AND import_run_id = :run GROUP BY 1;
-- refs → 项目/实体 无孤儿
SELECT count(*) FROM app.project_asset_refs r
 LEFT JOIN app.projects p ON p.id = r.project_id
 LEFT JOIN app.asset_entities e ON e.id = r.asset_entity_id
 WHERE p.id IS NULL OR e.id IS NULL;                                -- 必须 = 0
-- 抽样字段一致(每次跑固定 50 行样本)
SELECT x.source_pk, e.name, e.created_at FROM app.asset_entities e
 JOIN app.legacy_identity_crosswalk x ON x.target_id = e.id AND x.target_table='asset_entities'
 WHERE x.import_run_id = :run ORDER BY x.source_pk LIMIT 50;         -- 与 common 源行逐字段比对
```

### 4.4 分镜提示词 → shots(待 §2.7 决策后施工)

- 链接规则(实证修正):`project_prompts` 行**优先按 `metadata.project_director_storyboard_prompt_id` 回链** storyboard 行(B);退化才按 `(project_id, episode_no, shot_no)` 三元组对齐。`prompt_type` 只认 `'storyboard_image'`→`image_prompt`、`'shot_video'`→`video_prompt`(B);其他值 → quarantine。
- 幂等键:`(episode_id, shot_code)` 活跃唯一 + crosswalk 源行 uuid。
- 冲突:shot_code 重复、episode 无法定位、prompt 多条 → conflict/quarantine。
- 校验:每迁入镜头必有 `director_prompt` 或 `image_prompt`/`video_prompt` 至少其一非空;`shots` 数 ≤ 源 storyboard 行数(多条 prompt 合并);孤儿检查(`shots.episode_id → episodes`)。

### 4.5 pricing_rules

- 转换(实证修正):`unit_price_fen = round(output_unit_price × 100)`;`fixed_fee ≠ 0` → quarantine 人工(平费无法单行表达);`input_unit_price` 只留痕(代码证实不用,B)。详见 §2.6。
- 幂等键:`(provider, model, media_kind, billing_unit, effective_from)` 的 `WHERE NOT EXISTS`(目标侧无唯一索引,A;源侧同形唯一键已 B,`common-schema-v1.sql:251`)。
- 校验:迁后 `active` 规则数 ≤ 源 `status='active'` 行数;逐行抽核 `unit_price_fen = round(源 output_unit_price × 100)`;`media_kind` 全在 `(image, video, audio)`;quarantine 行逐条有人工结论。

### 4.6 全局账目隔离校验(证明"生成历史没迁")

```sql
SELECT count(*), coalesce(sum(charged_points),0) FROM app.cost_entries;   -- 窗口前后两快照必须完全一致
SELECT count(*) FROM app.generation_requests;                              -- 窗口前后必须一致(本包不迁生成)
```

## 5. 不迁清单(红线 + 理由 + 检测方式)

| # | 对象 | 理由 | 检测方式 |
| --- | --- | --- | --- |
| R1 | `common.user_credentials`、`public.manhua_user_credentials`(密码 hash) | **凭据绝不复制**。算法/参数不可混用(我方 scrypt N=16384/r=8/p=1,A:`src/modules/auth/service.ts`;对方 `password_algorithm` 值域未知);复制即放大撞库与内部滥用面 | ETL 列白名单代码审查(不含任何 password 列);迁后 `app.users` 本批口令 100% 为哨兵(§4.1 SQL);`common` 侧只读权限复核 |
| R2 | `common.user_sessions`(refresh token hash) | 会话 token 不可移植——移植等于把旧系统的会话劫持面搬进新系统;新旧 token 格式/哈希语义不兼容 | 迁移窗口内 `app.sessions` 增量 = 0:`SELECT count(*) FROM app.sessions WHERE created_at BETWEEN :freeze AND :unfreeze;` |
| R3 | provider secret / 完整 provider response(`generation_calls.request_payload/submit_response/latest_status_response`、`generation_tasks.original_request_payload`、`voice_clone_tasks.provider_response`、`seedance_asset_tasks.create_response/status_response`——S25 全部 B 级实证存在且代码确实写入原始响应) | 可能含签名 URL、临时密钥、供应商内部字段;我方设计只允许**净化后**摘要(我方 `seedance_asset_registration_attempts` 注释明确"no raw provider body",A) | 不迁生成历史使该红线天然成立(R4);额外检测:ETL 源码 grep 上述列名应为 0 命中;`app` 各 jsonb 列抽查不含 `submit_response`/`latest_status_response`/`create_response`/`status_response` 键 |
| R4 | 历史生成记录(`generation_tasks/calls/outputs`) | 生命周期模型不兼容(task/修版链 vs request+attempt,§2.5);成本口径不同(元 numeric vs 分 int + charged_points 账目),**迁入即污染 `cost_entries` 账目**;CHECK(target 非空)无法满足 | §4.6 账目隔离校验;`app.generation_*`/`media_results` 行数窗口内不变 |
| R5 | `project_prompts` 作为第二套正式事实 | `shots` 是提示词唯一真源;旧表只作为 ETL 源并入 `shots` 字段,不得作为 live 表存在 | `app` schema 表清单中不存在 `project_prompts`:`SELECT count(*) FROM information_schema.tables WHERE table_schema='app' AND table_name='project_prompts';` = 0 |
| R6 | TypeORM `down()` 回滚脚本(含 drop table/column) | 回滚手段是"批次事务回滚 + 快照恢复到**新实例**",不是反向跑破坏性 DDL(data-truth §6.1) | 任何执行窗口的命令清单审查,不含 `migration:revert`/`down()`;旧表只允许只读化 |
| R7 | TypeORM 迁移账本 ↔ `app.schema_migrations` | **两套账本必须分开**;伪造"已应用"记录会废掉 `migrate.ts` 的 checksum 防漂移(A:`src/db/migrate.ts:79-82`)。S25 实证:对方账本 = **默认 `public.migrations`**(`data-source.ts:5-17` 无 `migrationsTableName`,全仓无该配置),`common-schema-v1.sql` 手工 DDL 不入账 | `app.schema_migrations` 行数恰 = 本地迁移文件数,且逐行 checksum 与文件 SHA-256 `match`;无任何 version 不在文件清单内 |
| R8 | `scripts` / `script_breakdown_runs`(暂缓期) | 无冻结等价;S4 提案未决 | `app` 无同名表;旧表只读 |
| R9 | `audio_voices` / `voice_clone_tasks` | 无对应表(音色表);克隆任务属生成历史类且含红线字段 | `app` 无对应表 |
| R10 | `public.manhua_users / manhua_organizations`(另一套 API) | 非 `common` 迁移源;仅作身份匹配参考 | 其不出现在任何 ETL 抽取 SQL 中 |
| R11 | 组织/角色/权限细则(`organizations`、`roles`、`permissions`、`role_permissions`、`user_roles`、`organization_members`、`permission_policies`——S25 补登记) | 权限模型不同构(资源-动作 vs 平台角色+项目成员),机械映射必然错权 | `app.teams/team_members` 在组织决策前保持空(或仅 Day-0 数据) |
| R12 | PII 与外部身份(`email`、`auth_subject_id`、`ip_address`、`user_agent`) | 我方无对应列;PII 最小化 | ETL 列白名单审查;crosswalk `notes` 只允许人工匹配所必需的最小标识 |
| R13 | 行为历史与派生计数(`file_uploads`、`project_metrics`——S25 补登记) | 上传行为历史我方无对应表;`project_metrics` 是可由源事实重算的派生计数器(仓内无代码读写),迁入只会带进口径不明的快照数字 | 两张表不出现在任何 ETL 抽取 SQL 中;`app` 无对应表 |

## 6. 开放问题清单(S25 已用 `a2e06dd` 源码核销一批;剩余问题交 Fable)

| # | 问题 | S25 状态 | 拿到什么就能定 |
| --- | --- | --- | --- |
| Q-1 | live `common` 全表清单与逐表列结构;`script_imports`、`seedance_asset_tasks`、`manhua_*` 蓝图表是否真的存在 | **部分核销**:`script_imports`/`seedance_asset_tasks` 存在性已 B(迁移 `1784632000000`/`1784630000000`);`manhua_*` 蓝图表是否落库仍未知 | live `information_schema.tables/columns` 只读导出(readonly 账号即可) |
| Q-2 | 所称 2071 资产 / 23 项目 / 338 生成任务的真实行数;"259 条既有云资产"的来源表与字段画像 | **仍开放**(行数是 live 数据,源码证不了) | 只读计数与字段画像结果(data-truth §4.C 清单) |
| Q-3 | 各状态/类型列的值域 | **大部分核销(B 级)**,证据 = CHECK/代码字面量:`users.status`(CHECK :22)、`projects.status`(CHECK :188)、`project_access_grants.role_type`(代码 owner/admin/collaborator/viewer)、`project_prompts.prompt_type`(代码 storyboard_image/shot_video)、`model_pricing_rules.pricing_unit`+`status`(CHECK :249-250)、`model_catalog.model_type`(CHECK :266)、`asset_entities.asset_kind/reuse_scope/status`(代码写入值)、`organization_members.member_role`(CHECK :59)。**live 实际数据分布仍 C**(代码不写≠库里没有) | live `SELECT DISTINCT` 结果(去敏) |
| Q-4 | live 系统源码是否已领先 `53a3d6d` | **已核销**:当前检出 `a2e06dd` = `53a3d6d` + 19 个提交(祖先关系已验证);本契约全部 B 级证据已按 `a2e06dd` 重锚 | 后续若外部仓再更新:新提交哈希 + 差异评审 |
| Q-5 | TypeORM 迁移账本表名/schema/已应用清单 | **已核销(结构)**:无 `migrationsTableName` 配置 → 默认 `public.migrations`(`data-source.ts:5-17`);`common-schema-v1.sql` 手工 DDL 不入账。**已应用清单仍 C** | live 账本表内容只读导出 |
| Q-6 | `common.asset_media` 全列集:是否有 `asset_entity_id`、object key、`sha256`、尺寸、创建时间 | **已核销(仓内否定)**:已知 7 列,无关联列/key/hash/尺寸/时间戳;无代码写行;基表 DDL 仓外 → §2.4 决策变更。**live 是否还有仓外列仍 C** | live 列结构 + 空值率画像 |
| Q-7 | `timestamp without time zone` 列的写入会话时区 | **仍开放**(源码无 DB 连接 TimeZone 设置证据) | 旧服务 DB 连接 `TimeZone` 设置/服务器时区证据 |
| Q-8 | `common.model_catalog` live 是否有 `metadata`/`created_at`/`updated_at` | **已核销**:DDL 有三列(`common-schema-v1.sql:263-265`),实体至今缺列;种子迁移确实在写(B) | —(live 最终核对随 Q-1) |
| Q-9 | 用户 crosswalk 的匹配键质量:`login_name`/`email`/`auth_subject_id` 空值率与重复率 | **部分核销**:`login_name`/`auth_subject_id` 有 UNIQUE 约束(B),重复率担忧消解;**空值率仍 C** | live 画像(空值/重复计数,去敏) |
| Q-10 | `projects.owner_team_id` / `organizations` 是否被实际使用 | **部分核销**:`owner_team_id` 实体 NOT NULL + seed 写入(B),但 schema SQL 未列(陈旧)、无 FK;live 空值率与产品语义仍 C | live 空值率 + 他们产品语义确认 |
| Q-11 | 模型 catalog 层是否进 v0.2.x(建表 or 维持 metadata 携带) | **仍开放**(产品/架构决策;live catalog 行数作输入) | DC/Fable 决策记录 |
| Q-12 | 语音音色(`audio_voices`)是否资产化进 v0.2.x 计划 | **仍开放**(产品决策) | DC 决策 + live 行数 |

**需 DC 拍板(不需要他们源码,随本契约一并提交)**:`scripts` 域是否按 S4 提案立项;§2.4 资产 `status/visibility` 映射口径与 `asset_media` 默认路径(不迁数据、业务侧重新登记);§2.7 episode 自动创建与导演提示词拼接格式;迁移用户口令重置流程与哨兵格式;import owner 与 reviewer 人选(data-truth §4.A)。

## 7. 原契约错误(S25 实证推翻/纠正 v1 条目,逐条登记)

> 契约写错比契约缺失更危险——照着错契约做 ETL 会静默产生错数据。以下逐条说明 v1 怎么写的、`a2e06dd` 实证是什么、影响哪些迁移动作。v1 中这些条目多数本就标 C(猜测),但 §2.1/§2.3/§2.4 的列集遗漏是以"完整列清单"形态写出的,错误性质更重。

| # | v1 原文(位置) | 实证(`a2e06dd`) | 影响的迁移动作 |
| --- | --- | --- | --- |
| E1 | `project_prompts.prompt_type` 猜 `'image'`→`image_prompt`、`'video'`→`video_prompt`(§2.7) | 实际只有 `'storyboard_image'`/`'shot_video'` 两值(`script-breakdown.logic.ts:380-383`,B) | §2.7 映射规则已修正;§4.4 链接规则改用 `metadata.project_director_storyboard_prompt_id` 优先回链。若按 v1 施工,**所有 prompt 行都会掉进 quarantine 或被错误丢弃** |
| E2 | `project_access_grants.role_type` 建议映射按 `project_owner`/`project_admin`/`collaborator`/`viewer` 猜测(§2.3) | 实际值域 `owner`/`admin`/`collaborator`/`viewer`(`project-access.service.ts:49-51,185`,B) | §2.3 映射表已重写;`owner` 行与 projects 自动 owner 行的去重规则已补。若按 v1 施工,**全部 grant 行都会落入人工队列** |
| E3 | 取价规则猜"image/frame 用 `fixed_fee`,sec 用 `output_unit_price`;input≠output 且非零 → quarantine"(§2.6) | 计费代码实际公式 `fixed_fee + output_unit_price × 数量`(image)/ `fixed_fee + output_unit_price`(video);**`input_unit_price` 从不使用、`pricing_unit` 从不读取**(`image-generation.logic.ts:249-250`、`video-generation.logic.ts:180`,B) | §2.6 已重写:`unit_price_fen = round(output_unit_price×100)`;`fixed_fee≠0` → quarantine;`input_unit_price` 只留痕。若按 v1 施工,**图片规则会错用 fixed_fee 当单价、含 input 价的规则被误杀** |
| E4 | `common.users` 列集 10 列(§2.1) | DDL 实际 11 列,多 `metadata jsonb NOT NULL DEFAULT '{}'`(`common-schema-v1.sql:19`);另有 UNIQUE `(login_name)`/`(auth_subject_id)` 与 status CHECK 未登记 | §2.1 已补列与约束;`metadata` 落 crosswalk notes 口径已补。v1 漏列是"照实体抄表"所致——**实体是子集映射** |
| E5 | `common.projects` 列集 10 列(§2.3) | DDL 另有 `budget_amount`/`budget_spent_amount`/`budget_remaining_amount`、`cover_image_url`、`start_time`/`end_time`、`metadata`(:177-185);`status` 默认 `'draft'` 非 `'active'`;`project_code` UNIQUE | §2.3 已补 7 列的处置(不迁入正式列,进 crosswalk notes);status 默认值已修正。若按 v1 施工,**预算与封面等字段会被静默丢弃且无登记** |
| E6 | `project_asset_refs` 列集 11 列(§2.4) | 实际 13 列,漏 `id` PK 与 `updated_at`;`role_type` 实存资产类别字面量 | §2.4 已补;`id` 记 crosswalk `source_pk`、`updated_at` 进 `version_snapshot.legacy` |
| E7 | storyboard 表"到 `sound_instruction` 为止"(§2.7 注) | `a2e06dd` 新增 `script_id`/`breakdown_run_id` 两列 + FK(`1784631000000`,B) | §2.7 列清单已更正(17 列);不影响映射目标(新列只进 crosswalk notes) |
| E8 | `script_imports`/`seedance_asset_tasks`"pinned 源码中不存在,存在性未证实"(§1) | `a2e06dd` 已建两表(迁移 `1784632000000`/`1784630000000`,B),结构完整登记(§2.7/§1) | `script_imports` 随剧本域暂缓;`seedance_asset_tasks` 不迁数据。非"v1 写错",是 pinned 提交过时——**根源是 Q-4,已核销** |
| E9 | `asset_media` 决策"迁(全结构 C,先核实)",并预设"若有资产关联列则经 crosswalk 挂靠"(§1/§2.4) | 仓内证据:7 列、**无关联列、无 key/hash/尺寸/时间戳、无代码写行**(B);基表 DDL 仓外 | §1/§2.4 决策变更为**暂缓(施工阻塞)**,默认路径 = 不迁数据、业务侧重新登记。若按 v1 施工,**ETL 会在媒体挂靠步骤整体失败或静默产出无挂靠媒体** |

## 8. 边界回执

- S19(v1):只新增本文档;未写代码、迁移文件、测试夹具;未连任何数据库;未读/写 `common` 或 `app` 的任何数据;未 push、未部署、未触发付费动作。
- S25(v2):本文档按 `.worktrees/their-nestjs`(**只读**,检出 `a2e06dd`)逐条实证化;新增迁移 `migrations/023_legacy_merge_etl.sql`(crosswalk + ETL 运行记录表)与 `scripts/legacy-merge-etl/`(dry-run 默认);**未连云库、未执行任何真实数据迁移、未修改 their-nestjs 任何文件**;B 级证据全部可复验(文件路径 + 行号,见各节引用)。
- 本文所有"建议/待确认"项都不是施工授权;施工授权只能来自 Fable 对本契约的验收 + §6 剩余开放问题的证据补齐。

<!-- S19-DONE -->
<!-- S25-VERIFIED -->

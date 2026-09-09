# 运营底座合同(v0.2.0 P0,2026-07-23 起草)

背景:测试环境已部署(shortdrama-main-test.col.com)但无账号体系没法开放。
DC 需求原文五条(成本归属不清/成本感知不足/创作能力不完整/误删风险/权限体系
不足,存档 outputs/inspiration-digest-20260723.md 条 35)。本合同覆盖其中
①②⑤+管理后台;③创作能力由声音工坊一期与 AI 底座(#28)承接,④回收站已排
Kimi S10+Sol TTL 任务,均不在本合同内。

**现状事实(2026-07-23,集成线 65a583e)**:

- users 表只有 username/display_name/password_hash/active,无角色列;
  管理员=env `ADMIN_USERNAMES` 白名单(src/config/env.ts);
- projects 只有 owner_user_id,无成员、无团队归属、无题材分类;
- 无团队表、无用户分组表、无统一成本视图;任务成本散在
  generation_quotes.price_snapshot(jsonb)与 agent_messages.points_spent;
- 项目级审核策略已有(migration 007:project_review_policies,image/video
  分开 automatic|pending_review),缺审核人指定与单素材覆盖;
- 管理动作审计已有(admin_user_actions,010)。

**设计纪律(台账条 30,防复刻)**:权限矩阵、成本口径、审核规则一律服务端
单真源;前端入口显隐只是渲染,每条路由后端独立鉴权——"前端入口与后端鉴权
不一致"(DC 原文⑤)按此根治。

## 一、统一权限模型(两层角色,不搞第三套)

### 平台级角色:users.role

`admin | operator | member`(新列,varchar+CHECK;迁移时把 ADMIN_USERNAMES
命中的用户回填 admin,此后 env 白名单只供 Day-0 bootstrap 使用,运行时判定
一律读列)。

- **admin**:全后台+全项目+全成本可见;团队/用户/分组/权限管理。
- **operator**(运营):后台只读+导出+看全部成本;不改权限不动业务数据。
  (成本可见范围的第一档答案:普通成员看自己+所属项目,operator/admin 看全局)
- **member**:平台默认;能否创建项目=平台开关 `allow_member_create_project`
  (全局配置,默认关——创建项目权限统一规则,DC 原文⑤)。

### 项目级角色:project_members 表

```
project_members(project_id, user_id, role, added_by_user_id, created_at)
role ∈ owner | editor | viewer   -- owner=负责人,editor=可创作,viewer=查看人员
```

- 每项目至少一个 owner;projects.owner_user_id 保留并与成员表同步
  (owner 变更走成员表,列做冗余索引);
- **成员可见性即项目可见性**:非成员既看不到项目也查不到其成本与产物
  (admin/operator 除外);现有"所有人可见所有项目"行为在迁移时收敛——
  存量项目为每个历史参与者(有生成任务记录的 user)补 editor 行,不静默丢访问;
- 权限点矩阵(服务端唯一真源,前端经 `GET /api/v1/me/capabilities` 读):

| 动作 | owner | editor | viewer |
| --- | --- | --- | --- |
| 项目读/产物读 | ✓ | ✓ | ✓ |
| 创作(生成/编辑/导入/资产引用) | ✓ | ✓ | ✗ |
| 成员管理/审核策略/审核人指定 | ✓ | ✗ | ✗ |
| 项目成本视图 | ✓ | ✓ | ✗(可配,默认关) |
| 删除项目(进回收站) | ✓ | ✗ | ✗ |

### 项目生产职责（多选，不是第三个鉴权主体）

战略图口径的五种项目角色以独立多选职责落库：

```
project_member_production_roles(project_id, user_id, role, assigned_by_user_id, created_at)
role ∈ director | art | screenwriter | coordinator | reviewer
       导演       美术  编剧           统筹          审片
```

一个项目成员可以同时承担任意多项职责；`project_members.role` 的
`owner | editor | viewer` 继续单独决定权限。职责不映射、不放大权限：
`reviewer` 不自动获得平台通用资产审核权，也不自动写入项目指定审核人。
成员删除时职责级联删除，职责整组变化与操作者会话写入同一审计事务。

### 团队与用户分组(管理维度,不是第三个权限主体)

- `teams(id, name, parent_team_id nullable, created_at, …)`:成本归属单位,
  支持一层父子(团队层级,DC 原文⑤);`projects.team_id`(nullable,新项目
  必选,存量迁移到「未分配」团队);`team_members(team_id, user_id)`。
- `user_groups(id, name)` + `user_group_members`:运营侧标签(编剧组/美术组
  之类),用于后台筛选、导出与产能报表分组;**不参与鉴权**——权限主体只有
  平台角色+项目角色两层,避免三套权限并行打架。

## 二、成本可追溯(单一取数源,不另立账本表)

原则:**任务记录即账本**。不建第二张"账本表"造双真源,而是把实扣积分从
jsonb 里抬成结构化列,再用一个视图统一口径:

1. generation_requests 补列 `charged_points integer`(迁移回填:从对应
   quote.price_snapshot 提取;新任务写入时落列);
2. Sol AI 网关的 `ai_calls`(migration 014,在途)自带逐笔消耗,口径对齐
   同名列;
3. 建视图 `cost_entries`(UNION 生成任务+ai_calls+后续任何计费面):
   `entry_id, kind, user_id, project_id, team_id, model, charged_points,
   created_at, source_table, source_id`——source 双列保证每笔都能点回任务
   记录(DC 验收原文:"可追溯到任务记录");
4. **三处消费面同源**:项目概览成本、成员排行、后台项目列表,全部只许查
   `cost_entries` 聚合(禁止各自手写 SUM 逻辑),接口:
   - `GET /api/v1/projects/:id/costs?group_by=member|model|day`
   - `GET /api/v1/admin/costs?group_by=project|team|user|model&from=&to=`
     (operator/admin;支持导出 CSV);
5. 归属完整性护栏:0.2.0 起生成任务与 ai_call 的 user_id/project_id 均
   NOT NULL(现 generation_requests 已满足;ai_calls 合同侧要求一致),
   无归属的消费从源头写不进来——治"生成任务无法稳定归属"(DC 原文①)。

## 三、审核策略扩展(在 007 之上,不推倒)

- project_review_policies 补 `reviewer_user_id nullable`(指定审核人;空=
  项目 owner 均可审);策略仍按 image/video 分开默认 automatic|pending_review
  (丽芬 32-1 印证,现表已支持);
- 单素材覆盖:提交生成时可对单任务改一次性策略(automatic→pending 单向,
  只许收紧不许放松);
- 提审到人(丽芬 32-7①):asset_review_actions 补 `assigned_reviewer_user_id`,
  待审列表按人过滤;审核动作鉴权=项目 owner 或被指定审核人。

## 四、资产授权矩阵(clearance,台账条 20,本版只做字段+管理面)

- asset_entities 补 `clearance jsonb`:
  `{ "search": true, "gen_reference": true, "commercial_publish": false,
     "model_training": false }`(默认如左:站内可检索可作参考,商业发布与
  训练默认禁);
- 0.2.0 交付=字段落库+管理后台可编辑+资产详情展示;**策略 enforcement
  (生成/发布链按矩阵拦截)0.3.0 随发布链再接**,本版不拦——边界写明,防
  假可用。

## 五、管理后台(admin/operator 面)

在现有 /admin(用户管理)基础上扩:团队、用户、项目、用户分组四张管理表的
增删改查+筛选+CSV 导出+状态调整(禁用/恢复),全量动作进 admin_user_actions
式审计(表扩 action 枚举或平行表,Sol 定);业务初始化=Day-0 bootstrap:

- bootstrap 脚本(runbook 已有,震宇执行)建初始 admin;
- 后台「建用户」入口现已有(S1 交付),补:建用户时选平台角色/团队/分组;
- 项目管理列表:名称/负责人/团队/题材/成本(cost_entries 聚合)/状态。

### 新建项目增强(丽芬 32-1,随本合同前端一并交)

新建项目表单:负责人(默认自己)+查看人员(project_members viewer 批量加)
+题材分类 `projects.genre`(甜宠/虐恋/重生/复仇/穿越/其他,喂数据看板)+
项目级审核策略(image/video 分开选默认,可指定审核人)。项目设置页可编辑
以上全部(丽芬 32-1"项目可编辑")。

## 六、API 汇总(Sol 实现)

```
GET  /api/v1/me/capabilities                    # 平台角色+开关+访问角色+生产职责
GET  /api/v1/users/directory?q=                  # 登录可读的成员选择目录；仅返回安全身份字段
CRUD /api/v1/projects/:id/members               # owner/admin；production_roles 多选整组替换
CRUD /api/v1/admin/teams  /admin/user-groups    # admin
GET  /api/v1/projects/:id/costs?group_by=…      # 见第二节
GET  /api/v1/admin/costs?group_by=…&format=csv  # operator/admin
PATCH /api/v1/projects/:id  (genre/review-policy/reviewer)
```

项目成员与 capabilities 五条接口同时注册机器可读 OpenAPI schema；运行时 Zod 仍负责中文
校验错误，OpenAPI 冻结请求体、五职责枚举、响应结构与 POST 201。

所有既有路由补项目成员鉴权中间件(非成员 404 不 403,不泄露项目存在性)。

## 七、前端行为(Kimi 实现,合同产出后入 S10+ 队列)

- 入口显隐全部由 capabilities 接口驱动,前端不自判角色;
- 项目卡/列表只出现自己是成员的项目(admin/operator 有"全部项目"后台视图,
  不混进创作端);
- 项目概览加成本块、成员排行(数据只来自 costs 接口);
- 新建项目表单增强(上节);后台四张管理表页面。

## 八、验收口径(DC 原文,逐字为准)

1. **成本可追溯**:生成任务关联用户、项目、模型及成本账本;项目概览、成员
   排行和后台项目列表的成本值来源一致,可追溯到任务记录。
   → 验法:同一项目三处成本数值一致(同一时刻快照);任选一笔成本能经
   source_table/source_id 打开原始任务记录。
2. **管理可运营**:后台可管理团队、用户、项目、用户分组及权限;数据联动
   明确,支持筛选、导出、状态调整和业务初始化。
   → 验法:真栈走一遍"bootstrap 建 admin→建团队→建用户入组→用户建项目
   →加成员→生成一笔→三处成本对得上→导出 CSV"。
3. 权限一致性:viewer 调创作接口 403/404、非成员看不到项目,用后端直连
   (curl)验,不看前端入口。

## 九、边界(本合同不做)

- 声音工坊/文本创意(DC 原文③)→ 0.2.0 独立卡;回收站(④)→ S10+TTL;
- 积分充值/计费单价改造:沿用现 pricing 体系,本合同只管"记账与看见";
- clearance 的策略 enforcement(0.3.0);外部 SSO/邮箱验证(远景);
- 用户分组不做权限绑定(见第一节,防三套权限)。

## 十、实施切分建议

- **Sol 一包**:迁移(role 列/成员表/teams/分组/charged_points 回填/
  cost_entries 视图/审核扩展列/clearance 列)+鉴权中间件+第六节 API+后台
  数据面;与 AI 网关 ai_calls 口径对齐点单独列验收。
- **Kimi 一包**:第七节全部(等 Sol 接口好再发,或先发管理后台静态骨架)。
- Day-0 bootstrap 与建用户入口不等本合同全量——最小先行件已具备,转震宇
  即可让测试环境先用起来(台账条 37)。

# API 与数据合同

> 0.2.0 增量：控制资产类型化（role/usage_mode 字段、校验矩阵、references 结构）见
> `control-asset-typing.md`——E/G 两组实现以该文件为准。

> 0.3.0 增量：结构化剧本（IR）双语法/槽位/回源/后端映射见 `structured-script-ir.md`——
> 编译器与 W9-D 后端实现以该文件为准。

## API 规则

- 路径统一使用 `/api/v1`。
- 输入由 Zod 校验；输出使用统一成功/错误结构。
- 所有写接口支持认证、权限检查、审计字段和可解释错误。
- 创建付费任务和确认导入等操作必须有幂等键。
- 列表接口使用稳定排序和游标或明确分页，不依赖数据库偶然顺序。
- API schema 变更必须同步调用端、OpenAPI 和合同测试。

### 资产列表分页

`GET /api/v1/assets` 的个人/通用范围支持 `page` 与 `page_size`。通用范围尚未传
`sort` 时默认使用 `composite`；也可选 `newest`。`composite` 固定按有图片预览优先、
`use_count DESC`、`updated_at DESC`、`id ASC`，`newest` 固定按
`created_at DESC`、`id ASC`。个人范围保留既有工程顺序，本合同不把它升级为产品排序
承诺。响应为
`{ items, total, count, page, page_size, has_more, kind_counts }`；`count` 是保留一版的
兼容别名，新调用端使用 `total`：

- `total` 是当前 scope 与全部筛选条件下的总资产数，不是当前页条数；
- `kind_counts` 保留当前搜索、媒体与高级筛选，排除 `asset_kind` 自身后按大类聚合；
- 通用库普通用户无论是否传 `status` 都只见 `status='approved'`，只有 platform admin
  可以使用 `status` 筛选；
- browse-v1 参数为 `q`、`asset_kind`、`media=image|model3d`、`category`、
  `tags`（CSV，同维度 OR）、`source`、`gender`、`age_band` 与
  `sort=composite|newest`；`gender`/`age_band` 仅在角色大类有效；
- 资产中心必须显式使用 `page_size=24`，不得再按每种类型并发拉取全量列表；
- 兼容尚未分页的旧内部调用端，省略 `page_size` 时暂按 500；新调用端不得依赖该兼容值。

`use_count` 是采用次数代理指标：首次引用到项目、首次导入为个人资产各 `+1`；幂等重放不
重复累计，删除项目引用不回减。真实生产引用仍由 `assets/usage.ts` 的 usage 报表现算，
两套数字不得混写。

## 统一错误含义

至少区分：未登录、无权限、输入错误、资源不存在、状态冲突、预算阻止、供应商不可用、可重试失败和内部错误。页面应给出用户可执行的下一步，不直接展示供应商堆栈。

## 企业微信内部成员登录

### 身份与开户

- 只支持一个已配置 CorpID 下的企业微信自建应用，只接受应用可见范围内的内部成员；`external_userid`、第三方应用授权和多企业租户不在本合同内。
- 外部身份唯一键为 `(corp_id, wecom_user_id)`，其中 `wecom_user_id` 是企业微信 `userid`。正式映射表为 `wecom_user_identities`，固定包含 `id`、`user_id`、`corp_id`、`wecom_user_id`、`last_authenticated_at`、`created_at`、`updated_at`；`user_id` 以 `ON DELETE RESTRICT` 外键指向 `users.id`，并分别对 `(corp_id, wecom_user_id)` 和 `user_id` 建唯一约束。首期一名平台用户只能绑定一个当前企业微信身份。
- 首次成功授权可以在一个 PostgreSQL 事务内即时创建 `users` 与身份映射。新用户固定为 `role=member`、`ui_mode=full`、无任何 `project_members`；企业微信身份不能授予平台管理权限、项目权限或生产职责。
- 即时开户的 `username` 固定为 `wecom_` 加 `SHA-256(UTF-8(corp_id) || 0x00 || UTF-8(wecom_user_id))` 的前 58 位小写十六进制字符，正好不超过现有 64 字符合同；`email=NULL`，`display_name` 取已验证的企业成员名称。后续登录只更新 `last_authenticated_at`，不得用供应商资料静默覆盖用户或管理员改过的显示名。极小概率用户名冲突按 `wecom_identity_conflict` 失败关闭，不追加随机后缀。
- 即时开户只在目标授权模式返回非空、可向用户展示的成员名称时允许。资料权限不足或名称不可用时返回稳定错误 `wecom_profile_incomplete`，不创建用户或身份，改由管理员预绑定。
- 禁止按手机号、邮箱、姓名或显示名自动关联已有账号。身份已属于其他用户或唯一约束竞争失败时返回 `wecom_identity_conflict`，不得迁移绑定或创建第二个用户。
- 即时开户要求 `users.password_hash` 改为可空。密码登录遇到 `NULL` 必须失败关闭；禁止生成随机假密码或增加兼容分支。管理员后续设置密码必须走正式密码设置流程。
- `wecom_user_identities` 不提供解绑或硬删除；用户停用后保留映射并拒绝登录，避免同一 `userid` 被重新认领。后续法定删除或换绑需求必须另立带审计的合同和迁移，不能在本 MVP 中临时删行。
- 无法即时开户时，唯一预绑定入口为人类平台管理员调用 `PUT /api/v1/admin/users/:user_id/wecom-identity`，严格 body `{ wecom_user_id }`；CorpID 只读服务端配置，不接受客户端传入。操作验证目标用户存在且 active、执行两项唯一约束，并在同一事务写入 `admin_operation_actions`；成功返回 `{ user_id, bound: true }`，冲突返回 `409 wecom_identity_conflict`。首期无绑定/解绑 UI，也不允许 Agent 凭据调用该端点。

### OAuth 浏览器事务与数据

`wecom_auth_transactions` 是 state 防重放和一次性结果交换的唯一事务表，固定包含 `id`、`state_hash`、`browser_nonce_hash`、`return_path`、`expires_at`、`callback_consumed_at`、`result_hash`、`result_expires_at`、`result_consumed_at`、`resolved_user_id` 与 `created_at`、`updated_at`。`state_hash`、非空 `result_hash` 均唯一；`resolved_user_id` 以 `ON DELETE RESTRICT` 指向 `users.id`。

- state、浏览器 nonce 与 result 均使用高熵随机值，数据库只保存 hash；事务短期过期并且只能原子消费一次。
- 原始 state、浏览器 nonce、企业微信授权 code、企业微信 access token、CorpSecret 和平台 Bearer token 不得落库。
- `return_to` 只接受站内绝对路径，由服务端在创建事务和回跳前分别校验；协议相对路径、外站 URL、反斜杠变体和编码绕过一律拒绝。
- 回调必须在事务中校验并消费 state、过期时间和浏览器 nonce。重复回调、伪造值、过期值或浏览器不匹配均失败关闭，且不能产生身份或平台 session。
- 企业微信授权 code 只能向供应商交换一次；网络结果不明时不得自动重放 code。
- state 默认 300 秒过期，一次性 result 最长 60 秒过期；已消费或过期事务在 24 小时后由只删除该临时表的清理任务物理清除。该表不承担登录审计，正式身份与 session 事实不得随清理删除。

### API 与会话

| 方法 | 路径 | 认证 | 合同 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/auth/wecom/status` | 公开 | `200` 成功 envelope，data 固定 `{ enabled: boolean }`；只有服务端开关打开且启动配置已通过时为 true |
| `GET` | `/api/v1/auth/wecom/authorize?return_to=<path>` | 公开 | `return_to` 可省略且默认 `/projects`；创建事务、设置 nonce Cookie，`302` 跳转企业微信 |
| `GET` | `/api/v1/auth/wecom/callback?code=<code>&state=<state>` | 公开 | 消费授权结果；成功 `303` 到 `/landing#wecom_result=<opaque>&redirect=<encoded-path>`，预期失败只带稳定 `wecom_error` fragment |
| `POST` | `/api/v1/auth/wecom/exchange` | 公开但受 nonce/result 保护 | strict JSON body `{ result: string }`；单次消费 result，返回现有 `{ token, expires_at, user }` |

- 公开白名单只加入上述精确路径，禁止按 `/auth/wecom/*` 前缀放行。
- nonce Cookie 名固定为 `__Host-wecom_oauth_nonce`，必须由成熟 Fastify Cookie 插件设置为 `HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`、无 Domain、300 秒 TTL。平台 Bearer token 不进入 Cookie、URL、HTML 或日志。
- 一次性 result 只放 URL fragment，浏览器发起 HTTP 请求时不会传给服务端；前端读取后必须立即用 `history.replaceState` 清掉 fragment，再调用 exchange，不写入 localStorage/sessionStorage。callback 响应设置 `Referrer-Policy: no-referrer`。
- exchange 复用现有人工 Web session 签发、token hash 存储、用户 `active` 检查和生产单活规则；不得新建 JWT、refresh token 或第二套 session 表。
- session 签发必须锁定用户并与停用/密码变更竞态规则兼容，但不能错误复用“必须提供密码 hash”的条件。响应中的 `user.ui_mode` 读取 PostgreSQL 真值，调用端据此进入 Full 或 Lite。
- 前端能力真值来自 `status`，不得以 `VITE_ENABLE_WECOM_LOGIN` 或其他构建期开关独立决定是否可用。状态读取失败时隐藏入口并保留普通登录。唯一站内回调载体是现有 `/landing` 与 `LoginCard`；成功后只有与 `user.ui_mode` 相容的安全 `return_to` 才可复用，否则 Lite 进入 `/lite/projects`，Full 进入 `/projects`。

稳定错误码固定为：关闭 `wecom_login_disabled`（404，仅 authorize/callback/exchange；status 始终 `200` 并返回 `{ enabled: false }`）；state/result 伪造或浏览器不匹配 `wecom_transaction_invalid`（400）；过期 `wecom_transaction_expired`（400）；重复消费 `wecom_transaction_replayed`（409）；用户取消 `wecom_authorization_cancelled`（400）；非内部成员或不在可见范围 `wecom_member_not_allowed`（403）；资料不足 `wecom_profile_incomplete`（409）；绑定冲突 `wecom_identity_conflict`（409）；账号停用 `wecom_account_disabled`（403）；供应商不可用 `wecom_provider_unavailable`（503）。callback 的预期错误以同名 `wecom_error` fragment 回 `/landing`，exchange 的错误使用统一错误 envelope；任何路径都不得夹带供应商 message。

### 供应商边界与日志

企业微信 HTTP 调用收敛在 auth integration adapter，复用项目已有 `undici`。access token 只做当前模块的进程内缓存与并发单飞，按过期时间提前刷新；当前单体部署不引入 Redis、共享 token 服务或通用身份供应商框架。adapter 必须设置连接/读取超时并把供应商错误映射为稳定平台错误。

日志、错误响应、审计和追踪不得包含授权 code、access token、CorpSecret、平台 token、完整 `userid` 或供应商原始响应。允许记录脱敏 request ID、稳定错误码、阶段和耗时。

## vNext 独立产品面（`/api/vnext` 显式例外）

按 #306 规格与 #307 产品裁决，vNext 持续画布是独立于 Lite/完整版的试验产品面，
其 API 走 `/api/vnext` 前缀，是对上文「路径统一使用 `/api/v1`」的**显式例外**，
在此登记，不构成静默分叉；除本节列出的差异外，其余 API 规则（Zod 输入、统一
成功/错误结构、稳定排序游标分页、认证授权）与 `/api/v1` 完全一致。

- 数据面：独立 PostgreSQL schema `vnext`（projects/project_members/graph_documents/
  graph_revisions/generation_telemetry_events/agent_session_contexts），迁移链挂在正式受控迁移入口
  `runMigrations` 内同事务执行，账记 `vnext.schema_migrations`；不接触 Lite 数据语义。
- 运行时隔离：应用 vNext 数据面走专用连接池，每条连接经 `-c role=vnext_app`
  钉死最小权限角色（迁移 001 建角色；003 新建 NOLOGIN `vnext_owner` 持有
  schema/产品对象；迁移时临时授予部署迁移主体 `vnext_owner`，完成后立即撤销，
  不改变该共享登录身份原有的全局 INHERIT/NOINHERIT 语义）；
  `VNEXT_DATABASE_URL` 必须使用独立 NOINHERIT 登录身份，该身份只加入
  `vnext_app` 并仅允许专用连接显式 `SET ROLE`；
  `vnext_app` 只持有 vnext schema 的 USAGE 与 SELECT/INSERT/UPDATE（无 DELETE、
  对主 schema 无任何权限），普通主连接不能访问 vNext 产品表，成员资格缺失时
  专用连接直接 fail-closed。后续迁移由 runner 在同一连接内临时取得并
  `SET ROLE vnext_owner`，执行后撤销成员资格。
  会话认证仍走主连接（vnext_app 对主 schema 无权限，读不了 sessions/users）。
  TOS 侧：vNext 只拥有 `vnext/` 前缀，对象键固定为
  `vnext/projects/<project_uuid>/<object_uuid>_<sha256前16位>.<ext>`，拼路径必经
  `src/modules/vnext/storage.ts` 的合同校验，与 Lite/完整版资产键互不重叠；
  合同已就位，vNext 的对象写入链（上传/快照落 TOS）尚未建设，属已知产品缺口，
  建设时必须把 seam 统一接到该合同校验，越界键在 provider 调用前拒绝。
- 画布写入：`PUT /api/vnext/projects/:project_id/graph` 采用乐观 revision CAS，
  陈旧 revision 返回 409 `vnext_revision_conflict`（按仓库错误约定错误体不带 details），
  调用方经 `GET …/graph` 重读最新事实后把本地增量重放到新事实上（远端新增与本地
  拖动/新增都保留）再续写；网络错误/5xx 时未确认编辑保留为 dirty/error 显式重试；
  每次写入同事务追加 `vnext.graph_revisions`（不可变，含 `created_by_kind = human|agent`）。
- Agent 访问：复用仓库统一 Agent access 机制（`src/http/agentAccess.ts` 的
  fail-closed 闸），仅画布 `PUT …/graph` 显式声明 `agentAccess: "candidate"` 放行，
  创建项目、生成遥测等其他 mutation 对 Agent 凭证依旧 403 `agent_action_not_allowed`；
  Agent 画布写入复用同一 `VnextProjectService.replaceDocument` 与同一 revision 链
  （工具入口见 `src/modules/vnext/agentTool.ts`，`vnextProjectId` 只从真实 Agent
  Context 取）。Agent 必须先调用 `get_vnext_canvas` 读取最新完整 GraphDocument 与
  revision，再调用 `write_vnext_canvas` 保留既有节点后做 CAS 写入；陈旧 revision
  仍按同一 409 合同拒绝。
- 同一事实：Agent 与人类用户走同一服务同一 revision 链写入，页面「最近写入」
  与增量状态只读 revision 事实（`last_write` / `GET …/revisions`），不用本地文案冒充。

## 核心对象

- User、Role、ProjectMember：人、角色和项目内责任。
- Project、Episode、Scene、Shot：生产层级。
- Asset、AssetMedia、AssetVersion：可复用资产及版本。
- DirectorScene、Camera、SceneObject、Capture：3D 导演台状态与快照。
- GenerationIntent、GenerationTask、GenerationResult：准备内容、人工授权和结果。
- CandidateVersion、MainVersion、Decision：候选、主版本和人的判定。
- AgentSession、Memory、KnowledgeReference、ToolRun：AI 会话、记忆、知识引用和工具执行记录。

对象允许扩展，但新增对象必须说明：身份、生命周期、正式属性、关系、权限、责任人、审计和删除规则。

## 项目成员与多选生产角色

项目成员同时拥有两个正交维度：

- `project_role`（写接口字段仍为 `role`）取 `owner | editor | viewer`，继续作为项目可见性与
  服务端鉴权的唯一项目级来源；
- `production_roles` 是生产职责多选，固定为
  `director`（导演）、`art`（美术）、`screenwriter`（编剧）、
  `coordinator`（统筹）、`reviewer`（审片）。

生产职责不授予访问权限。尤其 `reviewer` 不等于平台超管、通用资产审核人或项目审核策略中的
指定审核人；#24 的通用资产审核仍只允许平台 `admin`。正式关系表为
`project_member_production_roles(project_id, user_id, role, assigned_by_user_id, created_at)`，
主键是项目、成员、职责三列，外键指向 `project_members` 并随成员删除级联。历史成员不猜测
职责，迁移后返回空数组。

### API

所有响应经统一 envelope 返回 snake_case。成员项固定为：

```json
{
  "project_id": "uuid",
  "user_id": "uuid",
  "username": "artist.one",
  "display_name": "美术一",
  "platform_role": "member",
  "project_role": "editor",
  "production_roles": ["director", "art"],
  "added_by_user_id": "uuid",
  "created_at": "2026-08-05T00:00:00.000Z"
}
```

- `GET /api/v1/projects/:project_id/members`
  - 入参：仅路径参数。
  - 出参：`{ items: ProjectMember[], count }`；owner 固定排在 editor/viewer 前，职责数组按
    导演、美术、编剧、统筹、审片稳定排序。
- `POST /api/v1/projects/:project_id/members`
  - 入参：`{ user_id, role, production_roles? }`。
  - 出参：HTTP 201，`{ item }`。
  - 语义：沿用既有成员 upsert；显式传 `production_roles` 时整组替换。省略时，新成员为
    空数组，已有成员保留原职责，避免旧调用端静默清空。
- `PATCH /api/v1/projects/:project_id/members/:user_id`
  - 入参：`{ role?, production_roles? }`，至少一项；`production_roles: []` 明确清空，
    非空数组也采用整组替换，不提供隐式追加/移除语义。
  - 出参：HTTP 200，`{ item }`。
- `DELETE /api/v1/projects/:project_id/members/:user_id`
  - 出参：HTTP 200，`{ deleted: true, user_id }`；生产职责由数据库级联删除。
- `GET /api/v1/me/capabilities`
  - 每个 `projects[]` 项继续返回 `project_id`、`role`，并新增 `production_roles`，供后续
    角色化入口使用；调用端不得用生产职责自行推导权限。

上述五条接口同步提供 Fastify/OpenAPI 机器可读合同：请求体、五职责枚举、成功响应结构及
POST 的 HTTP 201 均由合同测试冻结，`/docs` 生成结果不得退化成无请求体或默认 200。

五种职责可同时全选，不允许重复或未知值。成员管理只允许项目 owner 或平台 admin；已知项目
成员但无管理权时返回 HTTP 403、`forbidden`、中文“你没有在该项目中执行此操作的权限”；
普通非成员保持 HTTP 404、`not_found`、“项目不存在或你没有访问权限”，避免泄露项目存在性。
未登录返回 401 `unauthorized`；字段缺失、未知/重复职责或空 PATCH 返回 400
`invalid_request` 与中文填写提示；用户或成员不存在返回 404 `not_found`；移除或降级当前
owner 返回 409 `project_owner_required` 与中文先指定新负责人的说明；并发唯一性冲突返回
409 `conflict` 与中文刷新重试提示。

新增、访问角色变化、生产职责整组变化和删除均与业务写入处于同一 PostgreSQL 事务，并写入
`admin_operation_actions`。生产职责变更审计保存操作者/会话、项目、目标用户及
`from_production_roles`、`to_production_roles`；首次分配明确记录 `[] → 新职责`，删除审计
保留删除前的访问角色和生产职责。

## 状态规则

- 状态迁移由服务端控制，页面不能任意写状态字符串。
- 任务至少区分准备中、待人工提交、已提交、运行中、成功、失败、取消。
- 媒体只有完成 TOS 持久化并写入哈希后，才可标记为可交付。
- 删除默认进入回收站；真正清除必须独立权限和可审计操作。

### 集与场生产状态投影

`GET /api/v1/episodes/:episode_id/production-status` 与
`GET /api/v1/scenes/:scene_id/production-status` 只读投影同一条生产事实链，供集视图时间线
和场卡消费。机器枚举固定为
`not_broken_down | broken_down | preparing | ready | generating | has_media | delivered`，
对应业务标签为「未拆解 / 已拆解 / 备戏中 / 就位 / 生成中 / 有样片或成片 / 已交付」。

场状态按以下优先级派生：

1. 没有有效分镜时为 `not_broken_down`；
2. 任一有效分镜的当前尝试为 `pending` 或 `running` 时为 `generating`。当前尝试只认同一
   `generation_request` 下最大的 `attempt_no`，在途状态覆盖旧主版本与旧交付事实；尝试终止后
   再回落到下列事实；
3. 所有有效分镜的当前视频主版本都存在，且这些主版本 ID 均进入交付记录时为 `delivered`；
4. 所有有效分镜都有当前视频主版本时为 `has_media`；
5. 所有有效分镜的控制包均已标记就位时为 `ready`；
6. 至少一个有效分镜已有控制包时为 `preparing`；
7. 其余已拆分场为 `broken_down`。

图片主版本不推进「有样片或成片」阶段。交付判断必须针对当前视频主版本；换主版本后旧交付
不能造成假交付。集状态取有效场中最早的未完成阶段；没有有效场时为
`not_broken_down`。集响应同时返回七态计数、是否存在在途任务、已交付场数和聚合阶段的首个
`next_scene_id`。

场投影返回分镜总数、控制包已开始/已就位/在途/已有当前视频主版本/已交付计数，控制包已填
lane 数与当前启用 lane 总数，在途任务计数与可信队列位置，以及当前主视频中样片和成片计数。
lane 总数读取启用中的 `reference_lane_vocabulary`，不得写死。封面取稳定分镜顺序中的第一个
当前视频主版本；历史数据缺少 `production_mode` 时按 `full` 解释。响应携带稳定
`revision`，在事实未变化时不得因数据库偶然顺序而变化。

## 并发与一致性

- 重复点击、网络重试和 Agent 重放不能重复创建付费任务。
- 长任务状态由数据库恢复，不能只存在浏览器内存。
- 更新需要版本号或等价并发控制，冲突时提示刷新或合并，不能静默覆盖。
- Milvus 写入失败不回滚 PostgreSQL 正式事实；记录待同步状态并可重建。

## Seedance 素材登记与 MCP 边界

Seedance 素材登记的 PostgreSQL 登记行（含 `remote_asset_id`、状态和核验时间）是唯一
正式事实；`asset_media.metadata.seedance_asset_id` 仅是可重建投影。外来或来源不明素材
只有登记为 `active` 且 `last_verified_at + 15 minutes` 尚未过期，才可作为 `reference`
进入 provider 请求。15 分钟是我方保守 freshness 裁决，不是 Ark 官方期限；真实
provider 验证后可调整。过期必须要求用户显式 refresh，报价、提交和组包不得隐式调用
`GetAsset`，并应 fail-closed。

正式 MCP adapter 由 S71 在主仓实现，是调用现有 application service 的薄层。它必须完成
调用者鉴权和对象管理权限校验，并以 caller + `idempotency_key` 保证一次明确操作最多一次
TOS 上传和 CreateAsset；adapter 或 agent 仓不得直写数据库，也不得复制 provider。application
service 负责 TOS 上传、CreateAsset、显式 refresh 的 GetAsset，以及在同一数据库事务或受审计
outbox 内写 `asset_entities`、`asset_media`、登记真源和 metadata 投影。返回本地 asset、
asset_media、registration、`remote_asset_id`、`status`、`last_verified_at` 与 `fresh_until`，不返回
供应商原始响应或凭据。`provider_library` bind 只可先落 `unknown`，且不得调用 GetAsset；只在
用户显式 refresh 后才可查询并转为 `active`。

## 数据迁移

- 每次 schema 变更提供向前迁移、兼容窗口和回滚/恢复说明。企业微信身份、授权事务及 nullable password 变更必须使用新迁移，迁移号在立项时从最新 ledger 独占分配；不得修改已入账迁移。
- 不在应用启动时执行破坏性自动迁移。
- 测试夹具与正式数据明确分开，界面真实模式不得显示假数据。

## 控制资产与生成引用

正式表 `asset_entities` 新增可空字段 `role` 与 `usage_mode`；提案中的 `assets` 是概念名，不是第二张表。`role` 只能是 `character_identity`、`scene`、`prop`、`motion`、`camera_storyboard`、`style_env`；`usage_mode` 只能是 `reference`、`first_frame`、`last_frame`。旧数据的 `usage_mode=null` 按 `reference` 处理。

- JSON、图片、Excel 入库入口和资产 PATCH 接口均可选接受 `role` / `usage_mode`；API 为兼容旧 CLI 不强制必填，图片与 Excel multipart 显式传入时对本批统一生效。
- 生成请求的正式新形状是 `references: [{ media_id, usage_mode }]`。兼容期内继续接受 `reference_media_ids` + `first_frame_media_id` + `last_frame_media_id`；一次请求不能混用两种形状。
- `reference` 槽只能放 `usage_mode=reference` 的非 3D 图片或视频；`model_3d`、GLB、glTF 始终只能用于导演台。视频生成可选的 `first_frame` / `last_frame` 槽各至多一个，且只能引用同名 `usage_mode` 的图片资产。
- 图片生成不能携带首帧或尾帧。槽位、媒体类型或控制用途违规在估价、批量估价和正式创建前返回 `422 control_asset_invalid_usage` 与可执行中文提示，不触发供应商调用。
- 全能参考集合本版只允许图片和视频；音频返回 422，不借用旧版 `reference_audio` 路径，后续声音桥另立合同。动作和运镜参考视频以 `reference_video` 透传到模型适配层。视频参考不继承“无输入视频”的历史单价：只有当前 `pricing_rules.metadata.supports_input_video=true` 的可追溯规则才能创建报价；否则在报价阶段失败关闭，不创建报价或任务。报价快照中无视频参考才记录 `noInputVideo=true`，有视频参考记录数量但不作“无输入视频”声明。模型组包路径的本地测试不等同于已获云端视频参考定价批准。
- 通用资产作为控制包或生成参考时，当前审核状态必须为 `approved`；`automatic_review`、`pending_review`、`rejected` 和未知状态均返回 422，`error.message` 点名资产并给出中文状态。生成入口统一使用 `control_asset_invalid_usage`，拒绝不得创建报价、请求或 attempt，也不得调用供应商。
- 点名 422 只适用于调用者已能检查的资产（平台管理员，或项目已有该精确 media/variant 引用）；普通成员仅凭 UUID 探测未公开待审通用资产时保持 404/403 且不返回资产详情。
- HTTP 解析只是提前反馈；生成 repository 必须在报价、确认后建单、批量提交、人工重试和 Worker 从 `created` 进入 `submitting` 的 PostgreSQL 事务内重新读取并锁定资产、媒体和变体事实。报价快照或控制包既有引用不能替代当前审核事实。
- 批量估价直接在对应条目返回 `status_code=422` 与同一组可展示详情；批量提交保持整批 `202` 回执，但失败条目必须保留 `status_code=422`、中文详情和幂等重放结果，调用方不得把整批受理误读为每项成功。
- 个人资产继续免审；免审不等于越权，所有者和项目精确 media/variant 引用规则保持不变。

### V0.1.1 对 V0.1 视频合同的覆盖

本节仅在 V0.1.1 的“视频参考”能力上覆盖 `docs/contracts/v0.1/runtime.md` 中“无输入视频”的限制；720p、9:16、4 秒和一次一任务等其余 V0.1 约束仍有效。管理员开启视频参考报价前，必须创建当前有效的 `pricing_rules`：`metadata.supports_input_video=true`、`source` 为非空且可追溯的定价来源。两项任一缺失，报价接口必须失败关闭；不得用原来的每秒 80 分规则冒充视频参考价格。

旧固定档 `vid-seedance20fast-916-720p-4s` 永久保持“无输入视频、80 分/秒”语义；
给该行补写或残留 `supports_input_video=true` 也不构成视频参考定价授权。视频参考价格完成
单独实测和账单批准后,必须使用独立 `tier_id` 与可追溯价格规则登记,不得原地升级旧固定档。
- 通用资产复制到个人资产必须保留 `role` 与 `usage_mode`；资产中心的列表与详情响应显式返回这两个字段，前端尚未提供编辑入口。

## 批量生成清单估价

`POST /api/v1/generations/batch-estimate` 只做批量清单的逐项估价。请求含 1–50 个带稳定 `item_id` 的生成准备项；响应严格按输入顺序返回每项的可用状态、已冻结的单项报价、实际采用模型和参数摘要，及总预估费用与人工复核信号。

- 顶层 `production_mode` 可取 `full` 或 `sample`，省略时为 `full`。`sample` 只允许视频项；
  混入非视频项时该项返回中文业务错误，其余合法项继续估价。
- `production_mode` 只属于批量估价与批量提交合同；普通单项估价、确认提交不接受该字段，
  仍按既有成片模式执行。
- 样片价格对每个合法项按 `ceil(full_estimated_cost_fen * 3 / 5)` 取整到分，再汇总清单费用；
  不允许先汇总再乘系数，也不允许在后续授权或扣费时重复乘系数。
- 报价和价格快照显式保存 `production_mode`、`price_multiplier_bps`、
  `full_estimated_cost_fen` 与最终 `estimated_cost_fen`。`full` 对应 10000 bps，
  `sample` 对应 6000 bps；底层规则的 `unit_price_fen` 保持原价，不伪造低价档。
- `production_mode` 进入单项请求哈希、批次哈希、人工授权身份和尝试快照。历史快照缺失该字段
  时按 `full` 兼容读取；重试继承原尝试的模式。
- `POST /api/v1/generations/batch-submit` 必须显式或按默认解析同一顶层模式，并与全部报价冻结
  模式一致。任一不一致时整批返回 409 中文业务错误，不创建任务、不扣费；预算、积分、
  人工复核阈值与提交合计均使用折后最终价格。
- 可用项会创建普通、十分钟过期的报价记录，供后续人工确认使用；不会创建 `generation_request`、不会启动 Worker、不会调用模型供应商。
- 单项参数、资产权限、模型配置或单价错误只标记该项，其他项继续估价；空清单、超过 50 项等清单容器错误返回 400。
- `item_id` 必须在一次请求中唯一。客户端以此关联清单，不依赖数据库顺序。
- `requires_manual_review` 在任一单项或批量总额严格超过服务端 `paidGenerationReviewThresholdFen` 时为真。此信号不等同于提交授权；批量创建任务仍必须由单独的人类确认接口实现。

## 测试域默认策略

测试结果可以由人设为项目默认策略，正式事实保存在 `generation_default_strategies`。策略以“项目 + 媒体类型”唯一（`media_kind ∈ image | video | audio`，Lite 音频资产配置随 v0.1.1 音频改造纳入），包含模式、模型键、参数、可选来源任务、修改人和版本号。模式 `mode ∈ direct_reference | material_to_prompt | text_to_speech`；`text_to_speech` 为音频 TTS（文本+音色直接合成，无参考素材概念）。

- `GET /api/v1/projects/:project_id/generation-defaults`：列出当前项目的图片、视频和音频默认策略。
- `GET /api/v1/projects/:project_id/generation-defaults/:media_kind`：读取单项；不存在返回 404。
- `PUT /api/v1/projects/:project_id/generation-defaults/:media_kind`：人工保存默认策略。`expected_version=0` 表示首次创建，后续必须传当前版本；并发覆盖返回 `generation_default_version_conflict`。
- 音频默认策略的 `model_key` 存档 id、`parameters.speaker_id` 存默认音色；弹窗生成时未显式选档/音色则按此预填。
- 默认策略只影响后续页面备料，不创建生成任务，也不能保存密钥、令牌或供应商原始响应。

## 项目审核域

项目分别保存图片和视频的默认审核策略。缺少已保存策略时，服务端按 `pending_review` 返回安全默认值；修改必须带当前版本号，不能静默覆盖。

- `GET /api/v1/projects/:project_id/review-policies`：同时返回图片、视频两项。
- `GET/PUT /api/v1/projects/:project_id/review-policies/:media_kind`：读取或保存单项；首次保存传 `expected_version=0`。
- `POST /api/v1/projects/:project_id/reviews/submit`：把 1–50 个项目内通用资产送入待审核，拒绝重复 ID。
- `POST /api/v1/projects/:project_id/reviews/assets/:asset_id/decision`：人工通过或拒绝通用资产；拒绝必须填写原因。
- `GET /api/v1/projects/:project_id/reviews/assets/:asset_id/actions`：返回审核人、前后状态、拒绝理由和时间，供状态悬停与完整记录使用。

通用资产审核状态只允许 `automatic_review`、`pending_review`、`approved`、`rejected`，且只有平台 `admin` 可以提交或裁决；项目 owner、指定审核人和资产所有者均不能获得平台级通用库审核权。状态变化和动作记录在同一数据库事务中完成；已通过资产不能直接反向裁决，被拒绝资产可重新提审。个人资产免审并固定为 `approved`，提审/裁决接口对个人资产返回 `personal_asset_review_not_applicable`，不写审核动作。审核接口不报价、不创建生成任务、不调用模型。

审核权限与生产使用门禁是两层独立约束：审核接口按上一段限制执行人；控制包与生成链按当前
审核状态决定能否使用。任何一层通过都不能替代另一层。

项目内审核动作必须记录 `project_id`；采购后直接进入通用资产库的动作可不属于项目，但仍必须使用同一张动作表记录执行人、前后状态和时间，不能另建一套“采购审核”字段。

## 参考测试记录

参考测试保存“名称、图片或视频目标、直接引用素材或素材转提示词模式、模型、提示词、参数和参考素材引用”。它是测试配置与已有结果的记录域，不是第二套生成流程。

- `POST/GET /api/v1/projects/:project_id/reference-tests`：创建和分页列出测试。
- `GET/PUT/DELETE /api/v1/projects/:project_id/reference-tests/:reference_test_id`：读取、乐观锁更新或软删除。
- `POST/GET /api/v1/projects/:project_id/reference-tests/:reference_test_id/results`：只关联正常生成流程中已持久化到 TOS 的结果，并分页读取。
- `GET /api/v1/projects/:project_id/reference-test-results`：按项目汇总全部测试批次，可按图片或视频过滤。
- `POST /api/v1/projects/:project_id/reference-tests/:reference_test_id/results/:result_id/set-default`：人工把该结果冻结的模式、模型和参数写入项目默认策略。

创建或编辑测试不会产生付费任务；关联结果不会重新调用供应商；“设为默认”也只写策略。真正生成仍必须经过现有报价和人工确认链。

## 项目消耗聚合

`GET /api/v1/projects/:project_id/costs` 由 operations 域提供，是消耗账本 `cost_entries` 之上的聚合接口，不返回逐条明细。`group_by` 必填，取值 `member`、`model` 或 `day`；query 用 `.strict()` 校验，多传参数直接判为输入错误。另接受 `from`、`to` 时间范围（`from` 不能晚于 `to`）和 `page`、`page_size` 分页，`page_size` 默认 20、上限 100。

响应为 `{ group_by, rows, totals, total, page, page_size }`。`rows` 每项是 `{ key, label, charged_points, unpriced_count, entry_count }`，按 `charged_points` 降序、`label` 升序、`key` 升序稳定排序；`total` 是过滤范围内的分组总数，`totals` 也按同一过滤范围整体统计，不随当前页变化。`unpriced_count` 显式给出未定价条目数，避免把缺价目的消耗静默算成 0。

本接口以积分（`charged_points`，整数）为唯一口径。生成侧的预估与授权仍以人民币分（`*_cost_fen`）记账，两者不互相换算；AI 对话的供应商成本也不静默折算成人民币或积分。

`cost_entries` 没有 `media_kind` 和 `episode_id`，因此图片、视频、其他的费用拆分和按集聚合都不提供，也不靠推断补齐。同类缺口在 `GET /api/v1/projects/:project_id/consumption/records` 的 `compatibility_gaps` 里对调用方显式声明。

## AI 调用审计

每条用户、模型和工具消息都保存在 `agent_messages`，模型消息额外记录状态、供应商、模型、令牌用量、供应商报告的美元成本、耗时和失败摘要；工具消息记录参数和结构化结果摘要。中断和失败不能标记为完成。

`GET /api/v1/projects/:project_id/ai-audit-logs?page=1&page_size=50` 仅允许项目所有者分页读取该项目日志，按创建时间和 ID 倒序稳定返回。`provider_cost_usd_micros` 与 `points_spent` 分开：前者是供应商报告成本的定点数，后者只有存在正式积分记账时才填写。

## 通用资产复制到个人资产

`POST /api/v1/assets/:asset_id/copy-to-personal` 把一份可见的通用资产复制为当前用户可编辑的个人快照。

- 只允许复制 `visibility=common` 且未删除的来源；来源不存在时返回 404。
- 幂等键固定为“当前用户 + 来源通用资产”。重复点击或并发重放返回同一个个人资产；首次创建返回 201，命中已有副本返回 200。
- 复制资产、有效变体和媒体元数据。媒体继续引用原 TOS bucket、对象 key、URL 与哈希，不重复上传或复制媒体文件。
- `copied_from_asset_entity_id` 保存直接来源；各层 `metadata.source_lineage` 保存关系和来源 ID。个人副本不能再次作为通用来源继续复制。
- 个人副本及其变体、媒体立即进入免审可用态；来源通用资产必须已通过审核。副本后续编辑不反向修改通用资产，授权范围仍保留来源快照。

## 导入通用资产为个人资产

`POST /api/v1/assets/import-personal` 接受 `{ asset_id }`，供资产中心把一份可见且已通过审核的通用资产导入当前用户个人库。它复用上面的数据库幂等键和媒体引用复制语义。

- 首次导入返回 201；响应 data 直接包含可展示的完整个人资产字段，并附加 `{ created, source_asset_id, copied_variant_count, copied_media_count }`。重复或并发重放返回 200、`created=false` 和同一资产。
- 首次新建的资产实体、有效变体与媒体投影均为免审可用态（`status=approved`、`approved=true`）。迁移 041 会把历史个人域投影归一为同一口径；幂等重放不重复写副本。
- 只复制资产、有效变体和媒体元数据；bucket、对象 key、URL 与 SHA-256 继续指向同一 TOS 对象，不上传或复制对象字节。
- 只允许未删除的 `visibility=common` 来源；个人副本、他人的个人资产和回收站资产不能作为来源。

## 已入库图片登记为分镜主图

`POST /api/v1/shots/:shot_id/media/from-asset` 接受 `{ asset_media_id }`，把一条已经持久化的图片资产媒体登记进既有 `media_results`，并立即写入 `shots.selected_image_result_id` 作为该分镜图片主版本。

- 当前用户必须是分镜所属项目的 owner。来源必须是未删除的图片媒体，且属于可见的通用资产或当前用户自己的个人资产；不能使用他人的个人资产、未绑定媒体、视频或回收站内容。
- 服务端只从 `asset_media` 读取 bucket、对象 key、URL、已有 SHA-256、格式和尺寸；不接受客户端提交存储地址，不读取或复制 TOS 对象。缺少完整 TOS 定位时返回状态冲突；来源没有历史哈希时保持 `null`，本迁移不伪造哈希或改写旧数据。
- `(shot_id, source_asset_media_id)` 是有效登记的数据库幂等键。首次登记并选主返回 201、`created=true`；重复或并发重放返回 200、`created=false` 和同一 `media_result_id`。
- 响应为 `{ shot_id, media_kind=image, media_result_id, selected_media_result_id, source_asset_media_id, created }`。已有生成产物仍使用 `POST /api/v1/shots/:shot_id/media/:media_id/set-primary`，不重复登记。
- `media_results.origin_kind` 区分 `generation` 与 `asset_media`。生成来源必须绑定 request、attempt 和 provider result key；资产来源必须只绑定 `source_asset_media_id` 与 `registered_by_user_id`。两种来源严格互斥，不创建第二张分镜媒体表。
- `shots.selected_image_result_id` 仍是当前图片主版本的唯一正式真值。shot-media 列表、受保护下载和交付清单都读取同一登记；资产来源的生成请求、尝试、供应商和模型字段为 `null`，预估生成费用为 0，不能伪装成一次模型调用。

## 轻量行为事件

`POST /api/v1/events` 接受 `{ event, props, ts }`，服务端从登录态绑定 `user_id`，并同时记录接收时间。

- `event` 使用稳定的小写标识，例如 `asset.search.submitted`；不能发送中文文案或临时 DOM 名称。
- `props` 必须是 JSON 对象且不超过 16 KB，不得放密码、token、完整提示词、媒体正文或其他不必要的敏感内容。
- `ts` 接受带时区的 ISO 时间或 Unix 毫秒时间；服务端以 PostgreSQL `timestamptz` 保存。
- 事件写入不影响主业务成功与否，不承担业务事实、计费事实或 Agent 审计事实。

`GET /api/v1/admin/events/summary` 仅管理员可用，支持 `event`、`user_id`、`from`、`to` 过滤，返回总数及按事件、用户、UTC 日期聚合的结果。该接口只回答使用趋势，不替代项目消耗、任务状态或正式审核记录。

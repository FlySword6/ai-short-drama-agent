# V0.1 接口合同

状态：冻结第一版。所有网页、CLI 和小龙虾工具共用本合同。

## 通用约定

- 前缀：`/api/v1`。
- 登录后使用 `Authorization: Bearer <token>`。
- JSON 字段使用 `snake_case`。
- 成功响应固定为 `{ "ok": true, "data": ... }`；列表的 `data` 同时包含 `items` 和 `count`。
- 失败响应固定为：

```json
{
  "ok": false,
  "error": {
    "code": "invalid_request",
    "message": "给用户看的简短原因",
    "retryable": false,
    "details": null
  }
}
```

- 未登录返回 `401`，没有权限返回 `403`，资源不存在返回 `404`，重复或状态冲突返回 `409`。
- 所有读取默认排除回收站内容，只有回收站接口读取软删除内容。

## 登录

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` | 本地 V0.1 创建账号 |
| POST | `/auth/login` | 返回 token、过期时间和用户 |
| POST | `/auth/logout` | 注销当前会话 |
| GET | `/auth/me` | 返回当前用户 |

登录请求：

```json
{"username":"alice","password":"********"}
```

登录成功：

```json
{
  "ok": true,
  "data": {
    "token": "只在本次响应返回",
    "expires_at": "2026-07-15T12:00:00.000Z",
    "user": {"id":"uuid","username":"alice","display_name":"Alice"}
  }
}
```

## 项目、集、场和分镜

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/projects` | 当前用户的项目列表、创建项目 |
| GET/PATCH/DELETE | `/projects/:project_id` | 项目详情、修改、移入回收站 |
| GET/POST | `/projects/:project_id/episodes` | 集列表、创建集 |
| GET/PATCH/DELETE | `/episodes/:episode_id` | 集详情、修改、移入回收站 |
| GET/POST | `/episodes/:episode_id/scenes` | 场列表、创建场 |
| PATCH/DELETE | `/scenes/:scene_id` | 修改场、移入回收站 |
| GET/POST | `/episodes/:episode_id/shots` | 分镜列表、创建分镜 |
| GET/PATCH/DELETE | `/shots/:shot_id` | 分镜详情、修改、移入回收站 |

分镜至少包含：`shot_no`、`scene_id`、`title`、`script_text`、`director_prompt`、`image_prompt`、`video_prompt`、`duration_seconds` 和 `sort_order`。

## 分镜 Excel

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/projects/:project_id/storyboard-imports/preview` | multipart 上传并返回预览 |
| GET | `/storyboard-imports/:import_id` | 重新读取预览和问题 |
| POST | `/storyboard-imports/:import_id/confirm` | 确认后一次写入集、场和分镜 |

预览响应必须包含标准化行、源行号、警告和错误。存在错误时不得确认；重复确认返回原确认结果，不重复写入。

## 资产

保留现有入库和语义检索接口，并增加登录和可见性过滤。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/asset-ingest/upload` | 上传 Excel 或图片资产 |
| POST | `/asset-ingest/json/assets` | JSON 批量入库 |
| POST | `/asset-search/semantic` | 按当前用户可见范围检索 |
| GET | `/assets` | 个人或通用资产列表和筛选 |
| GET/PATCH/DELETE | `/assets/:asset_id` | 详情、修改、移入回收站 |
| GET | `/assets/:asset_id/versions` | 变体和媒体版本 |
| POST | `/assets/:asset_id/media` | 上传一个媒体版本 |
| POST | `/assets/:asset_id/media/:media_id/set-primary` | 事务内切换主版本 |
| GET/POST | `/projects/:project_id/assets` | 项目资产列表、引用资产 |
| DELETE | `/projects/:project_id/assets/:ref_id` | 移除项目引用，不删除源资产 |

列表参数 `scope` 只允许 `personal/common/project`。`project` 必须同时传 `project_id`。

`POST /assets/:asset_id/media` 使用 multipart，文件字段为 `file`。可选字段：

- `title`：版本名称。
- `description`：版本说明。
- `is_primary`：`true/false` 或 `1/0`，不传时为 `false`。

服务端按文件内容解码图片，不依据扩展名或请求声明判断。上传成功后记录图片宽高、格式和 `sha256`。只有个人资产所有者可以上传；通用资产和他人的个人资产都是只读。`is_primary=true` 时，清空旧主版本和写入新主版本必须在同一个数据库事务中完成。数据库保存失败时，服务端应尽量删除本次刚上传的 TOS 对象。

`GET /assets?scope=project&project_id=<uuid>` 复用项目引用的访问权限。每项返回当前资产信息、项目引用编号、引用时锁定的媒体编号和所选媒体详情；没有锁定媒体时，页面显示当前主媒体，但 `selected_media` 仍为 `null`。

## 生成和任务

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/generations/estimate` | 只估算费用，不提交方舟 |
| POST | `/generation-quotes/:quote_id/confirm` | 明确确认10分钟内有效的生成报价单 |
| POST | `/generations` | 提交图片或视频生成 |
| GET | `/generations/:request_id` | 查询请求和全部尝试 |
| GET | `/projects/:project_id/generations` | 项目任务列表 |
| POST | `/generations/:request_id/retry` | 新建一个 attempt |
| POST | `/generations/:request_id/cancel` | 停止本地继续处理 |
| GET | `/shots/:shot_id/media` | 分镜的所有媒体版本 |
| POST | `/shots/:shot_id/media/:media_id/set-primary` | 切换主版本 |

传入完整生成输入时，`/generations/estimate` 会返回 `generation_quote_id`、`estimated_cost_fen`、`price_snapshot`、`status=pending_confirmation` 和 `expires_at`。只传 `media_kind/parameters/quantity` 时仍可做简单费用查询，但 `generation_quote_id` 为 `null`，不能用于提交。这个入口只创建来源为 `web` 的报价；助手和 CLI 必须使用各自入口创建报价，不能伪造 `source`。

完整估价请求：

```json
{
  "media_kind": "image",
  "project_id": "uuid",
  "episode_id": "uuid",
  "scene_id": "uuid",
  "shot_id": "uuid",
  "prompt": "分镜提示词",
  "reference_media_ids": ["uuid"],
  "parameters": {"ratio":"16:9","resolution":"2K"},
  "client_idempotency_key": "project-shot-image-client-uuid",
  "source": "web"
}
```

用户确认费用后调用 `POST /generation-quotes/:quote_id/confirm`。之后向 `/generations` 提交同一份生成输入，并额外传：

```json
{
  "generation_quote_id": "uuid"
}
```

报价单绑定当前用户、来源 `web/assistant/cli`、操作 `submit/retry`、完整规范化请求和当时单价快照。报价未确认、超过10分钟、输入变化或单价变化时都不会新建付费尝试。单价变化返回 `409 quote_stale`。同一报价和同一输入重复提交时返回第一次绑定的 attempt，不重复排队。

报价来源必须与提交入口严格一致。`web`、`assistant` 和 `cli` 报价不能串用；不一致时返回 `409 GENERATION_QUOTE_SOURCE_MISMATCH`，不消费报价，也不创建 attempt。

任务响应至少包含：`generation_request_id`、`current_attempt_id`、`status`、`attempt_no`、`provider_task_id`、`failure_reason`、`estimated_cost_fen`、`media_results`、`created_at` 和 `updated_at`。首次提交成功返回 `202`。

重试前必须重新调用 `/generations/estimate`，传 `action=retry`、`original_request_id`和 `source`，再确认新报价。重试提交必须包含 `generation_quote_id` 和 `client_idempotency_key`。报价会绑定估价时最新的 attempt；如果期间已经发生过其他重试，旧报价返回 `quote_stale`。

## 播放、下载和交付

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/episodes/:episode_id/playback` | 按分镜顺序返回主视频播放列表 |
| GET | `/media/:media_id/download` | 受登录保护的媒体下载 |
| GET | `/episodes/:episode_id/deliverables` | 交付清单 JSON |
| GET | `/episodes/:episode_id/deliverables.csv` | 交付清单 CSV |

交付清单记录项目、集、分镜、媒体版本、模型、生成参数、任务号、TOS 地址和预估费用。

## 回收站和看板

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/trash` | 当前用户项目和个人资产的回收站 |
| POST | `/trash/:kind/:id/restore` | 恢复 |
| DELETE | `/trash/:kind/:id` | 通过引用安全检查后永久删除 |
| GET | `/dashboard/summary` | 项目和全局生产数据聚合 |
| GET | `/projects/:project_id/costs` | 项目预估费用摘要与明细 |
| GET/PUT | `/cost-settings/unit-prices` | 查看或配置单价 |

所有登录用户都可以读取单价。只有用户名列入 `ADMIN_USERNAMES` 的本地账号可以修改；图片只接受 `billing_unit=image`，视频只接受 `billing_unit=second`，`unit_price_fen` 必须是 1 到 2147483647 的整数。

## 小龙虾助手

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/agent/sessions` | 新建并绑定当前上下文 |
| GET | `/agent/sessions/:session_id/messages` | 恢复会话 |
| POST | `/agent/sessions/:session_id/messages` | SSE 流式回复 |
| POST | `/agent/sessions/:session_id/generation-quotes/:quote_id/submit` | 用户点击按钮后确认并提交助手报价 |

服务端只注册四类工具：

1. `search_assets`：检索当前用户可见资产。
2. `add_project_asset`：向当前项目增加资产引用。
3. `generate_media`：向当前分镜提交图片或视频请求。
4. `get_generation_task`：查询当前用户有权查看的生成请求。

用户、项目和分镜由服务端会话注入，模型提供的同名参数一律忽略。没有 shell、任意文件和任意网络工具。

`generate_media` 第一次只生成来源为 `assistant` 的一次性报价。页面显示费用、过期时间和“确认费用并提交”按钮；只有用户点击按钮后，浏览器才调用专用提交接口。浏览器只传 `generation_quote_id`，服务端从报价单恢复并严格校验冻结的模型、提示词、参数、引用素材、项目和分镜，不再让模型生成一次确认指令，也不接受浏览器重传付费输入。

助手报价绑定当前用户和当前会话。重复点击使用同一个稳定幂等键，返回第一次绑定的 attempt，不重复排队或预留费用。

## CLI 兼容入口

V0.1 保留以下兼容入口：

- `POST /api/v1/create/image`
- `POST /api/v1/runs/sync`
- `GET /api/v1/runs/:run_id/status`

这三个入口保留现有 Python CLI 的顶层响应结构，不使用 `{ "ok": true, "data": ... }` 包装；失败响应仍使用统一错误结构。

- `create/image` 中旧字段 `scene_id` 按现有 CLI 文档解释为分镜 ID，并在服务端补齐项目、集和场上下文。提交仍进入 `generation_requests` 和 `generation_attempts`，不另写付费调用。
- 第一次调用只生成报价，返回 `status=confirmation_required`、`generation_quote_id`、准确到分的预估费用和过期时间；即使同时传了 `yes=true`，也不会提交生成任务。
- 确认时，用完全相同的生成参数再次调用，并同时传第一次返回的 `generation_quote_id` 和 `yes=true`（或 `cost_confirmed=true`）。只有布尔确认但没有报价单，不能提交任务；只有报价单但没有布尔确认时，返回 `409 cost_confirmation_required`。
- 报价单固定为 `source=cli`，并绑定当前用户、模型、参数、引用素材、数量和当时有效价格，默认十分钟过期。参数或价格变化、报价过期、他人报价、其他入口的报价、已经被其他任务使用的报价，都会被拒绝。
- 可传 `client_idempotency_key`。旧 CLI 没有该字段时，服务端根据当前用户和有效生成参数生成稳定幂等键；要用完全相同的参数新建另一个版本时，客户端必须传新的键。
- `reference_assets` 接收已经入库的资产 ID 或媒体 ID；传资产 ID 时使用其主媒体版本。不读取 CLI 所在电脑的本地文件。
- `wait` 只为旧参数兼容，接口立即返回当前状态；后续通过 `runs/:run_id/status` 查询，避免 HTTP 长连接超时。
- `runs/sync` 收到 `provider=mock` 时保存清单并明确返回 `status=mock` 和 `mock=true`。非 mock 清单必须带有当前用户可访问的 `generation_request_id`，否则拒绝同步，不能把本地成功状态当成真实成功。
- `runs/:run_id/status` 可以查询已同步清单，也可以直接用生成请求 ID 查询持久化生成状态。

报价阶段不会调用方舟，也不要求开启付费开关。网页、助手和 CLI 的确认提交都必须在写入 `pending` attempt 前检查：

- `ALLOW_PAID_GENERATION=true`
- `ARK_API_KEY`
- `TOS_BUCKET`
- `TOS_ENDPOINT` 或 `TOS_SDK_ENDPOINT`
- `TOS_ACCESS_KEY`
- `TOS_SECRET_KEY`
- `TOS_PUBLIC_BASE_URL`

付费开关关闭时返回 `403 paid_generation_disabled`；Ark、TOS 或公网媒体地址配置不完整时返回 `503 generation_service_unavailable`。两种情况都不创建 attempt。补齐配置后也不会有旧 `pending` 任务自动执行，调用方必须重新提交有效报价。

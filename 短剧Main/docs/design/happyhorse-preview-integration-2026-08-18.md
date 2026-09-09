# HappyHorse（快乐马）预览视频集成方案 v0.2（2026-08-18）

> 状态：设计稿，待裁后施工。本文不改变 `docs/contracts/v0.1.1/*` 合同；涉及合同口径的以合同为准。
> 供应商真源：阿里云百炼《HappyHorse-参考生视频 API 参考》（华北2 等五地域，异步两阶段）。
> 界面真源配套：`docs/design/prd-v2/lite-shots-page.md`（分镜详情右栏，v1.6.3 止）。
> v0.2 修订：预览弹窗线框入文（v0.1 误指向会话原型）；新增 §5 版本管理——不新建库时预览视频与正式（Seedance 等）视频如何同流共存。

## 0. 结论先行

1. **不需要新建预览视频数据库，也不需要新表/新迁移。** 预览 = 快乐马的一个低价快速**档**，走现有 `generation_requests → generation_attempts → media_results` 付费链；预览身份用两个 jsonb 空位承载：提交侧 `parameters.preview=true`（档 params 的合法键），结果侧 `media_results.metadata.preview=true`（`MediaResultMetadata` 扩一个可选键）。版本号、当前版、软删、回溯、记账全部复用。
2. **预览是付费动作**，一次点击一次任务，quote→confirm→create、预算/幂等/权限全走原链（§4 红线不撕口）。"预览"只描述"便宜、快、低清、带标记"，不描述"免费"或"旁路"。
3. **界面**：分镜详情右栏正式生成按钮**之前**加次级入口「预览视频」（outline，免费开窗）；弹窗内展示当前生成视频 + 相关版本（与右栏同一状态）+ 锁定参数 + estimate 实报；付费点击「生成预览（1 次任务）」在弹窗内。提示词不在弹窗出现——自动与右栏当前视频提示词一致（同一 `supplement_prompt` 组装函数，单一真相源）。线框见 §4。
4. **版本管理**：预览视频与正式视频同处一条版本流（同一 `media_results`、同一 version_no 序号），靠 `metadata.preview` 徽记区分，不拆流、不建第二套版本语义。细则见 §5。

## 1. 供应商 API 事实与现有架构映射

### 1.1 API 事实（摘自文档，施工前以文档最新版复核）

| 项 | 事实 |
|---|---|
| 模型 | `happyhorse-1.1-r2v` / `happyhorse-1.0-r2v` |
| 创建 | `POST {Workspace}.{region}.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis`，必带头 `X-DashScope-Async: enable`（缺则报 "current user api does not support synchronous calls"）、`Authorization: Bearer $DASHSCOPE_API_KEY` |
| 查询 | `GET .../api/v1/tasks/{task_id}`；轮询建议 ~15s；RPS 20 |
| 状态 | PENDING → RUNNING → SUCCEEDED / FAILED / CANCELED / UNKNOWN（task 不存在或 >24h） |
| 结果 | SUCCEEDED 时 `output.video_url`（MP4/H.264），**链接 24h 有效**；`usage.duration` 为计费时长 |
| 输入约束 | `input.media` **必选**，1–9 张 `reference_image`（JPEG/JPG/PNG/WEBP，短边≥400px，≤20MB，URL 或 base64）；`input.prompt` 用 `[Image N]` 按 media 数组顺序指代，≤2500 中文字符 |
| 参数 | `resolution` 480P/720P/1080P（默认 1080P）；`ratio` 16:9、9:16、3:4、4:3、4:5、5:4、1:1、9:21、21:9（默认 16:9）；`duration` 3–15 整数秒（默认 5）；`watermark` 默认 **true**（右下角 "Happy Horse"）；`seed` 可选 |
| 地域 | 模型/Endpoint/API Key 必须同地域，跨地域失败 |

### 1.2 映射到现有 GenerationProvider 接缝（零新机制）

| 供应商事实 | 现有接缝 | 说明 |
|---|---|---|
| 创建任务返回 `task_id` | `ProviderSubmissionAccepted{ providerTaskId, rawStatus }` | `submit()` 发 POST，带 `X-DashScope-Async: enable` |
| 查询状态 | `ProviderResultSnapshot.status` | PENDING→`pending`、RUNNING→`running`、SUCCEEDED→`succeeded`、FAILED→`failed`+`errorCode/errorMessage`、UNKNOWN→`unknownStatus:true`（现有恢复链按 unknown 处理） |
| `video_url`（24h） | `ProviderMediaResult.temporaryUrl` | 现有 persist 工人下载转存 TOS（`mediaDownload.ts` DNS 钉扎白名单需**新增** `dashscope-result.oss-cn-beijing.aliyuncs.com` 等结果域，安全边界，代码内硬编码口径不变） |
| `usage` | `ProviderResultSnapshot.usage` | 成本台账（`providerCost.ts`）已按 usage 记账 |
| 参考图 URL | `ProviderGenerationRequest.references[].url` | 与 ark/Seedance 同口径：TOS 受控原件公网直链；适配器校验 1–9 张，越界 `ProviderRequestError(rejected)` |
| 地域/Key/Workspace | 部署配置 | 仿 `factory.ts` newapi/openspeech 模式：`happyhorseApiKey` + `happyhorseBaseUrl`（`isApprovedHappyHorseUrl` 白名单校验）+ `actualModelId` 显式配置；**代码不猜 URL/model ID**（`modelProviderRegistry.ts:96-98` 口径） |

注册链（`factory.ts`）：`adapters.happyhorse = new HappyHorseGenerationProvider(...)` + `capabilities: [{ id: "happyhorse-1-1", actualModelId, providerId: "happyhorse" }]` + `companyProviderAllowlist` 增 `"happyhorse"`（`companyProviderPolicy.ts` 已预留该账号 id）。未配置时 capability 保持 `unconfigured`，界面不渲染入口（裁决 4 不摆死按钮）。

### 1.3 提示词指代翻译（唯一需要新写的纯函数）

平台冻结快照的参考寻址是 Seedance 口径（「图片1/图片2」前缀，`arkGenerationProvider.ts:395-405`）；HappyHorse 要 `[Image N]`。适配器内做**映射前缀追加**，不改写用户 prompt：

```
参考图对应：[Image 1]=图片1、[Image 2]=图片2、…。{用户原 prompt}
```

media 数组顺序 = 快照 image 参考顺序。纯函数单测覆盖：0 张（拒，media 必选）、1–9 张、>9 张（rejected）、非 image 参考过滤。v1 不做 prompt 自动改写。

### 1.4 模型登记与凭据配置：什么入库、什么进 env

快乐马有三层"登记"，各归各位，不混：

| 项 | 归属 | 说明 |
|---|---|---|
| 产品能力 `happyhorse-1-1` | 代码 CATALOG（`modelProviderRegistry.ts:88`，已存在） | 零改动；产品层稳定名 |
| 供应商真实 model ID `happyhorse-1.1-r2v` | **env，不入库** | `HAPPYHORSE_MODEL` → factory `ConfiguredCapability.actualModelId`；「代码不猜 model ID」（registry.ts:96-98），部署显式配置 |
| 档（params/价格/展示标签） | **入库** `pricing_rules.metadata.capability_tier` | 快乐马"入库"的部分就是档（见 §3）；`model_label` 只是展示标签，非凭据绑定 |
| LLM 能力表 `model_capabilities`（迁移 059） | **不需要** | 该表记**文本模型**的上下文/输出 token 上限，provider 校验只 `ark/minimax/col`（059:41-42）；视频生成模型不进网关，不消费此表 |
| API Key | **env** `HAPPYHORSE_API_KEY` | DashScope `Bearer sk-…`；本地开发写 `.env`（gitignore）；生产经 VKE IRSA KMS 凭据 `shortdrama/production` 注入（AGENTS.md §2 口径），不进代码/仓库/文档 |
| Endpoint | **env** `HAPPYHORSE_BASE_URL` | 业务空间域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`；**与 Key 同地域**（API 文档硬约束），`isApprovedHappyHorseUrl` 白名单校验 |
| 公司账户开关 | **env** `COMPANY_PROVIDER_ALLOWLIST` 增 `happyhorse` | 账户 id 在 `companyProviderPolicy.ts` 已预留；凭据不自动开通计费（R195-5 同口径） |

一句话：**入库的只有"档"（价格与参数组合），进 env 的是"密钥与真实 model ID"，LLM 能力表不碰。**

## 2. 数据库问题：不新建，用两个 jsonb 空位

### 2.1 提交侧 `parameters.preview`

- `capabilityTiers.ts` 的档 params 是 `z.record(scalar)`，`preview: true` 可登记进预览档 params。
- 后端 `providerParameters()`（video 分支，`capabilityTiers.ts:169-175`）**增一行** `preview: booleanValue(params.preview)`，使其成为 `GenerationParameters` 合法字段——否则 `requireTierMatchesInput` 的 `sameParameters` 全量比对（`capabilityTiers.ts:202-204`）会把客户端多带的键 422 掉。
- 前端 `tierSubmitInput()` 视频分支 `...rest` 已透传（`capability-tiers.ts:259-268`），**零改动**。
- 供应商适配层不发 `preview`（HappyHorse 请求体无此键，适配器按已知字段组 body，自然剥离）。

### 2.2 结果侧 `media_results.metadata.preview`

- `MediaResultMetadata`（`schema.ts:1301-1303`）扩 `preview?: boolean`——jsonb 可选键，**无迁移**。
- 转录点：generation 仓库把 `StoredGenerationMedia` 落成 `media_results` 行处，读 `request.parameters.preview === true` 写入 `metadata.preview`（与 `shot_version` 同层不同键）。
- 读侧：`shot-media` service 的版本视图（`service.ts:97-105`）增透 `preview` 字段；前端 `MediaVersion` 类型 + `api.ts` 映射各加一行。

### 2.3 否决的替代

- 新建 `preview_videos` 表：版本/当前版/软删/回溯/记账全要复制一遍，违反八条 2/4。否。
- `generation_requests` 加 `purpose` 列：要迁移+全流程改，而 jsonb 空位已够。否。
- 用 `version_label="预览"` 标记：标签用户可改，身份会漂。否。

## 3. 档登记（pricing_rules.metadata.capability_tier）

预览档示例（dev/test 先登，生产待运行时核实后）：

```json
{
  "tier_id": "happyhorse-preview-480p-5s",
  "media_type": "video",
  "display_name": "快乐马 · 预览",
  "model_label": "happyhorse-1.1-r2v",
  "provider_label": "阿里云百炼",
  "status": "active",
  "params": { "resolution": "480P", "ratio": "9:16", "duration_seconds": 5, "watermark": false, "preview": true, "quantity": 1 },
  "price": { "unit": "per_second", "points": 8 }
}
```

- `watermark:false` 走现有 `providerParameters` 字段，预览不带 "Happy Horse" 水印；正式档不写 `preview`（或 `false`）。
- 前端识别预览档 = `params.preview === true`：正式级联**过滤掉**预览档（正式流更干净、误提交归零）；预览弹窗只取预览档。

## 4. 前端（Lite 分镜详情）

### 4.1 右栏底部动作行（入口）

```
┌─ 右栏底部 ─────────────────────────────────────────────────────┐
│ 参数行:9:16 · 1080p · 5s · 80 积分/秒(正式档级联,不含预览档)       │
│ ┌──────────  ┌─────────────────────────────┐                 │
│ │〔预览视频〕│  │ 〔 生成视频(1 次任务)〕primary  │                 │
│ └──────────  └─────────────────────────────┘                 │
│  ↑ 新增次级(outline),在正式生成之前;点开=免费动作,不付费          │
└────────────────────────────────────────────────────────────────┘
```

### 4.2 预览弹窗（点「预览视频」打开）

```
┌─ Dialog · 预览视频 ──────────────────────────────────────────────┐
│ ┌─ 播放器 ────────────────────────────────────────────────────┐ │
│ │                 ▶  当前版 v2 · 雨夜版                        │ │ ← 当前生成视频,同右栏播放器
│ └─────────────────────────────────────────────────────────────┘ │
│ 版本  [v1]  [v2·雨夜版 ✓当前]  [v3 预览]            横向滚动 →    │ ← 相关版本,预览版带徽记
│ ─────────────────────────────────────────────────────────────── │
│ 提示词   与右栏当前视频提示词一致(此处不可编辑)                    │
│ 模型     快乐马(锁定)     参数  480p · 5s · 9:16(锁定)           │
│ 参考资产  N 个(服务端自动解析,与正式生成同口径 8.9)               │
│ 预计     40 积分(开窗时 estimate 实报)                           │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │                〔 生成预览(1 次任务)〕                        │ │ ← 付费的那一次点击在窗内
│ └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 4.3 行为口径

- 弹窗播放器 + 版本条 = 右栏同一 `selectedVideo`/`videos` 状态（chip 可点切换，走同一 handler），无第二份数据、无同步问题；版本管理语义全部见 §5。
- 入口闸门复用 `generationGate`（提示词空等同一句人话）；已有进行中视频任务禁用（单任务槽位预览/正式共用）；快乐马未配置不渲染入口；参考快照为空（无定稿图/参考图）禁用——HappyHorse `media` 必选 1–9 张。
- 提交后弹窗不关：行内轮询/失败人话与右栏同源渲染；出片后 `[vN 预览]` chip 进版本条并自动选中可播。
- 设当前版/软删/回溯仍在现有版本详情弹窗，预览弹窗不叠这些功能。
- demo 模式：`lite-demo-fixtures` 增快乐马预览档 fixture（真栈不回落，裁决 4）。
- 完整版不受影响：级联过滤预览档，入口只在 Lite 页渲染。

## 5. 版本管理：预览视频与正式（Seedance 等）视频同流共存

**不新建库的前提是把"两种视频"放进同一条版本流，只加一个身份标记。** 现有版本语义（`schema.ts:1296-1299`、`shot-media/service.ts:97-105`）本来就与模型无关——version_no 按同 `shot_id + media_kind='video'` 的 `created_at` 升序**查询时计算、不落库**，所以预览版与正式版天然按时间交错编号，无需任何序号机制改动。

### 5.1 逐维对照

| 维度 | 预览视频（快乐马） | 正式视频（Seedance 等） | 共用机制 |
|---|---|---|---|
| 存储 | `media_results`（media_kind=video，origin_kind=generation） | 同左 | 同表同行，无第二存储 |
| 版本号 | 与正式版同一 created_at 升序序号（如 v3） | 同左 | 查询时计算，不落库 |
| 身份识别 | `metadata.preview=true` → chip/弹窗带「预览」徽记 | 无该键 → 无徽记；模型名在版本详情回溯里看 | `MediaResultMetadata` 一个可选键 |
| 默认播放 | 参与 `latest_default`（最新一行即默认选中，含预览） | 同左 | 现有选择逻辑不改；徽记如实告知身份 |
| 当前版 | 可设当前版（用户满意预览就直接用） | 同左 | `shots.selected_video_result_id` + 现有 set-primary/swap 动作 |
| 删除 | 软删（`deleted_at`）；当前版须先换当前版 | 同左 | 现有守卫不改（Lite R1 禁硬删） |
| 回溯 | `generation_request_id` → 提示词/模型（快乐马）/参数（含 preview=true）/参考快照 | 同左（模型为 Seedance 等） | 版本详情弹窗现有回溯，天然区分来源 |
| 对后续生成的影响 | 不进参考链（视频生成参考走定稿图 primary image，`buildLiteVideoReferences`） | 同左 | 预览设成当前版也不污染正式生成输入 |
| 记账 | 按请求 `charged_points`（预览档单价低） | 同左 | 预算/台账/限额全复用 |
| 任务槽位 | 同镜视频单任务槽位与正式共用，进行中互斥 | 同左 | 现有 videoTask 行内状态机 |
| 交付/打包 | **待裁**：倾向按 `metadata.preview` 过滤，交付只认正式版或当前版 | 正常进交付 | 实施前核 `shot_delivery` 取数口径 |
| 完整版视图 | 同一数据源；完整版版本 UI 原样列出所有版本，身份经回溯 metadata 可查 | 同左 | 不拆数据、不做两套读 |

### 5.2 为什么不拆成两条版本流

拆流（预览独立列表/独立序号）意味着当前版、删除守卫、回溯、交付、播放器选择全部要写第二套，且"预览转正式使用"（设当前版）变成跨流搬运——信息量没增加，机制翻倍。同流 + 徽记是共存所需的最小信息：用户唯一需要知道的"这版是便宜快出的预览"由徽记和回溯承担，其余语义与正式版完全一致。

### 5.3 边界与风险

- 交错编号会让正式版号"跳号感"（v2 正式 → v3 预览 → v4 正式）——接受，version_no 本就是时间序号而非质量序号，徽记补足语义。
- 预览设成当前版后，播放器/交付（若不过滤）都用预览——这是用户显式动作，语义正确；交付过滤待裁项兜底。
- 历史数据无 `metadata.preview` 键 → 读侧按 falsy 处理，旧版本一律视为正式，不回填。

## 6. 红线核对

- **§4 付费**：预览=付费动作；一次点击一次任务；预算/幂等/权限/记账全复用；不自动、不批量、不夜间。
- **Lite R1**：写 `generation_requests`/`media_results` 在 Lite 白名单内；无硬删（软删复用）。
- **Lite R3**：请求体仍是现有 zod 形状（`parameters` 为 `z.record`，`preview` 经 `providerParameters` 合法化）；合同快照测试（`lite-shot-detail-page.test.ts` 口径）增一个带 `preview` 档的 Lite 提交体用例；真实付费全流程走人工冒烟报告，不进 CI。
- **合同**：`model-and-paid-task.md` "只有真实查询供应商后才能把 ID 标记为可用"——dev 环境真跑一次 200 后才把 capability 标 available。

## 7. 24h 时效风险（无需新机制）

- `video_url` 24h：现有 persist 工人在 SUCCEEDED 后立即下载转存 TOS；下载失败走现有 lease 恢复重试；真超 24h 不可恢复 → attempt failed + 现有失败处理入口（人话+重试）。轮询总上限 30 分钟（`lite-generation.ts`），远小于 task_id 24h。
- 参考图 URL：TOS 受控原件直链，无时效问题（与 Seedance 同）。

## 8. 施工切片与验收

1. **适配器**：`src/modules/generation/provider/happyhorseGenerationProvider.ts`（submit/query/`[Image N]` 前缀纯函数/1–9 张校验）+ `factory.ts` 注册 + `HAPPYHORSE_API_KEY`/`HAPPYHORSE_BASE_URL`/`HAPPYHORSE_MODEL` 三个 env 键（本地 `.env`、生产走 KMS 凭据，见 §1.4）+ `mediaDownload.ts` 白名单增结果域。单测：请求体形状、状态映射、指代翻译、越界拒。
2. **preview 字段**：`providerParameters` 增 `preview`；`MediaResultMetadata` 扩键；media 落库转录；版本视图透传。单测：tier 匹配带 preview、metadata 转录。
3. **档登记**：dev/test 登预览档；`GET /capabilities` 返回 available 需真跑核实。
4. **前端**：入口+弹窗+「预览」徽记+fixture+合同快照用例；typecheck/build/门禁。
5. **冒烟**：真栈一次点击出预览版 → 版本条带徽记 → 设当前版 → 回溯，出带日期报告（≤14 天口径）。

## 9. 非目标 / 待裁

- 交付/打包是否过滤 `metadata.preview`：实施前核 `shot_delivery` 取数口径再定，倾向过滤、只认正式/当前版。
- 预览免费配额：二期提案，v1 不做。
- 弹窗内提示词临时改写不写回：v1 不做（只读同源）。
- `happyhorse-1.0-r2v` 旧模型：v1 只接 1.1，1.0 不登记。

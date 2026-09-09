# 音频素材入库 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
| --- | --- | --- |
| 删除 | `migrations/067_audio_ingest_tasks.sql` | 移除错误的 ASR 任务表迁移 |
| 修改 | `migrations/ledger.json` | 删除错误迁移登记 |
| 修改 | `src/db/schema.ts` | 删除 `audioIngestTasks` schema 和 `AudioIngestTaskRow` |
| 修改 | `src/config/env.ts` | 删除 `VOLC_LAS_AUDIO_ASR_ENABLED` |
| 修改 | `src/app.ts` | 删除音频入库 worker 生命周期 |
| 修改 | `src/server.ts` | 删除生产启动音频入库 worker 选项 |
| 修改 | `src/http/routes.ts` | 注册新版音频入库 routes，不传 worker |
| 修改 | `src/modules/audio-ingest/types.ts` | 音频分类、metadata、输入输出类型 |
| 新建 | `src/modules/audio-ingest/metadata.ts` | 音频 metadata、tags、检索文本构建 |
| 修改 | `src/modules/audio-ingest/repository.ts` | 同步创建资产、媒体和来源记录 |
| 修改 | `src/modules/audio-ingest/service.ts` | 校验、TOS 上传/检查、创建资产、向量同步 |
| 修改 | `src/modules/audio-ingest/routes.ts` | 两个同步创建端点 |
| 删除 | `src/modules/audio-ingest/worker.ts` | 移除音频解析 worker |
| 删除 | `src/modules/audio-ingest/normalizer.ts` | 移除 ASR transcript/utterance normalizer |
| 删除 | `src/modules/audio-ingest/migration.test.ts` | 移除任务表迁移测试 |
| 修改 | `src/modules/audio-ingest/repository.test.ts` | 覆盖同步创建与落库分类 |
| 新建/修改 | `src/modules/audio-ingest/metadata.test.ts` | 覆盖 metadata 清洗、字段组合和检索文本 |
| 修改 | `src/modules/audio-ingest/service.test.ts` | 覆盖上传/登记、格式、向量失败不回滚 |
| 修改 | `src/modules/audio-ingest/routes.test.ts` | 覆盖两个端点、201、错误请求和无任务端点 |
| 按需删除 | `src/integrations/volcLasOperatorClient.ts` | 若仅音频 ASR 使用，则删除；若视频仍使用，则保留为视频能力 |
| 按需删除 | `src/integrations/volcLasOperatorClient.test.ts` | 跟随上一项处理 |
| 修改 | `frontend/shortdrama-rag-demo/src/types.ts` | 同步音频入库分类、metadata 和返回类型 |
| 修改 | `frontend/shortdrama-rag-demo/src/api.ts` | 同步上传响应解析和埋点，不再读取 `task_id` |
| 修改 | `frontend/shortdrama-rag-demo/src/pages/global-pages.tsx` | 同步音频入库表单分类和字段 |
| 修改 | `frontend/shortdrama-rag-demo/src/pages/material-agent-page.tsx` | 同步素材入口的音频入库表单 |
| 修改 | `frontend/shortdrama-rag-demo/src/*audio*.test.ts`、`frontend/shortdrama-rag-demo/src/asset-api.test.ts` | 同步前端契约测试 |

## T1: 清理错误的 ASR 数据结构

**文件：** `migrations/067_audio_ingest_tasks.sql`、`migrations/ledger.json`、`src/db/schema.ts`
**依赖：** 无

**步骤：**

1. 删除 `migrations/067_audio_ingest_tasks.sql`。
2. 从 `migrations/ledger.json` 删除该迁移登记。
3. 从 `src/db/schema.ts` 删除 `audioIngestTasks` table、索引定义和 `AudioIngestTaskRow` 导出。
4. 搜索 `audioIngestTasks` 和 `AudioIngestTaskRow`，确认只剩待改的旧音频模块引用。

**验证：** `rg -n "audioIngestTasks|AudioIngestTaskRow|audio_ingest_tasks" src migrations` 只允许命中待删除或待改的音频模块文件；完成全任务后应无命中。

## T2: 清理错误的 ASR 运行时接线

**文件：** `src/config/env.ts`、`src/app.ts`、`src/server.ts`、`src/http/routes.ts`、`src/modules/audio-ingest/worker.ts`
**依赖：** T1

**步骤：**

1. 删除 `VOLC_LAS_AUDIO_ASR_ENABLED` 配置解析和 `settings.volcLasAudioAsrEnabled`。
2. 从 `src/app.ts` 删除 `AudioIngestWorker` import、`startAudioIngestWorker` 选项和生命周期注册。
3. 从 `src/server.ts` 删除生产启动音频入库 worker 的选项。
4. 从 `src/http/routes.ts` 删除 `AudioIngestKickPort` 类型和向 `registerAudioIngestRoutes` 传 worker 的代码。
5. 删除 `src/modules/audio-ingest/worker.ts`。

**验证：** `rg -n "VOLC_LAS_AUDIO_ASR_ENABLED|volcLasAudioAsrEnabled|AudioIngestWorker|startAudioIngestWorker|AudioIngestKickPort" src` 无命中。

## T3: 切换音频入库类型

**文件：** `src/modules/audio-ingest/types.ts`
**依赖：** T1、T2

**步骤：**

1. 删除任务状态、任务视图、ASR normalized 相关类型。
2. 定义 `AudioAssetCategory = "音色" | "背景音乐"`。
3. 定义 `AudioSourceFormat = "wav" | "mp3" | "ogg" | "opus"`。
4. 定义 `AudioAssetMetadata` 联合类型：音色分支包含 `kind="voice"`、`voiceTraits`、`speakingStyle`；背景音乐分支包含 `kind="background_music"`、`musicTraits`、`tempo`、`usageScene`。
5. 定义 `SubmitAudioAssetInput`、`SubmitUploadedAudioAssetInput` 和 `CreatedAudioAsset`。

**验证：** `npm run typecheck` 能识别新类型，且不会再要求任务状态字段。

## T4: 实现 metadata 与检索文本 builder

**文件：** `src/modules/audio-ingest/metadata.ts`、`src/modules/audio-ingest/metadata.test.ts`
**依赖：** T3

**步骤：**

1. 实现自由标签清洗：trim、去空、去重、限制单项长度和总数。
2. 实现 `buildAudioAssetMetadata`：按 `category` 接受对应字段，拒绝或忽略另一类字段。
3. 实现 `buildAudioStyleTags`：音色使用 `voice_traits/speaking_style`，背景音乐使用 `music_traits/tempo/usage_scene`。
4. 实现 `buildAudioAssetVectorText`：拼接名称、分类、通用描述和音频专属字段。
5. 确保 `description` 不写入 `metadata.audio_asset`。

**验证：** `node --import tsx --test src/modules/audio-ingest/metadata.test.ts` 通过，覆盖音色、背景音乐、去重、空字段、描述不进 metadata。

## T5: 改写 repository 为同步资产创建

**文件：** `src/modules/audio-ingest/repository.ts`、`src/modules/audio-ingest/repository.test.ts`
**依赖：** T3、T4

**步骤：**

1. 删除 `claimNextQueued`、`recordOperatorTask`、`markSucceeded`、`markFailed`、`retryFailed`、`requeueInterrupted`、`listRecentByUser`、`toAudioIngestTaskView`。
2. 将 repository 类改名或改职责为 `AudioAssetIngestRepository`。
3. 实现 `createAudioAsset`，在一个事务里创建 `asset_entities`、`asset_media`、`media_provenance_subjects`。
4. 资产固定写 `asset_kind=audio`、`category=音色/背景音乐`、`role=null`、`usage_mode=null`、`visibility=personal`、`approved=true`、`status=approved`。
5. 媒体固定写 `media_kind=audio`、`format=wav/mp3/ogg/opus`、`metadata.source=audio_asset_ingest`。
6. 将通用描述写入 `asset_entities.intro` 和 `asset_media.description`，不复制到 metadata。
7. 将检索文本写入 `asset_entities.appearance` 和 `asset_media.metadata.vector_text`。

**验证：** `node --import tsx --test src/modules/audio-ingest/repository.test.ts` 通过，覆盖资产落库、媒体落库、metadata、来源记录和无任务表写入。

## T6: 改写 service 为同步入库

**文件：** `src/modules/audio-ingest/service.ts`、`src/modules/audio-ingest/service.test.ts`
**依赖：** T3、T4、T5

**步骤：**

1. 删除 LAS client、ASR 常量、poll、`processNextQueued`、`get/listRecent/retry/requeueInterrupted`。
2. 实现 `submit`：校验已有 TOS 音频、调用 `headObject`、构建 metadata、创建资产。
3. 实现 `submitUploadedFile`：校验单文件、上传 TOS、复用 `submit` 的创建流程。
4. 支持 `wav/mp3/ogg/opus`，拒绝 `m4a/aac/flac/pcm`，不转码。
5. 成功创建后调用 `VectorSyncService.syncEntity`。
6. 捕获向量同步错误，只记录日志，不影响 `CreatedAudioAsset` 返回。

**验证：** `node --import tsx --test src/modules/audio-ingest/service.test.ts` 通过，覆盖音色、背景音乐、上传、已有对象、非法格式、向量失败不回滚、没有 LAS 调用。

## T7: 改写 routes 为两个创建端点

**文件：** `src/modules/audio-ingest/routes.ts`、`src/modules/audio-ingest/routes.test.ts`、`src/http/routes.ts`
**依赖：** T6

**步骤：**

1. 保留 `POST /api/v1/asset-ingest/audio`。
2. 保留 `POST /api/v1/asset-ingest/audio/upload`。
3. 删除 `GET /api/v1/audio-ingest-tasks`、`GET /api/v1/audio-ingest-tasks/:task_id`、`POST /api/v1/audio-ingest-tasks/:task_id/retry`。
4. route 层使用 Zod 校验 snake_case 请求体。
5. 音色请求只接受 `category=音色` 搭配 `voice_traits/speaking_style`。
6. 背景音乐请求只接受 `category=背景音乐` 搭配 `music_traits/tempo/usage_scene`。
7. 成功响应使用 HTTP `201` 和 `{ asset_id, media_id, storage_bucket, storage_path, storage_url }`。
8. 注册 routes 时不再接受 worker dependency。

**验证：** `node --import tsx --test src/modules/audio-ingest/routes.test.ts` 通过，覆盖 201、400、401、multipart 单文件、任务端点 404。

## T8: 处理通用 LAS client 的归属

**文件：** `src/integrations/volcLasOperatorClient.ts`、`src/integrations/volcLasOperatorClient.test.ts`、`src/integrations/volcLasVideoUnderstanding.ts`
**依赖：** T6

**步骤：**

1. 搜索 `VolcLasOperatorClient` 的引用。
2. 如果只有音频模块引用，则删除 client 和测试。
3. 如果视频模块引用，则保留 client，确认它只服务视频理解，不被音频模块引用。
4. 不在本任务里改变视频入库 API、payload 或状态语义。

**验证：** `rg -n "las_asr|AUDIO_ASR|audio.*VolcLasOperatorClient|VolcLasAudio" src` 无命中；若保留 client，`node --import tsx --test src/modules/video-ingest/*.test.ts src/integrations/volcLasOperatorClient.test.ts` 通过。

## T9: 同步前端 API 类型和解析

**文件：** `frontend/shortdrama-rag-demo/src/types.ts`、`frontend/shortdrama-rag-demo/src/api.ts`、`frontend/shortdrama-rag-demo/src/asset-api.test.ts`
**依赖：** T7

**步骤：**

1. 将前端 `AudioIngestCategory` 改为 `音色 | 背景音乐`。
2. 将音频入库返回类型改为创建完成结果，删除 `taskId/status`。
3. API 解析读取 `asset_id/media_id/storage_bucket/storage_path/storage_url`。
4. 上传埋点改为记录 asset/media 信息，不再记录 `task_id`。
5. 前端契约测试同步 201 响应和无任务字段。

**验证：** `npm --prefix frontend/shortdrama-rag-demo test -- asset-api` 或项目现有等价前端测试命令通过。

## T10: 同步前端音频入库表单

**文件：** `frontend/shortdrama-rag-demo/src/pages/global-pages.tsx`、`frontend/shortdrama-rag-demo/src/pages/material-agent-page.tsx`、相关前端测试
**依赖：** T9

**步骤：**

1. 分类下拉只显示 `音色` 和 `背景音乐`。
2. 选择 `音色` 时展示 `voice_traits` 和 `speaking_style` 输入。
3. 选择 `背景音乐` 时展示 `music_traits`、`tempo` 和 `usage_scene` 输入。
4. 提交 payload 使用 snake_case 字段。
5. 成功提示改为“已创建音频素材”，不展示任务排队状态。

**验证：** 相关前端测试通过；手动渲染页面时，音色和背景音乐两种表单不会出现 ASR、转写或任务文案。

## T11: 全仓残留扫描

**文件：** 全仓相关文件
**依赖：** T1-T10

**步骤：**

1. 搜索旧 ASR 字段和端点。
2. 搜索旧分类。
3. 搜索旧任务返回字段。
4. 确认音频模块没有创建任务表、没有 worker、没有 LAS ASR 调用。

**验证：**

```bash
rg -n "audio_ingest_tasks|AudioIngestTask|audio-ingest-tasks|las_asr|AUDIO_ASR|transcript|utterances|VOLC_LAS_AUDIO_ASR|queued|processing|retry" src frontend/shortdrama-rag-demo/src migrations docs/audio-ingest
rg -n "人声|音效|音乐|其他" src/modules/audio-ingest frontend/shortdrama-rag-demo/src docs/audio-ingest
```

第一条只允许在“明确不做/删除”的文档上下文或非音频业务中出现；第二条不允许作为音频入库分类枚举出现。

## T12: 终局门禁

**文件：** 全仓相关文件
**依赖：** T1-T11

**步骤：**

1. 运行架构门禁。
2. 运行类型检查。
3. 运行 Node 测试。
4. 运行构建。
5. 如果全量 `npm test` 因既有数据库环境缺失失败，记录失败套件和原因，不把它伪装成通过。

**验证：**

```bash
npm run check:architecture
npm run typecheck
npm run test:node
npm run build
```

## 执行顺序

```text
T1 ─ T2 ─ T3 ─ T4 ─ T5 ─ T6 ─ T7 ─ T8 ─ T9 ─ T10 ─ T11 ─ T12
```

## 明确不在本任务内

- 不做 ASR。
- 不做自动音色识别。
- 不做自动背景音乐识别。
- 不做自动打标。
- 不新增音频任务表。
- 不启动音频解析 worker。
- 不提供音频任务查询或重试接口。
- 不转码。
- 不接收 `m4a/aac/flac/pcm`。
- 不做片段级向量检索。
- 不做额外 LLM 丰富。
- 不清洗历史 PostgreSQL 脏分类。
- 不在本任务里修正视频入库分类落库。

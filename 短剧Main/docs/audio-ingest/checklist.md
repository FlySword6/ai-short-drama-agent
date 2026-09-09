# 音频素材入库 Checklist

> 每一项都要能通过运行测试、查看响应或检查数据库结果验证。V0.1.1 音频素材入库不做 ASR、不做自动识别、不触发付费生成。

## 实现完整性

- [ ] 已删除错误的 `audio_ingest_tasks` 迁移和 ledger 登记。（验证：`rg -n "audio_ingest_tasks" migrations migrations/ledger.json` 无命中）
- [ ] `src/db/schema.ts` 不再导出 `audioIngestTasks` 或 `AudioIngestTaskRow`。（验证：`rg -n "audioIngestTasks|AudioIngestTaskRow" src/db/schema.ts` 无命中）
- [ ] 音频入库模块不再包含 ASR normalizer、任务 worker 或任务迁移测试。（验证：`Test-Path src/modules/audio-ingest/normalizer.ts`、`Test-Path src/modules/audio-ingest/worker.ts`、`Test-Path src/modules/audio-ingest/migration.test.ts` 均为 false）
- [ ] 音频入库服务不依赖 LAS client 或 ASR 环境变量。（验证：`rg -n "LAS|las_asr|AUDIO_ASR|VOLC_LAS_AUDIO_ASR|VolcLas" src/modules/audio-ingest src/config/env.ts` 无命中）
- [ ] 应用启动不再注册音频入库 worker。（验证：`rg -n "AudioIngestWorker|startAudioIngestWorker|AudioIngestKickPort" src/app.ts src/server.ts src/http/routes.ts` 无命中）
- [ ] 保留两个音频创建端点并接入总路由。（验证：routes 测试和 `rg -n "asset-ingest/audio" src/http src/modules/audio-ingest`）

## API 契约

- [ ] `POST /api/v1/asset-ingest/audio` 可登记已有 TOS 音频并返回 HTTP `201`。（验证：routes 测试）
- [ ] `POST /api/v1/asset-ingest/audio/upload` 一次只接收一个音频文件，成功后返回 HTTP `201`。（验证：routes 测试）
- [ ] 成功响应只包含创建完成信息：`asset_id`、`media_id`、`storage_bucket`、`storage_path`、`storage_url`。（验证：routes/API 测试断言没有 `task_id` 和 `status=queued`）
- [ ] 未登录访问音频入库端点返回 401。（验证：routes 测试）
- [ ] 请求体多余字段、非法 UUID、非法 category、缺少音频文件或字段类型错误返回 400 或项目统一错误信封。（验证：routes 测试）
- [ ] `GET /api/v1/audio-ingest-tasks`、`GET /api/v1/audio-ingest-tasks/:task_id`、`POST /api/v1/audio-ingest-tasks/:task_id/retry` 不存在。（验证：routes 测试返回 404 或路由未注册）

## 数据与分类

- [ ] 新增音频资产固定写入 `asset_kind = audio`。（验证：repository 测试断言落库值）
- [ ] 新增音频媒体固定写入 `media_kind = audio`。（验证：repository 测试断言落库值）
- [ ] `category` 只允许 `音色 | 背景音乐`。（验证：route/service 测试提交非法 category 返回 400）
- [ ] 普通音频入库写入 `role = null`、`usage_mode = null`。（验证：repository 测试断言落库值）
- [ ] 第一版只创建个人资产，写入 `visibility = personal`、`approved = true`、`status = approved`。（验证：repository 测试断言落库值）
- [ ] `voice / sound / music` 不作为新增 `asset_kind` 写入。（验证：repository 测试和代码搜索）
- [ ] 通用描述只写入资产/媒体已有描述字段，不复制到 `metadata.audio_asset`。（验证：metadata/repository 测试）

## 音频格式

- [ ] 接受 `wav/mp3/ogg/opus`。（验证：service/routes 测试分别提交四种格式成功）
- [ ] 拒绝 `m4a/aac/flac/pcm`。（验证：service/routes 测试返回 400）
- [ ] 系统不做转码。（验证：代码检查无转码调用，测试断言上传后直接使用原始格式）

## 音色 Metadata

- [ ] 音色入库请求可提交 `voice_traits` 和 `speaking_style`。（验证：routes/service 测试）
- [ ] 音色 metadata 保存 `kind=voice`、`voice_traits`、`speaking_style`。（验证：metadata/repository 测试）
- [ ] 音色 metadata 不包含 `music_traits`、`tempo`、`usage_scene` 或 `description`。（验证：metadata/repository 测试）
- [ ] `voice_traits` 会 trim、去空、去重并限制长度和数量。（验证：metadata 测试）

## 背景音乐 Metadata

- [ ] 背景音乐入库请求可提交 `music_traits`、`tempo` 和 `usage_scene`。（验证：routes/service 测试）
- [ ] 背景音乐 metadata 保存 `kind=background_music`、`music_traits`、`tempo`、`usage_scene`。（验证：metadata/repository 测试）
- [ ] 背景音乐 metadata 不包含 `voice_traits`、`speaking_style` 或 `description`。（验证：metadata/repository 测试）
- [ ] `music_traits` 会 trim、去空、去重并限制长度和数量。（验证：metadata 测试）

## 检索与向量

- [ ] 音色资产检索文本包含名称、`音色`、通用描述、`voice_traits` 和 `speaking_style`。（验证：metadata/service 测试）
- [ ] 背景音乐资产检索文本包含名称、`背景音乐`、通用描述、`music_traits`、`tempo` 和 `usage_scene`。（验证：metadata/service 测试）
- [ ] 入库成功后触发 `VectorSyncService.syncEntity`。（验证：service 测试）
- [ ] 向量同步失败只记录日志，不回滚 PostgreSQL 资产和媒体创建结果。（验证：service 测试）
- [ ] 不生成片段级向量。（验证：代码搜索无音频片段向量写入）

## 前端同步

- [ ] 前端音频入库分类只展示 `音色` 和 `背景音乐`。（验证：前端测试或渲染检查）
- [ ] 选择 `音色` 时提交 `voice_traits` 和 `speaking_style`，不提交背景音乐字段。（验证：前端测试）
- [ ] 选择 `背景音乐` 时提交 `music_traits`、`tempo` 和 `usage_scene`，不提交音色字段。（验证：前端测试）
- [ ] 前端上传成功提示为创建完成，不展示排队、处理中、重试或 ASR 文案。（验证：前端测试或渲染检查）
- [ ] 前端 API 解析不再要求 `task_id`。（验证：`frontend/shortdrama-rag-demo/src/asset-api.test.ts` 通过）

## 回归与边界

- [ ] 不复用 `audio_versions` 承载外部音频素材入库。（验证：代码检查和测试）
- [ ] 不创建任务表、任务状态、任务列表或任务重试能力。（验证：残留扫描）
- [ ] 不调用 LAS 音频 ASR。（验证：残留扫描和 service 测试）
- [ ] 不保存 transcript 或 utterances。（验证：残留扫描和 metadata 测试）
- [ ] 不做自动音色识别、自动背景音乐识别或自动打标。（验证：代码检查无相关模型/供应商调用）
- [ ] 不做额外 LLM 丰富。（验证：代码检查无音频入库 LLM 调用）
- [ ] 不清洗历史 PostgreSQL 脏分类。（验证：迁移文件不包含历史 update）
- [ ] 不在本任务里修改视频 `category/role/usage_mode` 落库口径。（验证：git diff 检查）

## 残留扫描

- [ ] 旧 ASR 主线无实现残留。（验证：`rg -n "audio_ingest_tasks|AudioIngestTask|audio-ingest-tasks|las_asr|AUDIO_ASR|transcript|utterances|VOLC_LAS_AUDIO_ASR|AudioIngestWorker|startAudioIngestWorker" src frontend/shortdrama-rag-demo/src migrations` 无音频入库实现命中）
- [ ] 旧分类不再作为音频入库枚举出现。（验证：`rg -n "人声|音效|音乐|其他" src/modules/audio-ingest frontend/shortdrama-rag-demo/src docs/audio-ingest` 不出现旧枚举定义）
- [ ] 音频入库成功响应无任务字段。（验证：`rg -n "task_id|queued|retry" src/modules/audio-ingest frontend/shortdrama-rag-demo/src/api.ts frontend/shortdrama-rag-demo/src/types.ts` 不出现音频入库响应字段）

## 编译与测试

- [ ] 架构门禁通过。（验证：运行 `npm run check:architecture`）
- [ ] 类型检查通过。（验证：运行 `npm run typecheck`）
- [ ] Node 测试通过。（验证：运行 `npm run test:node`）
- [ ] 构建通过。（验证：运行 `npm run build`）
- [ ] 如全量 `npm test` 因既有数据库环境缺失失败，交接记录具体失败套件和原因。（验证：实际运行结果记录）

## 端到端场景

- [ ] 场景 1：用户提交已有 TOS mp3 + `category=音色` + `voice_traits=["低沉","克制"]` + `speaking_style=旁白` → 返回 `201` 和 asset/media/storage 信息 → 资产 metadata 包含音色字段 → 不出现任务 ID。（验证：routes/service 集成测试）
- [ ] 场景 2：用户上传 ogg + `category=背景音乐` + `music_traits=["悬疑","压抑"]` + `tempo=慢` + `usage_scene=反转` → 文件上传到 TOS → 创建音频资产和媒体 → 返回 storage path。（验证：routes/service 测试）
- [ ] 场景 3：用户提交 flac → 请求被拒绝，数据库不创建资产和媒体。（验证：service/routes 测试）
- [ ] 场景 4：向量同步失败 → API 仍返回创建成功，PostgreSQL 中资产和媒体存在，日志记录同步失败。（验证：service 测试）
- [ ] 场景 5：用户尝试传旧 `category=人声` 或带 `task_id` 语义的旧字段 → 请求被拒绝或字段被严格 schema 拦截。（验证：routes 测试）

# 音频素材入库技术方案

> 本文件只回答“怎么设计”。具体文件清单、任务顺序、实现步骤和验证命令留到 `task.md`。

## 架构概览

音频素材入库使用同步创建资产的形状：路由完成鉴权和请求校验，service 校验音频格式、上传或登记 TOS 对象，repository 在同一个 PostgreSQL 事务里创建音频资产、音频媒体和来源记录。PostgreSQL 是正式事实源；Milvus 只保存由资产事实重建出来的资产级检索投影。

第一版包含三块后端能力：

- `audio-ingest` routes：提供已有 TOS 音频登记和单文件上传两个入口。
- `AudioAssetIngestService`：负责输入校验、TOS 上传或对象检查、调用 repository、触发向量同步。
- `AudioAssetIngestRepository`：负责写入 `asset_entities`、`asset_media`、`media_provenance_subjects`。

第一版不新增音频任务表、不启动 worker、不调用 LAS、不执行 ASR 或自动识别。已出现的 `audio_ingest_tasks`、`las_asr`、transcript/utterances normalizer 和 `AudioIngestWorker` 属于错误方向，落地时应删除或改写，不保留兼容层。

## 核心数据结构

### `AudioAssetCategory`

用途：音频资产的业务子类。

```ts
type AudioAssetCategory = "音色" | "背景音乐";
```

`asset_kind` 仍固定写 `audio`；`category` 才表达音频业务子类。不得写入 `voice`、`music`、`sound` 等新的 `asset_kind`。

### `AudioAssetMetadata`

用途：保存音频专属结构化字段。通用描述继续使用资产自身的 `intro` 和媒体的 `description`，不复制进 metadata。

```ts
type AudioAssetMetadata =
  | {
      kind: "voice";
      voice_traits: string[];
      speaking_style: string | null;
    }
  | {
      kind: "background_music";
      music_traits: string[];
      tempo: string | null;
      usage_scene: string | null;
    };
```

字段口径：

- `voice_traits`：音色/情绪合并后的自由标签，如“低沉”“克制”“疲惫”“温柔”“沙哑”。
- `speaking_style`：说话方式或音色使用方式，如“旁白”“对白”“独白”“口播”“其他”。
- `music_traits`：音乐风格和情绪自由标签，如“悬疑”“压抑”“都市感”“温暖”“燃”。
- `tempo`：节奏描述，前端可给“慢/中/快”，后端只做长度和类型校验。
- `usage_scene`：使用场景，如“开场”“转场”“煽情”“反转”“高潮”“日常”“其他”。

### `SubmitAudioAssetInput`

用途：登记已有 TOS 音频。

```ts
interface SubmitAudioAssetInput {
  actorId: string;
  sourceProjectName?: string | null;
  name: string;
  description?: string | null;
  category: AudioAssetCategory;
  audioMetadata: AudioAssetMetadata;
  audio: {
    storageBucket?: string | null;
    storagePath: string;
    storageUrl?: string | null;
    originalFileName: string;
    contentType: string;
  };
}
```

### `SubmitUploadedAudioAssetInput`

用途：上传单个音频文件后复用登记流程。

```ts
interface SubmitUploadedAudioAssetInput {
  actorId: string;
  sourceProjectName?: string | null;
  name: string;
  description?: string | null;
  category: AudioAssetCategory;
  audioMetadata: AudioAssetMetadata;
  file: {
    fileName: string;
    contentType: string;
    content: Buffer;
  };
}
```

### `CreatedAudioAsset`

用途：两个入库端点的成功返回。

```ts
interface CreatedAudioAsset {
  assetId: string;
  mediaId: string;
  storageBucket: string;
  storagePath: string;
  storageUrl: string | null;
}
```

### 资产与媒体行

`asset_entities`：

- `asset_kind`: 固定为 `audio`
- `category`: `音色 | 背景音乐`
- `role`: `null`
- `usage_mode`: `null`
- `visibility`: `personal`
- `approved`: `true`
- `status`: `approved`
- `intro`: 用户提交的通用描述，空则为 `null`
- `appearance`: 可写入用于检索的音频资产文本摘要
- `style_tags`: 音频专属 tags 的去重结果
- `source_file_url`: TOS URL 或 `null`
- `metadata.audio_asset`: 音频专属结构化字段、源文件信息和入库来源

`asset_media`：

- `media_kind`: `audio`
- `format`: `wav | mp3 | ogg | opus`
- `description`: 用户提交的通用描述
- `metadata.source`: `audio_asset_ingest`
- `metadata.audio_asset`: 音频专属结构化字段和源文件信息
- `metadata.vector_text`: 便于排障的资产级检索文本副本

### 检索文本

音频入库生成资产级检索文本，不做片段级向量。文本由以下事实拼接：

- 名称
- 分类：`音色` 或 `背景音乐`
- 通用描述
- 音色字段：`voice_traits`、`speaking_style`
- 背景音乐字段：`music_traits`、`tempo`、`usage_scene`

service 将检索文本写入资产可被现有 `VectorSyncService.syncEntity` 消费的字段中，并调用向量同步。同步失败只记录日志，不回滚 PostgreSQL。

## 模块设计

### 音频入库 routes

端点：

```text
POST /api/v1/asset-ingest/audio
POST /api/v1/asset-ingest/audio/upload
```

删除任务端点：

```text
GET  /api/v1/audio-ingest-tasks
GET  /api/v1/audio-ingest-tasks/:task_id
POST /api/v1/audio-ingest-tasks/:task_id/retry
```

JSON 提交接收已有 TOS 对象；multipart 上传一次只接收一个文件。route 层使用 Zod 校验 snake_case 请求体，鉴权后把当前用户作为 `actorId` 传入 service。

音色请求示例：

```json
{
  "source_project_name": "参考音频素材库",
  "name": "沈孤舟低声旁白参考",
  "description": "适合冷静克制的男主旁白参考",
  "category": "音色",
  "voice_traits": ["低沉", "克制", "疲惫"],
  "speaking_style": "旁白",
  "audio": {
    "storage_bucket": "shortdrama-assets",
    "storage_path": "asset-audio/example.mp3",
    "storage_url": "https://example.invalid/example.mp3",
    "original_file_name": "example.mp3",
    "content_type": "audio/mpeg"
  }
}
```

背景音乐请求示例：

```json
{
  "source_project_name": "参考音频素材库",
  "name": "都市悬疑低频铺底",
  "description": "适合反转前的压迫感铺底",
  "category": "背景音乐",
  "music_traits": ["悬疑", "压抑", "低频"],
  "tempo": "慢",
  "usage_scene": "反转",
  "audio": {
    "storage_bucket": "shortdrama-assets",
    "storage_path": "asset-audio/bgm.ogg",
    "storage_url": "https://example.invalid/bgm.ogg",
    "original_file_name": "bgm.ogg",
    "content_type": "audio/ogg"
  }
}
```

返回结构：

```json
{
  "asset_id": "...",
  "media_id": "...",
  "storage_bucket": "...",
  "storage_path": "...",
  "storage_url": "..."
}
```

成功 HTTP 状态为 `201`。没有 `task_id`、没有 `status=queued`。

### 音频入库 service

职责：

- 校验名称、分类、音频格式、TOS bucket/path、文件元数据和音频专属字段。
- `/upload` 路径把 multipart 文件上传到 TOS，并复用已有对象登记流程。
- 已有 TOS 对象路径调用 `headObject` 确认对象存在并补齐 content type/length。
- 构建音频 metadata、style tags 和资产级检索文本。
- 调用 repository 创建资产、媒体和来源记录。
- 调用 `VectorSyncService.syncEntity` 做资产级向量同步。
- 向量同步失败时记录日志，不改变创建成功响应。

service 不依赖 LAS client，不读取 ASR 环境变量，不做轮询、重试或后台任务调度。

### 音频入库 repository

职责：

- 在一个 PostgreSQL 事务里创建 `asset_entities`、`asset_media` 和 `media_provenance_subjects`。
- 固定写入音频资产分类口径：`asset_kind=audio`、`media_kind=audio`、`category=音色/背景音乐`、`role=null`、`usage_mode=null`。
- 固定写入个人资产口径：`visibility=personal`、`approved=true`、`status=approved`。
- 保存音频 metadata 和源文件信息。
- 返回创建出的 asset ID 和 media ID。

repository 不创建 `audio_ingest_tasks`，不处理任务状态。

### 音频 metadata 与检索文本 builder

职责：

- 按 category 校验字段组合：音色只能提交 `voice_traits/speaking_style`，背景音乐只能提交 `music_traits/tempo/usage_scene`。
- 统一清洗自由文本数组：trim、去空、去重、限制单项长度和数量。
- 从音频专属字段生成 `style_tags`。
- 生成资产级检索文本，供 `appearance` 和媒体 metadata 的 `vector_text` 使用。

builder 不调用模型，不做自动标签推断。

## 模块交互

1. route 鉴权并校验 JSON 或 multipart 请求。
2. service 校验业务分类和音频格式。
3. 上传入口先写入 TOS；已有对象入口先检查 TOS 对象。
4. service 生成音频专属 metadata、style tags 和检索文本。
5. repository 在事务里创建 asset entity、asset media 和 media provenance。
6. service 调用 `VectorSyncService.syncEntity`；失败只记录日志，不回滚 PostgreSQL。
7. route 返回 `201` 和创建完成结果。

## 文件组织

```text
src/modules/audio-ingest/
├── types.ts        — 音频分类、metadata、输入输出类型
├── metadata.ts     — 字段清洗、metadata 构建、检索文本构建
├── repository.ts   — 资产、媒体、来源记录写入
├── service.ts      — 校验、TOS 上传/检查、创建资产、向量同步
├── routes.ts       — 两个 HTTP 入库端点
└── *.test.ts       — metadata、repository、service、routes 测试
```

删除或不再引入：

```text
migrations/067_audio_ingest_tasks.sql
src/modules/audio-ingest/worker.ts
src/modules/audio-ingest/normalizer.ts
src/modules/audio-ingest/migration.test.ts
src/integrations/volcLasOperatorClient.ts
src/integrations/volcLasOperatorClient.test.ts
```

如果 `VolcLasOperatorClient` 已被其他已批准视频入库工作使用，保留该 client 只服务视频合同；音频模块不得引用它。

## 技术决策

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 主对象 | 音频资产 | 与素材库行为保持一致，避免把音频误建模成 transcript 文档。 |
| 生命周期 | 同步创建，无任务表 | 第一版没有异步解析；任务状态会制造假流程。 |
| 分类 | `asset_kind=audio`，`category=音色/背景音乐` | 资产大类保持稳定，业务子类表达真实需求。 |
| metadata | 只存音频专属结构化字段 | 通用描述已有正式字段，避免双事实源。 |
| 自动识别 | 不做 | 自动音色/BGM 识别效果和责任边界未验证，另起 POC。 |
| ASR | 不做 | 当前需求不需要识别人声内容；ASR 后续独立立项。 |
| 检索粒度 | 只做资产级向量 | 对齐第一版范围和现有 vector sync。 |
| 文件格式 | 支持 `wav/mp3/ogg/opus` | 覆盖当前音频素材常见格式，不扩大到转码。 |
| 公共资产 | 不在第一版写路径内 | 避免绕过通用资产审核、版权和团队权限流程。 |
| 向量失败 | 不回滚 PostgreSQL | Milvus 是可重建投影，PostgreSQL 创建结果是真事实。 |

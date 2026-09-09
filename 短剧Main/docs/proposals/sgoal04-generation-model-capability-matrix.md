# S-goal-04 生成模型能力矩阵（后端提案）

> 状态：提案，供应商事实核验于 2026-07-30  
> 适用范围：Ark 图片/视频生成适配层、报价校验、任务创建前校验  
> 非目标：不修改现有产品版本范围，不自动开通模型，不触发真实付费调用

## 0. 结论

后端必须以正式 `model_id` 建立版本化能力注册表，不能根据展示名称推断能力。
截至 2026-07-30，火山方舟官方模型列表、API 文档和价格页可确认：

- Seedream 5.0 Pro、Seedream 5.0 / 5.0 Lite；
- Seedance 2.0、Seedance 2.0 Fast、Seedance 2.0 Mini。

`Seedance 2.5` 未出现在官方模型列表、视频生成 API 或价格页中。控制台私有灰度或
定向邀测状态不可评估；在取得官方 `model_id`、API 参数范围和价格规则之前，不得进入
`active` registry、报价或任务创建链。

供应商能力上限不等于当前产品已开放范围。现有 V0.1.1 / 0.2.0 合同继续覆盖本矩阵：

- 付费任务必须经过报价、预算、幂等、权限检查和一次明确人工点击；
- 当前全能参考产品面只开放图片、视频；虽然 Ark Seedance 2.0 支持音频参考，产品层仍对
  音频参考返回 `422`，直到声音桥合同另行批准；
- 生产环境当前固定档的 720p、9:16、4 秒等限制继续生效，不因供应商支持 4K 或 15 秒而自动扩权；
  S-goal-04 另提供 7 个 `dev_smoke_only` 组合，只用于开发环境展示、报价和逐档冒烟，
  不构成测试或生产启用授权；
- 供应商虽接受 `duration=-1` 的智能时长，但平台尚无可审计的对应计价规则，当前报价与
  任务创建统一拒绝该值，只开放 4–15 秒的明确时长；
- Seedream 5.0 / Lite 虽支持组图，当前价格档和产物登记仍只开放 `quantity=1`；完成
  多产物持久化、实际成功张数结算与付费实测前，不把供应商上限伪装成产品能力；
- 旧固定档 `vid-seedance20fast-916-720p-4s` 永久保持无输入视频语义，不能原地升级。

## 1. Active registry

### 1.1 图片模型

| capability tier | 展示名 | 正式 `model_id` | 输入与输出 | 尺寸、数量与特殊能力 |
| --- | --- | --- | --- | --- |
| `image_single_pro` | Seedream 5.0 Pro | `doubao-seedream-5-0-pro-260628` | 文生单图；1 张参考图生单图；2–10 张参考图生单图；交互编辑 | `1K` / `2K`，默认 `2K`；不支持组图、联网搜索、流式输出 |
| `image_batch_lite` | Seedream 5.0 | `doubao-seedream-5-0-260128` | 文生、单图参考、多图参考；可生成单图或组图 | `2K` / `3K` / `4K`；最多 14 张参考图；支持流式输出和 `web_search` |
| `image_batch_lite` | Seedream 5.0 Lite | `doubao-seedream-5-0-lite-260128` | 与上一行同能力；官方模型列表注明同时支持该 Lite ID | 与上一行相同 |

`doubao-seedream-5-0-260128` 与 `doubao-seedream-5-0-lite-260128` 是显式 alias；
registry 应分别保存供应商 ID，但可指向同一能力模板，不能通过去掉 `lite` 字符串自动生成。

图片输入统一约束：

- `image` 支持 URL 或 Base64；
- 格式：JPEG、PNG、WebP、BMP、TIFF、GIF、HEIC、HEIF；
- 单张图片宽高比 `[1/16, 16]`，宽和高均大于 14 px；
- 单张不超过 30 MB，总像素不超过 36,000,000；
- 图片生成不接受 `first_frame`、`last_frame` 使用槽。

图片输出与参数：

| 字段 | Seedream 5.0 Pro | Seedream 5.0 / Lite |
| --- | --- | --- |
| `size` 档位 | `1K`, `2K`；默认 `2K` | `2K`, `3K`, `4K` |
| 自定义尺寸总像素 | `[921600, 4624220]` | `[3686400, 16777216]` |
| 自定义尺寸宽高比 | `[1/16, 16]` | `[1/16, 16]` |
| `output_format` | `jpeg`, `png`；默认 `jpeg` | `jpeg`, `png`；默认 `jpeg` |
| `response_format` | `url`, `b64_json`；默认 `url` | 同左 |
| `watermark` | 布尔值；默认 `true` | 同左 |
| `optimize_prompt_options.mode` | `standard`, `fast`；默认 `standard` | 同左 |
| `sequential_image_generation` | 不支持 | `disabled`, `auto`；默认 `disabled` |
| `sequential_image_generation_options.max_images` | 不支持 | `[1,15]`；默认 15 |
| `stream` | 不支持 | 支持 |
| `tools[].type` | 不支持 | 当前仅 `web_search` |

组图跨字段约束：

- 仅 5.0 / Lite 可设置 `sequential_image_generation=auto`；
- 文生组图最多输出 15 张；
- 单参考图生组图最多输出 14 张；
- 多参考图生组图满足 `input_image_count + generated_image_count <= 15`；
- `max_images` 是输出上限，不会放宽上述输入 + 输出总量限制；
- Pro 请求出现 `sequential_image_generation`、`stream=true` 或 `tools` 时必须在适配层拒绝，
  不能静默删除后继续产生付费调用。

当前 Seedream 5.0 API 正文没有把 `seed` 或 `guidance_scale` 列为请求字段。后端不得把旧
API Explorer 或旧模型参数默认继承给上述 5.0 型号。

### 1.2 视频模型

| capability tier | 展示名 | 正式 `model_id` | 输入能力 | 输出规格 |
| --- | --- | --- | --- | --- |
| `video_full_4k` | Seedance 2.0 | `doubao-seedance-2-0-260128` | 文生；首帧；首尾帧；图片/视频/音频多模态参考；视频编辑；视频延长 | 480p / 720p / 1080p / 4K；4–15 秒或 `-1`；24 fps；MP4 |
| `video_fast_720` | Seedance 2.0 Fast | `doubao-seedance-2-0-fast-260128` | 与 2.0 基本相同 | 480p / 720p；4–15 秒或 `-1`；24 fps；MP4 |
| `video_budget_720` | Seedance 2.0 Mini | `doubao-seedance-2-0-mini-260615` | 与 2.0 基本相同 | 480p / 720p；4–15 秒或 `-1`；24 fps；MP4 |

三款 2.0 模型共同支持：

- `generate_audio`，默认 `true`；生成音轨为单声道；
- `return_last_frame`，默认 `false`；
- `tools[].type=web_search`；
- `priority` 取值 `[0,9]`，只影响同一 Endpoint 内的排队顺序；
- `callback_url`；
- `execution_expires_after`，默认 172800 秒，取值 `[3600,259200]`；
- `watermark`，默认 `false`；
- 比例 `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive`，
  默认 `adaptive`；
- 默认分辨率 720p、默认时长 5 秒。

三款 2.0 模型共同不支持：

- `service_tier=flex`，仅支持在线推理；
- `frames`；
- `seed`；
- `camera_fixed`；
- `draft` / 样片模式。

仅主型号 Seedance 2.0 支持 1080p 和 4K；Fast / Mini 出现 1080p 或 4K 必须返回参数错误。
4K 输出为 10-bit H.265 / HEVC，客户端和交付链不能假设所有浏览器都能直接播放。
产品界面展示写作 `4K`；传给供应商和写入价格档参数的规范值为小写 `4k`。

## 2. Seedance 输入模态与角色组合

Ark `content[]` 的供应商角色映射：

| 业务用途 | `content.type` | `role` | 数量 |
| --- | --- | --- | --- |
| 提示词 | `text` | 无 | 1 |
| 严格首帧 | `image_url` | `first_frame` | 恰好 1 |
| 严格尾帧 | `image_url` | `last_frame` | 仅首尾帧模式，恰好 1 |
| 图片参考 | `image_url` | `reference_image` | 多模态模式 1–9 |
| 视频参考 | `video_url` | `reference_video` | 0–3 |
| 音频参考（供应商支持） | `audio_url` | `reference_audio` | 0–3 |

支持的任务形状：

1. 文生视频：文本，无媒体。
2. 首帧图生视频：文本 + 1 个 `first_frame`。
3. 首尾帧图生视频：文本 + 1 个 `first_frame` + 1 个 `last_frame`。
4. 多模态参考：文本 + 图片、视频、音频的允许组合。
5. 视频编辑或延长：文本 + 1–3 个参考视频，可增加允许的图片或音频参考。

多模态组合可为图片、视频、图片 + 音频、图片 + 视频、视频 + 音频、图片 + 视频 + 音频。
官方明确不支持“文本 + 音频”或纯音频；即音频存在时必须至少有一张图片或一个视频。
“全能参考”不是独立供应商参数，它是 `reference_*` 角色集合，加上提示词中的
“图片 1 / 视频 1 / 音频 1”顺序引用。

严格首尾帧与多模态参考应建模为不同模式。多模态模式可以在提示词中指定某张
`reference_image` 作为开头或结尾，但这只是间接控制；需要像素级严格首尾帧时必须使用
`first_frame` / `last_frame`，不能把两种保证等级写成同一能力。

输入素材约束：

- 图片：1–9 张参考图；单张小于 30 MB；宽高比 `[0.4,2.5]`；
  宽高均 `[300,6000]`；
- 视频：MP4 / MOV，H.264 或 H.265；单个 2–15 秒，最多 3 个，所有视频总时长不超过
  15 秒；单个不超过 200 MB；24–60 fps；
- 音频：WAV / MP3；单个 2–15 秒，最多 3 个，所有音频总时长不超过 15 秒；
  单个不超过 15 MB；
- 首尾帧宽高比不一致时，以首帧为主，尾帧会被自动裁剪；
- Seedance 2.0 系列不支持直接上传含真人人脸的普通参考图或视频。只能使用方舟认可的
  同账号近期原始模型产物、预置虚拟人像或已授权真人素材；本项目仍需执行
  Seedance 素材登记 freshness 合同。

当前产品合同的额外收紧：

- `references` 正式形状为 `[{ media_id, usage_mode }]`；
- 一次请求不能混用 `references` 与兼容字段
  `reference_media_ids/first_frame_media_id/last_frame_media_id`；
- `reference` 只接受图片或视频；音频在产品服务层返回
  `422 control_asset_invalid_usage`；
- `first_frame`、`last_frame` 各至多一个，且只能是同名 `usage_mode` 的图片；
- 3D/GLB/glTF 永远不能进入图片或视频生成引用。

## 3. 创建付费任务前的跨字段校验

校验必须在估价、批量估价和正式创建三个入口复用同一套纯函数；任一失败均不得调用 Ark。

建议顺序：

1. **Registry**：`model_id` 必须精确命中 `active` 记录；alias 只走显式表。
2. **产品版本**：供应商能力与当前产品 allowlist 取交集，禁止用供应商上限绕过版本合同。
3. **媒体用途**：校验 `usage_mode`、媒体类型、资产权限、审核状态、Seedance 登记状态和
   `fresh_until`。
4. **任务模式**：文生、首帧、首尾帧、多模态、编辑/延长只能命中一个确定模式。
5. **模态数量**：校验图片、视频、音频分别和合计限制；音频必须搭配图片或视频。
6. **输出规格**：校验模型支持的 `resolution`、`ratio`、`duration`；2.0 系列拒绝
   `frames/seed/camera_fixed/draft/service_tier=flex`。
7. **图片组图**：校验 Pro 禁用组图；Lite 的输入图 + 输出图不超过 15。
8. **计费规则**：必须命中未过期、来源可追溯、与输入视频状态匹配的价格规则。
9. **预算与人工授权**：冻结报价快照后才允许人工确认；幂等键保证一次点击最多一个任务。

建议 registry 至少保存：

```ts
type GenerationModelCapability = {
  provider: "ark";
  modelId: string;
  status: "active" | "disabled" | "unverified";
  mediaKind: "image" | "video";
  aliases: string[];
  inputModalities: Array<"text" | "image" | "video" | "audio">;
  referenceLimits: {
    images: number;
    videos: number;
    audios: number;
    totalVideoSeconds?: number;
    totalAudioSeconds?: number;
  };
  roles: Array<"reference" | "first_frame" | "last_frame">;
  resolutions: string[];
  ratios: string[];
  durationSeconds?: { min: number; max: number; smart: boolean };
  outputCount?: { min: number; max: number; inputPlusOutputMax?: number };
  supportsAudioOutput: boolean;
  supportsStreaming: boolean;
  supportsWebSearch: boolean;
  supportsFlex: boolean;
  pricingRuleId: string;
  evidenceUrls: string[];
  verifiedAt: string;
};
```

不能把价格直接嵌入能力模板。能力与价格分别版本化，报价保存两者的不可变快照。

## 4. 计费合同

### 4.1 Seedream

| 模型 | 输入图 | 成功输出图 |
| --- | --- | --- |
| Seedream 5.0 Pro | 首张免费；第 2 张起 0.02 元/张 | 不超过 236 万像素：0.30 元/张；超过 236 万像素：0.60 元/张 |
| Seedream 5.0 / Lite | 免费 | 0.22 元/张 |

仅成功输出计费；Lite 组图按实际成功生成张数计费。报价必须按请求的输入图数、目标像素和
最大输出张数计算上限，最终账本以供应商返回的实际成功张数为准。

### 4.2 Seedance 2.0 系列

视频按成功任务的 token 用量计费：

```text
estimated_tokens =
  (input_video_seconds + output_video_seconds)
  × output_width
  × output_height
  × 24
  / 1024

estimated_cost = estimated_tokens × price_per_token
```

准确用量以 API 返回的 `usage.completion_tokens` 为准。输入视频存在时，2.0 和 Fast 还有
最低 token 用量约束，不能只按上式低估。

在线推理单价（元 / 百万 token）：

| 模型与输出 | 不含输入视频 | 含输入视频 |
| --- | ---: | ---: |
| Seedance 2.0，480p / 720p | 46 | 28 |
| Seedance 2.0，1080p | 51 | 31 |
| Seedance 2.0，4K | 26 | 16 |
| Seedance 2.0 Fast，480p / 720p | 37 | 22 |
| Seedance 2.0 Mini，480p / 720p | 23 | 14 |

“含输入视频”的 token 单价更低不代表任务总价更低：输入视频时长也进入 token 公式，
且可能触发最低用量。报价快照必须显式保存：

- `has_input_video`；
- 输入视频数量和总时长；
- 输出宽、高、帧率、时长；
- 单价档；
- 最低用量规则版本；
- 估算 token、供应商实际 token 和差异。

无视频参考时才可记录 `noInputVideo=true`。视频参考报价只能命中
`pricing_rules.metadata.supports_input_video=true` 且来源非空的独立规则，否则失败关闭。

## 5. Unverified / disabled registry

```json
{
  "provider": "ark",
  "display_name": "Seedance 2.5",
  "model_id": null,
  "status": "unverified",
  "reason": "No official model-list, API or pricing evidence as of 2026-07-30"
}
```

该记录仅用于解释为什么界面或迁移数据不能选择该模型；不得成为供应商请求配置。
第三方合作商、开发者社区文章、截图或控制台传闻不能把它提升为 `active`。提升条件至少是：

1. 火山方舟官方模型列表出现正式 `model_id`；
2. 官方 API 文档给出输入输出及组合限制；
3. 官方价格页或已批准账单给出可追溯价格；
4. 只读模型开通检查成功；
5. 完成零付费合同测试和独立人工批准。

### 5.1 S-goal-04 开发环境冒烟集合

为尽快让用户看见可选择的模型、画幅、清晰度和时长，首批只启用 7 个边界清楚的组合：

- 图片：Pro `9:16 / 2K`、`1:1 / 2K`、`16:9 / 1K`；
- 视频：2.0 `9:16 / 720p / 4 秒`、`16:9 / 1080p / 4 秒`；
- 视频：Fast `16:9 / 720p / 8 秒`；
- 视频：Mini `9:16 / 720p / 4 秒`。

它们与原有两个正式档合计形成 9 个开发环境可见档。图片数量仍为 1；智能时长 `-1`、
组图和视频参考价仍不开放。播种脚本要求 `--target dev`、启用参数和确认参数同时出现，
并拒绝生产 schema。记录会带 `activation_scope=dev_smoke_only` 与“待核”价格来源。
逐档真实调用和账单核对完成前，不得复制到测试或生产环境。

## 6. 官方证据

| 证据 | 用途 | 文档更新时间 |
| --- | --- | --- |
| [火山方舟模型列表](https://www.volcengine.com/docs/82379/1330310) | 正式 Model ID、能力和限流 | 2026-07-20 |
| [图片生成 API](https://www.volcengine.com/docs/82379/1541523) | Seedream 参数、尺寸、数量和组合约束 | 2026-07-21 |
| [Doubao Seedance 2.0 系列教程](https://www.volcengine.com/docs/82379/2291680) | 2.0 / Fast / Mini 能力、组合参考和素材边界 | 2026-07-28 前后当前版本 |
| [视频生成教程](https://www.volcengine.com/docs/82379/2298881) | 视频模型能力矩阵和输出规格 | 2026-07-28 16:49:02 |
| [创建视频生成任务 API](https://www.volcengine.com/docs/82379/1520757) | 请求字段、默认值和不支持项 | 2026-07-10 19:18:36 |
| [模型价格](https://www.volcengine.com/docs/82379/1544106) | 图片/视频单价和 token 公式 | 2026-07-27 12:31:07 |

以上均为火山方舟官方文档或官方价格页。未使用火山开发者社区用户文章、合作商文档或
搜索摘要作为 `Seedance 2.5`、正式 Model ID、参数或价格证据。

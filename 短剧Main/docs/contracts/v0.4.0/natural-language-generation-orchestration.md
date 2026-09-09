# 自然语言生成编排合同（v0.4.0）

状态：后端合同冻结，前端可据此接线。批准来源：Fable goal #73。Issue：#73（后端），#74（前端）。基础合同仍继承 `v0.1.1`。

## 1. 目标与边界

用户在既有助手会话里用一句自然语言准备图片、视频或音频生成。服务端负责：

1. 结合项目、集、场、镜头和当前选中媒体判断意图；
2. 歧义时只返回一个可回答的澄清问题，不创建报价或任务；
3. 无歧义时返回冻结的操作卡、当前有效档位和报价；
4. 只有用户点击操作卡上的确认按钮后，才允许进入执行；
5. 执行结果带回原目标位置和账证物指针。

无论 `mock` 还是 `real`，服务端都必须按同一条项目归属链和既有 creative 权限校验：
`project → episode → scene → shot`。请求中每一个已给出的下级对象都必须属于上级对象；
会话已绑定镜头时也必须一致。创建轮次、重新报价和确认均重新校验调用人的 creative
权限以及目标、选中媒体和引用媒体的项目归属；不得因为是 mock 而跳过这些校验。

本合同覆盖：

- 文生图；
- 图生图 / 改图；
- 文生视频；
- 图生视频 / 改视频；
- 文本转音频。

不在本包内：

- 前端面板实现；
- 自动确认、自动重试、批量扩张或后台生成；
- 未核价档位的真实调用；
- 生产环境开关和真实付费验收。

## 2. 配置与零付费保证

`GENERATION_ORCHESTRATION_MODE` 只有三个值：

- `mock`：自然语言解释器和供应商执行均为本地复刻；不访问 LLM、供应商或付费队列；
- `real`：自然语言解释使用既有 AI Gateway，报价和执行复用现有生成账本；
- `disabled`：接口返回中文不可用错误。

开发、测试未显式配置时为 `mock`；生产未显式配置时为 `disabled`。模式在服务端决定，客户端不能覆盖。

mock 与 real 共用同一组 `GenerationIntentInterpreter`、`GenerationQuoteAdapter`、
`GenerationOperationExecutor` 接口。供应商 mock 通过真实 Ark / Seed Audio adapter
的 HTTP 注入点喂入复刻响应，不另写一套业务解析器。

## 3. 创建一个对话轮次

`POST /api/v1/agent/sessions/:session_id/generation-orchestration/turns`

该路由只允许已登录的人类调用。

请求：

```json
{
  "message": "把这张图改亮一点",
  "context": {
    "project_id": "uuid",
    "episode_id": "uuid",
    "scene_id": "uuid",
    "shot_id": "uuid",
    "selected_asset": {
      "asset_entity_id": "uuid",
      "media_id": "uuid",
      "media_kind": "image"
    },
    "reference_media_ids": ["uuid"]
  }
}
```

约束：

- `project_id` 必须与助手会话绑定项目一致；
- 会话绑定了 `shot_id` 时，请求中的镜头必须一致；
- `episode_id`、`scene_id`、`shot_id` 只要出现，服务端必须分别验证其属于上一级
  `project → episode → scene → shot`；不能把来自不同项目或不同层级的 ID 拼成上下文；
- 修改图片或视频必须有同模态 `selected_asset`；
- 服务端必须验证 `selected_asset.media_id` 的真实归属与媒体类型同时匹配
  `asset_entity_id` / `media_kind`，客户端提供的三元组不能分别信任；
- 选中图片并要求“动起来”属于图生视频，不属于改图；
- 客户端不得传供应商 model id、价格或外部 URL。

### 3.1 需要澄清

HTTP 200：

```json
{
  "ok": true,
  "data": {
    "turn_id": "uuid",
    "status": "clarification_required",
    "assistant_message": "你想生成图片、视频还是音频？",
    "clarification": {
      "code": "media_kind_required",
      "question": "你想生成图片、视频还是音频？",
      "choices": [
        {"value": "image", "label": "图片"},
        {"value": "video", "label": "视频"},
        {"value": "audio", "label": "音频"}
      ]
    }
  }
}
```

该响应不得包含报价、操作 id 或确认入口。

### 3.2 等待确认

HTTP 201：

```json
{
  "ok": true,
  "data": {
    "turn_id": "uuid",
    "status": "confirmation_required",
    "assistant_message": "已按当前镜头准备改图操作，请确认后执行。",
    "operation_card": {
      "operation_id": "uuid",
      "operation_type": "edit",
      "input_mode": "image_to_image",
      "media_kind": "image",
      "prompt": "把画面整体提亮，保留人物和构图",
      "context": {
        "project_id": "uuid",
        "episode_id": "uuid",
        "scene_id": "uuid",
        "shot_id": "uuid"
      },
      "target": {
        "placement": "replace_asset_variant",
        "asset_entity_id": "uuid",
        "shot_id": "uuid"
      },
      "references": {
        "selected_media_id": "uuid",
        "media_ids": ["uuid"]
      },
      "tier": {
        "tier_id": "public-tier-id",
        "display_name": "默认档",
        "provider_label": "火山方舟",
        "model_label": "已核价图片模型"
      },
      "defaults": {},
      "parameter_groups": [
        {"key": "visual", "label": "画面", "controls": []},
        {"key": "motion", "label": "运动", "controls": []},
        {"key": "audio", "label": "声音", "controls": []},
        {"key": "cost", "label": "成本", "controls": []}
      ],
      "quote": {
        "mode": "mock",
        "generation_quote_id": null,
        "estimated_cost_fen": 60,
        "currency": "CNY",
        "expires_at": null,
        "notice": "模拟报价，不会扣费或创建真实任务"
      },
      "requote": {
        "method": "POST",
        "endpoint": "/api/v1/agent/sessions/:session_id/generation-orchestration/operations/:operation_id/requote",
        "label": "重新报价"
      },
      "confirmation": {
        "required": true,
        "method": "POST",
        "endpoint": "/api/v1/agent/sessions/:session_id/generation-orchestration/operations/:operation_id/confirm",
        "label": "确认并生成"
      }
    }
  }
}
```

`operation_type` 为 `generate | edit`。`input_mode` 为：

- `text_to_image`
- `image_to_image`
- `text_to_video`
- `image_to_video`
- `video_to_video`
- `text_to_audio`

`defaults` 是本次冻结值。`parameter_groups` 是“展开高级设置”所需的完整原生能力描述；
每个 control 必须说明当前值、默认值、可选项或原生范围、是否受当前核价档位固定，以及改动后是否需要重新报价。

未登记价格的原生组合可以展示，但不得伪造报价；用户显式选择该组合时返回
`tier_not_priced` 澄清结果。

### 3.3 配音变体的可信继承

对于“这段配音换成男声再生成一遍”这一类指令，服务端不得从客户端文本、前端缓存或
模型猜测补全台词。它必须从当前选中的音频及其项目/集/场/镜头归属中，解析服务端已持久化、
可追溯的原台词 provenance；同时从服务端已登记的男声音色中解析并冻结具体
`speaker_id`。生成的操作卡必须是 `text_to_audio`，目标固定为
`replace_asset_variant`，并把原音频作为目标变体的依据。原请求中可信的
`original_duration_seconds`、输出格式和采样率也必须继承后重新核价；缺少可信计费时长或
没有对应核价档时返回 `tier_not_priced`，不能退回更短、更便宜的默认档。

找不到可信原台词时返回中文 `trusted_script_required` 澄清；找不到可用、已登记的男声音色
时返回中文 `registered_male_speaker_required` 澄清。两种情况都不得创建操作卡、报价、任务或
确认入口。解析成功后的台词、`speaker_id`、目标和引用均写入冻结操作卡，后续确认不能由
客户端改写。

### 3.4 高级设置重新报价

`POST /api/v1/agent/sessions/:session_id/generation-orchestration/operations/:operation_id/requote`

请求只允许公开档位 ID 和白名单参数覆盖：

```json
{
  "tier_id": "public-tier-id",
  "parameters": {
    "size": "1024x1024",
    "ratio": "1:1",
    "duration_seconds": 6,
    "speech_rate": 20
  }
}
```

- 不传 `tier_id` 时沿用原卡档位；
- `parameters` 只传用户改动项，服务端与目标档位默认值合并、重新校验和计价；
- 成功返回一张新的冻结操作卡，原卡不被改写；
- 每一个可调控件的提交都必须调用本接口并得到新卡后才能确认，即使该参数在当前档位
  不改变金额；客户端不得把任何控件改动直接带到确认接口；
- 自定义尺寸只使用既有 `size=宽x高` 参数（例如 `size=1024x1024`）。操作卡不得展示
  `custom_pixels`，接口也不得接受它；
- 当前没有核价的原生组合返回 `tier_not_priced`，不能在前端本地改价格；
- 已确认执行的卡不能重新报价；
- mock 卡重新报价后仍是 mock，即使部署随后切到 real；
- 客户端不得传 model id、供应商、单价、总价、参考 URL 或目标资产。

## 4. 对话投影与生成事实边界

`agent_messages` 中的用户轮次、operation card 和 receipt 都只是对话提案或投影，用于恢复
会话与向用户展示；它们不是正式报价、生成任务、扣费或媒体事实。正式事实始终由 generation
域持有：报价在 generation quote，任务/attempt 在 generation request 与 attempt，扣费在正式
账本，媒体在正式媒体与资产关联中。操作卡的 `generation_quote_id` 或回执中的关联 ID 只可作
指针，不能反向把 `agent_messages` 当作权威来源。

mock receipt 只是“未调用供应商、未扣费”的模拟证据，不能作为真实报价、任务、扣费或媒体
已落库的证明；因此 mock 中的 `storage_state=simulated`、模拟时间线和模拟 attempt 都不得被
报表或后续业务当作真实产物。

`estimated_cost_fen` 的单位始终是人民币分（CNY fen），不是积分。正式积分扣减若存在，使用
generation 域独立的积分账本字段表达，不得把这两个概念混用。

## 5. 确认并执行

`POST /api/v1/agent/sessions/:session_id/generation-orchestration/operations/:operation_id/confirm`

无请求体。该路由只允许已登录的人类调用。

mock 响应为 HTTP 200，`execution_mode=mock`，不创建生成任务、积分流水或供应商请求。
real 响应为 HTTP 202，复用服务器冻结报价，客户端不能回传或改写 prompt、参数、价格、模型或参考素材。

```json
{
  "ok": true,
  "data": {
    "operation_id": "uuid",
    "status": "succeeded",
    "execution_mode": "mock",
    "generation_request_id": null,
    "attempt_id": "mock-attempt-id",
    "target": {},
    "artifact": {
      "media_kind": "image",
      "storage_state": "simulated",
      "storage_url": null
    },
    "ledger": {
      "estimated_cost_fen": 60,
      "charged_cost_fen": 0,
      "points_spent": 0,
      "currency": "CNY"
    },
    "timeline": [
      {"state": "accepted", "offset_ms": 0},
      {"state": "running", "offset_ms": 120},
      {"state": "succeeded", "offset_ms": 360}
    ],
    "message": "模拟生成已完成：未调用真实供应商，未扣费。"
  }
}
```

重复确认同一操作必须返回同一结果，不能创建第二次真实任务。
确认时必须重新校验 creative 权限、目标与全部冻结引用的当前可用性；建卡后撤权或删除引用
时，mock 与 real 都必须在执行前拒绝。单进程内并发确认复用同一个在途执行，真实生成仍由
generation 域报价消费的数据库幂等约束兜底，不能仅依赖对话回执查重。

## 6. Kimi #74 前端接缝

Kimi 的开发期 `NlOrchestrator` 是本地适配接口，不是最终 HTTP 路径。合流接线保持
视图状态机不动，在 transport 层做以下映射：

| Kimi 本地形状 | 本合同 |
|---|---|
| `send({text, context})` | `POST .../turns`；`clarification_required` 映射 clarify，`confirmation_required` 映射 card |
| `card_id` | `operation_card.operation_id` |
| `action` | `operation_card.operation_type` |
| `param_groups` | `operation_card.parameter_groups` |
| 本地换档/改参数 | 禁止本地改价；调用操作卡 `requote.endpoint` 获取新卡 |
| `confirm(card_id)` | 调用操作卡 `confirmation.endpoint` |
| `poll(task_id)` | mock 确认可直接成功；real queued 用 `generation_request_id` 调既有 `GET /api/v1/generations/:request_id` |

前端还必须补齐真实 `selected_asset` 三元组；只有“当前镜头”标签而没有媒体 ID
不能执行改图或改视频。后端会返回澄清，不会猜目标。能力档替代列表继续由既有
capability-tiers 免费读取接口提供，但最终报价只认本合同返回的冻结 quote。

## 7. 供应商复刻

复刻数据只含公开协议形状和人工构造内容，不保存真实供应商原始响应或凭据：

- Ark 图片：同步 `data[].url + usage`；
- Ark 视频：提交返回 `id + queued`，查询经历 `running → succeeded`，成功体含视频 URL；
- Seed Audio：同步 `code=0 + url/audio + duration + original_duration + subtitle`；
- 错误至少覆盖内容安全、限流、认证/配置和结果缺失，并经过真实 adapter 转成统一中文错误。

## 8. OpenAPI 与错误合同

OpenAPI 必须完整描述下列三个路由的请求、成功响应、冻结/幂等语义与中文错误响应，不能只
记录前端本地适配形状：

| 路由 | 成功状态 | 含义 |
|---|---|---|
| `POST .../turns` | `200` / `201` | `200` 为澄清；`201` 为创建冻结操作卡并等待确认 |
| `POST .../operations/:operation_id/requote` | `200` / `201` | `200` 为无需报价的澄清；`201` 为创建新的冻结操作卡，原卡不变 |
| `POST .../operations/:operation_id/confirm` | `200` / `202` | `200` 为 mock 已完成或既有幂等结果；`202` 为 real 已入队 |

OpenAPI 还必须为上述路由列出中文错误 `message` 与稳定 `code`，至少覆盖参数或层级不合法、
无 creative 权限、会话/操作不存在、`tier_not_priced`、可信台词或已登记男声音色缺失、操作已
确认、报价失效和服务不可用。错误不得泄露供应商、模型、凭据、内部堆栈或原始响应。

## 9. 安全不变量

- 自然语言轮次永不直接执行生成；
- mock 操作永不升级为 real；
- real 操作只从服务器冻结报价执行；
- 供应商和模型白名单仍以公司账户守卫为准；
- MiniMax/newapi experimental 占位不会因本接口激活；
- 前端不接收真实 model id、供应商任务 id、凭据、原始响应或内部错误；
- 操作卡只投影本合同字段，不暴露内部 schema 版本、执行模式或持久化时间；
- 所有错误信息为中文，并保留稳定 `code`。

## 10. 复刻依据

供应商协议形状以一手资料和仓内既有真跑证据交叉约束：

- Ark 图片生成 API：<https://api.volcengine.com/api-docs/view?action=ImageGenerations&serviceCode=ark&version=2024-01-01>
- Seedream 图片生成/编辑说明：<https://www.volcengine.com/docs/82379/1829186>
- Seedance 视频生成资料：<https://www.volcengine.com/docs/82379/2222480?lang=zh>
- Seed Audio 资料：<https://www.volcengine.com/docs/6561/1359370>
- 仓内真实适配器与回归：`src/modules/generation/provider/arkGenerationProvider.ts`、
  `src/modules/generation/provider/seedAudioProvider.ts`、
  `test/generation/openspeech-audio-chain-postgres.test.ts`、
  `scripts/sol-paid-e2e.mts`。

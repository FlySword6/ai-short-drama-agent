# 用户资产登记 API 形状稿 v1

状态：**Fable 2026-08-02 批准，已进入实现合同**

任务：S-goal-09 P1 / R136 资产登记功能面

日期：2026-08-02

## 1. 先定主要矛盾

用户要完成的是一次完整动作：

> 选图并填写少量业务字段 → 图片进入自己的资产库 → 能看见处理状态 →
> 需要作为 Seedance 参考图时，能看见供应商登记状态和下一步动作。

现有系统已经分别具备：

- `POST /api/v1/asset-upload-tasks`：图片排队、理解、TOS 持久化、写
  `asset_entities` / `asset_media`；
- `seedance_asset_registrations` 与现有登记 API：把已落 TOS 的图片显式登记到
  Seedance；
- 个人资产免审：`visibility=personal` 固定
  `status=approved, approved=true`；
- 资产类型词表、标签词表。

因此 v1 **扩现有上传任务，不再新建第二条上传队列或第二套资产表**。资产因子字典只提供
表单语义和校验依据，正式事实仍映射到现有 Entity / Media / Registration。

## 2. v1 范围

### 做

- 登录用户上传一张图片并提交登记表单；
- 任务异步进入个人资产库；
- 用户提交的字段按资产因子字典的“可人工声明字段”校验；
- 图片落 TOS 后，由同一次用户动作触发一次 Seedance `CreateAsset`；
- 查询任务时同时返回本地入库结果和 Seedance 登记结果；
- 幂等、防重复远端登记、业务语言错误；
- 个人资产不进入通用资产审核状态机。

### 不做

- 不支持音频、视频、3D 文件；这些不是当前 Seedance `CreateAsset(Image)` 合同能力；
- 不把字典的 88 个字段全部做成用户表单；
- 不允许客户端写模型置信度、证据等级、候选审核态、技术质量分或供应商状态；
- 不新建 FactorAsset、FaceIdentity 等物理表；
- 不自动刷新 Seedance 状态，不自动重试 `unknown`；
- 不把个人资产自动发布到通用库。

## 3. API 总览

沿用冻结响应信封：

```json
{ "ok": true, "data": {} }
```

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/assets/registration-schema` | 返回表单字段、资产类型、因子类型和能力边界 |
| POST | `/api/v1/asset-upload-tasks` | 扩展现有图片上传任务，增加登记表单与幂等键 |
| GET | `/api/v1/asset-upload-tasks` | 沿用现有当前用户在途任务列表 |
| GET | `/api/v1/asset-upload-tasks/:task_id` | 新增单任务详情，供页面轮询本地与供应商状态 |
| GET | `/api/v1/asset-upload-notifications` | 扩展现有终态提醒，附本地资产与登记摘要 |

已有显式登记与刷新 API 保持不变，作为失败后的人工补救：

```text
POST /api/v1/assets/:asset_id/media/:media_id/seedance-registration
POST /api/v1/assets/:asset_id/media/:media_id/seedance-registration/refresh
```

## 4. 表单字段目录

### 4.1 `GET /api/v1/assets/registration-schema`

请求：

```text
GET /api/v1/assets/registration-schema?asset_kind=character&factor_type=face_identity
```

`asset_kind`、`factor_type` 均可省略。省略时返回基础字段和可选目录；传入后返回适用于该组合
的完整字段列表。

响应：

```json
{
  "ok": true,
  "data": {
    "schema_version": "asset-registration-v1",
    "dictionary_version": "asset-factor-v0.2",
    "accepted_media_kinds": ["image"],
    "asset_kinds": [
      {
        "id": "character",
        "display_name": "角色",
        "factor_types": [
          { "id": "character_core", "display_name": "角色" },
          { "id": "identity_profile", "display_name": "身份档案" },
          { "id": "face_identity", "display_name": "面部身份" }
        ]
      }
    ],
    "fields": [
      {
        "id": "name",
        "display_name": "资产名称",
        "value_type": "text",
        "required": true,
        "max_length": 128,
        "input_source": "user"
      },
      {
        "id": "description",
        "display_name": "资产说明",
        "value_type": "long_text",
        "required": false,
        "max_length": 2000,
        "input_source": "user"
      },
      {
        "id": "age_stage",
        "display_name": "年龄阶段",
        "value_type": "single_select",
        "required": false,
        "options": ["child", "teen", "adult", "older", "unknown"],
        "input_source": "user"
      },
      {
        "id": "stable_feature_notes",
        "display_name": "稳定辨识特征",
        "value_type": "long_text",
        "required": false,
        "max_length": 2000,
        "input_source": "user"
      },
      {
        "id": "view_type",
        "display_name": "视角",
        "value_type": "single_select",
        "required": false,
        "options": ["front", "three_quarter", "side", "other"],
        "input_source": "user"
      }
    ],
    "system_managed_fields": [
      "version",
      "derivation_mode",
      "confidence_score",
      "review_state",
      "rights_status",
      "source_fragment_id",
      "status",
      "evidence_level",
      "reasoning_mode"
    ],
    "defaults": {
      "visibility": "personal",
      "status": "approved",
      "clearance": {
        "search": true,
        "gen_reference": true,
        "commercial_publish": false,
        "model_training": false
      }
    }
  }
}
```

约束：

1. `asset_kinds` 从现有 `asset_kind_vocabulary` 读取，不在新模块复制枚举；
2. 标签从现有标签词表读取，不塞进本接口的大响应；
3. `factor_type + fields` 是字典 v0.2 中已选入 v1 的用户输入子集；
4. AI 推断字段仍由图片理解链产生，并标记来源；用户输入不能伪装成 AI 测量结果；
5. 字典中仍标“待确认 / design_only / new_proposal”的物理模型不在本包建表。

### 4.2 v1 首批用户字段

所有类型共用：

| 字段 | 必填 | 映射 |
| --- | --- | --- |
| `name` | 是 | `asset_entities.name/display_name` |
| `description` | 否 | `asset_entities.intro` |
| `asset_kind` | 是 | 规范化后写 `asset_entities.asset_kind` |
| `factor_type` | 是 | `asset_entities.metadata.asset_factor.factor_type` |
| `tags` | 否 | 现有 `asset_tags`，先 ensure 再 attach |

首批因子字段只纳入“用户能理解并能直接声明”的字段：

| 因子 | v1 字段 |
| --- | --- |
| `character_core` / `identity_profile` | `age_stage`, `stable_feature_notes` |
| `face_identity` | `view_type`, `stable_feature_notes` |
| `costume` | `category`, `layer`, `dominant_colors`, `material`, `pattern`, `silhouette` |
| `scene` / `prop` / `other` | 先只用共用字段，等待字典卡确认后扩 |

`expression_neutrality`、`makeup_neutrality`、`occlusion_ratio`、embedding、landmarks、
Mask/Depth/Pose 等属于模型或系统产出，不能出现在用户提交白名单里。

## 5. 提交形状

### 5.1 `POST /api/v1/asset-upload-tasks`

`multipart/form-data`：

| part | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file` | binary | 是 | v1 仅一张可解码图片 |
| `client_idempotency_key` | uuid string | 是 | 同一用户明确动作的幂等键 |
| `registration` | JSON string | 是 | 下列登记表单 |

`registration`：

```json
{
  "schema_version": "asset-registration-v1",
  "dictionary_version": "asset-factor-v0.2",
  "name": "灰发老年男性",
  "description": "正面、肩部以上、表情中性的人物身份参考",
  "asset_kind": "character",
  "factor_type": "face_identity",
  "tags": ["写实人像", "老年男性", "正面肖像"],
  "factor_attributes": {
    "age_stage": "older",
    "view_type": "front",
    "stable_feature_notes": "灰发、短须、深眼窝"
  },
  "rights_declaration": {
    "source_kind": "self_created",
    "contains_real_person": false,
    "reference_use_confirmed": true
  }
}
```

`rights_declaration` 是用户声明，不是平台核验结论：

- `source_kind`：`self_created | licensed | public_domain | unknown`；
- `contains_real_person`：必须明确填写；
- `reference_use_confirmed`：必须为 `true` 才允许发起 Seedance 登记；
- 该声明写入 provenance/metadata，不能覆盖服务端生成的
  `source_channel=external_upload`；
- v1 仍采用现有保守 clearance：站内检索和生成参考可用，商业发布与模型训练默认关闭。

### 5.2 校验顺序

1. 鉴权；
2. 校验幂等键；
3. 校验文件类型、可解码性、大小和像素上限；
4. 从资产类型词表解析 `asset_kind`；
5. 按登记 schema 校验 `factor_type` 与 `factor_attributes`，未知字段直接拒绝；
6. 校验权利声明；
7. 计算内容 SHA-256；
8. 创建或复用当前用户的上传任务；
9. 返回 `202`，由既有 worker 处理。

同一 `user_id + client_idempotency_key`：

- payload 哈希一致：返回原任务，不重复上传、不重复 `CreateAsset`；
- payload 哈希不一致：返回 `409 idempotency_key_conflict`。

提交响应：

```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "status": "queued",
    "original_file_name": "portrait.png",
    "asset_kind": "character",
    "factor_type": "face_identity",
    "queue_position": 1,
    "estimated_duration_seconds": 12,
    "estimated_duration_sample_count": 6,
    "created_at": "2026-08-02T00:00:00.000Z"
  }
}
```

## 6. 任务详情与两段结果

`GET /api/v1/asset-upload-tasks/:task_id` 只允许任务所属用户读取。

```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "status": "succeeded",
    "original_file_name": "portrait.png",
    "asset_kind": "character",
    "factor_type": "face_identity",
    "queue_position": null,
    "estimated_duration_seconds": null,
    "estimated_duration_sample_count": 6,
    "created_at": "2026-08-02T00:00:00.000Z",
    "started_at": "2026-08-02T00:00:01.000Z",
    "finished_at": "2026-08-02T00:00:09.000Z",
    "result": {
      "asset": {
        "id": "uuid",
        "media_id": "uuid",
        "scope": "personal",
        "status": "approved"
      },
      "seedance_registration": {
        "id": "uuid",
        "status": "processing",
        "remote_asset_id": "string | null",
        "last_verified_at": null,
        "fresh_until": null,
        "can_use_as_seedance_reference": false,
        "next_action": "refresh"
      }
    },
    "error": null
  }
}
```

任务 `status` 继续沿用：

```text
queued | processing | succeeded | failed
```

其含义只描述“本地个人资产是否成功持久化”。Seedance 是嵌套的第二段状态：

```text
pending | submitting | processing | active | unavailable | failed | unknown
```

这样不会出现以下两种错误：

- Seedance 暂不可用时，把已经成功进入个人库的资产谎报为“全部失败”；
- 本地资产存在但 Seedance 未激活时，把它谎报为“可作为 Seedance 参考”。

只有登记为 `active` 且仍在 freshness 窗口内，
`can_use_as_seedance_reference=true`。`unknown` 不自动补发；
`processing/active` 后续状态只由用户显式 refresh 推进。

## 7. 服务端写入映射

| 业务事实 | 现有正式事实 |
| --- | --- |
| 用户与个人域 | `asset_entities.owner_user_id`, `visibility=personal` |
| 个人免审 | `asset_entities.status=approved`, `approved=true` |
| 名称、简介、类型 | `asset_entities` 一等字段 |
| 因子类型与首批扩展属性 | `metadata.asset_factor`，带 `dictionary_version` 与 `input_origin=user_declared` |
| 标签 | 现有 `tag_vocabulary` + `asset_tags` |
| 原始图片 | `asset_media`，独立 SHA-256，TOS URL |
| 外部上传来源 | `media_provenance_subjects.source_channel=external_upload` |
| Seedance 远端 ID 与状态 | `seedance_asset_registrations` 唯一正式事实 |
| metadata 中的 Seedance 字段 | 仅兼容投影，不作为权限或生成判断真源 |

`metadata.asset_factor`：

```json
{
  "dictionary_version": "asset-factor-v0.2",
  "factor_type": "face_identity",
  "attributes": {
    "age_stage": "older",
    "view_type": "front",
    "stable_feature_notes": "灰发、短须、深眼窝"
  },
  "input_origin": "user_declared"
}
```

模型图片理解结果放在既有模型输出位置，并明确 `inferred/generated`，不能覆盖
`user_declared`。两者冲突时保留两份来源，页面提示用户确认；本包不自动裁掉任一份。

## 8. Worker 顺序

```text
领取上传任务
  → 图片解码与 SHA-256
  → 图片理解
  → TOS 上传
  → 事务写 asset_entities / asset_media / provenance / tags
  → 调既有 Seedance registration application service
  → 写 seedance_asset_registrations
  → 上传任务记 succeeded，并保存 entity_id / media_id / registration_id
  → 向量投影异步重建
```

边界：

- TOS 或本地事务失败：任务 `failed`，不得留下无主对象；
- 本地事务成功后 Seedance 失败/不明：任务 `succeeded`，嵌套登记为
  `failed/unknown/unavailable`，不得删除个人资产；
- Seedance 调用必须复用现有 application service 的领取与审计，不复制 provider；
- 向量投影失败不改业务终态，允许重建；
- 日志只写 task/asset/registration ID 与业务错误码，不写 URL、签名或凭据。

## 9. 业务语言错误

| code | 用户文案 |
| --- | --- |
| `registration_schema_mismatch` | 登记字段已更新，请刷新页面后重新提交 |
| `unsupported_asset_media` | 当前只支持登记图片资产 |
| `unknown_factor_field` | 这项资产信息当前不支持，请刷新表单后重试 |
| `rights_confirmation_required` | 请先确认你有权上传并将该图片用于创作参考 |
| `idempotency_key_conflict` | 本次提交标识已被另一份内容使用，请重新提交 |
| `seedance_asset_registration_unavailable` | 图片已进入个人资产库，素材登记暂不可用，可稍后重试 |
| `seedance_asset_registration_unknown` | 素材登记结果暂时无法确认，请先核对后再重试 |

## 10. Fable 已批准的三点

1. **v1 只收图片**：与当前上传链和 Seedance `CreateAsset(Image)` 一致；音频、视频、
   3D 分别走自己的媒体能力，不在这包伪装成通用上传。
2. **复用 `asset-upload-tasks`**：不新建第二队列；任务成功表示“已进个人库”，
   Seedance 状态作为嵌套事实单独表达。
3. **字典只采用户可声明子集**：88 字段不等于 88 个表单项；AI/系统字段禁止客户端写，
   `design_only/new_proposal/待确认` 字段不在本包建物理模型。

三点已于 2026-08-02 零修改批准。实现使用迁移
`043_asset_registration_upload_tasks.sql` 保存幂等键、表单快照、结果 `media_id` 与
`registration_id`；该迁移进入发版手工件清单。

## 11. 来源对齐

- 《资产因子与关系字典 v0.2》：
  - 业务概念映射现有 `AssetEntity → AssetVariant → AssetMedia`；
  - AI 只写候选层，不能伪装成用户或已审核事实；
  - 身份、权利、来源与推断/生成结果必须保留证据边界；
  - `IdentityProfile/FaceIdentity` 首期先以 `factor_type + metadata` 验证，不直接建多表。
- 《Assets Discovery》：
  - 资产转化需分别保存内容理解、业务资产、检索表示、质量、权利与来源；
  - 外部 candidate 不应绕过质量/合规/证据判断直接写全局库；
  - 本包只进个人库，与通用资产发布和审核保持隔离。
- 现有仓库合同：
  - `docs/contracts/v0.2.0/seedance-asset-registration.md`；
  - R128 个人资产免审；
  - 资产词表、标签词表与 clearance 现有真源。

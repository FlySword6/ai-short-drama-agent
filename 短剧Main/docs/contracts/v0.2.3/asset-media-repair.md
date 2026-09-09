# 资产媒体修理后端合同

> 状态：`BACKEND_READY_FOR_FRONTEND`
>
> 版本卡：`asset-3d-thumbnails`，范围裁决 R183
>
> 后端交付：`SOL-ASSET-MEDIA-BE-R2-DONE`

本合同是 Kimi 前端段的接线事实。PostgreSQL 保存媒体事实、展示变体核验结果、修理任务和
逐动作审计；TOS 保存二进制原件。前端不拼接对象存储地址、不传入任意外链，也不直接读取
原件地址。

## 1. 通用约定

- 所有路由要求登录，响应沿用 `{ "ok": true, "data": ... }` 信封。
- 路径参数、媒体 ID、修理 ID 与 `client_idempotency_key` 都是 UUID。
- JSON 字段使用 snake_case，时间为 ISO 8601 UTC 字符串。
- 用户可见错误沿用平台错误信封，并保留中文 `display_reason`。
- `mode` 当前只接受 `safe`；后端只执行可证明、幂等、非破坏的修理。
- 个人资产仅 owner 可发起修理；通用资产仅 `admin` 可发起。读健康状态与下载原件沿用
  资产可见权限。

## 2. 展示媒体投影

资产列表、详情与媒体版本接口中的展示字段：

```json
{
  "sourceFileUrl": null,
  "storageUrl": "https://display.example/asset-renditions/v1/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp",
  "thumbnailUrl": "https://display.example/asset-renditions/v1/cc/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.webp",
  "mediaDisplay": {
    "thumbnail": {
      "url": "https://display.example/asset-renditions/v1/cc/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.webp",
      "kind": "thumbnail",
      "width": 320,
      "height": 180,
      "format": "webp"
    },
    "detail": {
      "url": "https://display.example/asset-renditions/v1/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp",
      "kind": "detail",
      "width": 960,
      "height": 540,
      "format": "webp"
    }
  },
  "original": {
    "downloadAvailable": true,
    "downloadEndpoint": "/api/v1/assets/{asset_id}/media/{media_id}/download-url"
  }
}
```

规则：

- `sourceFileUrl` 始终为 `null`；`storageBucket` 与 `storagePath` 不出现在公开媒体投影中；
  metadata 与项目版本快照里的原对象 key、URL、本地路径也会递归移除。历史 JSON 中
  locator 形态的任意大小写键名及存储 URI/路径值同样 fail-closed，不能靠换字段名绕过。
- 旧 `storageUrl`/`thumbnailUrl` 只承载已经核验并独立落 TOS 的展示对象，绝不回退到原件、
  GLB 或“原件 URL + 可删除的查询参数”。
- 没有合格图片媒体或展示基址时，展示字段返回 `null`，前端显示真实空态。
- 后端仍用固定 TOS 图片处理规格生成 320×180 WebP 与边界内 1280×720 WebP，但会把结果
  上传到不可由原 key 推导的 `asset-renditions/v1/<2位十六进制>/<64位十六进制>.webp`
  独立命名空间；前端不拼处理参数。公开路径使用完整 grammar 校验，点段、编码穿越、
  反斜杠与历史命名 key 均 fail-closed。
- `mediaDisplay` 只投影 `stored_object + healthy` 且具备 source SHA、输出 SHA、尺寸、格式、
  核验时间的事实；rendition 的 source SHA 还必须与当前源媒体 SHA 完全一致。缺一项或
  源内容已经变化就返回 `null`，同时由 `media-health` 说明原因。响应中的 `width/height`
  是最终回读对象的真实尺寸；1280×720 只是详情档上限，不会冒充实际尺寸。
- 目录、搜索、项目引用、备戏缩略图、健康诊断与下载端点使用同一归属口径：媒体必须已审核、
  未删除；绑定业务变体时该变体必须仍有效，且媒体直接声明的实体（如有）必须与变体 owner
  一致。“实体 A + 实体 B 的变体”这类历史双归属脏行一律 fail-closed，不能从任一 OR
  分支借图。
- `ASSET_MEDIA_DISPLAY_BASE_URL` 只接受 HTTPS CDN 域名；留空时使用
  `TOS_PUBLIC_BASE_URL`。代码已经阻断原 key 泄露，但 CDN、私有源站和桶策略的真实开通仍是
  独立云端动作，不能用本地测试冒充。

## 3. 查询健康状态

```http
GET /api/v1/assets/{asset_id}/media-health
```

```json
{
  "ok": true,
  "data": {
    "asset_id": "uuid",
    "status": "degraded",
    "active_repair_task_id": null,
    "media_count": 2,
    "healthy_media_count": 1,
    "checked_at": "2026-08-04T00:00:00.000Z",
    "issues": [
      {
        "code": "image_thumbnail_missing",
        "media_id": "uuid",
        "rendition_kind": "thumbnail",
        "display_reason": "列表缩略图尚未核验，后端可自动生成展示变体。",
        "auto_repairable": true,
        "blocker": false
      }
    ]
  }
}
```

`status`：

- `healthy`：没有已知问题；
- `degraded`：存在安全自愈项；
- `broken`：存在必须补来源或人工确认的 blocker；
- `repairing`：该资产有 `queued` 或 `processing` 任务。

个人资产 owner 和管理员可以看到完整修理诊断及 `active_repair_task_id`。通用资产普通成员
只看到与目录同口径的已审、未删除、归属一致媒体；待审或错绑媒体、管理员任务 UUID 和
`repairing` 运维状态都不会经健康端点形成侧信道。

问题码当前集合：

```text
asset_media_missing
media_unbound
media_variant_missing
media_entity_variant_mismatch
source_locator_missing
source_object_missing
source_object_unreadable
image_metadata_missing
image_thumbnail_missing
image_detail_missing
rendition_stale
rendition_failed
model_preview_missing
director_chinese_description_missing
```

前端用 `display_reason` 对人解释，用 `auto_repairable` 决定是否展示“安全修复”，用 `blocker`
决定是否改为人工处理提示；不要自行翻译问题码。

## 4. 创建安全修理任务

```http
POST /api/v1/assets/{asset_id}/media-repairs
Content-Type: application/json

{
  "client_idempotency_key": "uuid",
  "media_ids": ["uuid"],
  "mode": "safe"
}
```

- `media_ids` 可省略或传空数组，两者都表示检查并修理整件资产；最多 500 个。
- 相同用户、相同幂等键、相同请求重放时返回同一任务并令
  `idempotent_replay=true`。
- 同一幂等键承载不同请求返回 `idempotency_key_conflict`。
- 同一资产已有不同的活跃任务时返回 `asset_media_repair_in_progress`。

成功提交返回 HTTP 202：

```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "asset_id": "uuid",
    "requested_by_user_id": "uuid",
    "client_idempotency_key": "uuid",
    "mode": "safe",
    "trigger": "manual",
    "media_ids": ["uuid"],
    "status": "queued",
    "diagnosis": {
      "status": "degraded",
      "issue_codes": ["image_metadata_missing"],
      "issue_count": 1,
      "media_count": 1,
      "healthy_media_count": 0,
      "checked_at": "2026-08-04T00:00:00.000Z"
    },
    "result": null,
    "error_code": null,
    "display_reason": null,
    "created_at": "2026-08-04T00:00:00.000Z",
    "started_at": null,
    "finished_at": null,
    "updated_at": "2026-08-04T00:00:00.000Z",
    "idempotent_replay": false
  }
}
```

## 5. 查询修理任务

```http
GET /api/v1/assets/{asset_id}/media-repairs/{repair_id}
```

返回字段与创建响应相同。状态流：

```text
queued -> processing -> succeeded | partial | failed
```

- `succeeded`：本次范围内没有剩余问题；
- `partial`：至少一项成功，但仍有 blocker 或失败项；
- `failed`：没有完成可用修理，或任务级异常。

终态 `result` 至少包含：

```json
{
  "succeeded_actions": 3,
  "blocked_actions": 0,
  "failed_actions": 0,
  "remaining_issue_codes": []
}
```

前端轮询到终态后停止，并重新查询 `media-health` 和资产详情。不要从任务内部结果自行重建
媒体投影。

## 6. 获取原件短时下载地址

```http
POST /api/v1/assets/{asset_id}/media/{media_id}/download-url
```

```json
{
  "ok": true,
  "data": {
    "media_id": "uuid",
    "url": "https://signed.example/object?...",
    "expires_at": "2026-08-04T00:05:00.000Z"
  }
}
```

- URL 固定为短时 GET 签名，当前有效期 300 秒。
- 后端先验证媒体确实属于该资产且调用人仍可读取；只传媒体 ID 不能越权。
- 前端收到后立即打开或下载，不缓存到业务数据库、不写日志、不把它当展示 URL。

## 7. 自愈与 3D 边界

- 应用 worker 每次串行领取 PostgreSQL 任务；每次 claim 带 5 分钟租约和随机 token，
  处理期间续租。只回收已过期租约，旧 worker 的事实写入、审计和终态写入都会被 token
  条件拒绝。
- 每 15 分钟最多扫描 20 件具备明确源定位的候选资产，不处理归属歧义。hard blocker 会按
  资产/媒体状态指纹退避 24 小时；状态变化立即恢复候选，外部对象同 key 恢复后最迟在退避
  到期再次核验，坏资产不会每轮霸占窗口。
- 图片修理会读取原件、校验大小和像素、回填真实宽高/格式/SHA，用固定 TOS 图片处理生成
  两档 WebP，再上传独立对象；上传成功后必须从最终 bucket/key 回读，再次核验 WebP
  格式、尺寸与字节 SHA，全部一致才登记为 `healthy`。对象 key 绑定输出 SHA：过期 worker
  即使晚到，也不能用不同字节覆盖新 worker 的当前对象；相同字节写入同 key 仍保持幂等。
  rendition 事实与对应 action 在同一个持租约事务中提交，审计约束失败会连同事实一起回滚。
- 3D 缺预览时只返回 blocker。519 件真实 GLB 的离屏渲染、PNG 上传和中文描述回填使用
  独立清单及导入器；浏览器只允许精确的本地 renderer origin，GLB 外部 URI 在打开浏览器
  前拒绝；导入前逐件复核不透明存储 key、源 SHA、512×512 PNG 和输出 SHA。导入只登记
  与源 GLB 同资产、同业务变体且精确绑定源 ID+SHA 的 PNG；跨实体或跨变体 metadata
  引用一律不可成为预览。apply 会在事务内锁定实时 entity、源媒体与适用 variant，并重新
  验证已审核、未删除、`model_3d`/GLB、bucket/path 与 SHA；离线清单过期时整批回滚，不会
  覆盖现有 preview。随后由同一图片修理管线生成两档 WebP。
  没有源对象、云写和付费授权时不自动执行。

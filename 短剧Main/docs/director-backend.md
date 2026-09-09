# 导演台后端（director-backend）

V0.1.1 W3「3D 导演台迁移」后端：场景与版本（DirectorScene/DirectorSceneVersion）、
截图入库（captures）、DirectorCommand 合同与校验。模版包接口见 `docs/director-templates.md`。

## 模块布局与自包含插件

`src/modules/director/` 是一个自带鉴权的独立 Fastify 插件：

- `routes.ts`：`registerDirectorRoutes(app, getDatabase, deps?)` —— 总插件。
  在封装上下文挂 `preHandler` 鉴权钩子（`auth.ts`），下挂 templates/scene/captures/commands 四组路由。
- `auth.ts`：复用 `src/http/authenticate.ts` 的 `createAuthenticationHook`（Bearer session），
  生产环境全局 preHandler 已鉴权（`request.authUser` 存在）时直接放行，不重复查库；
  独立注册时自行完成鉴权。**AUTH-04：模块无任何匿名接口，未登录一律 401 `unauthorized`。**
- `scene/`：DirectorScene 服务（repository 原生 SQL + service + routes）。
- `captures/`：截图入库（multipart + sharp 实解码 + TOS + 三表事务 + 补偿清理）。
- `commands.ts` + `commands/`：14 种 DirectorCommand 的 zod 合同、快照契约（`snapshot.ts`）、
  reducer/executor 纯函数（`executor.ts`）、批量校验端点（`routes.ts`）。
- `migrations/004_director_scenes.sql`：`director_scenes` / `director_scene_versions` 正式迁移（见下）。
- `testUtils.ts`：测试脚手架（自建 Fastify 实例注册总插件、假 session 鉴权、生产同款错误信封）。

**数据契约**：本模块全部接口为导演台 camelCase 契约，**不做**仓库惯用的 snake_case 转换
（快照本体就是导演台场景 JSON，键名必须原样往返）。错误仍走统一信封
`{ok:false,error:{code,message,retryable,details}}`。

## 鉴权与项目归属

- 所有端点要求 `Authorization: Bearer <session-token>`（`/api/v1/auth/login` 签发）。
- 项目归属：URL 的 `project_id` 必须存在（未软删）且 `owner_user_id = 当前用户`，
  否则 404 `not_found` / 403 `forbidden`。校验逻辑与 `ProjectAssetRepository.assertProjectOwner`
  同一语义，scene/captures/commands 每条请求都执行（写路径在事务内再查一次）。

## API 契约

### GET /api/v1/projects/:project_id/director/scene

取当前导演场景（含当前版本快照）。

- 200：`{ ok:true, data:{ id, projectId, status, currentVersion, snapshot, createdByUserId, createdAt, updatedAt } }`
- 404 `not_found`：项目不存在，或该项目还没有导演场景。
- 403 `forbidden`：他人项目。401：未登录。

### PUT /api/v1/projects/:project_id/director/scene

保存新版本（乐观锁）。

请求体：

```jsonc
{
  "sceneVersion": 3,              // 期望的当前版本；创建场景必须传 0
  "snapshot": { "schemaVersion": 1, "objects": [], "cameras": [] },  // 过 sceneSnapshotSchema，缺省字段自动补默认值
  "sourceAction": "template_apply", // 可选，≤64 字符，默认 "manual_save"，写进版本行留痕
  "status": "saved"                // 可选 "draft"|"saved"，默认 "saved"
}
```

- 200：`{ ok:true, data:{ ...场景记录, savedVersion:{ id, sceneId, version, kind:"current", sourceAction, createdByUserId, createdAt } } }`
- 版本号单调 +1（服务端 `current_version+1`，不接受客户端指定）。
- 409 `scene_version_conflict`：`sceneVersion` 与服务端 `current_version` 不符（含并发写落空），
  `details.currentVersion` 给出服务端当前版本。
- 404：`sceneVersion>0` 但场景不存在。400：body 或 snapshot 不合法（zod 不静默吞错）。

### GET /api/v1/projects/:project_id/director/scene/versions

版本列表（倒序，不含 snapshot 本体）。

- 200：`{ ok:true, data:{ sceneId, currentVersion, versions:[{ id, sceneId, version, kind, sourceAction, createdByUserId, createdAt }] } }`
- `kind` 为派生语义：`version = current_version` → `current`，其余 `historical`。

### POST /api/v1/projects/:project_id/director/captures

导演台截图入库（multipart/form-data）。

- 表单字段：文件 `file`（必须，PNG）+ 可选 `episode_id` / `scene_id` / `shot_id` / `title`（uuid/≤128 字符）。
- 校验顺序与语义：
  1. 读文件前先做项目归属（403/404 不拖大文件）；
  2. 声明 MIME 必须 `image/png`（400）；文件 ≤ 10 MB（413 `payload_too_large`）；
  3. sharp 实解码：`metadata.format === "png"` 且 `stats()` 强制解码，宽高各 ≤ 4096 px（400）；
  4. `episode_id`/`scene_id`/`shot_id` 传入时必须存在且属于 URL 项目（404），彼此父级一致（400）——
     禁止自动挑项目、禁止静默接受错位归置；
  5. 上传 TOS（既有 `TosStorage` 封装，沿用服务端 bucket 配置，无 public bucket 语义），
     key：`prod/director/<projectId>/captures/<mediaId>_<sha256前16>.png`；
  6. 单事务写三表：`asset_entities`（`asset_kind=scene_reference`、`visibility=personal`、
     `status=pending_review`、`approved=false`，**绝不自动 approved**）、`asset_media`
     （`approved=false`）、`project_asset_refs`（含 version_snapshot 留痕）。
- **补偿**：DB 事务失败时删除刚上传的 TOS 对象（best effort，清理失败不掩盖原始 DB 错误）；
  未通过归属/解码校验时绝不写 TOS。
- 201：`{ ok:true, data:{ assetEntityId, assetMediaId, projectAssetRefId, projectId, episodeId, sceneId, shotId, title, status:"pending_review", approved:false, storageBucket, storagePath, storageUrl, widthPx, heightPx, sha256 } }`

### POST /api/v1/projects/:project_id/director/commands/validate

批量校验 DirectorCommand 序列（只校验不执行，不落库）。

请求体：`{ sceneId, sceneVersion, commands: [...] }`（1–100 条，逐条过 14 种命令合同）。

校验顺序：

1. zod 结构（400 `invalid_request`）；
2. 每条命令的 `projectId` 必须等于 URL 项目、`sceneId`/`sceneVersion` 必须等于请求体（400）；
3. 项目归属（403/404）与场景存在（404）、`sceneId` 与项目当前场景一致（400）；
4. `sceneVersion` 必须等于服务端 `current_version`（409 `scene_version_conflict`，`details.currentVersion`）；
5. 基于当前快照**干跑**（executor 纯函数在克隆上顺序执行）：对象/机位引用不存在、
   机位设姿态等错误汇总为 422 `command_validation_failed`，`details` 为
   `[{ index, type, message }]`（index 为 0 起的命令序号）；
6. 存储快照损坏不静默吞错：409 `scene_snapshot_corrupt`。

- 200：`{ ok:true, data:{ valid:true, commandCount, sceneId, sceneVersion } }`

## DirectorCommand 合同（14 种）

每条命令携带 `projectId` / `sceneId` / `sceneVersion`（乐观锁）与类型化 payload；
executor（`commands/executor.ts`，前端与 Pi 共用的纯函数真源）在应用时产出 `inverse`，
`undo(snapshot, inverse)` 精确回滚。14 种命令全部有正反执行与撤销单测。

| type | payload | 快照变化 | inverse |
| --- | --- | --- | --- |
| `add_object` | `{ object }` | 追加对象（id 全局唯一，含机位） | `delete_object` |
| `duplicate_object` | `{ objectId, newObjectId?, name? }` | 深拷贝对象/机位（默认 id `-copy`、名 `副本`） | `delete_object` |
| `delete_object` | `{ objectId }` | 删除对象/机位；清空指向它的 selected/active 指针 | `add_object`（含被删快照与 collection） |
| `select_object` | `{ objectId \| null }` | 设置/取消选择（对象须存在） | `select_object`（旧选择） |
| `set_transform` | `{ objectId, transform:{position?,rotation?,scale?} }` | 局部合并（机位仅 position） | `set_transform`（旧完整 transform） |
| `set_pose` | `{ objectId, pose }` | 替换姿态（对象须支持 pose，机位报错） | `set_pose`（旧 pose） |
| `add_camera` | `{ camera }` | 追加机位 | `delete_object` |
| `set_camera` | `{ cameraId, patch:{name?,focalLength?,target?,position?,rollDeg?} }` | 补丁修改；`rollDeg:null` 清除 | `set_camera`（旧完整机位） |
| `set_aspect_ratio` | `{ aspectRatio }` | 9:16/16:9/1:1/4:3/3:4 | `set_aspect_ratio`（旧值） |
| `set_environment` | `{ patch:{preset?,backgroundColor?,ambientLight?,groundVisible?} }` | 局部合并 | `set_environment`（旧完整环境） |
| `attach_asset` | `{ objectId, asset:{ assetEntityId, assetMediaId?, name? } }` | 挂到对象 attachments（去重；机位报错） | `detach_asset` |
| `save_scene` | 无 | 恒等（持久化走 PUT scene） | `noop` |
| `capture_view` | `{ cameraId?, label? }`（可选） | 恒等（落地走 POST captures） | `noop` |
| `undo` | 无 | 恒等（由调用方对 inverse 栈执行） | `noop` |

inverse 合同（`commandInverseSchema`）：`noop` / `add_object{collection,object}` /
`delete_object{objectId}` / `set_transform{objectId,transform}` / `set_pose{objectId,pose}` /
`set_camera{cameraId,camera}` / `select_object{objectId}` / `set_aspect_ratio{aspectRatio}` /
`set_environment{environment}` / `attach_asset{objectId,asset}` / `detach_asset{objectId,assetEntityId}`。

executor 语义边界：`delete_object` 的撤销只恢复对象本体，不恢复被清空的
selected/active 指针；所有函数不修改输入（`structuredClone` 后返回新快照）。

## 正式数据库迁移

`migrations/004_director_scenes.sql` 已由原提案收编为正式、可编号执行的迁移：

- `director_scenes`：项目维度场景元数据。`status ∈ draft/saved/archived`，
  `current_version` 指针；部分唯一索引保证每项目至多一条活跃场景；
  归档用 `archived_at`/`archived_by_user_id` 留痕。
- `director_scene_versions`：不可变版本行（`(scene_id, version)` 唯一，`version > 0`，
  `snapshot jsonb` 必须为 object），`source_action` + `created_by_user_id` 留痕；
  PRD 的 current/historical 由 `version = current_version` 派生，不冗余存列。
- 恢复：旧代码不会读取这两张表；应用回退时可先保留数据。需要清除时由 DBA 备份后按
  `director_scene_versions` → `director_scenes` 的依赖顺序手工删除，不在应用启动时自动回滚。

repository（`scene/repository.ts`）用注入的 pg client 写原生 SQL（新表未进 drizzle
schema；生产从 drizzle 的 `$client` Pool 取连接开事务），单测用脚本化假 client 断言 SQL 序列。

## 给集成者的接入清单

1. **路由注册一行**：`src/http/routes.ts` 的 `registerRoutes` 内加
   ```ts
   import { registerDirectorRoutes } from "../modules/director/routes.js";
   // ...
   await registerDirectorRoutes(app, options.getDatabase);
   ```
   （multipart 由 `src/app.ts` 全局注册，插件不重复注册；生产全局鉴权钩子先行，
   插件钩子自动放行，不会双重查库。）
2. **migration**：已落成 `migrations/004_director_scenes.sql`；部署时由显式
   `npm run db:migrate` 按编号执行，应用启动不自动迁移。
3. **Dockerfile**：无改动（未引入新依赖、无新构建步骤；TOS 凭据沿用现有环境变量）。

## 未验证项（本工作包范围内无法覆盖）

- 真实 PostgreSQL 未连：scene/captures 的 SQL 以假 client 单测验证语句序列与参数，
  未在真实库执行（含 `gen_random_uuid()`、部分唯一索引行为）。
- 真实 TOS 未连：上传/补偿删除以注入 fake 验证调用契约，未发真实请求。
- captures 的 `asset_kind=scene_reference` 是新取值：既有表无 CHECK 约束可直存，
  但资产中心 UI/检索对该 kind 的展示需前端工作包确认。

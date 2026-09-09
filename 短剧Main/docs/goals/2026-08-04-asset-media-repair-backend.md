# Sol Goal：资产媒体修理·后端段

> 状态：`complete`
> Owner：DC
> 统筹与验收：Fable
> 后端执行：Sol
> 前端接入：Kimi
> 基线：`origin/dev@02c3ab2d`
> 分支：`feature/asset-media-repair-backend`
> 交付标签：`SOL-ASSET-MEDIA-BE-DONE`

## 1. 目标

让资产库中的坏媒体、缺失展示变体和元数据错位可以被后端发现、解释、修复并在安全范围内
自愈；列表和详情只消费专门的展示变体，原文件只通过受权下载端点获取；为 Kimi 后续前端段
提供稳定、可回归的 API 合同。

本目标同时承接 `docs/design/version-plan.md` 的 `asset-3d-thumbnails` 卡和 R183 扩围：

- 图片列表小图、详情中图走固定的 TOS 图片处理参数；
- 原图不再作为列表或详情缩略图，只保留受权下载；
- 3D 资产有统一渲染预览与中文描述的可批量导入管线；
- CDN 接线配置与校验进入工程合同，云端开通必须另有回执。

## 2. 事实源与不变量

- 版本卡：`docs/design/version-plan.md` 中 `asset-3d-thumbnails` 及其 acceptance。
- 范围裁决：`docs/planning/orchestration.md` R183。
- 架构合同：`docs/contracts/v0.1.1/architecture.md`、`api-and-data.md`。
- PostgreSQL 是资产元数据、修理任务和审计的唯一正式事实；TOS 是二进制事实。
- 展示 URL 只能来自已核验、独立存储且不可由原 key 反推的 rendition 对象，不能接受客户端
  任意 URL，也不能使用“原件 URL + 可删除处理参数”。
- 独立对象只有在上传后从最终 bucket/key 回读并复核格式、尺寸和 SHA 才能登记健康；
  3D 预览必须与源模型同资产、同业务变体且精确绑定源 ID+SHA。
- 修理只自动执行可证明、幂等、非破坏的动作；关系归属有歧义、源对象缺失或内容不合法时
  返回 blocker，不猜测、不静默覆盖。
- 不把密钥、签名 URL、原图公网地址或供应商内部错误写入日志、任务结果和 API。
- 本分支不 push、不部署、不触发付费调用、不做生产变更。

## 3. 交付范围

### 3.1 数据与深模块

- 持久化媒体展示变体、健康状态、修理任务与逐动作审计。
- 诊断至少覆盖：源定位缺失、实体/业务变体归属错位、媒体无归属、图片元数据缺失或错位、
  展示变体缺失/过期、3D 预览缺失、导演资产中文描述缺失。
- 修理任务具备请求级幂等、明确状态、可重试边界和部分成功语义。
- 自愈 worker 只领取持久化任务；claim 使用可续租 token，过期才能回收，所有任务内写入均
  受 token 约束；hard blocker 有持久状态指纹与 24 小时退避，不依赖内存队列作为事实。

### 3.2 展示与下载合同

- 固定 `thumbnail` 和 `detail` 两种展示规格；图片源通过固定 TOS process 取回结果后，
  再上传到 `asset-renditions/v1/` 独立对象并核验；3D 预览 PNG 也进入同一修理管线。
- 资产列表/详情返回 `media_display` 展示 URL 与固定规格；健康状态与问题摘要由
  `media-health` 端点返回；不把模型文件或原图冒充缩略图。
- 原文件下载通过资产与媒体 ID 鉴权后签发短时 GET URL；API 响应不持久化该 URL。
- 旧字段保持兼容但服从安全语义：没有可派生展示图的图片媒体时返回 `null`，不回退到原文件。

### 3.3 3D 批处理合同

- 提供确定性的离屏渲染输入/输出清单与导入器：浏览器仅允许精确本地 renderer origin，
  GLB 外部 URI 预先拒绝；导入前逐件复核不透明路径、源哈希、512×512 PNG 与输出哈希，
  同一源哈希重复执行不重复写入。
- 渲染结果以图片媒体登记并关联源 3D 媒体；中文描述只接受显式批量输入并保留来源摘要，
  不用资产英文名伪装视觉描述。
- 519 个真实对象的下载、渲染、TOS 上传、中文视觉模型调用和 dev 数据回填，必须在对应
  凭据、源对象及云写/付费授权到位后单独执行并留回执。

### 3.4 CDN 工程合同

- 支持独立的 HTTPS 展示域名配置；公开 URL 只指向独立 rendition 对象，不携带
  `x-tos-process`。
- 配置缺失时可以使用已批准的 TOS 公共基地址投影独立对象；不得退回原图 URL。
- CDN 控制台开通、源站鉴权和缓存键配置属于云写，只有在当次明确授权后执行。

## 4. API 合同

前端接线的规范合同见
`docs/contracts/v0.2.3/asset-media-repair.md`；本节只保留路由总览。

```text
GET  /api/v1/assets/:asset_id/media-health
POST /api/v1/assets/:asset_id/media-repairs
GET  /api/v1/assets/:asset_id/media-repairs/:repair_id
POST /api/v1/assets/:asset_id/media/:media_id/download-url
```

- 健康端点返回 `healthy | degraded | broken | repairing`、问题码、是否可自动修复和 blocker。
- 创建修理接受 `client_idempotency_key`、可选 `media_ids`，仅支持 `mode=safe`；
  重放返回同一任务，冲突请求拒绝。
- 下载端点返回短时 URL 与过期时间；调用人必须仍有该资产的读取权限。
- 修理写权限沿用资产管理权限；公共资产只允许 `platform_admin` 发起。
- 所有用户可见失败均返回中文 `display_reason`，内部原因只进脱敏审计。

## 5. 可机器验证的完成判据

1. migration 可在 PostgreSQL 重复执行；约束、索引、任务 claim 与审计均有真库测试。
2. 单元测试证明两档 TOS 处理规格固定、独立对象 key 不可反推原 key、CDN/TOS 基址切换
   不泄露原图。
3. 诊断覆盖各问题码；安全修复幂等；歧义关系和缺源对象停在 blocker。
4. 路由测试覆盖未登录、越权、公共资产权限、幂等重放、冲突、查询与短时下载。
5. 列表、详情和备戏接口不再把 `model_3d` 或原图 URL 当缩略图；没有可派生展示图的
   图片媒体时诚实返回空。
6. 3D 渲染清单与导入器通过成功、重放、源哈希漂移和缺中文描述测试。
7. 全量门禁绿：

   ```text
   npm run check:architecture
   npm run typecheck
   npm test
   npm run build
   git diff --check
   ```

8. 回执列出代码已验证、真 PostgreSQL 已验证、云端尚未执行的边界；创建本地
   `SOL-ASSET-MEDIA-BE-R2-DONE` 标签，不直推 `dev`。

## 6. 检查点与停止条件

1. **合同检查点**：数据、API、权限和展示规格冻结后再写迁移与路由。
2. **本地行为检查点**：先用 fake TOS 与隔离 PostgreSQL 验证，不读取真实密钥。
3. **云写检查点**：CDN 开通、TOS 上传、dev 数据 apply 前必须取得当次明确授权。
4. **付费检查点**：视觉模型中文描述调用前必须取得当次付费授权和价格上限。
5. **关系歧义停止条件**：无法由 FK、源哈希或显式清单唯一证明归属时，任务以 blocker 收口。
6. **源对象停止条件**：HEAD/读取显示对象不存在、超限或内容类型不符时，不覆盖现有媒体事实。

## 7. 交接路径

- Kimi 以前端类型和路由测试固定的 `media_display`、健康与修理任务合同接线。
- Fable 复核本标签、回执和云动作 blocker；需要真实 519 批跑或 CDN 开通时另发授权单。
- 任何后续云端执行都复用本包清单与幂等键，不另写一次性脚本绕过审计。

## 8. R1 证据更正

- R1 冻结在 `02c3ab2d`。当时的 `npm test` 确实扫描了
  `src/modules/assets/catalog.test.ts`，但正向展示断言被
  `if (typeof value.storageUrl === "string")` 包住；该工作树没有展示基址，断言分支静默
  跳过。因此“Node 全量绿”不能证明 opaque 展示 URL 合同，原收口证据撤回为不充分。
- 旧断言实际位于 `catalog.test.ts`，不是 `mediaDisplay.test.ts` 的正向用例；后者只把
  `asset-renditions/v1/detail.webp` 作为必须拒绝的历史 key 反例。
- 在 R1 tag 上显式注入安全假展示基址后可稳定复现 8 pass / 1 fail，实际输出是
  `asset-renditions/v1/<hash-prefix>/<hash>.webp`，而旧断言仍期待
  `asset-renditions/v1/detail.webp`。这不是 dev 改写该测试，也不是测试发现规则漏扫，
  而是环境依赖令断言覆盖失真。

## 9. R2 收口证据

- R2 基线：本地 `dev` 水位 `d2fa6476`，包含 `e9a9e91c` 的 Kimi 双修复包和远端
  `7df210f9` 的项目成员职责包。
- 测试通过显式 `displayBaseUrl` 与 `displayBucket` 注入，不再读取运行环境决定是否执行；
  断言精确匹配合同规定的 opaque URL。无展示环境变量和有环境变量两种运行均为 9/9。
- `CI=true npm test`：Node 2774 total / 2715 pass / 59 conditional skip / 0 fail；
  随后的全部 PostgreSQL 14 wrappers 均执行并通过。
- 最新基线补验：资产/迁移定向 35/35；资产媒体真 PostgreSQL 1/1；
  `check:architecture` 检查 788 个生产源码文件；全仓 `typecheck`、production build 与
  `git diff --check` 通过。构建只保留既有 CSS selector 和 chunk-size warning。
- 远端已占用 `051_project_member_production_roles.sql`，资产媒体迁移顺延为
  `052_asset_media_repair.sql`；SHA-256
  `02519951faf1e098600bf929ff765cfbfc8047870546b3f844ead24bc99a2e5f`，与 ledger 一致。
  同时修正 dev 既有 `049` ledger SHA 少一字符的问题，未改写已应用迁移文件。
- 离屏 renderer smoke 仍为 512×512，SHA-256
  `4d4a4e78f190dbbb182daf6cafd45abfcff55a75e7d33c309fa801e7cb5ab01d`，
  `tosCalls=0`、`databaseWrites=0`、`paidCalls=0`。
- 本单未执行真实 TOS 读写、519 件真实渲染/上传、CDN 开通、dev 数据 apply、付费视觉调用、
  部署、push 或合流；代码证明不能替代桶私有策略与 CDN 源站鉴权的云端生效证据。

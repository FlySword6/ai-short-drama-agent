# S49：Seedance `asset://` 与 CreateAsset 通道对账

- 研究日期：2026-07-27
- 范围：仅核对火山方舟、Seedance 和官方国际版 BytePlus ModelArk 一手资料
- 目的：判断 Seedance 2.0 的 `asset://` 机制与仓库中的 CreateAsset 注册契约是同一体系、两套通道，还是尚无法确认
- 非目标：不以二手代理商文档补齐中国区接口参数，不把 DC 提供的仓库契约改写成官网事实

## 结论

当前最稳妥的判断是：

1. **产品体系上属于同一套素材资产体系。** 火山方舟中国区官方资料把 Assets API、CreateAsset、真人和虚拟人像入库、私域素材库配额放在同一个 Seedance 2.0 素材产品面内；已入库素材具有 Asset ID。
2. **调用职责上是两个阶段，不是两个互斥方案。**
   - `CreateAsset` 是控制面动作：把素材 URL 注册进素材库并获得 Asset ID。
   - `asset://<asset_id>` 是推理面引用格式：在视频生成请求中消费已入库、可用的 Asset ID。
3. **中国区公开证据尚未形成单页闭环。** 中国区文档分别证明了 CreateAsset 属于 Assets API，以及 `asset://` 用于引用已授权真人资产；但当前可检索正文没有在同一页完整写出“CreateAsset 的返回 ID 直接拼成 `asset://`”及其全部 Action/Version 参数。
4. **官方 BytePlus ModelArk 文档形成了同页闭环，但只能作为区域产品补证。** 它明确把 `Action: CreateAsset`、`Version: 2024-01-01`、Asset 状态变为 `Active` 后用于 Seedance 2.0，以及 `asset://<asset_ID>` 放在同一流程中。该证据不能证明中国区和国际区的 endpoint、权限、资产 ID 或响应外壳互通。

因此，S49 的实现口径应为：**外来输入先走 CreateAsset 注册；后续若 Seedance 2.0 请求需要素材库引用，再以注册得到的 Asset ID 组装 `asset://`。两者应顺序使用，而不是二选一。** 对中国区精确请求和响应字段，继续以“DC 提供的仓库契约”管理，直到合同测试或中国区完整官方 API 正文再次确认。

## 已确认的官方事实

### 1. 已授权真人素材通过 Asset ID 和 `asset://` 进入视频生成请求

[火山方舟《录入真人形象素材》](https://www.volcengine.com/docs/82379/2315856?lang=zh)说明：

- 真人演员的图片、视频或音频需经过本人认证、授权和一致性校验，随后进入私域素材库。
- 每位真人对应素材资产组，同一组仅承载同一真人的不同素材或妆造。
- 视频生成 API 使用前需取得 Asset ID。
- API 示例把 `asset://<asset_id>` 放在 `image_url.url` 中，并使用 `reference_image` 角色。
- 页面同时说明方舟另有可公开使用的虚拟人像库。

页面显示最近更新时间为 2026-04-14；本研究访问于 2026-07-27。

### 2. Assets API、CreateAsset、真人和虚拟人像共处同一个私域素材产品面

[火山方舟《Doubao Seedance 2.0 高级创作权益包》](https://www.volcengine.com/docs/82379/2377608?lang=zh)说明：

- Assets API 用于集成管理私域素材资产。
- 权益表同时列出真人素材 API 入库、虚拟人像 API 入库和 CreateAsset 上传限流。
- 真人和虚拟人像共享私域素材资产库配额。
- 权益到期会影响继续创建、查询和使用素材；特定逾期条件下，部分 API 创建的素材可能被删除。

这证明 CreateAsset 不是独立于 Seedance 人像素材库的另一套产品。该页没有展示 `Version=2024-01-01` 或 CreateAsset 的完整请求体。页面显示最近更新时间为 2026-05-26；本研究访问于 2026-07-27。

### 3. 中国区存在独立的 CreateAsset 官方 API 页面

[火山方舟《创建素材资产（CreateAsset）》](https://www.volcengine.com/docs/82379/2318271?lang=zh)是中国区官方文档入口，页面显示最近更新时间为 2026-05-20。

本次公开检索可以确认页面及 Action 名称存在，但正文导出只返回标题，未能独立读取并核验 endpoint、Version、全部 body 字段和响应外壳。因此，不能仅凭该页面标题把 DC 提供的完整参数表升级为“官网已确认”。

### 4. 真人、私域虚拟人像和公共虚拟人像属于同一安全创作素材体系

[火山方舟《Seedance 2.0 安全创作体系》](https://www.volcengine.com/activity/Seedance2-0-security)说明：

- 真人授权对应方舟素材资产组。
- 私域虚拟人像经校验入库后用于后续视频生成。
- 公共虚拟人像可通过体验中心或 API 调用。
- 未纳入私域可信素材库的输入会受到更审慎的风险拦截。
- 特定模型自产内容存在内容授信机制，但该页未给出本仓所采用的 30 天期限。

本研究访问于 2026-07-27；页面未展示可复核的最近更新时间。

### 5. 官方 BytePlus 文档直接连接 CreateAsset 与 `asset://`

[BytePlus ModelArk《Private real-human asset library guide》](https://docs.byteplus.com/en/docs/modelark/2333589)说明：

- Assets API 的素材支持图片、视频和音频。
- CreateAsset 是异步入库操作，素材只有在状态为 `Active` 后才能用于后续推理。
- 创建素材后取得的 Asset ID 可用于 Seedance 2.0。
- 同一页面给出 `ServiceName: ark`、`Action: CreateAsset`、`Version: 2024-01-01` 的调用示例，并说明 Seedance 2.0 以 `asset://<asset_ID>` 引用该素材。

页面显示最近更新时间为 2026-07-08；本研究访问于 2026-07-27。BytePlus 是官方国际区域产品，这条证据可证明机制设计，但不能证明中国区具体 endpoint、配额、权限或响应外壳完全相同。

[BytePlus ModelArk《Create a video generation task》](https://docs.byteplus.com/en/docs/modelark/1520757)进一步说明：

- Seedance 2.0 的图片、视频和音频输入字段可接受 `asset://<ASSET_ID>`。
- 预设数字角色和已授权真人素材都以素材资产方式参与生成。

页面显示最近更新时间为 2026-06-29；本研究访问于 2026-07-27。

## DC 提供的仓库契约：非官网确认

以下内容是 **DC 提供的仓库实现契约**。本研究未把它视为中国区官网已确认参数：

```text
POST <SEEDANCE_OPENAPI_ENDPOINT，默认
https://ark.cn-beijing.volcengineapi.com>
  ?Action=CreateAsset&Version=2024-01-01

body = {
  GroupId,
  URL,            // TOS storageUrl
  AssetType: "Image",
  ProjectName,
  assetName,
  assetDesc,
  userName?       // 可选
}

response asset id = Result.Id
兼容响应外壳和字段大小写差异
```

仓库正式入口同样属于 DC 提供的实现契约：

```text
资产库 MCP upload_asset_image
  -> TOS 上传
  -> HttpSeedanceProvider.registerImage
  -> 写 asset_entities / asset_media
  -> 将 Seedance asset id 写入 media metadata
```

需要保留“非官网确认”标签的具体点：

- 中国区默认 endpoint 的完整拼接形式。
- `assetName`、`assetDesc`、`userName` 这些仓库字段是否原样传给上游，还是由 provider 适配成上游字段。
- 中国区响应一定是 `Result.Id`，以及需要兼容的大小写/外壳集合。
- CreateAsset 返回后是否还必须轮询状态，以及当前仓库在哪一层执行该轮询。

## S50 E3 / DC 决策边界：仓库政策，不是官方事实

S49 应按以下来源分类执行：

| 输入来源 | 仓库政策 | 生命周期 |
| --- | --- | --- |
| 本账号模型自产的原始产物 | 进入自产信任窗口 | `trusted_at` / `expires_at`，窗口为 30 天 |
| 第三方原始图片 | 必须走 CreateAsset 注册 | 注册资产生命周期独立于 30 天信任窗口 |
| 第三方图片经 Seedream 5 Pro 图生图后的产物 | 仍按外来输入处理，必须走 CreateAsset | 注册资产生命周期独立于 30 天信任窗口 |
| 一切其他外来图输入链路 | 必须走 CreateAsset 注册 | 注册资产生命周期独立于 30 天信任窗口 |
| 已在方舟库中的公共虚拟人像或已授权真人素材 | 使用既有 Asset ID；无需因本仓上传流程重复注册 | 以方舟资产实际可用状态及授权状态为准 |

关键点：

- “经过本账号模型加工”不能洗掉第三方来源。第三方图片经 Seedream 5 Pro 图生图后，来源仍是外来输入。
- `expires_at` 和“过期态”只描述自产原始产物的 30 天信任窗口。
- CreateAsset 注册资产不应套用这 30 天过期规则。应独立保存 `provider_asset_id`、注册状态、供应商可用状态、授权/删除状态；若未来官方返回独立失效时间，再另设供应商生命周期字段。
- 自产产物信任窗口到期后的再授权、重新注册或禁止使用策略，本次输入没有裁定，不应由实现自行猜测。

## 关系对账：事实与推断

### 已确认事实

- `asset://` 是视频生成 API 对已入库 Asset ID 的引用方式，不是普通 HTTP/TOS URL 的别名。
- CreateAsset 位于 Assets API 管理面，属于 Seedance 2.0 私域素材资产体系。
- 真人和虚拟人像共享同一类素材资产配额和管理概念。
- 资产是否可用不能仅由“已返回 ID”判断；官方资料要求关注素材实际可用状态。

### 高置信推断

- CreateAsset 与 `asset://` 是同一素材资产体系中的“注册”和“消费”两个阶段。
- 对需要纳入素材库的外来图片，正确链路应是：

```text
外来图片
  -> TOS storageUrl
  -> CreateAsset 注册
  -> 等待/确认资产可用
  -> 保存 Seedance Asset ID
  -> Seedance 2.0 请求按能力需要使用 asset://<Asset ID>
```

- 已在公共虚拟人像库或授权真人库中的素材已有 Asset ID，只需使用 `asset://` 消费；不应再调用 CreateAsset 创建重复资产。

### 尚未确认

- 中国区 CreateAsset 返回的 ID 是否在所有 Seedance 2.0 输入角色中都可直接使用，而不受素材组类型、ProjectName、模型接入点或权限限制。
- 任意第三方非人像图片经 CreateAsset 后，是否都支持 `asset://`，还是中国区当前仅对人像/特定受邀资产开放。
- 中国区 CreateAsset 的完整参数、响应外壳、异步状态和错误码与 BytePlus 国际区是否完全一致。
- `assetName`、`assetDesc`、`userName` 是上游原生字段还是本仓适配层字段。
- 官方内容授信的时间范围是否确为 30 天。当前 30 天口径来自 DC 决策，不来自本研究找到的官方页面。

## 对 S49 实现和验证的建议

1. `HttpSeedanceProvider.registerImage` 继续作为 CreateAsset 差异的唯一适配层，业务层不要依赖上游大小写或响应外壳。
2. 外来来源标记应具备“污染传播”语义：只要祖先输入含第三方图片，Seedream 图生图输出仍走注册通道。
3. 来源血缘必须由 PostgreSQL 的不可变直接父输入边和服务端派生字段支撑；不能让客户端 metadata、模型名或 C2PA 自行声明“自产”。历史未知来源按外来通道 fail-closed。
4. 不要把“返回 Asset ID”直接等价为“可用于生成”。状态机至少应区分注册中、可用、失败、删除/失效；具体状态名以仓库合同为准。
5. 外来/unknown 图片没有当前可用登记时，报价、提交或 provider 组包必须拒绝，不能回退普通 TOS URL。
6. `seedance_asset_registrations.remote_asset_id` 应保持正式事实，`asset_media.metadata` 中的 Seedance ID 只能作为可重建投影；双写需同事务或受审计 outbox，并有漂移修复。
7. 已 Active 的资产仍需可复核远端/授权状态；明确失效后必须阻断生成，不能永久缓存 Active。
8. 自产 30 天信任状态机与注册资产状态机分开存储和判定，避免共享一个 `expires_at` 造成误过期。
9. 中国区最小非付费合同验证应覆盖：
   - provider 实际发送的 endpoint、Action 和 Version；
   - 仓库字段到上游字段的映射；
   - 响应外壳兼容；
   - Asset ID 的持久化；
   - GetAsset/等价查询确认可用状态；
   - 可用 ID 能否以 `asset://` 被目标 Seedance 2.0 接入点接受。
10. 在完成中国区合同验证前，回执应写“机制关系已获官方区域补证，精确中国区契约仍按 DC 仓库合同执行”，不得写成“中国区官网已完整确认”。

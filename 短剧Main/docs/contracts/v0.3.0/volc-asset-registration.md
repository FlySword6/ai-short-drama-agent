# 火山素材库注册适配层合同（V0.3.0）

## 目标与边界

本合同让本地 `asset_media` 到火山方舟私域素材库的真实登记流程走通：

```text
已持久化到 TOS 的本地素材
  -> 素材组幂等创建或复用
  -> CreateAsset
  -> ListAssets 精确回读
  -> PostgreSQL 保存本地—云端映射和可审计状态
```

只有 `ListAssets` 返回同一 `Id`、`GroupId`、`ProjectName` 的记录后，本地登记才可按
远端状态更新为 `active`、`processing` 或 `failed`。本地资产或 TOS 上传成功不等于
火山素材登记成功。

本合同只改变供应商 Assets OpenAPI、素材组和登记 API。V0.2.0 的来源血缘、
对象管理权限、`asset://` 生成门禁、显式人工动作和 15 分钟 freshness 继续有效。
登记与查询不触发模型生成，也不产生付费生成任务。

## 供应商 API 真源

统一使用：

```text
POST https://ark.cn-beijing.volcengineapi.com/
  ?Action=<Action>&Version=2024-01-01
Service=ark
Region=cn-beijing
AK/SK V4
```

### CreateAssetGroup

请求体：

```json
{
  "Name": "string <= 64",
  "Description": "string <= 300",
  "GroupType": "AIGC",
  "ProjectName": "default"
}
```

响应读取 `ResponseMetadata.RequestId` 与 `Result.Id`。素材组按
`(ProjectName, GroupType, Name)` 建立本地唯一键：

- 已有远端 ID 时直接复用，不再调用 `CreateAssetGroup`；
- `failed` 只允许下一次明确的人工登记动作重试；
- 网络中断、5xx、不可解析响应或成功外壳缺 ID 记为 `unknown`，禁止自动重发；
- `SEEDANCE_ASSET_GROUP_ID` 可导入一个运维预配置组，但仍要保存本地组映射；
- 同一配置下并发请求只能有一个 `creating` 领取者。

### CreateAsset

请求体：

```json
{
  "GroupId": "group-*",
  "URL": "public HTTPS URL",
  "Name": "string <= 64",
  "AssetType": "Image",
  "ProjectName": "default"
}
```

响应读取 `ResponseMetadata.RequestId` 与 `Result.Id`。截至 2026-08-03 的火山官方
合同字段是 `Name`；不得继续发送旧仓库合同中的 `assetName`、`assetDesc` 或
`userName`。

`Name` 必须带本地 `asset_media_id` 的稳定短标识，既便于 `ListAssets` 搜索，也避免
同名素材把回读命中绑定到错误的本地记录。

### ListAssets

查询同步使用 `ListAssets`，不把供应商原始响应或 12 小时 URL 传给页面：

```json
{
  "Filter": {
    "GroupIds": ["group-*"],
    "Name": "本次 CreateAsset 的稳定名称"
  },
  "PageNumber": 1,
  "PageSize": 100,
  "SortBy": "CreateTime",
  "SortOrder": "Desc",
  "ProjectName": "default"
}
```

客户端解析 `Result.Items[]`、`TotalCount`、`PageNumber` 与 `PageSize`。服务端按
远端 Asset ID 精确匹配，并同时校验 Group ID 与 ProjectName。模糊名称搜索只能缩小
范围，不能作为身份。需要翻页时按 `TotalCount` 有界继续；查不到目标时保持
`processing` 并记录本次请求，不伪造 `active`。

允许状态为 `Active | Processing | Failed`。未知状态、字段缺失或身份不一致属于协议错误，
本地转 `unknown`，不删除已有远端 ID。

## PostgreSQL 正式事实

### 素材组映射

`volc_asset_groups` 至少保存：

- 本地 UUID、`name`、`description`、`group_type`、`project_name`；
- `volc_asset_group_id`；
- `pending | creating | active | failed | unknown`；
- 来源 `configured | created`；
- 最近 Request ID、失败码、中文失败说明；
- `retry_count`、`last_attempt_at`、`last_retry_at`；
- 创建人、最近动作人和时间。

表中禁止保存 AK/SK、Authorization、Security Token、供应商原始响应或素材 URL。

### 素材登记映射

现有 `seedance_asset_registrations` 继续作为兼容表名和正式映射，不另建第二真源。
字段语义如下：

- `asset_group_id` = `volc_asset_group_id`；
- `remote_asset_id` = `volc_asset_id`；
- `status` = 本地可查询注册状态；
- `latest_request_id`、`latest_error_code`、`latest_error_message`；
- `retry_count`、`last_retry_at`；
- `last_action_at`、`last_verified_at`。

`seedance_asset_registration_attempts` 保留追加式审计。主表的最新字段用于查询，
尝试表用于复核历史；两者必须在同一事务更新。失败说明必须是稳定中文，不持久化
供应商原始 Message。

## HTTP 合同

新增通用资产域接口，同时保留旧的 `seedance-registration` 兼容路由：

```text
POST /api/v1/assets/registrations
GET  /api/v1/assets/registrations/:registration_id
POST /api/v1/assets/registrations/:registration_id/refresh
```

创建请求：

```json
{
  "asset_id": "uuid",
  "asset_media_id": "uuid"
}
```

唯一幂等键是本地 `asset_media_id`。调用者必须有该资产的管理权限；服务端在任何
素材组或素材远端写调用前完成权限和 TOS 来源校验，并在数据库事务中再次校验。

响应中的 `registration` 至少包含：

```json
{
  "id": "uuid",
  "asset_media_id": "uuid",
  "volc_asset_group_id": "string",
  "volc_asset_id": "string | null",
  "status": "pending | submitting | processing | active | unavailable | failed | unknown",
  "request_id": "string | null",
  "retry_count": 0,
  "last_retry_at": "ISO-8601 | null",
  "last_verified_at": "ISO-8601 | null",
  "failure": {
    "code": "string",
    "message": "可直接展示的中文说明"
  }
}
```

`failure` 无失败时为 `null`。关闭开关、缺凭据、URL 不可供火山读取、素材组结果不明、
素材处理失败等错误必须给出中文下一步，并保证本地状态不冒充成功。

## 配置与 URL 边界

非 secret：

```text
SEEDANCE_ASSET_REGISTRATION_ENABLED
SEEDANCE_ASSET_GROUP_ID            # 可选，导入既有组
SEEDANCE_ASSET_GROUP_NAME
SEEDANCE_ASSET_GROUP_DESCRIPTION
SEEDANCE_ASSET_PROJECT_NAME
SEEDANCE_ASSET_REGISTRATION_ENDPOINT
SEEDANCE_ASSET_REGISTRATION_REGION
```

secret：

```text
VOLCENGINE_ACCESS_KEY_ID
VOLCENGINE_SECRET_ACCESS_KEY
VOLCENGINE_SECURITY_TOKEN          # STS 可选
```

本地开发工作树允许以共享工作区根 `.env` 为底值、工作树 `.env` 为覆盖；显式
`SHORTDRAMA_ENV_FILE` 优先。生产不向上搜索本地文件，仍只接受 KMS/IRSA 注入。

`CreateAsset.URL` 只能来自服务端已持久化的 TOS 定位。当前 P0 接受配置并经本地校验的
公共 HTTPS URL；签名 URL、受控代理或对象权限策略属于后续加固项。任何 URL、凭据或
Authorization 都不得进入登记表、错误信息和验收收据。

## 验收

1. mock 合同测试逐字冻结 `CreateAssetGroup`、`CreateAsset`、`ListAssets` 的 Action、
   Version、请求字段和响应解析；
2. 并发素材组创建、素材登记和明确失败后的人工重试均保持幂等；
3. 真 PostgreSQL 覆盖素材组映射、登记最新字段、追加审计、失败中文说明和迁移重放；
4. 只执行一次受控真实 `CreateAsset`，随后用 `ListAssets` 精确回读同一 Asset ID；
5. 真实证据只记录脱敏 ID、状态、Request ID 是否存在和本地映射完整性，不记录 URL、
   AK/SK、token 或供应商原始正文。

## 兼容与回滚

- 迁移 `053_volc_asset_registration.sql` 保留 `seedance_asset_registrations` 作为唯一登记
  真源；新增字段均允许旧读端忽略，既有 `CreateAsset/GetAsset` 路由继续保留。
- `asset_group_id` 只从 `NOT NULL` 放宽为可空，用于表达素材组尚未准备完成；旧的非空数据
  不会被改写。新服务只有在组 ID 已绑定后才允许调用 `CreateAsset`。
- 生产环境不执行破坏性 down migration。需要回退应用时，先关闭
  `SEEDANCE_ASSET_REGISTRATION_ENABLED`，保留 053 表和列，再部署旧版本；这样不会删除已取得的
  云端 ID、Request ID、失败事实或审计记录。
- 若必须物理撤销结构，须先备份并证明不存在空 `asset_group_id`、`group/list` 新动作以及依赖
  新字段的登记记录，再由 DBA 在维护窗口单独裁决；本 PR 不提供会丢审计数据的自动回滚 SQL。

## 一手来源

- DC Wiki（revision 240）：
  <https://bytedance.larkoffice.com/wiki/TDCpwAFECiJ8wqkLWF5clGunnlc>
- [CreateAssetGroup](https://www.volcengine.com/docs/82379/2318270?lang=zh)
- [CreateAsset](https://www.volcengine.com/docs/82379/2318271?lang=zh)
- [ListAssets](https://www.volcengine.com/docs/82379/2318273?lang=zh)
- [AK/SK V4 签名](https://www.volcengine.com/docs/6369/185600?lang=zh)

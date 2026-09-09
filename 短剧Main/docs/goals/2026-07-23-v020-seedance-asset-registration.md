# Seedance 资产注册链（V0.2.0）

## 目标

让已入库的参考资产可以由人工登记到火山方舟可信素材库；后续同一资产在
Seedance 视频生成中使用 `asset://<Asset ID>`，同时保留 PostgreSQL 中完整、可追溯的
登记事实和尝试记录。

本工作包还要对 `50facf1a-f017-4d71-be26-9d197199a8f2` 做一次 dev 线验证：登记后以
合同固定的 fast 视频档位完成一次受限的同图 I2V 冒烟，或如实保存火山返回的阻断证据。

## 范围

- CreateAsset 的 AK/SK V4 调用、配置、登记状态与审计。
- 已登记 `asset_media` 在视频生成请求中转换为火山 `asset://` 引用。
- 针对生成产物的显式“转为可引用资产”最小桥接，仅在目标素材不属于 `asset_media` 时使用。
- 单元、路由、真库门禁，以及 dev 线的登记和一次不超过 500 积分的人工确认冒烟。

不做：生产环境变更、批量自动登记、自动生成或重试、push、部署。

## 硬约束

- 接口以火山官方 CreateAsset 文档（2026-07-13 更新）为准：AK/SK、
  `Action=CreateAsset`、`Version=2024-01-01`、`GroupId`、公共 URL、`AssetType`、
  `ProjectName`；CreateAsset 是异步接口。
- PostgreSQL 是本地资产与登记审计的唯一正式事实；火山 Asset ID 是外部引用。
- 注册由人明确触发，不能在生成时静默注册。
- 付费生成固定为：估价 → 人工确认 → 提交；报价超过 500 积分立即停下。
- 只记录脱敏请求摘要、响应状态、RequestId、错误码和远端 Asset ID；不记录 AK/SK、
  Authorization、完整签名或原始敏感 URL。

## 检查点与停止条件

1. **接口真相**：官方字段、异步语义、Asset URI 用法均有来源；否则不写网络调用。
2. **本地实现**：配置缺失时 fail-closed；状态和审计可查询；已登记资产映射到
   `asset://`；测试覆盖成功、业务错误和幂等。
3. **目标资产可引用性**：`50facf1a…` 必须能被明确映射成当前 actor 可见的
   `asset_media`。若不能，先走显式转资产桥接，绝不放宽引用权限。
4. **dev 登记**：配置和目标资产均就绪才调用 CreateAsset；失败保留脱敏错误证据后停。
5. **dev 冒烟**：模型可用、报价有效且不超过 500 积分、人工确认后仅提交一次；
   最终检查任务状态、TOS 持久化和账本。若仍被安全拦截，不继续猜测或重试。
6. **交付**：四件套门禁全绿、回执写清验证与未验证项、仅本地提交。

## 当前状态

`READY_FOR_DEV_SMOKE（未完成）` — 本地登记链、隔离 PostgreSQL 验证和配置注入合同已完成；
独立 dev 环境尚未注入素材组与 AK/SK，因而未发送 CreateAsset、未创建付费任务。完整证据见
`docs/validation/v020-seedance-asset-registration-receipt.md`。

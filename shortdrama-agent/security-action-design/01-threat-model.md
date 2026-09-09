# 威胁模型与信任边界

## 需要保护的资产

| 资产 | 保护目标 |
| --- | --- |
| 火山云 AK/SK、Ark/AgentKit/MCP API Key、短期 Token | 不进入仓库、CLI、Agent Prompt、日志、镜像或产物；最小权限、可轮换、可撤销 |
| 平台用户会话和刷新 Token | 只发送给 profile 引用的受信服务 Endpoint（含 fixed base path 和 credential audience）；不出现在 argv、日志和运行目录 |
| 付费能力和额度 | 绑定 `app.users.id`、项目角色、一次页面确认、Submission、幂等键和预算 |
| 剧本、角色、素材、附件和结果 | 项目隔离、最小外发、服务端 DLP、对象授权和脱敏审计 |
| Quote、Confirmation、Submission、Job 和成本账本 | 平台数据库保存，原子状态变更，不可由 CLI/Agent 伪造 |
| 能力目录和策略 | 版本化、受限发布；客户端不能指定真实模型、价格和目的地 |
| 云资源地图 | runtime、pipeline、registry、endpoint、桶和集合等按内部配置管理 |

## 生产信任边界

```text
用户 / WorkBuddy / Codex
          ↓ 不可信输入
产品页面 / CLI
          ↓ 受管理 HTTPS
平台后端
  ├─ 服务端会话 → app.users.id
  ├─ 平台角色 + 项目角色
  └─ Quote / Confirmation / Submission / Quota / Audit
          ↓ 内部 Job/Execution 引用
Agent（不持有云密钥、无直接公网）
          ↓ 只调用平台内部 API
Provider Worker / Generation Gateway
  └─ Security Action：重新加载服务端权威记录并决策 → Ark
Asset Worker
  └─ asset.store：对象授权、存储额度、私有 ACL、幂等 → TOS
```

以下信息永远不构成身份或授权：

- CLI/HTTP 参数中的 `user_id`、`session_id`、角色和项目归属；
- Prompt、Tool 参数、LLM 输出和聊天中的“已确认”；
- `reviewer="director"`、`auto_approve_generated_assets=True` 或通用 `--yes`；
- 调用方指定的 `api-base`、`agent-url`、`ARK_BASE_URL`；
- Agent 自己生成的 Quote、Grant、额度或数据分类标签。

## 主要攻击路径

| 威胁 | 可能后果 | V1 必需控制 |
| --- | --- | --- |
| 仓库中提交 AK/SK、AgentKit/MCP Key | 云资源被调用、数据或费用损失 | 立即轮换和审计；当前树+全历史秘密扫描；Secret Store；见 06 文件 |
| 配置暴露 runtime/endpoint/资源关系 | 攻击者获得资源地图 | 环境配置隔离、资源标识扫描、最小公开模板 |
| WorkBuddy/Codex 诱导 CLI 使用恶意 URL | 平台 Token、密码或内容外发 | 普通 CLI 不能创建受信 Endpoint；严格匹配 service/scheme/host/port/base path/audience；所有 API 3xx 立即失败；禁止直连 Agent |
| Prompt 注入伪造用户确认、改模型或地址 | 未授权付费、数据外发 | 后端从数据库重新加载 Quote/Confirmation/Submission；客户端字段不可信 |
| 只读成员或非项目成员直接调用 API | 越权生成 | 每次 Quote/Submit 查询项目成员关系；管理员无隐式跨项目绕过 |
| 同一确认并发提交或超时重试 | 重复扣费、重复生成 | 原子状态转换、唯一幂等键、预算预留、Provider 结果对账 |
| Agent 当前代码直连 Ark/AgentKit/TOS | 绕过后端授权、泄露云密钥 | 生产 Agent 无云凭据且无云/公网出口；只允许平台内部 API |
| `quality/fast` 被替换为任意模型/尺寸/价格 | 费用和策略失控 | 服务端版本化能力目录；拒绝客户端真实模型/规格/价格字段 |
| 外部 URL、A2A Hub 或 AgentCard 指向内网 | SSRF、横向移动、恶意 Agent 替换 | 默认隔离；拒绝 HTTP、私网、重定向和任意 Hub；逐项资源级设计 |
| 日志透传 Prompt、剧本、签名 URL 或供应商错误 | 二次泄露 | 每类输出字段白名单；错误码+request_id；不记录原始正文 |
| 依赖、镜像或 CI 工作流被投毒 | 代码执行和 Secret 泄露 | 锁定依赖/Action SHA、SAST、SBOM、镜像和工作流检查、Fork 无 Secret |

## 数据分类与外发

| 类别 | 例子 | 默认规则 |
| --- | --- | --- |
| secret | AK/SK、API Key、Bearer、Cookie、私钥、签名授权 | 硬拒绝；触发脱敏告警 |
| restricted | 未公开剧本、角色资料、私有附件、内部 URL | 只有服务端记录明确允许该项目、用途、能力档位和 Provider 时才可外发 |
| internal | 已脱敏拆解、内部模板、非公开元数据 | 必须命中显式能力和项目规则；不因标签为 internal 自动放行 |
| public | 已公开文案或素材 | 仍受目的地、额度、角色和能力目录约束 |
| unknown | 无法读取、无法分类或类型不一致 | 默认拒绝 |

数据分类不能由 CLI、Prompt 或 Agent 自报。最终 Provider 请求在 Generation Gateway 内形成后，DLP 对规范化的完整请求体重新计算；审计只保存分类、长度、规则 ID 和项目作用域 HMAC 摘要。

## 失败安全

以下任一情况发生时默认拒绝：

- 会话失效或 `app.users` 用户不存在；
- 项目成员关系缺失、过期或为只读；
- Quote/Confirmation/Submission 状态不匹配；
- 能力目录、模型映射或额度未配置；
- 确认/额度/审计存储不可用；
- Agent 到公网的阻断无法证明；
- Provider Worker 的 Ark 目的地、Asset Worker 的 TOS 目的地或网络责任人未确认；
- 数据未知、含秘密或跨项目引用；
- 策略版本未知或评估器报错。

Mock、测试和 shadow 环境不得继承生产会话、云凭据、生产数据或真实 Provider 网络。shadow 只观测低风险假调用，不能和真实付费生成同时启用。

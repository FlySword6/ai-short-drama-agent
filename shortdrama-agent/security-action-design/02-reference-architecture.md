# 参考架构：平台授权、Agent 隔离、云出口强制

## 核心原则

Security Action 不是 CLI 中的一个 `if`，也不是提示词中的一句“请先确认”。它是平台后端在真实云调用前执行的、由服务端账本和策略驱动的强制判断。

```text
共享契约和策略
  ├─ CLI Security Boundary：会话/受信 Endpoint 绑定、预检、脱敏
  ├─ Platform Control Plane：用户、项目、Quote、Confirmation、Quota、Audit
  ├─ Agent Isolation：只处理 Job 引用，只访问平台内部 API
  ├─ Generation Gateway：Security Action + Provider 适配 + Ark 模型凭据
  ├─ Asset Worker：asset.store + 平台资产登记 + 独立 TOS 凭据
  └─ Network Enforcement：Agent 无公网，Gateway 仅出站 Ark，Asset Worker 仅出站 TOS
```

## 组件职责

### 产品页面

- 展示服务端生成的报价摘要、能力档位、数量、规格、最大费用和过期时间；
- 让已登录且有项目权限的真人确认；
- 不把 Confirmation 作为可复制的 Bearer Secret 暴露给聊天、Agent 或普通 CLI 输出。

### CLI

CLI 可以：

- 使用平台账号会话调用受管理业务 API；
- 本地检查明显密钥、危险 URL、文件大小和输出字段；
- 请求并展示服务端 Quote；
- 对受控人员要求语义明确的危险确认参数；
- 显示 `approval_required`、`quota_exceeded`、`policy_denied` 等稳定结果。

CLI 不可以：

- 接受 `user_id/session_id` 并把它们当真实身份；
- 创建或消费页面 Confirmation；
- 直连 Agent Gateway、AgentKit、Ark、TOS、数据库或第三方模型；
- 将会话 Token、密码或刷新 Token发送给任意 `api-base`；
- 把聊天“确认”、旧 `--yes` 或本地费用估算当成服务端报价/授权；
- 在真实模式提交任意模型 ID、尺寸、分辨率和价格参数。

### 平台后端控制面

平台后端是唯一业务授权权威：

1. 从服务端会话解析 `actor_user_id = app.users.id`；
2. 从数据库读取平台角色、项目成员关系和成员关系版本；
3. 只允许项目负责人/编辑发起付费生成流程；
4. 使用版本化能力目录把 `quality/fast` 解析成真实 Provider 参数；
5. 创建 Quote、保存页面 Confirmation、原子创建 Submission/Job；
6. 预留并结算用户/项目额度和成本；
7. 保存业务账本与安全审计；
8. 向 Agent、Generation Gateway 和 Asset Worker 传递不可伪造的内部 Job/Execution/Asset 引用。

平台管理员管理全局配置，但没有默认的跨项目生成权限。运营或管理员要生成，也必须具有该项目负责人/编辑身份，除非以后另行设计可审计的代操作权限。

### Agent

生产 Agent：

- 接收后端分配的 Job/Execution 引用和最小必要业务输入；
- 不从 Prompt 或 Tool 参数读取真实用户、角色、确认和额度；
- 若需要模型或生成能力，只调用平台内部 Generation Gateway/业务 API；
- 不持有 Ark API Key、火山云 AK/SK、TOS 或 MCP 长期凭据；
- 网络上不能直连 Ark、TOS 或任意公网。

Agent 可以在本地做防御性预检，但其结果不是最终授权。最终 Security Action 必须在持有权威账本和云调用能力的平台侧重新执行。

### Provider Worker / Generation Gateway

Generation Gateway 是真实云调用前的强制执行点：

1. 使用受批准的内部服务身份接收 `execution_id`；
2. 根据 `execution_id` 从平台数据库重新加载用户、项目、Quote、Confirmation、Submission、能力目录和额度状态；
3. 验证 Job 未执行、参数未变化、策略版本有效；
4. 对最终完整 Provider 请求执行 DLP 和目的地校验；
5. 原子标记计划项、调用 Provider、记录 provider request ID；
6. 成功后按实际成本结算，超时则进入 `reconcile_required`；
7. 只返回最小结果和安全错误，不透传供应商敏感原始正文。

Gateway 不接受 Agent 自报的 `allow=true`、用户角色、模型价格或 Confirmation。

TOS 写入不是“网络白名单一开就允许”。只有独立平台 Asset Worker 的 `asset.store` 动作在满足已验证 Provider 结果、项目对象授权、批准桶、服务端生成项目前缀、私有 ACL、静态加密、内容校验、原子幂等登记和审计后才可执行。Agent、CLI、Generation Gateway、test-agent 的直接 TOS 写入继续默认拒绝。

## 身份和内部执行引用

### 用户请求

服务端可信上下文至少包含：

```text
actor_user_id          # app.users.id
session_ref            # 服务端会话引用，不是原始 Cookie/Token
platform_role
project_id
project_role
membership_version
request_id / trace_id
issued_at / expires_at
```

### 后台异步执行

Provider Worker 与 Asset Worker 常以内部分离的服务身份执行，不能简单要求 `principal_type=user`。正确关系是：

```text
原始发起者：有效 app.users 用户
当前执行者：允许的内部 service_id
代表关系：on_behalf_of_user_id
权威依据：已消费的一次 Confirmation + Submission/Execution
```

Agent 只传 `execution_id` 和幂等信息；Gateway 按 ID 重新加载其余权威字段。内部请求必须有工作负载身份或等价完整性保护，但具体使用 mTLS、工作负载身份还是短期服务 Token，由平台基础设施实现并留证，不能仅依赖“在内网”。

当前平台回执没有确认组织/租户模型，因此 V1 不强制 `tenant_id`。项目是当前真实隔离边界；以后若引入组织模型，通过契约版本升级加入。

## 能力目录

客户端请求形状：

```text
capability_tier: quality | fast
project_id
scene/asset references
output_count（受服务端上限约束）
业务内容
```

服务端能力目录解析结果：

```text
catalog_version
provider
model_id
allowed_media_type
size / resolution
unit_price
max_output_count
max_estimated_cost
provider_destination_id
```

解析结果写入不可变 Quote/Plan。客户端若提交 `model_id`、任意尺寸、价格或 Provider 目的地，后端应返回 `invalid_capability_parameter`，不能忽略后继续，也不能猜测映射。

当前目录未获生产批准，因此：

```text
paid_generation.enabled = false
text_inference.enabled = false
asset_storage.enabled = false
quota.user_daily = 0
quota.project_daily = 0
quota.text_user_daily_tokens = 0
quota.text_project_daily_tokens = 0
asset_storage.user_daily_object_count = 0
asset_storage.project_daily_object_count = 0
asset_storage.user_daily_bytes = 0
asset_storage.project_daily_bytes = 0
```

Agent 的文本推理同样消耗云资源，也必须经平台 Gateway。它不必自动套用每次媒体生成的页面确认，但必须具备服务端用户/项目上下文、已批准文本模型目录、文本额度预留、完整请求 DLP 和受控目的地。当前没有一份已验证的 Ark 模型/预算目录，因此提议策略同样把未登记的 `model.send` 默认关闭；不能用 Agent 自带 `model_api_key` 绕过。

## 报价、确认和一次提交

```text
draft
  → quoted
  → confirmed
  → submitted
  → executing
  → settled
       ↘ reconcile_required
```

### Quote

服务端 Quote 至少绑定：

- `quote_id`、`actor_user_id`、`project_id`；
- 项目角色快照与 `membership_version`；
- 能力档位、目录版本和解析后的 Provider 参数；
- 规范化内容摘要、参考素材摘要、数量和规格；
- 估算费用、最大费用、策略版本和过期时间。

### Confirmation

- 只能由产品页面中已登录真人对同一 Quote 创建；
- 一次 Confirmation 只对应一次 Submission；
- 聊天、Agent、Prompt、`reviewer`、自动批准和通用 `--yes` 均不能创建；
- Quote 过期、内容或能力参数变化后必须重新报价。

### Submission

`confirmed → submitted` 必须在一个事务中完成：

1. 比较并交换 Confirmation 状态；
2. 验证项目成员关系仍然有效；
3. 预留用户和项目额度；
4. 保存幂等键；
5. 创建 Submission、Job 和执行项。

同一幂等键重试只能返回原 Submission；不得重复预留或重复调用 Provider。一份多图 Quote 可以创建一个 Submission 和多个固定执行项，但不能对每张图片重复消费 Confirmation。

## 受控 CLI 的付费流程

普通用户的最终确认仍在产品页面。受控 CLI 只作为有项目权限人员的操作入口：

```text
CLI 请求 Quote
  → 输出 quote_id、摘要、最大费用、过期时间和 approval_url
  → 真人在产品页面确认
  → CLI 使用明确参数提交该 quote_id
  → 后端验证 Confirmation 并一次性创建 Submission
```

建议参数使用语义明确的形式，例如 `--submit-confirmed-quote <quote_id>`。它只表示“提交已经在页面确认的报价”，本身不是授权；后端必须重新加载绑定同一用户、项目和 plan digest 的 Confirmation。该命令应要求受控人员专用的服务端 session scope，并从 WorkBuddy/Codex Skill 中移除。旧 `--yes` 不能兼容映射成它。

## 凭据生命周期

| 阶段 | 规定 |
| --- | --- |
| 创建 | 由云平台/Secret Store 管理；最小权限、环境隔离 |
| 注入 | 模型凭据只注入 Provider Worker/Gateway；最小权限 TOS 凭据只注入独立 Asset Worker；不注入 CLI 或 Agent |
| 使用 | Provider Worker 只向批准模型目标发送；Asset Worker 只向批准 TOS endpoint/bucket 写入；两类凭据不混用，不进入 Prompt、Tool 参数或 LLM |
| 存储 | 不写 Git、`.env`、`agentkit.yaml`、镜像层、日志、run 目录和审计 |
| 轮换 | 有责任人、周期和紧急撤销流程；泄露先撤销再清理历史 |
| 失败 | Secret Store 不可用时拒绝付费调用，不回退到硬编码 AK/SK |

当前仓库已核验到历史凭据问题，具体处置见 `06-current-security-findings.md`。

## 网络分区

### Agent 工作负载

允许：

- 平台内部业务 API / Generation Gateway；
- 必要的内部 DNS、监控和追踪目标。

拒绝：

- Ark、TOS、VikingDB、任意公网 IP/域名；
- 调用方提供的代理、重定向、A2A Hub 和任意 URL。

### Provider Worker / Generation Gateway

允许：

- 经批准的 Ark 模型/媒体目标；
- 必要的 Token/Secret 控制面；
- 平台数据库/账本和内部监控。

拒绝：

- 未登记 Provider、HTTP、任意公网、私网跳转和跨 Origin 重定向。

VKE/VCI 安全组、网络策略、ALB 来源限制和 RDS 白名单是基础控制，但安全组通常只能限制 IP/端口。若要证明 HTTP method/path 也受限，需要 L7 出口代理或可验证的服务网格。

### Asset Worker

允许：

- 只访问批准的 TOS endpoint 和 bucket；
- 使用独立的、最小权限 TOS 凭据；
- 访问平台资产登记、额度和审计接口。

拒绝：

- Ark、任意公网、调用方指定 bucket/key、公开 ACL 和跨项目对象前缀。

Asset Worker 必须与 Provider Worker 一样处于默认拒绝且经过验证的受控网络区。TOS 网络可达不等于 `asset.store` 获得业务授权。

## 网络上线证据

至少保存以下自动化或可复核证据：

1. Agent 直连 Ark/TOS 失败；
2. Agent 直连任意公网失败；
3. Agent 到批准平台内部 API 成功；
4. Provider Worker 到批准 Ark 目标成功、到 TOS/其他目标失败；
5. Asset Worker 到批准 TOS endpoint/bucket 成功、到 Ark/其他 bucket 失败；
6. Provider/Asset Worker 到未批准目标、HTTP、私网重定向失败；
7. 网络策略/IaC、责任人、变更记录和出口日志齐全。

没有以上证据，不能声称“Agent 不直连火山云”已经在生产生效。

## 当前直连代码的迁移定位

多份 `production_chain/llm.py`、`app.py` 中的 `model_api_key` 和裸生图工具与目标架构冲突。迁移应采用统一的平台内部客户端：

```text
现有 LLMClient / AgentKit model_api_key
  → PlatformAIClient（内部 API，不含云密钥）
  → execution_id / capability intent
  → Generation Gateway
```

如果 AgentKit 框架无法使用平台适配器且必须直接拿 Ark Key，则该框架路径在 V1 中是生产阻断项，不能以“临时环境变量”绕过。

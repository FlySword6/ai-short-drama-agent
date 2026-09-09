# 短剧 Agent + CLI 联合安全设计 V1：范围与决策

> 状态：Agent、CLI 两个仓库的 CI Security Action 仍是本地候选实现，尚未进入 GitHub
> required checks；平台 `main` 的第一批 P0 fail-closed 修复已推送到 Draft PR #148，仍待
> Actions、staging 和运行时控制面验收。
> 覆盖对象：`zhongwen-shortdrama-agent`、`zhongwen-shortdrama-cli`，以及平台 `main` 后端必须提供的安全控制面。
> 决策依据：2026-08-03 平台回执；详情见 `05-confirmed-decisions-and-production-gates.md`。

## 最终范围决定

仓库层面分别建设两个独立的 CI Security Action：

- Agent Action 只在 Agent 仓库运行，使用 Agent 自己的规则、baseline 和测试；
- CLI Action 只在 CLI 仓库运行，使用 CLI 自己的规则、baseline、制品和 Release 检查。

二者共享下列安全语义，但不共享可执行脚本，也不跨仓读取文件。平台运行时的身份、审批、
额度和云调用授权则只能由 main 后端及受控 Worker 建设，不能在两个仓库各自复制一套。

两个仓库 Action 需要保持一致的原则包括：

- 身份和项目权限语义；
- 动作、能力档位和策略版本；
- 报价、确认、一次提交、额度和幂等状态机；
- 稳定错误码、业务账本和安全审计字段；
- CI 安全基线和跨仓安全回归夹具。

两个代码仓库按边界分别实施：

| 位置 | V1 职责 | 权限边界 |
| --- | --- | --- |
| CLI | 本地预检、会话/受信 Endpoint 绑定、危险操作提示、受控业务 API、脱敏输出 | 没有授权权；不能直连 AgentKit/Ark，不能创建确认记录 |
| Agent | 处理后端下发的任务引用，调用平台内部 API，拒绝 Prompt/Tool 伪造的身份与确认 | 不持有火山云密钥，不直接访问 Ark/TOS，不决定额度 |
| main/平台后端 | 从会话解析 `app.users.id`，检查项目权限，保存报价/确认/提交/额度/成本/审计 | 唯一业务授权权威 |
| Provider Worker / Generation Gateway | 根据服务端已提交任务执行 Security Action，使用受管理模型凭据调用 Ark | 唯一允许访问批准 Ark 模型/媒体目标的业务工作负载 |
| Asset Worker | 按 `asset.store` 对象授权和存储额度写批准 TOS bucket，登记平台资产 | 使用独立最小权限 TOS 凭据；不能调用 Ark 或接受任意 bucket/key |
| 网络边界 | Agent 默认无公网；Provider Worker 只访问批准 Ark；Asset Worker 只访问批准 TOS；限制 ALB/RDS/VKE/VCI 边界 | 最终阻止绕过，但不拥有业务授权权 |
| Agent 仓库 CI Action | 独立检查 Agent 的秘密、云直连、自动批准、测试表面、依赖、工作流和历史 | 只保护 Agent 提交链路 |
| CLI 仓库 CI Action | 独立检查 CLI 的凭据/Endpoint/输出、Provider/数据库绕过、Skill、发行物、依赖、工作流和历史 | 只保护 CLI 提交与发布链路 |

## 目标生产拓扑

```text
产品页面 / 受控 CLI
  → 平台后端：会话、用户、项目角色
  → quote：创建不可变报价/Plan
  → 产品页面 confirm
  → submit：原子消费确认、预留额度、创建 Job
  → Agent：只按 Job/Execution 引用调用平台后端
  → Provider Worker / Generation Gateway：Security Action → Ark
  → Asset Worker：asset.store → TOS
  → 结算额度、成本账本和脱敏审计
```

旧设计中“Agent 持有云密钥并经过 Guard 直连 Ark”不再是生产目标。当前仓库中的直连代码只可作为待迁移的开发历史，不能通过配置直接变成生产路径。

## V1 保护目标

1. CLI、WorkBuddy、Codex、Prompt 和 Tool 参数均不能伪造用户、项目角色、确认或额度。
2. 一次页面确认只允许创建一次 Submission；并发和重试不能重复扣费或重复调用 Provider。
3. 客户端只表达 `quality` / `fast` 能力意图，不能指定真实模型 ID、任意尺寸、价格或云地址。
4. Agent 生产工作负载不能获得火山云长期凭据，也不能直接访问 Ark/TOS 或任意公网。
5. 平台后端在真实云调用前执行身份、项目权限、状态、额度、数据和策略检查。
6. Agent、CLI、main 三个代码仓库在代码进入受保护分支前检查秘密、端点、依赖、工作流、数据库迁移和架构绕过。

## 已确认的业务规则

### 身份

- 用户身份只来自平台服务端会话解析出的 `app.users.id`。
- 当前不把 AgentKit 身份或公司 SSO 当作用户身份来源。
- Agent、CLI、请求 JSON、Header、Prompt 中自报的 `user_id` 和角色全部不可信。

### 权限

- 平台数据库保存平台角色、项目成员关系、审批、额度和成本。
- 项目负责人、编辑可以发起报价和生成流程。
- 只读成员和非项目成员必须拒绝。
- 管理员的全局配置权限不自动授予任意项目生成权限。

### 真人确认

- 唯一正式路径是产品页面 `quote → confirm → submit`。
- 聊天中说“确认”、`reviewer="director"`、自动批准或 CLI 通用 `--yes` 都不是授权。
- 受控 CLI 可要求明确的危险确认参数作为操作防呆，但服务端仍须验证页面确认和项目权限。

### 能力和费用

- 客户端只提交 `quality` / `fast`。
- 服务端能力目录把档位映射成真实模型、规格、价格和限制，并把目录版本写入报价。
- 当前生产能力目录和额度未完成批准，媒体付费生成、未登记文本推理和 TOS 资产写入必须关闭；媒体、文本 Token、存储对象数和字节额度均为 0。

### 云和审计

- Agent 只调用平台后端，不持有火山云密钥。
- 平台 Provider Worker 只能访问批准 Ark 目标；独立 Asset Worker 只有通过 `asset.store` 对象授权、存储额度和审计后才能访问批准 TOS endpoint/bucket。
- 日志只保留最小身份/项目/请求/模型/耗时/结果/错误字段；禁止剧本全文、Prompt 原文、密钥、连接串和供应商敏感原始返回。

## 当前代码中的 P0 上线阻断项

| 风险 | 已知位置 | V1 处置 |
| --- | --- | --- |
| 多份 `production_chain/llm.py` 直接使用 Ark 和可覆盖的 `ARK_BASE_URL` | Agent 多个子项目 | 迁移为平台内部 AI/生成接口；生产 Agent 网络同时阻断 Ark |
| 多份 `app.py` 使用 `model_api_key`，可能绕过自定义客户端 | AgentKit/VeADK 根 Agent | 生产不得注入云密钥；未提供平台适配器前不得上线该路径 |
| 裸 Prompt 直接生图 | `sd-generation-agent/app.py` | 只能执行服务端已提交的 Job/Execution 引用 |
| Demo 自动批准和 `reviewer="director"` | `sd-orchestrator/app.py` 等 | 不得作为安全确认；生产删除或硬禁用 |
| CLI 直连真实 Agent Gateway并携带 Bearer Token | `providers/agent.py`、`cli/breakdown.py`、`cli/generate.py` | 从生产入口和发行物移除；开发替身仅 loopback、无生产会话 |
| 平台 Token 跟随任意 `api-base`，默认地址还是明文 HTTP IP | `cli/common.py`、`server_api/client.py` | 生产只引用安装包/管理员签名的 Endpoint；严格匹配 service、scheme、host、port、fixed base path 和 audience；API 3xx 失败 |
| CLI 可提交任意模型、尺寸、价格参数并直接创建生成任务 | `cli/create.py`、`server_api/client.py` | 改为服务端报价和 `quality` / `fast` 能力档位 |
| test-agent/A2A/MCP/TOS/VikingDB 存在更宽入口和出口 | `test-agent`、`production-chain-agent/sda2a` | 生产隔离；逐项完成资源级设计后才能解除 |

## V1 非目标

- 不以提示词规则替代安全授权。
- 不把作品内容审核 `ReviewGate` 当作付费安全审批。
- 不承诺仅靠 CI 防止运行时滥用。
- 不在没有 `main` 仓库真实路径和接口核对的情况下猜测修改后端代码。
- 不在剩余生产门禁未完成时开启真实付费生成。

## 三项仍待确认的生产决定

1. 生产模型、规格、单次上限、用户日额度、项目日预算和超额审批人；
2. 云网络出口责任人及 Agent/Provider Worker/Asset Worker 的实际拦截与连通证据；
3. 业务账本和安全审计的查看范围与保存期限。

它们不阻塞契约、状态机、RBAC、CLI 收缩、Agent 直连隔离、测试和 CI 的开发，但阻塞真实云能力开启。生产还必须额外关闭 S-001 凭据事件，并通过 main 实施、三仓 CI、资产对象授权和网络/并发等工程门禁。

## 验收底线

当身份缺失、项目无权、角色只读、页面确认缺失或已消费、能力目录未配置、额度为 0、目的地不允许、数据含秘密或安全系统故障时：

> Provider Worker 对 Ark、Asset Worker 对 TOS 的真实调用数必须为 0；Agent 对 Ark/TOS 和任意公网的直连必须失败。

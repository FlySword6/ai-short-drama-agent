# 接入、迁移、兼容与验证计划

> 本文件把设计映射到当前 Agent/CLI 代码。它是开发任务和验收依据，不代表任务已经实现。
> 真实云能力保持关闭；三项待确认决定及其他事故/工程门禁见 `05-confirmed-decisions-and-production-gates.md`。

## 开始开发前的 P0 事故处置

`test-agent/agentkit.yaml` 和远端历史已经核验到非占位凭据。代码开发不能替代事故响应：

1. 凭据所有者撤销/轮换火山云 AK/SK、MCP Router Key 和 AgentKit runtime key；
2. 核查调用、资源变更和账单；
3. 移除当前受跟踪真实配置；
4. 仓库负责人协调历史清理；
5. 全历史扫描通过后再关闭事件。

详细关闭条件见 `06-current-security-findings.md`。不要先强推重写历史、后轮换凭据。

## 仓库实施边界

| 工作包 | 所属仓库/系统 | 是否可立即做 |
| --- | --- | --- |
| A：关闭 Agent 直连云、自动批准、裸生图、A2A/Test 暴露 | Agent 仓库 | 可以 |
| C：CLI 受信 Endpoint/凭据/直连 Agent/输出/能力参数收缩 | CLI 仓库 | 可以 |
| R：代码仓库的 PR 安全 Action | Agent/CLI 现在分别落地；main 路径确认后必须接入同一基线 | 可以开始 |
| M：会话、RBAC、Quote/Confirm/Submit、额度、Gateway、审计 | main/平台后端 | 可以设计；需要明确 main 路径后实现 |
| N：VKE/VCI/ALB/RDS/出口网络规则和验证 | 云平台/运维 | 可准备；责任人待确认 |
| P：真实模型目录、额度和审计期限 | 产品/平台/安全责任人 | 待最终确认 |

仅完成 A、C、R 可以显著收缩风险，但不能开启真实付费生成；生产闭环必须同时完成 M、N、P。

## A：Agent 仓库工作包

仓库：`D:\Internship\COL\zhongwen-shortdrama-agent`

### A-01：阻断所有生产直连 Ark

当前至少六份客户端直接读取 Ark Key/AK/SK、允许 `ARK_BASE_URL` 并调用 Ark：

- `production-chain-agent/production_chain/llm.py`
- `sd-script-agent/production_chain/llm.py`
- `sd-asset-agent/production_chain/llm.py`
- `sd-scene-agent/production_chain/llm.py`
- `sd-generation-agent/production_chain/llm.py`
- `sd-orchestrator/production_chain/llm.py`

目标改造：

1. 提取统一的 `PlatformAIClient`，只调用平台内部 API；
2. 方法只接受 `execution_id` 或受控能力意图，不接受 endpoint、Ark Key、AK/SK；
3. 生产配置检测到 `ARK_BASE_URL`、Ark Key 或 AK/SK 时启动失败；
4. Agent 工作负载网络策略明确拒绝 Ark/TOS/公网；
5. 单元测试使用假平台后端，不调用真实云。

兼容：本地 mock 可以保留，但必须是独立 dev/test profile、固定 loopback、无生产会话和云凭据。不得用一个普通环境变量把 dev 直连重新切回生产。

验收：

- 即使设置测试 AK/SK、Ark Key 和恶意 `ARK_BASE_URL`，假 Ark collector 收到 0 请求；
- 所有生产模块搜索不到直接创建 Ark/TOS Provider 客户端的允许路径；
- 网络测试证明 Agent 容器无法连接 Ark/TOS 和任意公网。

### A-02：处理 AgentKit/VeADK `model_api_key`

多个 `app.py` 通过 `model_api_key` 让框架自行发起模型请求，可能绕过自定义客户端。

目标改造：

- 生产 Agent 不注入云 Key；
- 使用平台支持的内部模型适配器/Generation Gateway；
- 如果框架不能使用平台适配器且必须直连 Ark，该入口标记为 `production_blocked`，不能临时上线；
- Agent 入站仅允许平台后端或认证网关来源，不能直接公网暴露。

验收：删除/禁用自定义 LLMClient 后，框架也不能对 Ark 建立网络连接。

### A-03：生图必须从已提交 Job 开始

真实风险：

- `sd-generation-agent/app.py` 的 `generate_scene_image` 接受裸 Prompt；
- `sd-orchestrator/production_chain/workflow.py` 的 `AssetGenerationSkill` 在审批前已经生成；
- `sd-orchestrator/app.py` 的 `auto_approve_generated_assets` 判断发生在生成之后，因此仅把默认值改成 `false` 仍会产生费用；
- `confirm_asset_card` 和 `task_state.py` 只凭 `card_id`/内存状态推进，没有用户、项目、Quote、Confirmation 或 Submission 绑定；
- 解锁后的资产卡可以再次直连生成，并发下可能重复调用。

目标改造：

1. 公开 Tool 只能创建生成意图或查询状态；
2. 真正生成函数只接受服务端 `execution_id + plan_item_id`；
3. 每个执行项在平台后端原子领取；
4. 无 Submission、已消费、参数不匹配或对账中的执行项一律拒绝；
5. 删除“生成后再审批”的流程。

验收：

| 输入 | Provider 调用 |
| --- | --- |
| 裸 Prompt | 0 |
| 只有 `card_id` | 0 |
| 聊天出现“确认” | 0 |
| `auto_approve_generated_assets=True` | 0 |
| 任意非空 reviewer | 0 |
| 有效且未执行的 plan item | 最多 1 |
| 同一执行项并发两次 | 最多 1 |

### A-04：ReviewGate 与安全确认彻底分离

`production-chain-agent/production_chain/workflow.py` 及复制版本的 ReviewGate 只检查 reviewer 非空并保存在内存中；`agent.py`、`agentkit_entry.py` 和 A2A 编排存在自动 approve。

处置：

- ReviewGate 只保留内容质量审核语义；
- 从所有云调用授权条件中移除 reviewer/approved 布尔值；
- 安全确认只来自平台 Confirmation/Submission；
- 测试保证 ReviewGate 已通过但无 Submission 时 Provider 调用仍为 0。

### A-05：隔离 A2A、test-agent、MCP、Skill、TOS、VikingDB

已知路径包括：

- `production-chain-agent/sda2a/server.py`：入站缺少正式认证；
- `production-chain-agent/agentkit_entry.py`：Tool 可指定 Hub host/port；
- `production-chain-agent/sda2a/client.py`：可请求任意 HTTP URL；
- `production-chain-agent/sda2a/sub_agents.py`：generation agent 明确缺少 ReviewGate/幂等；
- `test-agent/agent.py`、`agent_a2a.py`：固定测试用户、宽 CORS、调试路由、HTTP/公网监听；
- `test-agent/short_drama_agent/factory.py`：直接挂载模型、MCP、Skill、TOS/VikingDB 能力。

V1 处置：

- `test-agent` 不进入生产镜像/部署清单，不获得生产凭据、生产数据或生产网络；
- 生产硬拒绝调用方指定 Hub、HTTP A2A、未签名 AgentCard 和调试路由；
- MCP、Skill、VikingDB 及 Agent/test-agent 的直接 TOS 按动作默认 deny；TOS 只有平台 Asset Worker 的 `asset.store` 满足项目对象授权、批准桶/前缀、私有 ACL、加密、内容校验、幂等和审计后才可开放；
- 不以 CORS 代替服务认证。

### A-06：云结果只返回平台资产引用

当前 Ark 原始图片 URL 会进入工作流结果/回执。目标：

- Provider Worker 先把结果登记成平台 `asset_id`；
- `asset.store` 在写入前原子领取唯一资产登记 ID并预留用户/项目对象数和字节额度，写入后按实际对象结算；并发重复只返回同一 asset，额度服务不可用时 TOS 调用为 0；
- 返回平台 `asset_id` 或每次访问都重新校验用户与项目权限的平台下载端点；不得返回 Ark/TOS 原始或签名直链；
- 不把供应商原始 URL、桶名、内部 endpoint 或签名查询串写入 Agent 输出/日志；
- URL 过期和项目访问撤销后，平台下载接口必须拒绝。

## C：CLI 仓库工作包

仓库：`D:\Internship\COL\zhongwen-shortdrama-cli`

完整边界见 `docs/security-action-boundary.md`。

### C-01：受信 Endpoint 与会话绑定

当前风险：

- `src/shortdrama_cli/cli/common.py` 默认使用明文 HTTP IP；
- `--api-base` / 环境变量可以改到任意地址；
- `server_api/client.py` 对任意配置地址附加 Authorization；
- `cli/runs.py` 还有独立 `api-url + token` 路径；
- 资产库也使用独立明文 HTTP IP。

目标：

- 生产 Endpoint 只能来自安装包白名单、管理员签名配置或受管理设备 Endpoint ID；普通 CLI/WorkBuddy/Codex 不能登记新信任；
- 业务 API、runs API、资产 API 分别按 `service_id + scheme + host + port + fixed_base_path + credential_audience` 登记；
- 登录密码、access/refresh Token 只发送给其绑定 Endpoint/audience；
- HTTP、userinfo、query/fragment、未登记端口和所有 API 3xx 在网络前拒绝，不发送第二次请求；
- `--api-base`、`--api-url`、`--asset-api-base` 只可选择/完全匹配对应 Endpoint，不能变成任意 URL；
- 测试通过注入 fake transport 使用测试域名，不靠关闭校验。

### C-02：移除生产直连 Agent

当前 `providers/agent.py` 硬编码真实 Gateway，`cli/breakdown.py` 和 `cli/generate.py` 暴露 provider、agent-url、Token、user/session。

目标：

- 生产命令和发布制品不包含 Agent provider/真实 Gateway；
- 用户 ID和会话不能从命令参数传给 Agent；
- 若保留 dev harness，独立于生产入口，只允许 loopback、无平台 session、无 Agent/云 Token；
- WorkBuddy Skill 同步删除直连指导。

### C-03：凭据不进入 argv 或明文会话

- 登录密码改为隐藏交互输入或平台批准的登录机制；
- 删除 `--password`、`--refresh-token`、`--token` 等生产 argv 秘密；
- Windows 使用 Credential Manager 或平台批准的系统凭据存储；
- profile 绑定受信 Endpoint 和 audience，Token 不跨 profile/Endpoint；
- 旧明文 session 迁移成功后清除 Token，不能永久静默兼容；
- Mock 模式不加载任何生产 session/Token。

### C-04：改成 Quote/Confirm/Submit 和能力档位

当前 `create.py` / `server_api/client.py` 可以直接 POST 生成，并暴露模型、尺寸、分辨率、cost mode；本地费用估算不能作为服务端 Quote。

目标：

1. 真实模式只接受 `--capability quality|fast`；
2. `--model-preference quality|fast` 可做一版明确别名；
3. 真实模式遇到具体模型、尺寸、价格参数时网络前拒绝；
4. CLI 请求并显示服务端 Quote；
5. 页面确认后，受控人员用 `--submit-confirmed-quote <quote_id>` 提交已确认报价；后端仍须重新验证绑定的用户、项目、plan digest 和一次性 Confirmation；
6. 该参数不是授权，WorkBuddy/Codex 不得自动填；
7. main 接口未落地前返回 `paid_generation_disabled`，不能沿用直接 POST。

旧 `--yes` 不能自动映射为新参数，这是必要的安全性破坏性变更。

### C-05：输出和错误使用字段白名单

当前 JSON formatter 可序列化任意字典，多个命令输出完整服务端对象；Agent debug 输出 Prompt/响应；HTTP 异常可能包含服务端原始正文。

目标：

- 每类命令定义输出 Schema，而不是只做通用字符串替换；
- 默认仅保留 status、action、task/project/scene ID、request/audit ID、安全摘要；
- 不输出完整 Prompt、剧本、绝对本地路径、签名 URL、连接串、Token、供应商原始错误；
- manifest 只保留 ID、状态、时间、摘要和安全相对产物引用；
- `runs sync` 不发送绝对路径和自由文本错误；
- debug 也遵守同一白名单。

### C-06：同步修改 WorkBuddy Skill

`skills/shortdrama-cli/SKILL.md` 当前仍指导选择具体模型并直接生成。代码收紧时必须同时更新：

- 只使用 `quality/fast`；
- 不调用 Agent Gateway；
- 不传 argv Token、密码或任意 API URL；
- 聊天“确认”不能转换成生成提交；
- 禁止 Skill 自动填写生产危险确认参数。

## R：代码仓库 CI Security Action

建议先在 Agent 和 CLI 仓库分别创建 `.github/workflows/security.yml`；main 路径确认后也必须接入同一基线并增加控制面/并发/迁移检查。规则基线相同，仓库专属检查不同。

共同必需检查：

1. 秘密扫描：PR diff、当前树、定期全历史；AK/SK、AgentKit/MCP Key、私钥、Bearer、`.env`、`agentkit.yaml`、高熵值；
2. 依赖/SBOM：锁文件一致性、已知漏洞、恶意包和基础镜像；
3. SAST：SSRF、任意 URL+Authorization、原始错误/Prompt 日志、危险反序列化；
4. 工作流：最小 token 权限、第三方 Action 固定 commit SHA、Fork PR 无生产 Secret、避免危险 `pull_request_target`；
5. 制品扫描：镜像/包中无 `.env`、密钥、真实 Gateway 和部署配置；
6. 安全测试：全部使用 fake Provider，无真实云 Secret。

Agent 专属架构检查：

- 禁止生产模块读取 AK/SK、Ark Key、`ARK_BASE_URL`；
- 禁止新增 Agent→Ark/TOS 直连；
- 禁止用 reviewer/auto_approve/card_id 触发生成；
- test-agent/A2A/MCP/Skill 不进入生产部署清单。

CLI 专属架构检查：

- 生产路径不得导入 AgentKit/Ark/Agent provider；
- 未命中完整受信 Endpoint 的地址不能携带平台 Authorization、密码、Prompt 或上传正文；
- 发布帮助和制品不含 agent-url、argv Token/密码；
- Mock 不读取 session、不联网；
- Skill 不指导具体 Provider 模型或自动危险确认。

main 专属架构检查：

- 会话推导的 `app.users.id` 和项目 RBAC 不能被请求字段覆盖；
- Confirmation 唯一约束、Submission/额度事务和执行项 claim 的并发测试；
- Generation Gateway/Asset Worker 不能绕过策略、对象授权和审计；
- 数据库迁移、回滚和能力目录变更必须有 Schema/策略兼容测试。

三仓 CI 工作流都必须成为受保护分支和 Release 的 required check。CI 不接收生产凭据。
`main` 仓库现已确认，但 P0 候选仍在 Draft PR #148 中等待 Actions；不能以 Agent/CLI 的
本地检查或 main 的本地测试替代生产开启门禁。

## M：main/平台后端工作包

当前 `main` 仓库路径已确认。P0 候选已先收口 Worker fail-closed、Assistant 当前项目权限
复核、审计读取脱敏、禁用 Assistant 直连/回退 Ark，以及资产处理 Worker fail-closed；
完整 Gateway、额度账本、私有 TOS 和 staging 证据仍未完成。因此下表仍是后续交付与验收依据：

| ID | 工作 | 最低验收 |
| --- | --- | --- |
| M-01 | 会话与项目 RBAC | 从会话得到 `app.users.id`；负责人/编辑允许，read-only/非成员拒绝 |
| M-02 | Quote/Confirmation/Submission | 页面确认一次；原子消费、额度预留、幂等和并发测试 |
| M-03 | 能力目录 | 客户端只用 quality/fast；模型/规格/价格版本化；未知拒绝 |
| M-04 | Generation Gateway | 按 execution ID 重载权威记录；Agent 自报字段无效 |
| M-05 | Provider 资产登记 | `asset.store` 预留对象数/字节额度，执行批准桶/项目前缀/私有 ACL/加密/校验/幂等，结果转平台 asset ID 和鉴权下载端点 |
| M-06 | 业务账本与安全审计 | 最小字段、禁止原文、访问/保留配置可验证 |

## 兼容策略

| 旧能力 | 兼容方式 |
| --- | --- |
| 本地 mock pipeline | 保留，但标记 local-only；不加载 session、无网络、无真实费用 |
| CLI 任意 `--api-base` / `--api-url` / `--asset-api-base` | 只允许选择并完全匹配对应受信 Endpoint 的 service/scheme/host/port/base path/audience |
| CLI `--provider agent` | 从生产入口移除；必要 dev harness 独立发布且仅 loopback |
| CLI 具体 `--model/--size/--cost-mode` | Mock 可保留；真实模式拒绝；quality/fast 提供明确迁移提示 |
| CLI 旧 `--yes` | 不映射为付费确认；删除或仅用于无付费本地操作 |
| Agent 直接 LLMClient | 替换为平台内部客户端；不能用“临时 Key”维持生产 |
| ReviewGate | 保留内容质量审核，不参与云调用授权 |
| 旧供应商 URL 输出 | 迁移为 platform asset ID；旧 URL 不进入新响应 Schema |

## 自动化验收矩阵

### 身份和权限

| 场景 | 预期 |
| --- | --- |
| 客户端伪造 user_id/session_id | 忽略并按服务端会话判断 |
| 项目只读成员 | `project_role_forbidden`，Provider 0 调用 |
| 非项目成员 | `project_access_denied`，Provider 0 调用 |
| 管理员无项目成员关系 | 默认拒绝生成 |
| 报价后成员权限被撤销 | 提交拒绝，Provider 0 调用 |
| 报价/确认后角色降为只读 | Confirm、Submit 或执行前重查拒绝，剩余 Provider 0 调用 |

### 报价、确认、额度和并发

| 场景 | 预期 |
| --- | --- |
| 无 Quote | `quote_required` |
| Quote 未页面确认 | `approval_required`，Provider 0 调用 |
| 聊天“确认”/旧 `--yes`/reviewer/auto approve | Provider 0 调用 |
| 过期或参数变化 | `confirmation_invalid` |
| 同一 Confirmation 并发提交 | 只创建一个 Submission，只预留一次 |
| 同一执行项并发领取 | Provider 最多 1 调用 |
| 额度为 0或额度服务不可用 | deny，Provider 0 调用 |
| Provider 超时 | `reconcile_required`，不自动重复生成 |

### 参数、网络和数据

| 场景 | 预期 |
| --- | --- |
| 客户端指定模型/任意尺寸/价格 | 网络前 `invalid_capability_parameter` |
| 未登记 capability | `capability_not_configured`，Provider 0 调用 |
| Agent 发起未登记文本模型调用 | Gateway deny，Provider 0 调用 |
| asset_storage 关闭、额度为 0或存储额度服务故障 | TOS 0 调用 |
| Asset Worker 指定其他 bucket/公开 ACL/跨项目 prefix | deny，TOS 0 调用 |
| Agent 设置 AK/SK/Ark Key/ARK_BASE_URL | 无法连接云 |
| CLI 使用恶意 api-base/agent-url/api-url/asset-api-base | 网络 0 调用，Token/密码/正文不离开受信 Endpoint |
| HTTP、任何 API 3xx、私网/DNS 重绑定 | 拒绝 |
| Prompt/上传含测试密钥 | deny，审计无原文 |
| Agent 返回供应商原始 URL | 输出 Schema 拒绝或转换为 asset ID |

### 输出、Mock 和 CI

| 场景 | 预期 |
| --- | --- |
| 恶意嵌套响应含 Token/Prompt/连接串/签名 URL | human/json/debug/manifest 均无原值 |
| 设置全部生产凭据后运行 mock | 不读取凭据，网络调用为 0 |
| Fork PR | 无生产 Secret、无写权限、无真实云调用 |
| 全历史扫描 | S-001 清理后无有效秘密 |
| Agent/CLI 全量测试 | 各仓库规定的测试命令全部通过 |

测试必须使用假 Provider、网络 collector、固定时钟、并发执行器和可检查的内存/测试数据库，不得调用真实火山云。

## 发布顺序

```text
凭据事故处置
  → P0 直连/自动批准/Endpoint 收缩
  → main 契约和假 Provider
  → Agent/CLI/main 三仓 CI required
  → staging enforce + 网络拦截测试
  → 完成三项待确认决定、S-001 事故和全部工程门禁
  → production canary
  → production enforce
```

shadow 环境不得使用真实付费 Provider 或生产受限数据。回滚可以回滚应用/策略版本，但不能恢复 Agent 云凭据、任意出口、自动批准或任意 Endpoint。

## 生产开启条件

真实付费生成只有在以下全部满足时才能从 `enabled=false` 改为 `true`：

- S-001 凭据事件关闭；
- 平台会话和项目对象授权通过；
- Quote/Confirm/Submit、原子额度和幂等通过；
- quality/fast 的模型、规格和预算目录获批；
- Agent 无云凭据且无法直连 Ark/TOS/公网；
- Provider Worker 出口责任人和允许/拒绝测试证据齐全；
- Asset Worker 的独立服务身份、最小 TOS 凭据、批准 endpoint/bucket、默认拒绝网络和存储额度测试齐全；
- CLI 无法把会话、密码、Token 发往任意地址；
- 输出和审计脱敏测试通过；
- 审计查看范围和保存期限确认；
- Agent、CLI、main 三仓 CI 安全检查已设为 required；
- 所有 ask/deny 场景的真实 Provider 调用数为 0。

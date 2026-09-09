# Security Action 契约、状态机与运行语义

## 术语与现有平台对象的映射

设计术语不要求平台重复建立一套数据库：

| 安全语义 | 平台实现对象 |
| --- | --- |
| Plan | Quote 中冻结的生成参数和成本快照 |
| Grant | 服务端 Confirmation 的“一次确认”语义；不是发给客户端的 Bearer Token |
| ExecutionLease | Submission/Job 中仅内部服务可使用的执行记录 |
| Quota reserve/settle | 平台额度和成本账本的预留/结算事务 |
| SecurityContext | 后端从会话和数据库推导的可信上下文 |

如果现有表可以满足唯一约束、原子状态转换和审计，就复用现有表；不能为了沿用术语而多造一套互相不一致的授权数据。

## 可信上下文

```text
InteractiveSecurityContext
  schema_version
  actor_user_id              # app.users.id
  session_ref                # 服务端引用，不是 Cookie/Token
  platform_role              # administrator | operator | member
  project_id
  project_role               # project_owner | editor | read_only
  membership_version
  request_id / trace_id
  issued_at / expires_at
  integrity_proof

ExecutionSecurityContext
  schema_version
  actor_user_id              # 原始发起者
  project_id
  project_role_snapshot
  membership_version_at_submission
  submission_id / execution_id
  executor_service_id
  on_behalf_of_user_id       # 必须等于原 actor
  request_id / trace_id
  issued_at / expires_at
  integrity_proof
```

规则：

1. `actor_user_id` 只能由服务端会话推导。
2. `project_role` 只能由平台数据库读取；客户端声明只作为待验证输入。
3. `membership_version` 用于发现报价后成员关系被撤销的情况，提交时必须重新检查。
4. 后台任务允许内部服务代表用户执行，但必须绑定已创建的 Submission/Execution；不要求原始用户会话在整个异步执行期间继续存活。
5. Worker 每次云调用前仍要检查原始用户状态、当前项目成员/角色和 membership version；会话结束不等于权限撤销，但用户停用或角色降级必须阻止剩余执行项。
6. V1 不强制不存在的 `tenant_id`；项目是当前已确认的隔离边界。
7. Prompt、Tool、CLI/HTTP 参数提供的同名字段全部不可信。

## 客户端生成意图

客户端只允许提交业务意图：

```text
GenerationIntent
  project_id
  capability_tier            # quality | fast
  media_type
  content/reference IDs
  output_count
  idempotency_key
```

生产请求禁止客户端字段：

```text
provider
model_id / model_name
arbitrary size / resolution
price / cost_mode
provider endpoint / api_base
approval_grant
user_id / session_id / role
```

出现禁止字段时返回 `invalid_capability_parameter`，不能静默忽略。

## Quote 契约

后端根据身份、项目权限和能力目录创建：

```text
GenerationQuote
  quote_id
  actor_user_id
  project_id
  project_role_snapshot
  membership_version
  capability_tier
  catalog_version
  resolved_provider / model_id
  resolved_specifications
  output_count
  normalized_plan_digest
  reference_digest
  estimated_cost / max_estimated_cost
  policy_version
  status = quoted
  expires_at
  approval_url
  audit_id
```

Quote 返回给 CLI/页面时可以隐藏真实 Provider 凭据和内部 endpoint。真实模型是否对用户展示由产品决定，但客户端不能修改。

## Confirmation 与 Submission

状态机：

```text
draft
  → quoted
  → confirmed
  → submitted
  → executing
  → settled
       ↘ reconcile_required
```

允许的转换：

| 当前状态 | 操作 | 必需条件 | 新状态 |
| --- | --- | --- | --- |
| quoted | 页面确认 | 会话用户、项目和 Quote 匹配；未过期 | confirmed |
| confirmed | 提交 | 成员权限仍有效；额度可预留；幂等键唯一 | submitted |
| submitted | Worker 领取 | 批准的内部服务；任务未领取/租约可恢复 | executing |
| executing | Provider 成功 | 结果与 provider request ID 已登记 | settled |
| executing | 结果未知 | 超时或响应丢失，无法证明未生成 | reconcile_required |

以下全部为 `deny`：

- 过期、篡改或已消费 Confirmation；
- Quote 内容、档位、数量、规格、参考或目录版本发生变化；
- 只读成员、退出项目或成员关系版本失效；
- 同一 Confirmation 创建第二个不同 Submission；
- `reconcile_required` 未完成对账就再次调用 Provider。

`confirmed → submitted` 的一个数据库事务必须同时：

1. 比较并交换 Confirmation 状态；
2. 以数据库 `UNIQUE(confirmation_id)` 保证一份 Confirmation 只能关联一个 Submission，并保存唯一幂等键；
3. 预留用户额度和项目预算；
4. 创建 Submission、Job 和固定执行项；
5. 写业务账本和安全审计。

事务失败则全部回滚，Provider 调用为 0。

## 多图和重试

一次 Confirmation 对应一次 Submission，不等于“一张图片”。多图 Quote 中已经展示并确认的数量可以拆成固定 `plan_item_id` 集合：

- Confirmation 只消费一次；
- 每个 `plan_item_id` 最多成功调用一次；
- Submit 策略评估前先查询幂等记录；同一用户、Confirmation、Quote、plan digest 和幂等键完全匹配时，直接返回原 Submission/Job，不再次预留额度，也不进入 allow/ask/deny 或调用 Provider；
- 不同幂等键重放同一 Confirmation 必须拒绝；
- Worker 领取执行项必须原子 compare-and-claim，并绑定 `executor_service_id`、`lease_owner`、过期时间和单调递增 fencing token；过期、所有者不匹配或旧 fencing token 不能调用 Provider；
- Provider 超时后进入 `reconcile_required`，先查 Provider/账本再决定补偿；
- 只有明确证明未产生云资源时，才能由受控补偿流程重试。

## Generation Gateway 的 ActionRequest

ActionRequest 只在平台可信边界内创建：

```text
ActionRequest
  schema_version
  request_id / trace_id
  policy_version
  trusted SecurityContext
  execution_id / submission_id / plan_item_id
  caller_service_id / deployment_environment / code_version
  action                     # model.send | cloud.generate | asset.store ...
  capability_tier / catalog_version
  resolved resource          # provider、model、destination、method、path
  normalized provider body
  data classification / secret findings
  estimated and reserved cost
```

Gateway 必须根据 `execution_id` 重新加载权威记录，不能相信 Agent 在 ActionRequest 中复制的身份、角色、状态、模型、成本或数据分类。

## 决策结果

控制面和执行面不能混用 `ask`：

- Quote/页面确认控制面可以返回 `ask` / `approval_required`；
- Provider Worker / Generation Gateway 只应收到已经 `submitted` 的 Execution；缺失或无效 Submission、Confirmation 或执行租约必须 `deny`，不能在云调用点等待聊天确认。

```text
Decision
  outcome                    # allow | ask | deny
  reason_code
  request_id / audit_id
  policy_version
  safe_constraints
```

- `allow`：执行面只允许已原子领取的当前执行项发生一次已登记 Provider 调用；
- `ask`：仅由控制面对“合法 Quote 但尚未页面确认”返回，真实云调用为 0；
- `deny`：状态无效、越权、额度/目录/策略缺失或疑似篡改，真实云调用为 0。

控制面的无 Confirmation 可以引导页面确认；无效/已消费 Confirmation 是重放或篡改，应拒绝。完全匹配的幂等重试属于“返回已有结果”的预处理终止分支，不是新的 `allow`，也不能再次产生副作用。

## 稳定错误码

| 错误码 | 含义 | CLI 行为 |
| --- | --- | --- |
| `authentication_required` | 无有效平台会话 | 提示登录；不回退其他 Provider |
| `project_access_denied` | 不属于项目 | 终止 |
| `project_role_forbidden` | 只读或角色不允许 | 终止 |
| `quote_required` | 尚未创建有效 Quote | 可请求 Quote |
| `approval_required` | Quote 有效但页面未确认 | 显示安全摘要和 `approval_url` |
| `confirmation_invalid` | 过期、篡改或不匹配 | 终止并重新报价 |
| `confirmation_consumed` | 已被另一 Submission 消费 | 返回原幂等结果或终止 |
| `quota_exceeded` | 用户/项目额度不足 | 终止 |
| `paid_generation_disabled` | 生产付费开关关闭 | 终止 |
| `capability_not_configured` | 档位没有批准映射 | 终止 |
| `invalid_capability_parameter` | 客户端传真实模型/规格/价格等禁止字段 | 网络前拒绝 |
| `policy_denied` | 数据、目的地或规则拒绝 | 显示安全文案和 audit ID |
| `untrusted_endpoint` | CLI 目标未命中受信 service/scheme/host/port/base path/audience | 网络前拒绝；过渡期可把旧 `untrusted_origin` 映射到此码 |
| `reconcile_required` | Provider 结果未知 | 不自动重试；等待对账 |
| `security_dependency_unavailable` | 权限/额度/审计/策略依赖不可用 | fail closed |

错误响应不能包含原始 Prompt、完整剧本、Token、签名 URL、连接串或供应商响应正文。

## 评估顺序

Provider Worker 对每个执行项固定按以下顺序处理：

1. 验证策略版本、执行环境和内部服务身份；
2. 根据 execution ID 加载用户、项目、Submission 和执行项；
3. 重新检查原始用户仍有效、项目成员关系、当前角色仍为负责人/编辑、membership version、Submission、额度预留和幂等；
4. 解析已批准能力目录，核对模型/规格/成本；
5. 生成规范化完整 Provider 请求；
6. 重新执行 DLP、数据分类、引用对象授权和目的地检查；
7. 原子领取执行项，取得绑定当前 service/instance 的有效 lease 和 fencing token，并写调用前安全审计；
8. 只有 `allow` 且 lease/fencing token 仍有效才访问网络；
9. 保存 provider request ID、结果摘要，结算或进入对账。

策略、额度、审计或状态存储故障全部 fail closed。

Provider 返回媒体后，独立平台 Asset Worker 才能执行 `asset.store`：在一个原子步骤中领取唯一资产登记 ID并预留对象数/字节额度，再使用批准桶、服务端生成的项目对象前缀、私有 ACL、静态加密及内容类型/大小/校验和验证写入。重复登记只返回已有 asset，不重复写 TOS；超时进入存储对账。Agent/CLI/Gateway 不能直接写 TOS。对外只返回平台 `asset_id` 或每次请求都重新鉴权的平台代理下载端点，不能返回 Ark/TOS 原始或签名直链。

## 审计分层

### 业务账本

按用户和项目保存：

- 事件时间和 request ID；
- Quote、Confirmation、Submission、Job ID；
- 能力档位、目录版本、模型/规格；
- 估算费用、预留额度、实际成本和耗时；
- 状态、结果摘要和业务错误码。

项目成员只能查看被授权的本项目业务记录。

### 安全审计

保存：

- 事件时间、request/trace/audit ID；
- 用户 ID、项目 ID、角色快照、内部服务 ID；
- 策略/规则/能力目录版本；
- action、能力档位、模型、destination ID、数据分类和规则命中；
- allow/ask/deny、额度摘要、provider request ID、耗时和错误码；
- 网络出口拒绝和重放/并发异常。

禁止保存：

- 剧本全文、Prompt 原文、Tool 原始内容和附件字节；
- AK/SK、API Key、Bearer、Cookie、Confirmation 秘密；
- 数据库连接串、签名 URL和供应商敏感原始返回。

业务账本和安全审计必须分别配置查看范围与保存期限；两项均是生产门禁，见 `05-confirmed-decisions-and-production-gates.md`。

## 策略发布

`policy-v1.proposed.yaml` 只是可评审配置形状。真正执行前必须：

- 有 Schema 和语义校验；
- 版本不可变并有批准记录；
- 只允许平台管理员/安全责任人发布；
- 有 staging 假 Provider 回归和回滚版本；
- 未决生产值不存在占位符；
- 付费开关、能力目录和额度门禁全部通过。

CLI、Agent、LLM 和普通环境变量都不能修改生产策略。

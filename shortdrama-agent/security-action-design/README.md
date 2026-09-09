# 短剧平台 Security Action V1

> 状态：Agent、CLI 的 CI Security Action 是本地候选实现，尚未成为 GitHub required checks；
> 平台 `main` 的第一批 P0 fail-closed 修复已推送到 Draft PR #148，但没有 Actions/staging
> 验收。真实付费生成仍关闭。
> 更新时间：2026-08-10。
> 适用范围：`zhongwen-shortdrama-agent`、`zhongwen-shortdrama-cli`，以及必须由平台 `main` 后端完成的安全控制面。

## 先看结论

**明确结论：分别为 Agent 和 CLI 两个仓库各设计、各运行一个独立的 CI Security Action。**
两个 Action 不跨仓执行，也不共用 baseline；它们共享的是安全原则、服务端授权边界和
错误处理要求，而不是同一份可执行脚本。

| 系统 | 负责什么 | 不能做什么 |
| --- | --- | --- |
| CLI | 会话保护、危险输入预检、受控业务 API 调用、脱敏输出 | 不能决定是否允许生成，不能直连 AgentKit/Ark，不能持有火山云密钥 |
| Agent | 使用服务端下发的任务引用执行业务流程，只调用平台后端 | 不能相信 Prompt 中的身份/确认，不能直接访问 Ark/TOS，不能签发授权 |
| main/平台后端 | 认证、项目权限、报价、页面确认、一次性提交、额度、业务账本和安全审计 | 不能让客户端指定真实模型、价格或云地址 |
| Provider Worker / Generation Gateway | 在模型/媒体调用前执行 Security Action，使用受管理模型凭据调用批准 Ark 目标 | 不能接受未经后端账本确认的执行项，不能写 TOS |
| Asset Worker | 执行 `asset.store`，使用独立最小权限凭据写批准 TOS bucket 并登记平台资产 | 不能调用 Ark，不能接受任意 bucket/key/公开 ACL |
| 网络边界 | 阻止 Agent 绕过后端直连公网；Provider Worker 仅能访问批准 Ark，Asset Worker 仅能访问批准 TOS | 不能替代用户、项目、审批和额度判断 |
| Agent 仓库 CI Action | 检查云凭据/配置、Agent 直连 Ark/TOS、自动批准、测试入口、依赖、工作流和 Git 历史 | 只作用于 Agent 仓库；不能替代运行时认证、额度和网络控制 |
| CLI 仓库 CI Action | 检查 Token/Endpoint/输出泄露、直连 Provider/数据库、Skill 指令、依赖、发行物、Release 和 Git 历史 | 只作用于 CLI 仓库；不能替代服务端授权 |

因此，最终可运行的闭环一定会涉及 `main` 后端。只修改 Agent 和 CLI，最多能关闭绕过路径，不能完成生产授权闭环。

## 两个仓库 Action 的启用边界

两个独立 Action 的文件目前都只在本地工作区，尚未暂存、提交或在 GitHub 中成为
required checks。正式启用时，两个仓库必须分别完成分支/Tag/部署入口保护，并让
明确指定的安全团队通过 CODEOWNERS、Ruleset 或等价机制审批 workflow、扫描器、
baseline 和安全测试的变更。真实 team slug 尚未确认，不能由设计者猜写一个
CODEOWNERS 条目；仓库或组织管理员必须配置并验证实际权限。

Agent Action 当前候选稿的 baseline 只有 40 项供应链迁移债务（28 项未锁定依赖、5 项
缺少锁文件、7 项未固定 Docker 基础镜像）。Agent 直连 Ark/TOS、云凭据读取、任意
Hub、自动批准、旧 A2A/test harness、动态 URL 请求和敏感日志等生产阻断项不允许进入
baseline；当前已先关闭 6 项 test-agent 默认暴露风险，但快照仍有 72 项这类风险及 2 项
已跟踪运行配置风险，因此 Guard 必须保持失败。实际部署入口也必须接入对生产阻断规则
零豁免的 strict deploy gate。直到这些
active finding 清零，真实 Agent 生产部署和真实付费云调用必须保持关闭。CLI Release
则由 CLI 仓库自己的 strict 门禁独立控制，不能用其中一个仓库的检查结果替代另一个仓库。

## 生产目标调用链

```text
产品页面 / 受控 CLI
  → 平台后端验证 app.users 用户会话和项目权限
  → quote：创建不可变报价与生成计划
  → 用户在产品页面 confirm
  → submit：原子消费本次确认、预留额度并创建任务
  → Agent 按任务引用调用平台后端
  → Provider Worker / Generation Gateway 执行 Security Action → Ark
  → Asset Worker 执行 asset.store → TOS
  → 结算额度、业务账本和脱敏安全审计
```

聊天中说“确认”、`reviewer="director"`、`auto_approve_generated_assets=True` 或 CLI 的 `--yes` 都不构成安全授权。

## 已确认和仍待确认的边界

六个问题的回执已经足以继续设计和开发：

- 身份来源已确认：平台服务端会话与 `app.users.id`；
- 权限、审批、额度和成本账本已确认由平台数据库负责；
- 付费生成确认入口已确认为产品页面 `quote → confirm → submit`；
- 客户端只提交 `quality` / `fast` 能力档位，真实模型由服务端映射；
- Agent 生产环境只调用平台后端，不持有火山云密钥；
- 审计允许记录的最小字段和禁止内容已经明确。

仍有三项待业务/平台确认的决定：

1. 真实模型、规格、单次上限、用户日额度、项目日预算和超额审批人；
2. 云网络出口责任人及实际连通/拦截证据；
3. 审计查看范围和保存期限。

三项未全部完成前，策略必须保持媒体付费生成、未登记文本推理和 TOS 资产写入均关闭；媒体、文本 Token、存储对象数和字节额度均为 0，真实 Ark/TOS 调用数为 0。

此外，生产开启还必须关闭 `06-current-security-findings.md` 中的 S-001 凭据事件，并完成 main 状态机/Gateway/资产存储、Agent/CLI/main 三仓 CI 和网络/并发测试。三项回执答完不等于已经可以上线。

## 正式设计文件

以下文件共同构成当前有效设计：

1. [00-scope-and-decision.md](00-scope-and-decision.md)：统一范围、仓库分工和生产边界。
2. [01-threat-model.md](01-threat-model.md)：资产、攻击路径和信任边界。
3. [02-reference-architecture.md](02-reference-architecture.md)：目标调用链、身份、审批、能力目录和网络分区。
4. [03-contract-policy-and-operations.md](03-contract-policy-and-operations.md)：可信上下文、状态机、错误码和审计契约。
5. [04-migration-verification.md](04-migration-verification.md)：按真实代码路径拆分的实施顺序、兼容策略和验收测试。
6. [05-confirmed-decisions-and-production-gates.md](05-confirmed-decisions-and-production-gates.md)：六项回执的正式决策记录和剩余门禁。
7. [06-current-security-findings.md](06-current-security-findings.md)：当前仓库已经核验的凭据/资源配置风险及事故处置顺序。
8. [policy-v1.proposed.yaml](policy-v1.proposed.yaml)：供评审和后续实现使用的提议策略；当前不能直接部署。
9. [07-current-implementation-status-2026-08-10.md](07-current-implementation-status-2026-08-10.md)：三仓
   当前实现、验证证据与未完成门禁的统一快照。

CLI 仓库还有一份只描述 CLI 本地边界的配套文件：

`D:\Internship\COL\zhongwen-shortdrama-cli\docs\security-action-boundary.md`

两个本地实现入口分别是：

- Agent：`D:\Internship\COL\zhongwen-shortdrama-agent\.github\workflows\security.yml`
- CLI：`D:\Internship\COL\zhongwen-shortdrama-cli\.github\workflows\security.yml`

Agent、CLI 的两个入口目前仍是工作目录候选；只有经仓库负责人评审并进入受保护分支后，
GitHub Actions 门禁才会真正生效。main 的 P0 候选已在 Draft PR #148 中，仍不能据此开启
真实 Ark/TOS 或付费生成。

## 历史文件

`01-v1-design.md`、`02-implementation-task-plan.md`、`MENTOR_DELIVERY.md` 和 `policy-v1.draft.yaml` 是早期草案，保留用于追溯，不得作为开发或上线依据。若内容冲突，以本 README 列出的正式设计文件为准。

## 验收底线

在 staging/prod 的强制模式下，出现未登录、项目无权、只读成员、未页面确认、确认已消费、额度为 0、能力档位未映射、网络目的地不允许或策略系统故障中的任一情况时：

> Ark/TOS 的真实付费请求数必须为 0，且日志不得包含剧本全文、Prompt 原文、密钥、连接串或供应商敏感原始返回。

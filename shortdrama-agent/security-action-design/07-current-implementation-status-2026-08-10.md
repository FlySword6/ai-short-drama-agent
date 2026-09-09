# 三仓安全整改实施状态（2026-08-10）

> 这是评审快照，不是上线批准。只有 GitHub Actions、分支保护和 staging 实证都完成后，
> 才能把候选代码视为有效门禁。

## 已有可复核实现

| 仓库 | 已实现的候选控制 | 已有本地证据 | 仍不能宣称 |
| --- | --- | --- | --- |
| `main` | 付费/预算/依赖不满足时 Generation Worker 不启动或领取历史任务；Assistant 不直连或回退 Ark；请求前复核当前项目创建权限；项目审计投影脱敏；资产上传/修复 Worker 默认 fail-closed | 类型检查、架构检查和定向单测已执行；代码在 [Draft PR #148](https://github.com/col-shortdrama/zhongwen-shortdrama-main/pull/148) | GitHub Actions 全绿、完整受控 Gateway、用户×项目×周期额度账本、私有 TOS、云出口和 staging 八类拒绝场景 |
| `Agent` | 独立 repository guard、供应链 baseline、依赖审计/SBOM、Bandit、PR 增量与定期全历史秘密扫描；`test-agent` 只允许 loopback/CORS，禁止直接 config/deploy | `security/tests` 57/57；local-server 测试 4/4 | Action 已启用、Guard 为绿、历史凭据事故关闭、生产 Agent 不再直连 Ark/TOS/Hub/A2A |
| `CLI` | 独立 guard、Release gate、Linux/macOS workflow；`make security-test` 不依赖人工 `PYTHONPATH`；候选代码关闭 direct Agent、脱敏输出、移除命令行密码和本地明文 token 会话 | 静态文件互相一致；本机没有可用的锁定 `uv`/pytest 工具链 | CI 通过、任意 Endpoint 收口、全历史候选核验、Release 可放行 |

## Agent 当前扫描口径

Agent baseline 只有 40 项明确的供应链迁移债务（未锁依赖、缺锁文件、Docker digest），
不包含生产安全例外。当前快照仍有 74 项 active finding：云凭据读取、直连 Ark/TOS、任意
Hub、旧 A2A 面、自动审批、可部署 test harness、敏感日志、动态 URL、受跟踪运行时配置等。
这些结果使 Guard 失败是正确的；不得为了让 PR 变绿而加入 baseline。

`test-agent/agentkit.yaml` 目前仍被 Git 跟踪且历史存在。必须先由凭据负责人轮换/撤销、
核查云侧调用，再由维护方移出追踪并执行受控历史清理。`.gitignore`、模板文件或文档不能
替代该事故处置。

## CLI 当前扫描口径

CLI 当前扫描有 6 条 active endpoint 阻断：调用方可通过 `--api-base`、
`SHORTDRAMA_API_BASE` 或旧 E2E 环境变量指定任意地址，其中一条仍允许 HTTP。
在有受信 Endpoint profile/系统凭据库方案前，这些不能被 baseline 豁免。全历史扫描还有
13 个已脱敏测试文件候选，需由安全负责人核验其是否曾为真实凭据。

## 需要外部决定或环境证据的项目

1. **main 目标分支**：维护方须确认本次使用 `dev`，还是遵循 `AGENTS.md` 的
   `integration/v011`；PR #148 在此之前只保持 Draft。
2. **受控 Gateway 合同**：Assistant/Agent/CLI 到内部 Gateway 的身份、项目权限、模型/参数
   白名单、流式 tool-turn、错误码与审计字段。
3. **额度账本规则**：用户与项目的周期、预留/扣减/释放、重试/退款、超额审批人及现有积分
   的兼容方式。没有这些不能凭空建立财务语义。
4. **私有 TOS 与出口**：私有 ACL、工作负载身份、短时签名、受信目的地、VPC/安全组出口规则
   和负责人。
5. **staging 证据**：未登录、无项目权限、未确认、确认已消费、额度为 0、目录未登记、
   目的地不允许、依赖故障这八类拒绝场景，均须证明真实 Ark/TOS 请求计数为 0。

## 正确的交付顺序

1. 清理并在获批目标分支上验证 main #148；
2. 推送 Agent 独立 Draft PR，保留 active P0 的失败结果和历史凭据处置任务；
3. 收口 CLI 的受信 Endpoint，再推送独立 Draft PR；
4. 三仓 Actions 和 required checks 生效后，进行 main staging 拒绝场景验证；
5. 只有全部证据完整后，才评估关闭 #76 和开启真实云调用。

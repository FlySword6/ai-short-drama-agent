---
status: proposed
date: 2026-08-18
updated: 2026-08-24
issue: <INTERNAL_GITHUB_ISSUE_URL>#15
---

# GUI 与 TUI 通过薄适配层调用 Agent 底座

## Context

主仓提供 GUI 与业务真源，CLI 仓提供 TUI 与 Skill，Agent 仓提供 Pi runtime。GUI 和 TUI 都需要 Agent，但会话长度、流式交互与部署约束不同。

调用链路分为两段，归属不同、分别论证，本 ADR 只定第一段：

- **段①「上层 → Agent 层」**：GUI/TUI 如何消费 Pi 能力。**这是本 ADR 的选型对象**，结论是 wrapper（sync + SSE）。
- **段②「Agent 层 → 主站」**：wrapper 回连主站时复用 `shortdrama-cli` 接口层（`server_api.client`），受 CLI ADR-0001 受信端点清单约束，本 ADR 只引用、不复制、不重新选型。

`shortdrama-cli` 是段②的接棒者，不是段①的选型候选——它站在「Agent → 主站」这一段，不与 wrapper 竞争。两条合起来才是「从调用方发起 → agent 执行 → 结构化结果返回」的完整链路；「至少一条链路实通」的判据落在段①与段②的接缝处（wrapper 对上收口、对下复用 CLI 真源）。

Pi 支持 JSON 单轮、RPC 长连接和 Node.js SDK；Agent 仓的 `pi-http-wrapper` 把 Pi RPC 收敛为受认证的同步 JSON 与 SSE HTTP 合同。若 GUI、TUI 分别理解 Pi 原始事件、模型名和供应商参数，模型快速迭代会迫使两个上层重复修改。模型选择与参数必须由一个适配边界管理。

这里涉及两个互相独立、不可混为一谈的命题，本 ADR 分别对待：

- **命题 A（公理，已单独证立）**：上层不感知模型版本、供应商参数与 Pi 内部事件；模型选择/参数归适配层单点管理，上层只表达创作意图。依据 Seedance 闭门会 2026-08-18（官方迭代节奏 2.5→1080P 仅隔 10 天、「每次进步抹平前一代精品门槛」），押具体模型版本等于沉没成本。这是硬约束，本 ADR 以它为公理。
- **命题 B（选择，需独立论证）**：满足命题 A 的落地载体为什么是 `pi-http-wrapper`，而不是让上层直接消费 RPC/SDK 或另起一层。命题 A 成立并不能直接推出命题 B——满足「模型下沉」的收口层理论上可以有多个，wrapper 是其中一个候选。命题 B 的论证见下节「为什么不选另外两种」。

运行时事实（供命题 B 引用）：GUI 宿主是 main 仓（非 Node.js 运行时）；CLI 仓是 Python 包（Agent 仓直接 `import shortdrama_cli` 消费其接口层），TUI 侧不承载任何 Pi 客户端运行时，也不持 Node 运行时。

## Decision

### 共同边界

GUI 与 TUI 只表达对话和创作意图、允许的业务工具 schema、业务工具结果、稳定的会话与请求标识。

Agent 层负责模型/供应商选择、供应商参数、Pi 输入映射、稳定 JSON/SSE 输出、认证、并发、用量与错误分类。上层不传具体模型版本、供应商私有参数或 Pi 内部事件。

### GUI（main）

GUI 使用 `pi-http-wrapper`：短轮调用 `POST /pi/prompt/sync`，长轮调用 `POST /pi/prompt` SSE。工具仍在主仓执行并审计，`requires_tool` 后用同一 `conversationId` 续请求；主仓 PostgreSQL 是会话唯一事实源。

不直接选 JSON 子进程：GUI 需要流式输出、工具续轮和跨请求状态。不直接选 Pi RPC：它是运行时协议，会把子进程生命周期与事件兼容推给主仓。不选 SDK：主仓不应绑定 Pi 的 Node.js 内部 API。

### TUI（cli）

TUI 侧「上层 → Agent 层」的定案模式是 **pi-http-wrapper（PiRpcEngine）**：wrapper 在 Agent 仓内部 spawn `pi --mode rpc`，把 Pi RPC 收敛为受认证的同步 JSON + SSE HTTP 合同，TUI 只发 HTTP 请求、不感知 Pi 内部事件。此模式已于 2026-08-24 实通（`docs/validation/2026-08-24-pi-agent-cli-chain-trace.md`：`pi --mode rpc` 底层跑通 + `shortdrama_cli.BusinessServerClient` 端点表可 import + 官方 E2E `tools/run-main-chain-read-e2e.py` 就位）。

生成能力走三层定位（已于 2026-08-24 定案）：**wrapper 工具层不新增 generation 工具**；`shortdrama-cli` 库包（0.3.1）的 generation 只作 `MockProvider` 写假数据、不联网；真实画面/视频生成只走发行版 CLI exe（0.3.0）的 `estimate → confirm → submit` 下单链路，由主站 `/generations/*` 落单后调 Seedream/Seedance 模型。意即：生成能力不是 wrapper 提供的，而是发行版 CLI 的下单入口 + 主站的模型供应商。

若 TUI 需要程序化调用 Agent 层，复用同一 HTTP 同步合同，不直接消费 Pi JSON/RPC/SDK。Pi JSON 仅用于本地诊断和一次性实验；RPC 与 SDK 只允许 Agent 仓内部实现使用。

> **2026-08-24 链路现状注记**：链路架构本身已定案且非生成工具部分已实通。主站模型配置失败（`generation` 档位/供应商配置异常）落在「发行版 CLI → 主站 `/generations/*`」这一环，属平台侧配置问题，不改变本 ADR 的选型结论——它恰恰证明「生成下到主站、上层不自己持模型」的边界是对的：模型/供应商故障被隔离在段②末端的平台侧，不触发段①上层任何改动。

### 为什么不选另外两种（选型矩阵）

| 集成模式 | 本质 | 适合谁 | 被排除的原因 |
| --- | --- | --- | --- |
| pi JSON 单轮 | `pi --mode json -p "..."`，一次性输出结构化 JSONL 事件 | 脚本、诊断、一次性实验 | 无流式增量、无工具暂停/续轮会话、无跨请求状态；GUI/TUI 均需要流式输出与工具暂停/续跑，JSON 模式下这些语义要由调用方自己拼装 |
| pi RPC 长连接 | `pi --mode rpc`，外部进程持续发 JSON 命令，支持连续对话、中止、追加、查询状态 | 需要深度控制会话生命周期的运行时 | 被排除的不是「使用 RPC」，而是「上层直接消费 RPC」。RPC 只允许在 Agent 仓内部使用、不暴露给上层；二者的差异见本节末尾「wrapper vs RPC 的本质差异」四条对照 |
| Node.js SDK | 直接 import Pi 类/函数，无需独立 RPC 进程 | Node.js/TS 应用深度定制模型、工具、会话 | 见本节末尾「SDK 的排除：事实陈述而非假设」 |
| pi-http-wrapper | 收敛 Pi RPC 后的受认证 HTTP 合同（sync JSON + SSE） | 任意上层，只要 HTTP + Bearer | ✅ 唯一满足「上层只表达意图、适配层单点管模型/供应商/认证/并发」的选项；已实通（2026-08-18 端到端 200 + usage.costKnown:true） |

### wrapper vs RPC 的本质差异（逐条，回应「差一层封装」追问）

上层直连 RPC，需自行实现的四项能力，wrapper 均已单点兜底、上层无需感知：

1. **版本化合同**：wrapper 对外是带版本号的稳定 HTTP 合同（sync `completed|requires_tool`、SSE 七类事件，见 `docs/contracts/v0.1.1/`）；RPC 的 JSON 命令与事件流随 Pi 内部实现变化，上层直连就要跟随 break。
2. **统一鉴权**：wrapper 单点收口多 Bearer token 轮换、内部 callback token、用户身份真源（`X-Shortdrama-User-Token` 回查 `/auth/me`）；上层直连 RPC 需各自实现一套同样强度的鉴权。
3. **统一审计**：wrapper 单点做截断指纹审计，不记提示词/参数/工具结果；上层直连 RPC 则审计纪律分散到各仓，无法保证一致。
4. **进程生命周期单点兜底**：wrapper 用 `pi --mode rpc --no-session` 启动 Pi 子进程、一轮结束即销毁，由 Agent 仓单点管理并发、超时、watchdog 与清理；上层直连 RPC 就要把子进程生命周期、并发上限、僵尸进程清理全部下沉到主仓/cli 仓。

这四条的落点都在「模型薄适配层」边界内：它们本就应该由适配层单点管理，而非分发给每个上层独立实现。RPC 本身是好的，只是它该待在 Agent 仓内部。

### SDK 的排除：事实陈述而非假设

- **GUI（main）**：宿主是非 Node 运行时，无法直接 import Pi 的 Node SDK；即便桥接，绑定 SDK 即绑定 Pi 内部 API，违背命题 A 的「上层不感知 Pi 内部事件」。
- **TUI（cli）**：CLI 仓是 Python 包，TUI 侧不承载任何 Pi 客户端运行时，也不存在「用 Node SDK 深度定制」的位置——TUI 的上层消费点定案为 pi-http-wrapper（发 HTTP 收 sync JSON/SSE），根本不落到「上层直接消费某一种 Pi 模式」这一步。
- 因此 SDK 的排除对 GUI 靠运行时事实、对 TUI 靠「不构成上游消费点」这一架构事实，均不依赖未说明的运行时假设。

### 命题 B 的充分性边界

本 ADR 的结论是「wrapper 是当前唯一满足命题 A 的落地形态」，而非「wrapper 是唯一可能的形态」。若未来出现第二个满足命题 A 的收口层（例如另一份版本化合同），它同样不违背命题 A，只需受同一「共同边界」与验收门约束即可。命题 A 是稳定公理，命题 B 是其在当前约束下的一个充分实现。

## Stable contract

字段级合同以 `docs/contracts/v0.1.1/pi-http-wrapper-takeover.md` 为准。该合同当前状态为 `implemented_pending_host_validation`（详见 `docs/validation/v0.1.1-pi-wrapper-takeover-handoff.md`：`artifact_ready_pending_fable_review_and_host_validation`），即字段级合同已实现，但真实 Pi 0.80.7 的端到端流式行为仍是部署前验证门。本 ADR 引用其字段语义作为选型依据，但把它升格为「已 validated 的稳定合同」的前提是 host validation 通过；在通过前，本 ADR 的结论停留在 `proposed`，不视为已验收：

- sync 状态只有 `completed` / `requires_tool`；
- SSE 只暴露 `meta`、`text_delta`、`thinking_delta`、`tool_call`、`usage`、`done`、`error`；
- 未知 token 或 cost 返回 `null`；
- 401/403/409/422 与协议错误不静默降级；
- 仅网络错误或 503 且尚无业务可见事件时，允许整轮切换后端。

CLI 目的地继续受 CLI ADR-0001 的受信端点清单约束。Wrapper 必须复用 CLI 包的端点真源，不接受任意 URL，也不复制第二份清单。

## Consequences

- GUI 与 TUI 可采用不同交互方式，但共享一份 Agent 产品合同。
- 模型切换只修改 Agent 适配层；上层创作意图和业务工具合同不变。
- HTTP wrapper 成为产品边界，需要版本、接入文档、认证轮换和兼容策略。当前 `pyproject.toml` 版本为 `0.3.0`；是否升号（候选 tag）由发布任务定，本 ADR 不预设，但 tag 必须与 `pyproject.toml` 版本一致后才可作为「稳定产品合同」被本 ADR 引用为 validated。
- TUI tracer 可能只需 Skill + CLI；若需改 CLI，另开 CLI Issue。
- GUI 接线需要 main 仓 Issue；本 ADR 不授权跨仓修改。

## Acceptance gate

DC 过目后才能改为 `accepted`。接受前必须：agent#3 完成 CLI 升锁；agent#4 完成端点真源复用；wrapper 接入文档与候选版本完成；至少一条 TUI 或 GUI 链路从调用方到结构化结果实通并留证据；选型矩阵（本节「为什么不选另外两种」）经受信评审，能对「为什么不是 JSON/RPC/SDK 各两种」给出可经受追问的回答，而非仅断言。

> **验收进展（2026-08-24）**：TUI→Agent 段已实通并留证据（`docs/validation/2026-08-24-pi-agent-cli-chain-trace.md`），「至少一条链路实通」一项已满足；生成能力三层定位已定案（见 §Decision → TUI）。剩余未闭项为：主站模型配置恢复（平台侧，非本仓）、DC 过目授权改 `accepted`。本 ADR 仍保留 `proposed`，等 DC 过目后流转。

### 证据与状态流转约定

- **实通证据落点**：`docs/validation/` 下新增一条 `*-trace.md` 回执（沿用现有 `2026-08-18-issue-3-cli-pin.md`、`2026-08-20-issue-4-trusted-endpoint.md` 的格式），记录调用方发起请求、Agent 执行、结构化结果返回的完整一程，含请求摘要与响应关键字段，不含明文凭据。
- **状态流转**：本 ADR 的 `status` 由 `proposed` 变为 `accepted` 仅由 DC 在过目后授权执行；单一提交内同时满足上述验收项并附上证据回执路径，方可从 `proposed` 改为 `accepted`。若被否决则记为 `rejected`，若被后续 ADR 取代则记为 `superseded`。

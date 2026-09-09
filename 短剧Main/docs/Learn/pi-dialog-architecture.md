# Pi 对话框 & 剧本拆解 — Agent 参考手册

> **文件位置**: `docs/Learn/pi-dialog-architecture.md`
> **最后更新**: 2026-08-28
> **状态**: 活跃维护，每次对话后更新
> **关联文档**: `AGENTS.md`、`docs/contracts/v0.1.1/architecture.md`、`docs/contracts/v0.1.1/model-and-paid-task.md`

---

## 会话上下文（给接手 agent）

### 用户是谁

- 正在学习这个项目的架构和代码，不是修 Bug 也不是开发新功能
- 已具备基本的 Web 开发知识（HTTP、前后端、数据库），但对这个项目的具体实现不熟悉
- 对 Pi 对话框和剧本拆解两个模块最感兴趣

### 已聊过什么

1. **剧本拆解**：两阶段流水线（Agent 循环 + Skill 拆镜）、草稿/确认分离、提示词版本化
2. **Pi 对话框整体架构**：三个仓库的关系、一条消息的完整执行路径
3. **Grill Engine**：信息充分性闸门的三层决策树、任务画像、A/B 埋点
4. **Agent 循环**：`agent.prompt()` → `agent-loop.js` 的 `runLoop()` → 模型调用 ↔ 工具执行的循环
5. **pi-http-wrapper**：为什么需要翻译层、HTTP ↔ RPC 的角色
6. **routes.ts 逐段走读**：前置检查 → Grill 预检 → Agent 组装 → SSE 流 → 启动
7. **Bug 修复**：`createAgentSession` 的 `label` 字段导致 400 错误，已修复
8. **Pi 本地运行**：配置了 `.env` 并启动了 pi-http-wrapper，但模型推理失败（转圈超时）

### 用户当前理解水平

- ✅ 理解：三个仓库的分工、Pi 对话框的调用链、Agent 循环的 while 循环逻辑
- ✅ 理解：Grill 的三层决策、routes.ts 的完整处理流程
- ⚠️ 部分理解：`createAssistantAgent` 内部的组装细节、`remotePiProvider.ts` 的具体实现
- ❌ 还没看：`runtime.ts` 的 `createAssistantAgent` 函数体、前端 `agent-stream.ts` 的归一化逻辑

### 待继续

- 用户想看 `runtime.ts` 的 `createAssistantAgent` 内部组装逻辑
- 用户想看前端 SSE 事件归一化
- 用户想理解 `agent-loop.js` 的 `streamAssistantResponse` 和 `runToolCalls` 具体实现
- 用户可能想继续调试 Pi 本地运行的问题

### 当前状态

- Pi 对话框在本地跑不起来（pi-http-wrapper 启动了但模型推理超时）
- 用户已接受"学代码不需要 Pi 跑起来"，可以继续代码走读
- 上次对话停在：应该接着看 `runtime.ts` 的 `createAssistantAgent`

### 沟通风格

- 用户偏好：一段一段代码走读，边看边讲
- 使用中文交流
- 代码文件路径完整给出，方便用户直接打开

---
# Pi 对话框 & 剧本拆解 — Agent 参考手册

> **文件位置**: `docs/Learn/pi-dialog-architecture.md`
> **最后更新**: 2026-08-28
> **状态**: 活跃维护，每次对话后更新
> **关联文档**: `AGENTS.md`、`docs/contracts/v0.1.1/architecture.md`、`docs/contracts/v0.1.1/model-and-paid-task.md`

---

## 快速定位表

| 想看什么 | 去哪个文件 | 搜什么 | 行号 |
|---|---|---|---|
| 用户发消息 → 完整处理流程 | `src/modules/assistant/routes.ts` | `app.post("/api/v1/agent/sessions/:session_id/messages"` | ~265 |
| Agent 组装 | `src/modules/assistant/runtime.ts` | `createAssistantAgent` | ~30 |
| 系统提示词 | `src/modules/assistant/runtime.ts` | `assistantSystemPrompt` | ~180 |
| 5 个工具定义 | `src/modules/assistant/tools.ts` | `ASSISTANT_TOOL_NAMES` | ~10 |
| 工具实现 | `src/modules/assistant/services.ts` | `createAssistantToolServices` | ~15 |
| Agent 循环（库代码） | `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` | `async function runLoop` | — |
| Agent 类（库代码） | `node_modules/@earendil-works/pi-agent-core/dist/agent.js` | `class Agent` | — |
| 远程 Pi 调用 | `src/modules/assistant/remotePiProvider.ts` | `class RemotePiProvider` | ~50 |
| Grill 引擎入口 | `src/modules/assistant/grill/engine.ts` | `class GrillEngineImpl` | ~50 |
| Grill 规则预检 | `src/modules/assistant/grill/rule_precheck.ts` | `rulePreCheck` | ~40 |
| Grill 任务画像 | `src/modules/assistant/grill/profiles.ts` | `getTaskProfile` | ~80 |
| 会话/消息持久化 | `src/modules/assistant/repository.ts` | `class AssistantRepository` | ~40 |
| 前端 SSE 归一化 | `frontend/.../src/agent-stream.ts` | `mapAgentStreamFrame` | ~30 |
| 前端聊天 UI | `frontend/.../src/pages/material-agent-page.tsx` | `MaterialAgentPage` | — |
| 前端 API 调用 | `frontend/.../src/api.ts` | `createAgentSession` / `streamAgentMessage` | ~2729 |
| 剧本拆解编排 | `src/modules/script-breakdown/service.ts` | `class ScriptBreakdownService` | ~100 |
| 拆解 Agent 循环 | `src/modules/script-breakdown/agent/runner.ts` | `runBreakdownAgent` | — |
| 拆解工具定义 | `src/modules/script-breakdown/agent/tools.ts` | `BREAKDOWN_TOOL_NAMES` | ~20 |
| 拆解工作台 | `src/modules/script-breakdown/agent/workspace.ts` | `class BreakdownWorkspace` | ~80 |
| 拆解阶段② Skill | `src/modules/script-breakdown/storyboard-skill.ts` | `STORYBOARD_SKILL_TEXT` | ~20 |
| AI 模型适配层 | `src/modules/ai/` | `routedCompletionProvider` / `colCompletionProvider` | — |
| Pi 运行时 wrapper | `../中文/zhongwen-shortdrama-agent/pi-http-wrapper/` | `server.py` | — |
| CLI 工具 | `../中文/zhongwen-shortdrama-cli/` | `README.md` | — |

---

## 仓库关系图

```
zhongwen-shortdrama-agent (Agent 底座仓, Python)
  ├─ pi-http-wrapper/     ← HTTP 服务，包装 pi --mode rpc
  └─ agent_resources/     ← Pi 的 Skill 和 Prompt
       │
       │ HTTP (RemotePiProvider)
       ▼
COL-RAG-INGEST-CO (主仓, TypeScript/Node.js)
  ├─ src/modules/assistant/     ← Pi 对话框模块
  ├─ src/modules/script-breakdown/ ← 剧本拆解模块
  ├─ src/modules/ai/            ← 模型适配层
  ├─ frontend/                  ← React 前端
  └─ docs/Learn/                ← 本文件
       │
       │ HTTP (API 调用)
       ▼
zhongwen-shortdrama-cli (CLI 仓, Python)
  └─ 命令行工具，也被 Agent 仓 import 为库回调主站
```

---

## 数据流：一条消息从发到收

```
[浏览器] POST /api/v1/agent/sessions/:id/messages  { content: "你好" }
     │
     ▼
[routes.ts] parseRequest(messageSchema) → Zod 校验
     │
     ├─ 前置检查: 认证 / 并发互斥 / 频率限制 / 运行时配置
     │
     ├─ Grill 预检 (GRILL_ENABLED=true 时):
     │    ├─ registration profile → 新用户无偏好 → 引导收集
     │    └─ content_creation profile → 有项目 → 检查信息充分性
     │         ├─ clarify → 直接 SSE 返回反问，不调模型
     │         ├─ offer_candidates → 直接 SSE 返回候选
     │         └─ execute/pending_confirmation → 放行
     │
     ├─ createAssistantAgent():
     │    ├─ systemPrompt (角色边界 + 用户偏好)
     │    ├─ model (RemotePiProvider)
     │    ├─ tools (5 个)
     │    ├─ messages (历史消息)
     │    ├─ beforeToolCall (配额 ≤4 + Grill 二次拦截)
     │    └─ afterToolCall (候选卡片注入)
     │
     ├─ agent.prompt("你好")
     │    └─ [agent-loop.js] runLoop():
     │         while (hasMoreToolCalls) {
     │           ① streamFn() → RemotePiProvider → HTTP → pi-http-wrapper → pi --mode rpc
     │           ② 模型返回 { text?, toolCalls? }
     │           ③ 有 toolCalls → runToolCalls():
     │               prepareToolCall → beforeToolCall → tool.execute → afterToolCall
     │           ④ 工具结果追加到 context.messages → 回到 ①
     │         }
     │
     ├─ agent.subscribe() → SSE 事件流:
     │    ├─ text_delta → 打字机效果
     │    ├─ tool_start/tool_end → 工具调用展示
     │    ├─ card_delta → Grill 候选卡片
     │    └─ message_end → 持久化到 agent_messages 表
     │
     └─ send("[DONE]")
```

---

## 关键常量

| 常量 | 位置 | 值 | 含义 |
|---|---|---|---|
| `requestDeadlineMs` | `routes.ts` | 90_000 | 单次请求超时 90 秒 |
| `maxGlobalRequests` | `routes.ts` | 8 | 全局并发上限 |
| `maxRequestsPerUser` | `routes.ts` | 2 | 单用户并发上限 |
| `maxRequestsPerMinute` | `routes.ts` | 30 | 频率限制 |
| `MAX_TOOL_CALLS` | `script-breakdown/service.ts` | 600 | 拆解工具调用上限 |
| `MAX_TURNS` | `script-breakdown/service.ts` | 60 | 拆解模型轮次上限 |
| `PROMPT_VERSION` | `script-breakdown/types.ts` | `"script-breakdown.v11"` | 拆解提示词版本 |
| `SCENES_MAX` | `script-breakdown/schemas.ts` | — | 单集最大场次数 |
| `ASSETS_PER_KIND_MAX` | `script-breakdown/schemas.ts` | — | 每类资产最大数量 |
| `STAGE_HEARTBEAT_INTERVAL_MS` | `script-breakdown/service.ts` | 60_000 | 阶段②心跳间隔 |

---

## 关键环境变量

| 变量 | 用途 | 敏感 |
|---|---|---|
| `AI_GATEWAY_ENABLED` | Pi 对话框总开关 | 否 |
| `PI_REMOTE_API_URL` | pi-http-wrapper 地址 | 否 |
| `PI_REMOTE_API_TOKEN` | pi-http-wrapper 认证令牌 | **是** |
| `PI_REMOTE_MODEL` | Pi 模型标识 | 否 |
| `GRILL_ENABLED` | Grill Engine 开关 | 否 |
| `ARK_API_KEY` | Ark 模型 API 密钥 | **是** |

配置位置：本地 `.env`、生产 K8s ConfigMap（非敏感）+ KMS（敏感）。

---

## 中英术语对照

| 中文 | 英文（代码标识符） | 位置 |
|---|---|---|
| 助手/Pi 对话框 | assistant / Agent | `src/modules/assistant/` |
| 会话 | session | `agent_sessions` 表 |
| 消息 | message | `agent_messages` 表 |
| 工具 | tool | `tools.ts` |
| 系统提示词 | systemPrompt | `runtime.ts` |
| 流式事件 | SSE (Server-Sent Events) | `routes.ts` `send()` |
| 信息充分性闸门 | Grill Engine | `src/modules/assistant/grill/` |
| 规则预检 | rulePreCheck | `grill/rule_precheck.ts` |
| 反问 | clarify | `GrillCheckResult.action` |
| 候选 | candidates | `GrillCheckResult.action` |
| 待确认 | pending_confirmation | `GrillCheckResult.action` |
| 剧本拆解 | script breakdown | `src/modules/script-breakdown/` |
| 场次 | scene | `SceneDivision` |
| 镜头/分镜 | shot | `ShotCandidate` |
| 资产候选 | asset candidates | `AssetCandidates` |
| 草稿 | draft | `ScriptBreakdownDraft` |
| 确认 | confirm | `confirmRun` |
| 远程 Pi | remote Pi / pi-http-wrapper | `RemotePiProvider` |

---

## 已知问题 & 修复记录

### Bug 1: 创建会话 400 错误

- **日期**: 2026-08-27
- **症状**: 在资产页面打开 AI 工作区，`POST /api/v1/agent/sessions` 返回 400
- **根因**: `frontend/.../src/app.tsx` 的 `routeContext()` 返回 `{ label: "资产面板" }`，前端 `api.ts` 的 `createAgentSession` 直接 `JSON.stringify` 整个对象，但后端 `createSessionSchema` 用了 `.strict()`，不认识 `label` 字段
- **修复**: `frontend/.../src/api.ts` 第 2729 行，在 `createAgentSession` 中解构去掉 `label`：`const { label: _, ...rest } = context;`

### 已知限制: Pi 对话框本地不可用

- **原因**: Pi 对话框需要 `pi-http-wrapper` 服务运行，它是独立部署的生产基础设施，本地开发环境通常没有
- **影响**: 学习代码不需要 Pi 跑起来，Agent 组装、工具调用、Grill 拦截等逻辑全在本地
- **替代**: Ark 模型不能替代 Pi，架构决策（ADR-0001）规定 Pi 对话框只走 Pi

---

## 架构约束（不可绕过）

1. **Pi 对话框 = Pi**：不能用 Ark 或其他模型直连替代，`runtime.ts` 和 `routes.ts` 写死了
2. **工具本地执行**：Pi 只负责"是否调工具"的决策，工具实际执行在主仓本地，审计在主仓
3. **PostgreSQL 唯一事实源**：pi-http-wrapper 不保存对话，一轮结束销毁 Pi 进程
4. **付费红线**：生成必须人点一次，不能自动提交
5. **草稿/确认分离**：AI 产出只入草稿区，`confirmRun` 才写入正式表
6. **Lite 禁硬删**：`users.ui_mode='lite'` 时禁止任何硬 `DELETE`，允许项目内可逆操作

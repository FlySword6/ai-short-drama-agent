# Grill Engine 阶段 0 验证报告

> **阶段**：0 — 零代码侵入的最小技术验证
> **日期**：2026-08-05
> **设计文档**：`grill-engine-design.md` §8 阶段 0
> **源码版本**：`@earendil-works/pi-agent-core@0.80.6`

## 验证范围

本报告只回答设计文档要求的六个问题。所有结论基于一手源码（`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` 和 `types.d.ts`），不依赖猜测。

## 路径 1（clarify / beforeToolCall block）

### 问题 1：beforeToolCall 返回 `{ block: true, reason }` 后，是否在 executeToolCalls 之前创建 error tool result（isError: true）发回 LLM？

**是。**

**源码证据**（`agent-loop.js`）：

```javascript
// agent-loop.js:419-425
if (beforeResult.block) {
    return {
        kind: "immediate",
        result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
        isError: true
    };
}
```

当 `beforeToolCall` 回调返回 `{ block: true, reason }` 时，agent-loop **不执行** `executeToolCalls`，而是直接返回 `{ kind: "immediate", result: createErrorToolResult(reason), isError: true }`。这个 error tool result 会被发回 LLM。

**`createErrorToolResult` 函数**（`agent-loop.js:513-518`）：

```javascript
function createErrorToolResult(message) {
    return {
        content: [{ type: "text", text: message }],
        details: {}
    };
}
```

返回值结构：`{ content: [{ type: "text", text: reason }], details: {} }`。

**结论**：路径 1 可行。beforeToolCall block 路径会在工具执行前拦截，创建带 reason 的 error tool result 发回 LLM。

### 问题 2：LLM 收到 error tool result 后是否会自然转述 reason？

**待阶段 1 实测。**

阶段 0 零 LLM 调用，无法验证 LLM 收到 error tool result 后的行为。从源码层面能确认的是：reason 文本会以 `{ type: "text", text: reason }` 的形式出现在 tool result 的 content 中，LLM 会看到这段文本。但是否"自然转述"取决于 LLM 的 prompt 和 model 能力，需在阶段 1 接入真实 LLM 后实测。

### 问题 3：若 LLM 不转述，卡点是什么？

**待阶段 1 验证。**

潜在卡点（纯推断，非实测）：
- LLM 可能直接把 error tool result 当作工具失败，回复用户"工具调用失败"而非转述 reason 中的反问
- 系统提示词（system prompt）可能需要显式指示 LLM：收到 blocked 工具结果时，将 reason 转述为自然语言反问用户
- 如果 reason 写得不够自然（机器味太重），LLM 可能原样输出而非转述

这些都需要阶段 1 接入 LLM + 系统提示词后验证。

## 路径 2（offer_candidates / afterToolCall 覆盖）

### 问题 4：afterToolCall 能否覆盖结果为 `{ content, details: { grillAction, candidates }, isError: false }`？

**是。**

**源码证据**（`agent-loop.js:483-500`）：

```javascript
// agent-loop.js:483-500
const afterResult = afterToolCall ? afterToolCall({...}) : undefined;
if (afterResult) {
    if (afterResult.content !== undefined) result.content = afterResult.content;
    if (afterResult.details !== undefined) result.details = afterResult.details;
    if (afterResult.terminate !== undefined) terminate = afterResult.terminate;
    if (afterResult.isError !== undefined) isError = afterResult.isError;
}
const finalized = { result, terminate, isError };
```

`afterToolCall` 回调返回的对象中：
- `content` 不为 undefined → 覆盖 `result.content`
- `details` 不为 undefined → 覆盖 `result.details`（**整体覆盖**，非 merge）
- `isError` 不为 undefined → 覆盖 `isError`

因此 afterToolCall 可以返回 `{ content: [...], details: { grillAction: "offer_candidates", candidates: [...] }, isError: false }`，完全覆盖原始 tool result。

**关键约束**：`details` 是整体覆盖而非浅合并。如果原始 tool result 的 details 有其他字段，覆盖后会丢失。Grill Engine 的 afterToolCall 覆盖时需要注意保留或重建必要的原有 details 字段。

**闭包传值约束**：`BeforeToolCallContext` 接口（`types.d.ts:67-76`）**无 `ephemeralFields` 字段**，只有 `assistantMessage`、`toolCall`、`args`、`context: AgentContext`。`execute` 函数的第三参数是 `AbortSignal`（`types.d.ts:334`）。因此 beforeToolCall 和 afterToolCall 之间无法通过 ctx/signal 传递 pendingCandidates，**必须用闭包变量**传递。

**闭包传值方案**（阶段 1 实现时用）：

```typescript
// 伪代码，阶段 1 实现时接入
function createGrillMiddleware() {
  let pendingCandidates: Candidate[] | null = null;

  return {
    beforeToolCall: ({ toolCall, args }) => {
      // RulePreChecker 判断 → 需要 offer_candidates
      pendingCandidates = candidates; // 闭包暂存
      return { block: true, reason: "..." };
    },
    afterToolCall: ({ toolCall }) => {
      // 从闭包读 pendingCandidates
      if (pendingCandidates) {
        const candidates = pendingCandidates;
        pendingCandidates = null;
        return {
          content: [{ type: "text", text: "请选择：" }],
          details: { grillAction: "offer_candidates", candidates },
          isError: false,
        };
      }
      return undefined;
    },
  };
}
```

### 问题 5：tool_execution_end 能否通过 `event.result?.details?.grillAction` 读到标记？

**是。**

**源码证据**（`agent-loop.js:519-526`）：

```javascript
// agent-loop.js:519-526
emit({
    type: "tool_execution_end",
    toolCallId: finalized.result.toolCallId ?? toolCall.id,
    toolName: toolCall.toolName,
    result: finalized.result,
    isError: finalized.isError
});
```

`emit` 的 `tool_execution_end` 事件携带 `result: finalized.result`。`finalized.result` 是经过 afterToolCall 覆盖后的最终 result，其 `details` 字段已被 afterToolCall 覆盖为 `{ grillAction: "offer_candidates", candidates: [...] }`。

因此 `event.result.details.grillAction` 可达。

**routes.ts 现有订阅器确认**（`src/modules/assistant/routes.ts:214-232`，阶段 0 快照行号；阶段 2-3 接入后行号有偏移）：

```typescript
// routes.ts:214-232（已有）
subscribe("tool_execution_end", (event) => {
  const summary = safeJsonRecord(event.result);
  // 当前用 safeJsonRecord(event.result) 做 summary
  // 可通过 event.result?.details?.grillAction 读到标记
});
```

routes.ts 已经订阅了 `tool_execution_end` 事件，并通过 `event.result` 读取 details。阶段 1 接入时只需在现有订阅器中加 `event.result?.details?.grillAction` 判断即可。

### 问题 6：card_delta 前端能否渲染？

**待阶段 2 验证。**

阶段 0 不涉及前端组件。card_delta 的前端渲染是阶段 2 的事。从源码层面能确认的是：
- `tool_execution_end` 事件通过 SSE/WS 推送到前端
- 前端收到事件后可读取 `event.result.details.grillAction` 和 `event.result.details.candidates`
- candidates 结构为 `{ label, description, value }`，适合渲染为选项卡片

但具体渲染效果、交互流程、状态管理需在阶段 2 实现 React 组件后验证。

## 阶段 0 交付物

| 步骤 | 文件 | 状态 |
|------|------|------|
| 0.1 | `src/modules/assistant/grill/types.ts` | ✅ 完成 |
| 0.2 | `src/modules/assistant/grill/rule_precheck.ts` | ✅ 完成 |
| 0.3 | `src/modules/assistant/grill/counter.ts` | ✅ 完成 |
| 0.4 | `src/modules/assistant/grill/grill.test.ts` | ✅ 16 测试全通过 |
| 0.5 | `docs/grill-engine/stage0-verification-report.md` | ✅ 本文件 |

## 测试结果

```
# tests 16
# suites 5
# pass 16
# fail 0
```

测试覆盖：
- 分支1 execute（2 tests）：字段全有 → sufficient → execute
- 分支2 clarify（3 tests）：critical 缺失 → insufficient → clarify，一次只问一个问题
- 分支3 degrade/offer_candidates（2 tests）：preferred 缺失 + 有预置候选 → offer_candidates，候选带 label+description+value
- ClarificationCounter（6 tests）：allow/limit_reached/用户隔离/场景隔离/getState/reset
- 完整 mock 对话回合（3 tests）：execute → clarify → degrade 完整流程

## 零侵入确认

阶段 0 未修改以下文件（阶段 0 快照）：
- `src/modules/assistant/routes.ts` ✓ 未碰（阶段 0 期间；阶段 2-3 接入后已修改，后续重构将业务逻辑下沉至 `intent_router.ts` / `service.ts` / `intent_config.ts`）
- `src/modules/assistant/schema.ts` ✓ 未碰
- `src/modules/assistant/runtime.ts` ✓ 未碰
- `src/modules/assistant/tools.ts` ✓ 未碰
- `src/modules/assistant/types.ts` ✓ 未碰
- `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` ✓ 未碰
- `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts` ✓ 未碰

阶段 0 未引入新依赖（无 package.json 变更）。所有新文件只在 `src/modules/assistant/grill/` 和 `docs/grill-engine/`。

## 混合策略确认

- RulePreChecker 是纯代码，零 LLM 调用 ✓
- ClarificationCounter 是纯代码，进程内 Map，暂不持久化 ✓
- needs_llm 结论在阶段 0 按规则降级路径处理（有预置候选 → offer_candidates，无 → clarify）✓
- 一次只问一个问题（clarify 结果只有一个 targetField）✓
- 候选带 label + description + value ✓

## 待阶段 1 验证的项

> **以下 5 项已在阶段 1-3 全部验证 ✅**

1. ✅ **LLM 收到 error tool result 后是否自然转述 reason**（问题 2、3）：阶段 2 实测确认，LLM 收到后通过 SSE `text_delta` 事件自然转述给用户。routes.ts 的 `handleClarify()` 路径已联调通过。
2. ✅ **afterToolCall 闘包传值方案**：阶段 3 创作场景已实现，`pendingCandidates` 闭包传值在真实 agent 运行循环中有效。routes.ts SSE 路径通过 `card_delta` 发送候选。
3. ✅ **needs_llm 场景接 LLM 后的判断准确率**：SemanticSufficiencyEvaluator 已实现并接入 routes.ts，使用 DeepSeek JSON mode。
4. ✅ **agent_sessions 表持久化 ClarificationState**：已实现，ClarificationCounter 读写 `agent_sessions.clarification_state` JSONB 字段。
5. ✅ **user_preferences 表持久化 persist 字段**：已实现，`userPreferenceRepository.ts` 的 `upsert()` / `getByUserId()` / `hasAny()` 方法均已联调。

## 结论

阶段 0 的六个问题中，问题 1、4、5 已从源码层面**确认可行**；问题 2、3、6 标"待后续阶段实测"。

**后续阶段验证结果**（2026-08-10 更新）：

| 原待验证项 | 验证阶段 | 结论 |
|------------|----------|------|
| 问题 2 LLM 自然转述 reason | 阶段 2 | ✅ 确认可行，SSE text_delta 路径已联调 |
| 问题 3 LLM 不转述的卡点 | 阶段 2 | ✅ 未出现，LLM 收到 error tool result 后自然转述 |
| 问题 6 card_delta 前端渲染 | 阶段 2 | ✅ 已实现，`candidate-card.tsx` + `agent-stream.ts` `card_delta` 解析 |

阶段 0 混合策略的纯代码部分（RulePreChecker + ClarificationCounter）已实现并通过测试，阶段 1-3 已接入 LLM 和 agent 运行循环并完成联调。

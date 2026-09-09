# 追问引擎（Grill Engine）设计文档

> 卡片标题：信息不足时反问，而不是拿默认值糊过去
> 提出人：东丞　|　提出日期：2026-07-26
> 关联：剧本拆解 #34（向编剧追问 + 给多个候选，同一能力两个场景）
> 版本判属：v0.2.x（注册期）+ v0.3.0（创作/拆解期）　|　当前仓库：v0.1.1

---

## 一、问题陈述

当前 agent 在信息不足时会**静悄悄取默认值**往下走，导致：
1. 生成结果不是用户想要的；
2. 用户不知道为什么结果是这样；
3. 无法收集到用户的个性化信息并复用。

**目标行为**：信息不足时先反问补全，再执行；反问有次数上限，问不出来就降级到给候选让人挑，绝不变成让用户填表。

---

## 二、核心能力：Grill Engine

场景无关的通用能力。注册引导、创作补全是前两个使用场景，剧本拆解 #34 是第三个。三个场景各填一份 `TaskProfile` 配置接入同一引擎，不重复造轮子。

### 2.1 决策流程（混合策略）

```
用户消息 + 会话上下文
      │
      ▼
GRILL_ENABLED 开关 ── 关闭 ──▶ 走原默认值路径（行为不变）
      │ 开启
      ▼
规则预检器（零 LLM）
  · 按 FieldSpec 检查 critical 字段是否存在
  · critical 全有 + preferred 全有 → 充分
      │
      ├─ 规则能定论（充分）─▶ 执行
      │
      │ 不能定论
      ▼
LLM 语义充分性判断（1 次 LLM，记账）
  · preferred 字段能否从上下文语义推断
      │
      ├─ 充分 ─▶ 执行 + 写 user_preferences 表
      │
      │ 不充分
      ▼
反问生成器（1 次 LLM，只问 1 个字段）
      │
      ▼
计数 ≤ N? ── 未达上限 ──▶ 回复用户 → 重新评估
      │
      │ 达上限
      ▼
候选降级（profile 预置候选为主，零 LLM）
  · 给 2~4 个候选让人挑
      │
      ▼
执行 + absorb（规则抽取 + LLM 兜底）+ 写库
```

**创作场景的回复用户输出路径（混合）：**
- **clarify 分支**（最常见）：beforeToolCall block → error tool result → LLM 收到后自然转述给用户（可能重新措辞，像对话）
- **offer_candidates 分支**（降级）：beforeToolCall 闭包暂存候选 → afterToolCall 覆盖结果为带 `grillAction` 标记的非 error 结果 → routes.ts tool_execution_end 提取 `event.result.details` → 发 `card_delta`
- 两条路径都不阻止循环控制流，不需要 shouldStopAfterTurn

### 2.2 五个核心组件（混合实现）

| 组件 | 实现策略 | LLM 调用 | 备注 |
|------|----------|---------|------|
| **RulePreChecker** | 纯代码：按 FieldSpec 的 required/priority/exists 检查 | 0 | critical 缺失直接判不充分，preferred 缺失交 LLM |
| **SemanticSufficiencyEvaluator** | LLM JSON mode：判断 preferred 字段能否从上下文语义推断 | 1 | 仅规则无法定论时调用；写入 agent_messages 记账 |
| **ClarificationGenerator** | LLM 生成 1 个聚焦问题 | 1 | 只问 priority 最高且未收集的字段 |
| **ClarificationCounter** | 纯代码：读 agent_sessions.clarification_state 计数 | 0 | 跨回合持久化，浏览器重开可恢复 |
| **CandidateGenerator** | profile 预置候选为主 + LLM 兜底 | 0（常态）/ 1（兜底） | LLM 失败时用 profile 预置候选 |
| **absorb** | 规则字段抽取 + LLM 兜底 | 0（常态）/ 1（兜底） | persist 写 user_preferences 表；ephemeral 写会话 context |

**成本估算**（一次不充分回合，最坏路径）：
- 规则预检：0 次 LLM
- 语义判断：1 次 LLM（~1-3s 延迟）
- 反问生成：1 次 LLM（~1-3s 延迟）
- absorb：0-1 次 LLM（规则能抽取则 0）
- **合计：2~3 次 LLM 调用**，且充分回合只走规则预检 = **0 次 LLM**

### 2.3 关键设计原则

1. **规则优先，LLM 兜底**——能用代码判断的不用 LLM，降低成本和延迟。
2. **一次只问一个问题**——不变成填表。
3. **反问有次数上限**——默认 N=2~3，按场景可配，达上限立即降级到候选。
4. **候选要具体可挑**——"写实电影感/二次元/水墨国风"，不是"请补充描述"。
5. **收集的信息要回流**——persist 写 user_preferences 表，下次直接读，不重复问。
6. **反问要自然**——像对话不像表单，带"我先按 X 来，你看着改"的兜底。

---

## 三、共享接口契约

> **注意**：以下为设计契约。运行时真源是 `src/modules/assistant/grill/types.ts`，以下与实现保持同步。

```typescript
// 场景配置
interface TaskProfile {
  taskType: 'registration' | 'content_creation' | 'script_breakdown';
  requiredFields: FieldSpec[];
  maxClarifications: number;          // 反问次数上限，默认 2
  maxTotalRounds: number;             // 总交互轮次上限，默认 6
  maxSubjectDepth: number;            // 主题细化深度上限，默认 2（防止无限递归）
  candidateCount: number;             // 候选数量，默认 3
  fallbackCandidates?: Record<string, Candidate[]>; // 按 fieldName 分组的预置兜底候选
}

interface FieldSpec {
  name: string;
  description: string;
  priority: 'critical' | 'preferred';  // critical=缺了必须问；preferred=可默认/可推断
  defaultValue?: unknown;
  usage: 'persist' | 'ephemeral';      // persist=写 user_preferences 表；ephemeral=写会话
  extractor?: 'regex' | 'enum' | 'llm'; // absorb 抽取策略，默认 llm 兜底
  knownEnums?: string[];                // enum 字段的有效枚举值列表；有此属性的字段不接受原文兜底
}

// 字段来源标记：区分用户提供 vs 引擎推断 vs 默认值
type FieldSource = 'user' | 'inferred' | 'default';

// Grill Engine 入口（agent 运行循环的编排层，非工具）
interface GrillEngine {
  check(profile: TaskProfile, intent: string, ctx: ConversationContext, opts?: { isVague?: boolean }): Promise<GrillCheckResult>;
  absorb(profile: TaskProfile, answer: string, targetField: string, ctx: ConversationContext): Promise<{
    extracted: unknown, updatedCtx: ConversationContext
  }>;
}

// check() 返回的动作
type GrillCheckResult =
  | { action: 'execute' }
  | { action: 'pending_confirmation'; summary: string; collectedFields: string[] }
  | { action: 'clarify'; question: string; targetField: string }
  | { action: 'offer_candidates'; candidates: Candidate[]; targetField: string }
  | { action: 'best_inference'; summary: string; collectedFields: string[] };

// 会话上下文（扩展 AssistantContext）
interface ConversationContext {
  userId: string;
  projectId?: string;
  shotId?: string;
  // 反问状态
  clarificationState?: {
    count: number;
    totalRounds: number;             // 总交互轮次（跨字段累计）
    subjectDepth: number;            // 主题字段已细化深度
    targetField?: string;
    askedFields: string[];
    lastUserInput?: string;          // 上一轮用户输入（重复输入检测）
    originalIntent?: string;         // 用户原始意图文本
  };
  // 本回合临时收集的字段
  ephemeralFields?: Record<string, unknown>;
  // 每个字段的来源标记（user/inferred/default），用于待确认输出分组
  fieldSources?: Record<string, FieldSource>;
}
```

---

## 四、数据层

### 4.1 新建 user_preferences 表

```sql
CREATE TABLE user_preferences (
  id               BIGSERIAL PRIMARY KEY,
  user_id          VARCHAR(64) NOT NULL,
  preferred_genre  VARCHAR(64),              -- 'sweet' | 'rebirth' | 'ancient'
  preferred_tone   VARCHAR(64),              -- 'hot_blooded' | 'healing' | 'suspense'
  style_tags       TEXT[],                   -- 风格标签数组
  metadata         JSONB DEFAULT '{}',       -- 含 user_role 等扩展字段
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);
CREATE INDEX idx_user_prefs_user ON user_preferences(user_id);
```

> **注意**：实际实现使用列式存储而非 EAV 模型。`user_role` 存于 `metadata.user_role`。详见 `src/modules/assistant/grill/userPreferenceRepository.ts`。

- `usage: persist` 的字段写这里
- 读取：`repository.getUserPreference(userId, fieldName)`
- 写入：`repository.upsertUserPreference(userId, fieldName, value, 'grill')`
- 走 PostgreSQL 稳定接口，符合架构边界要求

### 4.2 扩展 agent_sessions 表

```sql
ALTER TABLE agent_sessions
  ADD COLUMN clarification_state JSONB DEFAULT NULL;
```

存储结构：`{ count: 2, totalRounds: 3, subjectDepth: 1, targetField: 'user_role', askedFields: ['preferred_genre', 'user_role'], lastUserInput: '...', originalIntent: '...' }`

- 解决"浏览器重开反问到一半如何恢复"
- ClarificationCounter 读写此字段

### 4.3 LLM 调用审计（复用现有 agent_messages）

现有 agent_messages 已有 `provider_cost_usd_micros` 和 `points_spent` 字段。Grill Engine 的每次 LLM 调用（SemanticSufficiencyEvaluator / ClarificationGenerator / CandidateGenerator 兜底 / absorb 兜底）都作为一条 agent_message 写入，role 标记为 `system_internal`，content 含调用的组件名和结果摘要。

### 4.4 LLM 调用成本控制（两阶段）

现有代码库有两套预算体系：
- **generation 模块**（`generation/ports.ts` 的 `budgetLimitFen` + `budget_exceeded`）：管图片/视频生成费用，不管 LLM 调用。
- **assistant 模块**：`AiCallRepository`（`src/modules/ai/repository.ts`）已存在，`ai_calls` 表（schema.ts）已有 `costFen`、`modelId`、`userId` 字段，专门记录每次 AI 调用的成本——比 `agent_messages` 更适合做 LLM 调用计数。

因此成本控制分两阶段做出来：

**阶段 A（v0.2.x）：记账 + 次数熔断**

先做记账（写 ai_calls 表），预算拦截用"每日 LLM 调用次数上限"代替金额预算。真正的金额预算需要先在合同里定义 assistant LLM 调用的计费规则。

```typescript
// 每日调用次数熔断（阶段 A）
// 计数基于 ai_calls 表：SELECT count(*) WHERE user_id = ? AND created_at >= today
async function callLLMWithGuard(userId: string, component: string, ...args) {
  const todayCount = await aiCallRepo.countCallsToday(userId);
  if (todayCount >= DAILY_LLM_CALL_LIMIT) {
    // 超次数：降级到纯规则 + profile 预置候选
    return fallbackToRules();
  }
  const result = await llmAdapter.call(...args);
  await aiCallRepo.create({
    userId,
    modelId: 'deepseek',
    costFen: result.costFen,
    component,                        // Grill Engine 哪个组件调的
    durationMs: result.durationMs,
  });
  return result;
}
```

**阶段 B（合同定义计费规则后）：金额预算**

```typescript
// 金额预算拦截（阶段 B，需先在合同定义 assistant LLM 调用计费规则）
async function callLLMWithBudgetCheck(userId, component, ...args) {
  const remaining = await budgetRepo.getRemainingLLMBudget(userId);
  if (remaining < ESTIMATED_COST) {
    return fallbackToRules();
  }
  // ... 同上
}
```

不与 generation 模块的预算体系耦合——各自独立。

---

## 五、触发机制

### 5.1 注册引导触发

在 routes.ts 对话循环的首回合检测：

```typescript
// routes.ts - 对话循环入口
if (isNewSession || isFirstTurn) {
  const hasPrefs = await userPrefRepo.hasAnyPreference(userId);
  if (!hasPrefs && featureFlag.GRILL_ENABLED) {
    const result = await grillEngine.check(registrationProfile, intent, ctx);
    if (result.action === 'clarify') {
      // 作为 text_delta 发送问题，暂停后续执行
      return sendClarification(result.question);
    }
  }
}
```

### 5.2 创作补全触发（混合路径）

Agent Core 源码时序分析排除了两个方案：
- ❌ `message_end` 订阅器的 `return` 只退出回调，不阻止 `runLoop` 继续走到 `executeToolCalls`——工具照常执行。
- ❌ `shouldStopAfterTurn` 在 `executeToolCalls` 之后（line 150）才检查，工具已执行完，阻止的是下一轮 LLM 调用，不是当前轮工具执行。

采用**混合路径**：clarify（最常见）走 beforeToolCall block，offer_candidates（降级）走工具内部标记。

**路径 1：clarify 分支 → beforeToolCall block**

源码验证表明 block 后流程是：`beforeToolCall` 返回 `{ block: true, reason }` → Agent Core 创建 error tool result（`isError: true`，content 是 reason 文本）→ 发回给 LLM → LLM 自然地把 reason 转述给用户（可能重新措辞，反而更自然）。这恰好是反问想要的效果。

```typescript
// agent config - beforeToolCall
config.beforeToolCall = async (ctx) => {
  if (ctx.toolName === 'prepare_generation_card' && featureFlag.GRILL_ENABLED) {
    const result = await grillEngine.check(contentCreationProfile, intent, ctx);
    if (result.action === 'clarify') {
      // block → error tool result → LLM 收到后自然转述给用户
      return { block: true, reason: result.question };
    }
    // offer_candidates 见路径 2
  }
};
```

局限：error tool result 是纯文本，无法携带结构化候选数据（card_delta）。但 clarify 分支只需纯文本问题，足够。

**路径 2：offer_candidates 分支 → afterToolCall 覆盖结果 + routes.ts 提取**

候选需要结构化数据，不能走 block 路径。用闭包变量在 beforeToolCall 暂存候选，工具正常执行后，afterToolCall 覆盖结果为带 `grillAction` 标记的非 error 结果，routes.ts 的 tool_execution_end 提取并发 card_delta。

BeforeToolCallContext 没有 ephemeralFields 字段，execute 第三参数是 AbortSignal 不是自定义上下文——不能用 ctx/signal 传值。afterToolCall 的 AfterToolCallResult 接口（types.d.ts:56-64）支持覆盖 content、details、isError、terminate。

```typescript
// 闭包变量传递 check 结果
let pendingCandidates: Candidate[] | null = null;

config.beforeToolCall = async (ctx) => {
  if (ctx.toolName === 'prepare_generation_card' && featureFlag.GRILL_ENABLED) {
    const result = await grillEngine.check(contentCreationProfile, intent, ctx);
    if (result.action === 'clarify') {
      return { block: true, reason: result.question };
    }
    if (result.action === 'offer_candidates') {
      pendingCandidates = result.candidates; // 闭包暂存
    }
    // action === 'execute' → 放行
  }
};

config.afterToolCall = async (ctx, signal) => {
  if (pendingCandidates) {
    const candidates = pendingCandidates;
    pendingCandidates = null;
    return {
      content: [{ type: 'text', text: '请从以下选项中选择：' }],
      details: { grillAction: 'offer_candidates', candidates },
      isError: false,
    };
  }
};
```

```typescript
// routes.ts - tool_execution_end 处理器
agent.subscribe('tool_execution_end', (event) => {
  if (event.result?.details?.grillAction === 'offer_candidates') {
    send({ type: 'text_delta', delta: '请从以下选项中选择：' });
    send({ type: 'card_delta', candidates: event.result.details.candidates });
    send({ type: 'done' });
  }
});
```

两条路径都不阻止循环控制流，不需要 shouldStopAfterTurn。用户回答反问（路径 1 的 LLM 转述，或路径 2 的候选选择）后作为新 user message 提交，下一轮 turn 中 beforeToolCall 再次检查，clarification_state 已记录上轮状态。不违反"每次请求最多 4 次工具调用"约束——Grill Engine 是编排层预检，不计入工具调用配额。

---

## 六、候选交互组件（新建）

### 6.1 后端工具定义

```typescript
// 新增工具：呈现候选给用户
{
  name: 'ask_user_question',
  description: 'Grill Engine 降级时给用户呈现候选',
  parameters: {
    candidates: [{ label: string, description: string, value: any }],
    question: string
  }
}
```

### 6.2 前端交互组件

新建前端多选卡片组件：
- 渲染 2~4 个候选，每个带 label + description
- 用户点击选中，或输入自定义答案（对应"Other"）
- 选中后作为 user message 回传，触发 absorb → 重新 check → execute

### 6.3 SSE 集成

现有 SSE 事件类型有 `text_delta`、`tool_start`、`tool_end`、`done`、`error`。新增 `card_delta` 事件类型携带候选数据，schema 与现有事件格式一致（顶层 `type` 字段 + 数据体）：

```
{ "type": "card_delta", "candidates": [{ "label": "...", "description": "...", "value": "..." }], "question": "..." }
```

前端 `mapAgentStreamFrame`（frontend/shortdrama-rag-demo 下）需同步更新解析逻辑，与 `text_delta` 同层处理。同一仓库可同步改，改动面小。

候选展示流程：先通过 `text_delta` 发送问题文本，紧接 `card_delta` 携带候选数据。前端收到后渲染交互卡片，用户选择后作为下一轮 user message 提交——不改对话协议。

---

## 七、场景 TaskProfile

### 7.1 注册引导场景（已实现）

> 运行时真源：`src/modules/assistant/grill/profiles.ts` → `registrationProfile`

```yaml
taskType: registration
maxClarifications: 2
maxTotalRounds: 6
maxSubjectDepth: 2
candidateCount: 3
requiredFields:
  - name: preferred_genre
    description: 偏好题材
    priority: critical
    usage: persist            # 写 user_preferences 表
    extractor: enum
    knownEnums: ['sweet', 'rebirth', 'ancient']  # 不接受原文兜底
  - name: user_role
    description: 用户身份（编剧/导演/制片等）
    priority: critical
    usage: persist
    extractor: llm            # 无 knownEnums，可接受原文兜底
  - name: preferred_tone
    description: 偏好调性
    priority: critical
    usage: persist
    extractor: enum
    knownEnums: ['hot_blooded', 'healing', 'suspense']
fallbackCandidates:
  preferred_genre:
    - { label: '甜宠', description: '高甜、撒糖、嗑CP', value: 'sweet' }
    - { label: '重生逆袭', description: '重生开挂、打脸爽文', value: 'rebirth' }
    - { label: '古风宫斗', description: '古代背景、权谋争斗', value: 'ancient' }
  user_role:
    - { label: '编剧', description: '我主要写剧本', value: 'screenwriter' }
    - { label: '导演', description: '我负责镜头和场面调度', value: 'director' }
    - { label: '制片', description: '我管项目推进和资源', value: 'producer' }
  preferred_tone:
    - { label: '热血打脸', description: '节奏快、反转多', value: 'hot_blooded' }
    - { label: '温馨治愈', description: '情感细腻、慢节奏', value: 'healing' }
    - { label: '悬疑烧脑', description: '反转多、逻辑密', value: 'suspense' }
```

### 7.2 创作补全场景（已实现）

> 运行时真源：`src/modules/assistant/grill/profiles.ts` → `contentCreationProfile`

```yaml
taskType: content_creation
maxClarifications: 2
maxTotalRounds: 6
maxSubjectDepth: 2
candidateCount: 3
requiredFields:
  - name: content_type
    description: 内容类型（图片/视频/文案等）
    priority: critical
    usage: ephemeral
    extractor: enum
    knownEnums: ['video', 'image', 'text']
  - name: subject_or_theme
    description: 主题或题材方向
    priority: critical
    usage: ephemeral
    extractor: llm
  - name: style_or_tone
    description: 风格或调性
    priority: critical            # 已从 preferred 提升为 critical
    usage: ephemeral
    extractor: llm
  - name: constraints
    description: 约束条件（尺寸、时长、规格等）
    priority: preferred
    defaultValue: '标准规格'
    usage: ephemeral
    extractor: llm
fallbackCandidates:
  content_type:
    - { label: '视频', description: '生成短视频片段', value: 'video' }
    - { label: '图片', description: '生成单张图片', value: 'image' }
    - { label: '文案', description: '生成文字内容', value: 'text' }
  subject_or_theme:
    - { label: '都市情感', description: '现代都市背景的恋爱/职场故事', value: 'urban_romance' }
    - { label: '古风穿越', description: '古代或穿越题材，宫斗/权谋', value: 'ancient_time_travel' }
    - { label: '悬疑推理', description: '烧脑反转，案件侦破向', value: 'mystery' }
    - { label: '热血励志', description: '逆袭成长，打脸爽文向', value: 'hot_blooded' }
  style_or_tone:
    - { label: '写实电影感', description: '冷色调，强光影', value: 'realistic_cinematic' }
    - { label: '二次元插画', description: '高饱和，柔和线稿', value: 'anime_illustration' }
    - { label: '水墨国风', description: '留白，淡彩', value: 'ink_wash' }
```

---

## 八、实现步骤（分五阶段，按版本判属）

> **实现状态总览**（2026-08-10 快照）
>
> | 阶段 | 状态 | 说明 |
> |------|------|------|
> | 阶段 0 | ✅ 已完成 | 接口定义 + 规则预检 + 计数 + profile 预置候选 + 混合路径验证 |
> | 阶段 1 | ✅ 已完成 | 全部 7 个组件实现 + 模糊词过滤 + intent_config |
> | 阶段 2 | ✅ 已完成 | registration profile + routes.ts SSE 联调 + user_preferences 持久化 + system prompt 消费 |
> | 阶段 3 | ✅ 已实现 | content_creation profile + beforeToolCall + SSE 联调；待完善：创作反问前端轮次提示/字段提示/跳过按钮 |
> | 阶段 4 | ⬜ 未开始 | 剧本拆解 #34 复用 |
>
> **架构重构**（2026-08-10）：遵循 AGENTS.md 第 3 条（HTTP 层只做认证、校验、协议转换和调用服务），将以下业务逻辑从 `routes.ts` 下沉到各自归属模块：
>
> | 原在 routes.ts | 移至 | 说明 |
> |---|---|---|
> | `confirmKeywords` + `isConfirmExecution()` | `intent_router.ts` | 确认执行判断属于意图路由 |
> | `inferSessionState()` | `intent_router.ts` | session 状态推断属于意图路由；签名改为接受 `clarificationState` 对象 |
> | `formatRoundAnnotation()` | `service.ts`（`GrillService` 方法） | 轮次标注属于业务服务层 |
> | `chatReplies` 映射表 | `intent_config.ts` → `INTENT_CONFIG.chat_replies` | 闲聊应答配置属于意图配置 |
>
> `routes.ts` 现在只做：导入 `isConfirmExecution` / `inferSessionState` / `INTENT_CONFIG.chat_replies`，调用 `grill.formatRoundAnnotation()`。

### 阶段 0：设计验证 + 最小技术验证（已完成 ✅）

**目标**：验证反问技术路径走通，不写生产代码。

| 步骤 | 内容 | 产出 |
|------|------|------|
| 0.1 | 阶段1组件接口定义（TypeScript types，不接对话循环） | `types.ts` |
| 0.2 | 规则预检器纯代码实现（FieldSpec exists/priority 检查） | `rule_precheck.ts` |
| 0.3 | ClarificationCounter 纯代码实现（进程内 Map，暂不持久化） | `counter.ts` |
| 0.4 | 在测试环境 mock 一个对话回合，验证 execute → clarify → degrade 三分支 | `grill.spec.ts` |
| 0.5 | **混合路径技术验证**：① beforeToolCall block 后 LLM 是否会把 reason 自然转述给用户（发一条测试 message，观察 LLM 回复是否包含 reason 文本）；② 工具 execute 返回带 `details.grillAction` 标记的非 error 结果后，routes.ts tool_execution_end 能否提取标记并发 card_delta | 验证报告 |

**阶段 0 验收**：零 LLM 调用下，规则预检 + 计数 + profile 预置候选能跑通三分支；混合路径两条子路径可行性确认。确认技术路径可行，再进 v0.2.x 正式实施。

---

### 阶段 1：通用引擎骨架（已完成 ✅）

| 步骤 | 内容 | 产出 |
|------|------|------|
| 1.1 | 新建 user_preferences 表迁移 + repository 方法 | migration + repo |
| 1.2 | 扩展 agent_sessions 加 clarification_state 字段 | migration |
| 1.3 | 实现 SemanticSufficiencyEvaluator（DeepSeek JSON mode，记 agent_messages） | `semantic_eval.ts` |
| 1.4 | 实现 ClarificationGenerator（LLM，约束只问 1 个字段，schema 校验） | `clarification.ts` |
| 1.5 | 实现 CandidateGenerator（profile 预置为主 + LLM 兜底） | `candidate.ts` |
| 1.6 | 实现 absorb（规则抽取优先 + LLM 兜底，persist 写 user_preferences） | `absorb.ts` |
| 1.7 | 实现 GRILL_ENABLED feature flag + 预算检查 callLLMWithBudgetCheck | `feature_flag.ts` |
| 1.8 | 单元测试：信息够/不够/问N次不清/超预算降级 四种 case | `grill.test.ts` |

---

### 阶段 2：注册引导场景（已完成 ✅）

| 步骤 | 内容 | 产出 |
|------|------|------|
| 2.1 | 编写 registration.profile.yaml（见 7.1） | profile |
| 2.2 | routes.ts 对话循环首回合检测：user_preferences 为空 → check | 内联预检 |
| 2.3 | clarify 问题作为 text_delta 发送；回答后 absorb 写 user_preferences | 接入循环 |
| 2.4 | 新建 AskUserQuestion 工具 + 前端候选卡片组件 | 新工具 + 前端 |
| 2.5 | 动态 system prompt：读 user_preferences 注入 user_role，影响话术 | prompt 组装 |
| 2.6 | 复用验证：user_role 真的影响建议方向（编剧→分镜，制片→进度） | 集成测试 |

**验收**（对应"怎么算做完"第 1 条）：
- [ ] 新用户首回合反问称呼和角色，不静默往下走
- [ ] user_role 写入 user_preferences 表，后续回合读出并影响 system prompt
- [ ] 老用户（有记录）不重复问

---

### 阶段 3：创作补全场景（已实现，前端体验待完善 🔧）

| 步骤 | 内容 | 产出 |
|------|------|------|
| 3.1 | 编写 content_creation.profile.yaml（见 7.2） | profile |
| 3.2 | beforeToolCall block（clarify 路径） + afterToolCall 覆盖结果（offer_candidates 路径） | 混合路径接入 |
| 3.3 | clarify: LLM 收 error tool result 后自然转述反问 → 用户回答 → absorb → 重新 check → 放行 | 接入循环 |
| 3.4 | offer_candidates: afterToolCall 返回 grillAction 标记 → routes.ts tool_execution_end 提取 event.result.details → card_delta | 接入循环 |
| 3.5 | A/B 埋点：GRILL_ENABLED 开关对比"结果不符合预期"比例 | 监控指标 |

---

### 阶段 4：剧本拆解 #34 复用（v0.3.0）

| 步骤 | 内容 | 产出 |
|------|------|------|
| 4.1 | 编写 script_breakdown.profile.yaml | profile |
| 4.2 | 在剧本拆解"向编剧追问"环节替换为 check | 接入流水线 |
| 4.3 | 验证 #34"给多个候选"= offer_candidates 分支，无新代码 | 复用验证 |

---

## 九、技术选型

| 组件 | 实现方式 | 备注 |
|------|----------|------|
| RulePreChecker | 纯代码：FieldSpec exists/priority 检查 | 零 LLM，零延迟 |
| SemanticSufficiencyEvaluator | DeepSeek JSON mode | 仅规则无法定论时调用；避免 Union type schema |
| ClarificationGenerator | LLM 生成，schema 校验 | 约束只问 1 个字段 |
| ClarificationCounter | 读 agent_sessions.clarification_state | 跨回合持久化 |
| CandidateGenerator | profile 预置候选为主 + LLM 兜底 | 零 LLM 常态 |
| absorb | 规则抽取（regex/enum）优先 + LLM 兜底 | persist 写 user_preferences 表 |
| 记忆持久化 | PostgreSQL user_preferences 表 | 走稳定接口 |
| 候选 UI | 新建 AskUserQuestion 工具 + 前端候选卡片 | 新建非复用 |
| 触发机制（clarify） | beforeToolCall block → error tool result → LLM 自然转述 | 最常见路径，零额外代码 |
| 触发机制（offer_candidates） | afterToolCall 覆盖结果（grillAction 标记）+ routes.ts tool_execution_end 提取 event.result.details → card_delta | 降级路径，结构化数据 |
| 成本控制 | GRILL_ENABLED flag + 次数熔断 + ai_calls 记账 | 超限降级纯规则 |
| 延迟控制 | 规则预检零延迟 | 充分回合不触发 LLM |

---

## 十、风险与对策

| 风险 | 严重度 | 对策 |
|------|--------|------|
| LLM 调用成本（每次不充分回合 2~3 次） | 高 | 混合策略：充分回合 0 次 LLM；次数熔断超限降级纯规则；ai_calls 记账 |
| 创作触发的工具执行时序 | 高 | 已解决：clarify 走 beforeToolCall block（时序正确，工具不执行）；offer_candidates 走 afterToolCall 覆盖结果（AfterToolCallResult 支持 content/details/isError，已验证接口） |
| SemanticSufficiencyEvaluator 延迟（1~3s） | 中 | 规则预检先过，仅规则无法定论才调 LLM；充分回合无延迟 |
| AskUserQuestion 工具需新建 | 高 | 阶段2新建工具+前端组件 |
| 记忆持久化机制需新建 | 高 | 新建 user_preferences 表 + repository，走 PostgreSQL 稳定接口 |
| 反问打断对话节奏 | 中 | maxClarifications 创作场景压到 2；每次带"我先按 X 来"兜底；GRILL_ENABLED 可关 |
| 候选质量不稳定 | 中 | profile 预置兜底候选，LLM 失败时 fallback |
| persist 写了但没复用 | 高 | 阶段2.6强制复用验证，user_role 必须影响 system prompt |
| DeepSeek JSON schema 兼容 | 中 | 避免 Union type schema；用扁平 JSON；阶段1.3验证 |
| 版本范围 | 高 | 阶段0零侵入验证；阶段1-2落 v0.2.x；阶段3-4落 v0.3.0 |
| 与 #34 耦合 | 低 | 阶段4前完全独立，#34 只读 profile |

---

## 十一、验收清单（对应"怎么算做完"）

> **当前状态**（2026-08-10）

- [x] **1. 注册时引导提问**，收得到个性化信息，且后续真的被用上
  - ✅ user_preferences 表有记录（preferred_genre/preferred_tone/user_role）
  - ✅ system prompt 读出偏好影响话术（`buildAssistantSystemPrompt()` 消费 user_preferences）
  - ✅ 老用户（有记录）不重复问（`hasAnyPreference()` 检查）
  - 🔧 待补：注册引导前端 UI（第 2 批）→ 注册 → 引导页 → 收集 3 字段 → 跳 /projects
- [x] **2. 创作时信息不足，AI 先反问补全再执行**，不静默取默认值
  - ✅ clarify: beforeToolCall block → SSE text_delta → LLM 自然转述反问
  - ✅ offer_candidates: SSE card_delta → 候选卡片
  - ✅ GRILL_ENABLED feature flag 已接入
  - 🔧 待补：创作反问前端轮次提示/字段提示/跳过按钮（第 3 批）
- [x] **3. 反问有次数上限**，问不出来给候选让人挑，不变填表
  - ✅ maxClarifications=2 + ClarificationCounter 跨回合持久化
  - ✅ CandidateGenerator profile 预置候选
  - ✅ 前端 CandidateCard 组件已实现
- [ ] **4. 与剧本拆解 #34 共用同一引擎**，不重复造轮子
  - ⬜ 阶段 4 未开始，#34 走同一 GrillEngine + script_breakdown.profile

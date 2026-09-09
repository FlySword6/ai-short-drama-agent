# grill 引擎 · 生产级意图路由设计

> **实现状态**（2026-08-10 更新）：六层 Pipeline 全部实现 ✅
>
> - 运行时真源：`src/modules/assistant/grill/intent_config.ts`（② 特征提取 + 词典 + 配置）+ `src/modules/assistant/grill/intent_router.ts`（① 预处理 + ③ 规则匹配 + ④ 上下文层 + ⑤ 决策 + ⑥ 后处理 + `isConfirmExecution` / `inferSessionState` 导出）
> - 模糊词过滤 46 词四类（`intent_config.ts` 的 `VAGUE_WORDS`）
> - 复合句误判已修复（R5 规则：动作词优先于闲聊词）
> - 上下文感知已实现（session 状态：idle / clarifying / pending_confirmation / executing）
> - 复合意图拆分已实现（segment_count > 1 时拆 sub_intents）
> - 配置化词典已实现，新增意图只需改 `intent_config.ts`
> - **架构重构**（2026-08-10）：`routes.ts` 中原有的 `isConfirmExecution()`、`inferSessionState()`、`formatRoundAnnotation()`、`chatReplies` 映射表已下沉到各自归属模块（`intent_router.ts` / `service.ts` / `intent_config.ts`），HTTP 层只做认证、校验、协议转换和调用服务，不承载业务逻辑（AGENTS.md 第 3 条）

## 当前实现的局限（原始问题，现已修复）

现有 intent_router.ts 基于单层关键词匹配（闲聊词 + 动作词 + 长度），存在以下问题：

1. **复合句误判**："你好，帮我生成一张图"命中闲聊关键词 → 误判为 chat，丢失任务
2. **无置信度**：非黑即白，边界模糊的输入没有降级机制
3. **无上下文感知**：grill 正在反问中时，用户回复"算了不生成了"应识别为 cancel，而非 chat
4. **无意图变更检测**：闲聊中突然出现任务，或任务中突然切换主题，没有衔接逻辑
5. **规则不可扩展**：硬编码 if-else，新增意图需改代码
6. **无多意图处理**："帮我生成图片，顺便写个文案"含两个任务，只取一个

---

## 生产级架构（六层 Pipeline）

```
输入文本
   │
   ▼
① 预处理层 ── 清洗 / 归一化 / 分段
   │
   ▼
② 特征提取层 ── 动作词 / 闲聊词 / 否定 / 疑问 / 指令词 / 长度 / 标点模式
   │
   ▼
③ 规则匹配层 ── 多规则并行打分，每条带权重 + 置信度
   │
   ▼
④ 上下文层 ── 结合 session 状态（idle/clarifying/pending_confirmation/executing）
   │
   ▼
⑤ 决策层 ── 最高置信度胜出，低于阈值走 vague 兜底
   │
   ▼
⑥ 后处理层 ── 意图变更检测 / 复合意图拆分 / 降级输出
   │
   ▼
路由结果 { intent, confidence, sub_intents[], reason }
```

---

## ① 预处理层

| 步骤 | 处理 | 说明 |
|---|---|---|
| 1.1 | trim + 全角转半角 | 统一标点符号 |
| 1.2 | 去除控制字符 | 防注入 |
| 1.3 | 超长截断 | >500 字截断到 500，标记 truncated |
| 1.4 | 分段 | 按逗号/分号/句号拆成 segments[]，用于多意图检测 |

**输出**：`{ cleaned_text, segments[], truncated }`

---

## ② 特征提取层

对 cleaned_text 和每个 segment 提取以下特征：

| 特征 | 提取方式 | 示例 |
|---|---|---|
| `has_action_verb` | 匹配动作词词典 | 生成/制作/写/画/设计/创建/做/搞/弄 |
| `action_verb` | 命中的具体动作词 | "生成" |
| `has_chat_keyword` | 匹配闲聊词词典 | 你好/谢谢/在吗/早安/晚安/拜拜 |
| `has_negation` | 匹配否定词 | 不/别/取消/算了/不要/放弃 |
| `has_question` | 疑问词或问号 | 怎么/为什么/？/吗 |
| `has_confirm` | 确认指令词 | 确认/开始生成/执行/可以了/就这样 |
| `has_cancel` | 取消指令词 | 取消/算了/不生成了/退出/结束 |
| `text_length` | 字符数 | 12 |
| `punctuation_pattern` | 标点模式 | 纯感叹号/纯问号/混合 |
| `segment_count` | 分段数 | 2 |

**词典设计**：动作词、闲聊词、否定词、确认词、取消词各一份，独立配置文件，不改代码即可扩展。

---

## ③ 规则匹配层（多规则并行打分）

每条规则独立计算，输出 `{ intent, score, weight }`，最终汇总。

| 规则 ID | 条件 | 命中意图 | 权重 | 置信度贡献 |
|---|---|---|---|---|
| R1 | has_confirm 且无动作词 | confirm | 1.0 | +0.9 |
| R2 | has_cancel 或 (has_negation + 状态=clarifying) | cancel | 1.0 | +0.9 |
| R3 | has_action_verb 且无 has_chat_keyword | task | 1.0 | +0.8 |
| R4 | has_chat_keyword 且无 has_action_verb 且 len≤20 | chat | 0.8 | +0.7 |
| R5 | has_action_verb + has_chat_keyword（复合） | task（优先） | 1.0 | +0.6 |
| R6 | 无任何特征 且 len≤15 | chat | 0.3 | +0.3 |
| R7 | 无动作词 + len>15 + 无闲聊词 | vague | 0.5 | +0.4 |
| R8 | 纯问号 + 无动作词 | chat | 0.6 | +0.5 |

**关键规则：动作词优先级高于闲聊词**（解决"你好，帮我生成一张图"被误判问题）。

**置信度计算**：`confidence = Σ(score × weight)`，归一化到 [0,1]。

---

## ④ 上下文层（session 状态感知）

路由结果不是绝对的，要结合当前 session 状态修正：

| session 状态 | 输入特征 | 修正逻辑 |
|---|---|---|
| idle | 闲聊词 | → chat（不变） |
| idle | 动作词 | → task（不变） |
| clarifying | 确认词 | → confirm（终止反问） |
| clarifying | 取消词 | → cancel（退出反问） |
| clarifying | 闲聊词 | → chat_but_in_clarifying（闲聊但不退出 grill，反问继续） |
| clarifying | 新动作词 + 与原 intent 不同 | → task_switch（主题切换，触发重置） |
| pending_confirmation | 确认词 | → confirm（执行） |
| pending_confirmation | 修正词（如"改成30秒"） | → amend（回到 clarifying 补充） |
| executing | 任意 | → 排队或忽略 |

**新增意图**：`chat_but_in_clarifying` / `task_switch` / `amend` / `cancel`

---

## ⑤ 决策层

```
1. 汇总所有规则得分，取最高置信度意图
2. 若最高置信度 < 阈值(0.5) → 走 vague 兜底
3. 上下文层修正（如 clarifying 中的闲聊不退出 grill）
4. 输出：{ intent, confidence, sub_intents[], reason, session_aware }
```

**vague 兜底**：保守当 task 处理进 grill（不丢任务），但标记 confidence 低，grill 内 check 时宽容些。

---

## ⑥ 后处理层

| 处理 | 条件 | 动作 |
|---|---|---|
| 复合意图拆分 | segment_count>1 且多个 segment 含动作词 | 拆成 sub_intents[]，主意图取第一个，其余排队 |
| 意图变更检测 | intent=task 且 session 状态=clarifying 且新 intent 与原 intent 不同 | 触发 clarificationState 重置（清已填字段+已问维度，保留 intent 更新） |
| 降级标记 | confidence<0.5 | 标记 low_confidence，grill 首轮宽容判断 |

---

## 意图枚举（完整）

| 意图 | 含义 | 路由去向 |
|---|---|---|
| `chat` | 闲聊问候 | → agent 直接回复，不进 grill |
| `chat_but_in_clarifying` | 反问中的闲聊 | → agent 回复 + grill 保持反问状态 |
| `task` | 任务指令 | → grill 反问流程 |
| `confirm` | 确认执行 | → 重置计数器 + agent 执行 |
| `cancel` | 取消任务 | → 清空 session + agent 回复"已取消" |
| `task_switch` | 切换主题 | → 重置 clarificationState + 重新进 grill |
| `amend` | 修正已确认内容 | → 回到 clarifying 补充 |
| `vague` | 意图模糊 | → 保守当 task 进 grill，标记低置信度 |

---

## 配置文件结构（intent_config.ts）

```typescript
export const INTENT_CONFIG = {
  thresholds: {
    vague: 0.5,        // 低于此置信度走 vague
    high_confidence: 0.7  // 高于此为高置信度
  },
  dictionaries: {
    action_verbs: ['生成','制作','写','画','设计','创建','做','搞','弄','剪','合成','配音','剪辑'],
    chat_keywords: ['你好','谢谢','在吗','早安','晚安','拜拜','嗨','hello','hi','thanks'],
    confirm_words: ['确认','开始生成','执行','可以了','就这样','ok','好的','行'],
    cancel_words: ['取消','算了','不生成了','退出','结束','不要了','放弃'],
    negation_words: ['不','别','不要','不用']
  },
  limits: {
    max_length: 500,
    chat_max_length: 20,
    vague_min_length: 15
  },
  rules: [
    { id: 'R1', weight: 1.0 },
    { id: 'R2', weight: 1.0 },
    // ... 可扩展
  ],
  // 闲聊应答配置（routes.ts 直接引用 INTENT_CONFIG.chat_replies[intent]）
  chat_replies: {
    chat: '...',
    chat_but_in_clarifying: '...',
    // ...
  },
  // 确认执行提示语（routes.ts 通过 getConfirmHint(taskType) 读取）
  confirm_hints: {
    registration: '...',
    content_creation: '...',
    default: '...',
  }
};
```

**设计原则**：词典和阈值全部配置化，新增意图或调整规则不改代码，只改配置。`chat_replies` 和 `confirm_hints` 也收敛在 `intent_config.ts` 中，HTTP 层（`routes.ts`）只做查表引用，不内联业务映射。

---

## 完整意图路由伪代码

```typescript
function routeIntent(input: string, session: Session): RouteResult {
  // ① 预处理
  const { cleaned, segments, truncated } = preprocess(input);

  // ② 特征提取
  const features = extractFeatures(cleaned, segments);

  // ③ 规则匹配（多规则并行打分）
  const scores = RULES.map(rule => rule.evaluate(features));

  // ④ 上下文修正
  const adjusted = applyContext(scores, session.state);

  // ⑤ 决策
  let { intent, confidence } = pickTopIntent(adjusted);
  if (confidence < CONFIG.thresholds.vague) {
    intent = 'vague';
  }

  // ⑥ 后处理
  const sub_intents = splitCompoundIntent(features, segments);
  const task_switch = detectTaskSwitch(intent, session);
  const result = { intent, confidence, sub_intents, task_switch, reason: '...' };

  // 审计日志
  log('intent_route', { input: cleaned, features, scores, result, session_state: session.state });

  return result;
}
```

---

## 边界用例（验证路由健壮性）

> **全部已通过 ✅**（2026-08-10）

| 输入 | 原始结果 | 生产级预期 | 测试点 | 状态 |
|---|---|---|---|---|
| "你好" | chat ✓ | chat | 基础闲聊 | ✅ |
| "帮我生成一张图片" | task ✓ | task | 基础任务 | ✅ |
| "你好，帮我生成一张图" | chat ✗（误判） | task | 复合句动作词优先 | ✅ 已修复 |
| "算了不生成了" | 未定义 | cancel | 取消意图 | ✅ 已实现 |
| "确认" | confirm ✓ | confirm | 确认指令 | ✅ |
| "改成30秒" | 未定义 | amend | 修正已确认 | ✅ 已实现 |
| "你好，在吗，谢谢" | chat ✓ | chat | 多闲聊词 | ✅ |
| "帮我生成图片，顺便写个文案" | task（取第一个） | task + sub:[task] | 复合意图拆分 | ✅ 已实现 |
| "asdfgh" | vague | vague | 无意义输入 | ✅ |
| 反问中回复"你好" | chat（退出 grill） | chat_but_in_clarifying | 上下文感知 | ✅ 已修复 |
| 反问中回复"改成科技类" | task | task_switch | 主题切换检测 | ✅ 已实现 |
| "？？" | 未定义 | chat | 纯问号 | ✅ 已实现 |
| 超长500字 | 未截断 | truncated=true + task | 超长处理 | ✅ 已实现 |

---

## 可观测性

每次路由输出结构化日志：

```json
{
  "timestamp": "2026-08-06T16:45:00Z",
  "input": "你好，帮我生成一张图",
  "cleaned": "你好，帮我生成一张图",
  "segments": ["你好", "帮我生成一张图"],
  "features": {
    "has_action_verb": true,
    "action_verb": "生成",
    "has_chat_keyword": true,
    "text_length": 12
  },
  "scores": [
    { "rule": "R3", "intent": "task", "score": 0.8 },
    { "rule": "R5", "intent": "task", "score": 0.6 }
  ],
  "session_state": "idle",
  "result": {
    "intent": "task",
    "confidence": 0.8,
    "sub_intents": [],
    "reason": "action_verb 优先于 chat_keyword"
  }
}
```

用途：出 bug 时可追溯每步决策，统计误判率，持续优化规则权重。

---

## 实现优先级

> **全部已实现 ✅**（2026-08-10）

| 阶段 | 内容 | 价值 | 状态 |
|---|---|---|---|
| Phase 1 | ②③⑤（特征+规则+决策） | 解决复合句误判，立刻见效 | ✅ 已实现 |
| Phase 2 | ④（上下文层） | 解决反问中闲聊/取消/切换 | ✅ 已实现 |
| Phase 3 | ⑥（后处理） | 复合意图+主题切换 | ✅ 已实现 |
| Phase 4 | 配置化 + 审计日志 | 可维护+可观测 | ✅ 已实现（审计日志在 routes.ts SSE 路径；配置全部收敛在 intent_config.ts，routes.ts 仅做查表引用） |

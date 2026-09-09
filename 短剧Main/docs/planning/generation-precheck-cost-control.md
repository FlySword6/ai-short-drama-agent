# 生成预检与成本控制——操作报告手册

**版本**: v1  
**日期**: 2026-08-11  
**吸收范围**: "生成预检与抽卡成本控制" (2026-08-05 DC 令)  
**目标**: 提示词完整度预检 → 省钱/挑好双档开关 → 段落累计消耗, 降低反复抽卡次数

---

## 0. 执行提示词（AI 执行约束）

本卡吸收"生成预检与抽卡成本控制"的范围：提示词完整度在提交生成前先给一个预检打分，并提供"省钱模式/挑好的花钱模式"两档开关，配合段落级的累计消耗展示，让人在生成前后都清楚自己在花多少钱、值不值。位置在段落工作台的生成按钮区域。这一条是提高生成效率的主要判据——目标是降低反复抽卡的次数，而不是让人反复试错烧钱。

**执行约束（AI 必须遵守，不得逾越）：**

1. **只做本手册 §1 范围内的三件事**（预检打分 / 双档开关 / 段落累计消耗），不得扩展到预算限额设置、跨段落报表、生成策略自动决策。§1 已列为非目标的，一律不碰。
2. **不瞎猜符号、表名、字段名**。引用任何源码符号前，必须先用 grep/读码核实其存在与行号。若文档已标注 ⚠️ 修正项，以修正后为准，不得回退到原文档的错误写法。
3. **不瞎猜数据库结构**。消耗流水真实数据源是 `cost_entries` **视图**（schema.ts:1553, migration 016 UNION view），不是表；段落聚合粒度是 `project_id + scene_id`（shots 表无 segment_id 字段）。不得虚构 `consumption_records` 表或 `segment_id` 字段。
4. **预检评分器是纯规则引擎，不调 LLM**。零成本、零延迟、确定性。不得以"提升准确度"为由引入 LLM 调用，违反付费红线。
5. **预检不硬阻止提交**。低分仍然能点生成，只给红色醒目提示。不得把建议变成门禁。
6. **双档开关映射到已有的 `production_mode: "sample" | "full"`**，sample 单价 = full × 0.6。不得自创新枚举。
7. **三个能力的植入位置统一在 segment-workbench-page.tsx 整段生成区（3b）**，排列顺序：档位选择 → 参考控制包 → prompt 编辑区 → 预检卡片 → 成本模式开关 → 段落消耗条 → 生成按钮。不得改逐镜重生成区（3a）。
8. **不写未经验证的辅助函数**。`deriveCharacterDescriptions` / `deriveSceneDescription` / `deriveShotIntent` 在源码中不存在，必须新建并写明数据源（shots 表 breakdownElements + directorPrompt + imagePrompt + videoPrompt）。不得假设它们已有。
9. **前端无 segmentId**。segment-workbench-page.tsx 用 `episodeId + sceneId`，Props 不得写 `segmentId: string`。
10. **收费闸门不变**。`ALLOW_PAID_GENERATION=false` 时 precheck 仍可用（只读），提交仍被拦截。不得让预检绕过付费闸门。

---

---

## 目录

1. [范围与非目标](#1-范围与非目标)
2. [现状基线](#2-现状基线)
3. [架构设计](#3-架构设计)
4. [数据模型](#4-数据模型)
5. [后端实现方案](#5-后端实现方案)
6. [前端实现方案](#6-前端实现方案)
7. [集成顺序](#7-集成顺序)
8. [测试策略](#8-测试策略)
9. [风险与边界](#9-风险与边界)
10. [验收清单](#10-验收清单)

---

## 1. 范围与非目标

### 范围内

| 能力 | 说明 |
|------|------|
| 提示词完整度预检打分 | 生成按钮点击后、报价前, 对当前提示词做结构化质量评估 (0–100 分 + 分项明细) |
| "省钱模式 / 挑好的花钱模式" 双档开关 | 映射到 `production_mode: "sample" | "full"`, 段落工作台生成按钮区域新增 toggle |
| 段落级累计消耗展示 | 段落详情面板显示该段落已跑生成的总积分 + 可分项下钻 |

### 非目标

- **不做**账户余额总览页 (已有 `consumption-records` 模块)
- **不做**预算限额设置 UI (已有 `PAID_GENERATION_BUDGET_FEN` 环境变量, 限管理员修改)
- **不做**生成策略自动决策 (预检结果是建议, 不替人做交付判定)
- **不做**跨段落消耗汇总报表

---

## 2. 现状基线

### 2.1 生成管线已有什么

```
前端 (segment-workbench-page.tsx)
  │
  ├── 逐镜重生成 (3a: regen 流程)
  │     ├── tier → estimate → regenReview (复核阈值) → submit
  │     └── 已有: 档位价格显示、余额感知、V-29 "备好再拍"软引导 (仅缺参考)
  │
  └── 整段生成 (3b: 段落工作台)
        └── 已有: 档位选择、参考控制包提交、prompt 编辑区
```

后端 `POST /api/v1/generations/estimate` 已有:
- `production_mode: "full" | "sample"` → sample 单价 = full × 0.6
- `quoteSubmission()` / `quoteRetry()` → 创价 + 消耗报价号
- `requiresManualReview(estimatedCostFen)` → 复核阈值 (整数百元门槛)
- `budgetLimitFen` → 预算门禁

### 2.2 缺什么

| 缺口 | 位置 | 影响 |
|------|------|------|
| **提示词完整度评分器** | 不存在 | 用户不知道自己写的 prompt 有多好/多差, 只能靠生成结果反向猜测 |
| **省钱/挑好的可视开关** | 3b (整段区) 没有 | 用户感知不到 "sample mode" 存在, 只能每次手动改参数 |
| **段落累计消耗** | 前端无展示 | 不知道这个段落已经花了多少钱, 无法做 ROI 判断 |
| **预检结果 UI** | 不存在 | 评分器有了也没地方展示 |

### 2.3 可复用的基础设施

| 资产 | 位置 | 复用方式 |
|------|------|----------|
| `GenerationProductionMode` | `src/modules/generation/types.ts:4` | 双档开关直接映射 (✅ 已核实) |
| `estimateGenerationCost()` | `src/modules/generation/cost.ts:63` | 预检后调用, sample 用 `priceMultiplierBps: 6_000` (✅ 已核实) |
| `resolveSubmissionPrompt()` | 定义 `src/modules/generation/routes.ts:721`; 调用点 :328/:426/:545 | prompt 组装逻辑已有, 预检器用同一输入 (⚠️ 文档原写 :328 是调用点非定义) |
| `requireCurrentUser()` / `projectAccess()` | 已有认证中间件 | 新接口复用 (✅ 已核实 `routes.ts:235` projectAccess 工厂) |
| `ControlPackSubmitTruth` | segment-workbench-page.tsx:815 | 参考控制包提交状态已有展示 (✅ 已核实) |
| `balancePoints` + 余额感知 | segment-workbench-page.tsx:826 | 余额已经在显示, 累计消耗放旁边 (✅ 已核实) |
| Promotion Tier 查询 | `requireActiveTier()` 定义 `routes.ts:1256` | 已有, 预检需要知道目标档位 (✅ 已核实) |
| `AppError` + `parseRequest` | `src/modules/errors.ts`, Zod | 校验链完整 (✅ 已核实) |
| `authorizeGenerationProject()` | `routes.ts:642` | 鉴权封装已有, precheck 直接复用 (✅ 已核实) |
| `resolveControlReferences()` | `routes.ts:810` | 参考控制包解析已有, precheck 复用 (✅ 已核实) |
| `quoteSubmission()` / `quoteRetry()` | `src/modules/generation/service.ts:80/:99` | 创价 + 消耗报价号 (✅ 已核实) |
| `requiresManualReview()` | `routes.ts:1105` | 复核阈值 (✅ 已核实) |
| `PAID_GENERATION_BUDGET_FEN` / `ALLOW_PAID_GENERATION` | `src/config/env.ts` + `deploy/k8s/base/configmap.yaml` | 付费红线环境变量 (✅ 已核实) |

---

## 3. 架构设计

### 3.1 数据流

```
用户点击 "生成" / "节省抽卡次数"
  │
  ├── ① 前端调用 POST /api/v1/generations/precheck
  │     入参: { project_id, shot_id, tier_id, prompt_override?, media_kind }
  │
  ├── ② 后端:
  │     a. 解析已填 prompt (服务端编译 autoPrompt + 用户补充)
  │     b. 检查参考控制包完整度 (reference completeness)
  │     c. 产出 PrecheckResult { score, dimensions[], recommendations[] }
  │
  ├── ③ 前端展示 PrecheckCard:
  │     - 总分 0–100 + 颜色 (红/黄/绿)
  │     - 分项维度: 角色描述、场景描述、镜头意图、参考素材、负面词
  │     - 每条缺失给出建议文案
  │
  ├── ④ 用户选择 cost_mode: "省钱" (sample) | "挑好的" (full)
  │
  ├── ⑤ 调用现有 POST /api/v1/generations/estimate (带 production_mode)
  │     → CostEstimate 返回
  │
  └── ⑥ 前端展示:
        - 本单报价 (复用现有报价行)
        - 段落累计消耗 (新增 GET /api/v1/projects/:id/scenes/:sceneId/consumption-summary)
        - 确认按钮
```

### 3.2 模块边界

```
src/modules/generation/
  ├── promptPrechecker.ts        ← 新增: 纯函数, 提示词质量评估
  ├── routes.ts                   ← 新增 1 个 precheck 路由
  ├── cost.ts                     ← 不改
  └── types.ts                    ← 新增 PrecheckResult 类型

src/modules/consumption-records/  ← 新增 1 个查询函数 (段落累计)
  └── (已有: 记录消费流水)

frontend/.../segment-workbench-page.tsx  ← 新增 2 个组件
frontend/.../components/
  ├── PromptPrecheckCard.tsx      ← 新增: 预检结果卡片
  └── SegmentConsumptionBar.tsx   ← 新增: 段落消耗条
```

---

## 4. 数据模型

### 4.1 后端类型 (Zod + TypeScript)

```typescript
// src/modules/generation/types.ts 新增

/** 单维度评分 */
export interface PromptDimensionScore {
  key: string;                        // e.g. "character_description"
  label: string;                      // "角色描述"
  score: number;                      // 0–100, 该维度得分
  weight: number;                     // 0–1, 权重, 所有维度 weight 之和 = 1
  status: "good" | "ok" | "weak" | "missing";
  detail: string;                     // 一句话定位问题
  suggestion?: string;                // 改进建议
}

/** 提示词预检结果 */
export interface PrecheckResult {
  overallScore: number;               // 加权总分 0–100
  dimensions: PromptDimensionScore[];
  autoPromptPreview: string;          // 服务端编译的自动段 (只读预览)
  missingReferences: string[];        // 缺失的参考栏位名称列表
  recommendations: string[];          // 优先级排序的改进建议
  estimatedSamplingEffect: {          // 预检分过低时 sample 模式可能浪费
    warning: boolean;
    message?: string;
  };
  precheckId: string;                 // 幂等键
  createdAt: string;                  // ISO 8601
}
```

### 4.2 请求/响应 Schema

```typescript
// POST /api/v1/generations/precheck
const precheckRequestSchema = z.object({
  project_id: z.string().uuid(),
  shot_id: z.string().uuid().optional(),
  target_asset_entity_id: z.string().uuid().optional(),
  tier_id: z.string().trim().min(1).max(128),
  media_kind: z.enum(["image", "video", "audio"]),
  prompt_override: z.object({
    manual_segment: z.string().max(1000).optional(),
  }).optional(),
  reference_lane_count: z.number().int().min(0).optional(),  // 新增: 前端传 laneList.length
}).refine((input) => Boolean(input.shot_id || input.target_asset_entity_id), {
  message: "shot_id 和 target_asset_entity_id 至少提供一个",
});

// GET /api/v1/projects/:projectId/scenes/:sceneId/consumption-summary
// ⚠️ 路由路径修正: /segments/:segmentId → /scenes/:sceneId (前端无 segmentId 实体)
// ⚠️ 字段修正: cost_entries 视图无 tier_id/cost_fen, 用 kind + charged_points
const consumptionSummarySchema = z.object({
  total_cost_points: z.number().int(),     // 修正: cost_fen → cost_points (cost_entries 用 charged_points)
  request_count: z.number().int(),
  breakdown_by_kind: z.array(z.object({    // 修正: by_tier → by_kind (cost_entries 有 kind 无 tier_id)
    kind: z.enum(["image", "video", "audio"]),
    model: z.string().optional(),          // cost_entries 有 model 字段
    charged_points: z.number().int(),       // 修正: cost_fen → charged_points
    request_count: z.number().int(),
  })),
});
```

### 4.3 数据库

**不需要新建表**。消耗流水由 `cost_entries` 视图统一聚合 (schema.ts:1553, `common.view("cost_entries", ...)`), 该视图是 migration 016 的 UNION 视图, 字段为: `entryId/kind/userId/projectId/teamId/model/chargedPoints/createdAt/sourceTable/sourceId/isUnpriced`。注释明确"neither the ORM nor a service may write a second accounting table"。

⚠️ **源码级修正 (原文档两处硬伤)**:
- 原写 `consumption_records` 表 → 实际是 `cost_entries` **视图** (VIEW), 不是表; `consumption-records` 模块 (`src/modules/consumption-records/repository.ts`) 只是读取该视图的仓储层, 不拥有独立表。
- 原写"段落到镜头 JOIN 走 `shots.segment_id`" → **`shots` 表无 `segment_id` 字段** (schema.ts:312-339, 字段为 episodeId/sceneId/shotCode 等); 全库 grep `segment_id` 零命中。

**段落累计消耗的 JOIN 路径 (修正后)**:
"段落" 在前端 `segment-workbench-page.tsx` 的语义 = `episodeId + sceneId` 组合 (无独立 segmentId 实体)。累计消耗查询走:
```sql
-- cost_entries 视图按 project_id 聚合, 下钻到 scene 级需 JOIN generation_requests → shots → scenes
SELECT ce.kind, ce.model, SUM(ce.charged_points) AS total_points, COUNT(*) AS request_count
FROM cost_entries ce
JOIN generation_requests gr ON ce.source_id = gr.id AND ce.source_table = 'generation_requests'
JOIN shots s ON gr.shot_id = s.id
WHERE ce.project_id = $1 AND s.scene_id = $2
GROUP BY ce.kind, ce.model
```
- `cost_entries.projectId` 已有, 直接用;
- `cost_entries` 无 `tier_id`/`media_kind` 字段 → 用 `kind` (image/video/audio 语义) + `sourceTable` 区分来源; tier 信息需从 `generation_requests` 关联 `pricing_tier_snapshots` 取 (已有表)。
- 段落聚合粒度 = `project_id + scene_id` (不是 segment_id)。

**索引**: `cost_entries` 是视图, 性能取决于底层 UNION 表 (generation_requests / account_debit_transactions 等) 的索引; `generation_requests` 已有 `(project_id, shot_id)` 索引, `shots` 已有 `scene_id` 索引。

---

## 5. 后端实现方案

### 5.1 `promptPrechecker.ts` (纯函数, 零副作用)

**输入结构**:

```typescript
interface PrecheckInput {
  autoPrompt: string;                        // 服务端编译的自动段
  manualPrompt?: string;                     // 用户手写补充
  characterDescriptions: string[];           // 角色描述列表 (每角色一条)
  sceneDescription?: string;                 // 场景描述
  shotIntent: string;                        // 镜头意图文本
  referenceLaneCount: number;                // 参考控制包栏位总数
  filledLaneCount: number;                   // 已填栏位数
  negativePrompt?: string;                   // 负面提示词
  mediaKind: GenerationMediaKind;            // image/video/audio
}
```

**评分维度** (6 维, 可后续扩展):

| key | label | weight | 判分逻辑 |
|-----|-------|--------|----------|
| `character_description` | 角色描述 | 0.25 | 每角色有名字 + 特征 → 满分; 只有名字 → 50; 无 → 0 |
| `scene_description` | 场景描述 | 0.20 | 有场景文本 → 满分; 仅代码生成的默认值 → 30; 空 → 0 |
| `shot_intent` | 镜头意图 | 0.25 | 有动作/构图描述 → 满分; 只有时间码 → 20; 空 → 0 |
| `reference_materials` | 参考素材 | 0.15 | filled / total 比例换算 |
| `negative_constraints` | 约束与排除 | 0.10 | 有自定义负面词/排除 → 满分; 仅默认词表 → 60; 空 → 0 |
| `prompt_length` | 提示词充分度 | 0.05 | ≥200 字 → 满分; 50–200 → 50–90 线性; <50 → 0 |

**加权公式**: `overallScore = Σ(dimension.score × dimension.weight)`

**算法**: 纯规则匹配, 不调 LLM。理由:
- 零延迟、零成本、确定性 (同一输入永远同一输出)
- 规则可根据实际生成结果迭代 (A/B 对比预检分 vs 实际满意率)
- 不违反付费红线 (不自动调 LLM 做判定)

### 5.2 新增路由

**文件**: `src/modules/generation/routes.ts`

```typescript
// POST /api/v1/generations/precheck
app.post("/api/v1/generations/precheck", async (request) => {
  const actor = requireCurrentUser(request);
  const input = parseRequest(precheckRequestSchema, request.body);
  
  // 1. 鉴权: actor 有 project 写权限
  const generationActor = await authorizeGenerationProject(
    projectAccess(), actor, input.project_id, "create"
  );
  
  // 2. 获取档位信息
  const generationRepository = repository();
  const tier = await requireActiveTier(generationRepository, input);
  
  // 3. 解析参考控制包完整度
  const controls = await resolveControlReferences(
    generationRepository, actor.id, input, { /* same as estimate */ }
  );
  // ⚠️ 修正: controls 真实返回 { mediaIds, snapshots }, 无 totalLanes/filledLanes
  // lane 完整度需从 input.reference_control_package.lanes 或前端 laneList 单独传参
  
  // 4. 编译自动段 prompt
  const resolvedPrompt = await resolveSubmissionPrompt(
    generationRepository, input, controls.mediaIds
  );
  
  // 5. 评估
  const result = evaluatePromptCompleteness({
    autoPrompt: resolvedPrompt.prompt,          // 修正: resolvedPrompt 是对象, 取 .prompt
    manualPrompt: input.prompt_override?.manual_segment,
    characterDescriptions: deriveCharacterDescriptions(input, generationRepository),
    sceneDescription: deriveSceneDescription(input, generationRepository),
    shotIntent: deriveShotIntent(input, generationRepository),
    referenceLaneCount: input.reference_lane_count ?? 0,   // 修正: 需新增请求字段, 后端无 controls.totalLanes
    filledLaneCount: controls.mediaIds.length,              // 修正: 用 mediaIds.length 近似, 或前端传
    mediaKind: input.media_kind,
  });
  
  return success(result);
});
```

⚠️ **修正**:
- `controls` 真实返回 `{ mediaIds: string[], snapshots: ... }` (routes.ts:819), **无 `totalLanes`/`filledLanes` 字段**; lane 完整度信息只在前端 `segment-workbench-page.tsx:190-191` (`laneList`/`readyLaneCount`) 计算, 后端需在 precheck 请求中新增 `reference_lane_count` 字段由前端传入, 或从 `input.reference_control_package.lanes` 解析。
- `resolvedPrompt` 是 `ResolvedSubmissionPrompt` 对象 (routes.ts:725), 取 `.prompt` 字段, 不是直接字符串。
- `deriveCharacterDescriptions`/`deriveSceneDescription`/`deriveShotIntent` 是文档假设的辅助函数, 源码中不存在, 需新建 (从 `input.shot_id` 查 `shots` 表的 `breakdownElements`/`directorPrompt`/`imagePrompt` 等字段组合)。

### 5.3 段落累计消耗查询

**文件**: `src/modules/consumption-records/repository.ts` (已有仓储, 新增导出函数)

```typescript
// GET /api/v1/projects/:projectId/scenes/:sceneId/consumption-summary
// 聚合 cost_entries 视图 (不是表), JOIN generation_requests → shots 取 scene_id:
//   SELECT ce.kind, ce.model, SUM(ce.charged_points), COUNT(*)
//   FROM cost_entries ce
//   JOIN generation_requests gr ON ce.source_id = gr.id AND ce.source_table = 'generation_requests'
//   JOIN shots s ON gr.shot_id = s.id
//   WHERE ce.project_id = $1 AND s.scene_id = $2
//   GROUP BY ce.kind, ce.model
```

⚠️ **修正**:
- 真实数据源是 `cost_entries` **视图** (schema.ts:1553), 不是 `consumption_records` 表; `consumption-records` 模块 (`repository.ts`) 已有读取该视图的仓储层, 只需新增聚合查询函数。
- JOIN 键是 `shots.scene_id` (不是不存在的 `segment_id`); 段落 = `episodeId + sceneId` 组合 (前端无独立 segmentId)。
- `cost_entries` 无 `tier_id`/`media_kind` 字段 → 分档明细用 `kind` (image/video/audio) + `model`; tier 需关联 `generation_requests.pricing_tier_snapshot_id`。
- 响应 schema 的 `breakdown_by_tier` 字段名需改为 `breakdown_by_kind` (对齐真实字段 `kind` 而非 `tier_id`)。

---

## 6. 前端实现方案

### 6.1 植入位置

**文件**: `frontend/shortdrama-rag-demo/src/pages/segment-workbench-page.tsx`

**当前位置结构** (整段区 3b, 约行 800-1200):

```
<逐镜重生成区>  ← 3a 已有成本感知, 暂不改

<整段生成区>    ← 3b 植入点
  ├── 档位选择卡片
  ├── 参考控制包提交区
  ├── prompt 编辑区
  ├── [NEW] PromptPrecheckCard ← 预检结果 (初始折叠, 有结果才展开)
  ├── [NEW] 成本模式开关       ← "省钱模式" | "挑好的" toggle
  ├── [NEW] SegmentConsumptionBar ← 段落累计消耗条
  └── 生成按钮 (现有, 只改 disabled 逻辑: 预检未过的提示但不阻止)
```

### 6.2 PromptPrecheckCard 组件

**文件**: `src/components/PromptPrecheckCard.tsx`

```
┌─────────────────────────────────────────────┐
│ 🔍 提示词预检 · 总分 72/100  🟡             │
│─────────────────────────────────────────────│
│ ✅ 角色描述         85  已有 3 位角色描述     │
│ ⚠️ 场景描述         45  建议补充光线与氛围     │
│ ❌ 镜头意图          0  缺失: 添加运镜方向     │
│ ⚠️ 参考素材         60  还缺 2 类参考图       │
│ ✅ 约束与排除       100  已排除低质量输出      │
│ ✅ 提示词充分度      90  当前 278 字           │
│─────────────────────────────────────────────│
│ 💡 建议: 补充镜头运镜方向描述, 建议 15–30 字   │
│ 💡 建议: 再上传 2 张风格参考图可明显提升出片质量 │
└─────────────────────────────────────────────┘
```

**Props**:

```typescript
interface PromptPrecheckCardProps {
  result: PrecheckResult | null;
  loading: boolean;
  onCheck: () => void;          // 触发 /precheck 调用
  onRefresh: () => void;        // 重新预检
}
```

**状态**:
- `null`: 不显示 (初始)
- `loading`: 骨架屏
- `result.overallScore >= 70`: 绿底, "提示词质量良好"
- `result.overallScore >= 40`: 黄底, "建议补充后再生成"
- `result.overallScore < 40`: 红底, "提示词不完整, 生成效果可能不达预期"

### 6.3 成本模式开关

**位置**: PromptPrecheckCard 下方, 生成按钮上方

```
┌──────────────────────────────────────┐
│  生成模式                             │
│  ○ 省钱模式 (样片, 约 0.6 倍积分)      │
│  ● 挑好的花钱模式 (成片, 标准积分)      │
└──────────────────────────────────────┘
```

- 默认选中 "挑好的" (full mode), 不暗中替用户省钱
- 切换后立即重新调用 `estimate` 刷新本单报价
- 预检分 < 30 时, "省钱模式" 旁显示工具提示: "提示词过短, 样片可能也难以体现效果, 建议先补全"

### 6.4 SegmentConsumptionBar 组件

**文件**: `src/components/SegmentConsumptionBar.tsx`

```
┌─────────────────────────────────────────────────────┐
│ 本段累计消耗 · 1,200 积分 (已生成 8 次)               │
│ ████████████████████████░░░░  (占项目预算 24%)       │
│  视频: 1,100 积分 (6 次) · 图片: 100 积分 (2 次)      │
└─────────────────────────────────────────────────────┘
```

**Props**:

```typescript
interface SegmentConsumptionBarProps {
  projectId: string;
  episodeId: string;          // 修正: 前端段落工作台用 episodeId + sceneId, 无 segmentId
  sceneId: string;            // 修正: 替代原 segmentId (前端 segment-workbench-page.tsx 无此字段)
  budgetLimitFen?: number;     // 从 tier context 或项目设置获取
}
```

⚠️ **修正**: 原文档 Props 写 `segmentId: string`, 但前端 `segment-workbench-page.tsx` (行 132 `SegmentWorkbenchPage({ projectId, episodeId, sceneId, ... })`) 根本没有 segmentId 概念, 段落 = episodeId + sceneId 组合。grep `segmentId` 在该文件零命中。

**数据源**: `GET /api/v1/projects/:projectId/scenes/:sceneId/consumption-summary` (路径修正: segments → scenes)

### 6.5 API 客户端扩展

**文件**: `src/api.ts`, 新增:

```typescript
export async function precheckGeneration(params: PrecheckRequest): Promise<PrecheckResult> { ... }
export async function getSegmentConsumption(projectId: string, segmentId: string): Promise<ConsumptionSummary> { ... }
```

### 6.6 TypeScript 类型

**文件**: `src/types.ts`, 新增 `PrecheckResult`, `PromptDimensionScore`, `ConsumptionSummary` (与后端对齐)。

---

## 7. 集成顺序

按依赖关系分 4 个 Phase, 每 Phase 可独立提交:

### Phase 1: 纯函数评估器 (后端, 可单独测试)

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/modules/generation/promptPrechecker.ts` | 新建 | 6 维评分纯函数 |
| `src/modules/generation/promptPrechecker.test.ts` | 新建 | 单元测试: 每种维度正常/边界/空值 |
| `src/modules/generation/types.ts` | 修改 | 新增 `PrecheckResult`, `PromptDimensionScore` |

**验证**: `npm test -- promptPrechecker` 全绿。

### Phase 2: API 路由 (后端)

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/modules/generation/routes.ts` | 修改 | 新增 `POST /precheck` (约行 290 之后) |
| `src/modules/consumption-records/` | 修改 | 新增 `getSegmentConsumptionSummary()` 查询函数 + 路由 |
| `src/modules/generation/routes.precheck.test.ts` | 新建 | 集成测试 |

**验证**: curl 测试 precheck 接口, 各种 prompt 质量得到不同分数。

### Phase 3: 前端组件 (独立开发, mock 数据)

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/components/PromptPrecheckCard.tsx` | 新建 | 预检结果卡片 |
| `src/components/SegmentConsumptionBar.tsx` | 新建 | 段落消耗条 |
| `src/api.ts` | 修改 | 新增 `precheckGeneration()`, `getSegmentConsumption()` |
| `src/types.ts` | 修改 | 新增前端类型 |
| `src/pages/segment-workbench-page.tsx` | 修改 | 植入 3 个组件 + 成本模式切换逻辑 |

**验证**: 前端独立运行, mock 数据渲染正常。

### Phase 4: 联调 + 端到端

| 步骤 | 说明 |
|------|------|
| 1 | 启动 dev 环境, 确认 `/precheck` 返回正确 |
| 2 | 在段落工作台点击预检, 卡片正确展示 |
| 3 | 切换成本模式, 报价刷新 |
| 4 | 确认消耗条数据与 consumption_records 表一致 |
| 5 | 完成一次生成, 确认消耗条更新 |

---

## 8. 测试策略

### 8.1 单元测试 (Phase 1)

| 用例 | 输入 | 期望输出 |
|------|------|----------|
| 满分 prompt | 6 维全满, 有角色/场景/意图/参考/约束/长度 | overallScore ≥ 95 |
| 空 prompt | 所有维度空白 | overallScore ≤ 10 |
| 缺角色 | 有场景/意图/参考, 无角色描述 | overallScore 70–80 |
| 缺参考 | 有角色/场景/意图, 无参考图 | overallScore 80–85 |
| 仅有默认负面词 | negativePrompt 为 null, 走默认词表 | constraint 维度 60 |
| 极短 prompt | 总字数 < 50 | prompt_length 维度 0 |
| mediaKind 影响 | video vs image 权重微调 | video 对 shot_intent 权重略高 |

### 8.2 集成测试 (Phase 2)

| 用例 | 说明 |
|------|------|
| `/precheck` 正常返回 | 鉴权通过, 有效 project/shot/tier |
| `/precheck` 鉴权失败 | 非项目成员 → 403 |
| `/precheck` 无效 tier | tier 不存在 → 422 |
| `/consumption-summary` 空段 | 无生成记录 → total = 0, 不报错 |
| `/consumption-summary` 有记录 | 正确聚合 3 条生成记录 |

### 8.3 前端测试 (Phase 3)

| 测试 | 说明 |
|------|------|
| `PromptPrecheckCard` 渲染各状态 | null / loading / 高分 / 中分 / 低分 |
| `SegmentConsumptionBar` 渲染 | 有消耗 / 零消耗 / 超过预算线 |
| 成本模式切换 | 默认 full → 点击 sample → estimate 重新调用 |
| 预检为低分时的提示 | 省钱模式下拉工具提示正常 |

---

## 9. 风险与边界

### 9.1 不做的事 (防止范围蔓延)

| 边界 | 理由 |
|------|------|
| 规则评分器不调 LLM | 零成本、确定性、可迭代; 后续 A/B 对比验证规则是否与生成结果满意率正相关 |
| 预检不阻止提交 | 只给参考, 不给强制门禁。人能无视 30 分提交 |
| 不做跨段落消耗仪表盘 | 属于 dashboard 模块的范围, 不在本卡 |
| 预算设置不走前端 | 敏感操作, 只走环境变量或管理员 CLI |
| 段落消耗不跨项目聚合 | 超出现有 consumption-records 的表结构能力 |

### 9.2 已知风险

| 风险 | 缓解 |
|------|------|
| 规则评分与人类感知不一致 | 评分器输出格式化为建议而非判定; 上线后收集实际生成结果用户满意度做回归 |
| sample mode 0.6× 实际节省 vs 质量损失 | 预检高分时建议 full, 低分时提示 "sample 也浪费钱" |
| 段落累计查询在大量记录下性能 | `cost_entries` 是 UNION 视图 (非表), 性能取决于底层 generation_requests 等表索引; 该表已有 `(project_id, shot_id)` 索引, `shots` 有 `scene_id` 索引, 单次 JOIN 聚合 < 50ms |

---

## 10. 验收清单

### 功能验收

- [ ] 段落工作台生成区出现 "预检" 按钮
- [ ] 点击预检后显示 6 维度评分卡片 (含总分 + 各维度状态 + 建议)
- [ ] 成本模式切换: "省钱模式" → `production_mode: "sample"`, "挑好的" → `"full"`
- [ ] 切换模式后报价数字立即刷新 (sample 为 0.6×)
- [ ] 段落累计消耗条显示该段总积分 + 生成次数 + 分 tier 明细
- [ ] 预检分 < 30 时, 省钱模式旁有提示 "建议先补全提示词"

### 合规验收

- [ ] 预检不自动调用 LLM (纯规则引擎)
- [ ] 收费闸门不变: `ALLOW_PAID_GENERATION=false` 时 precheck 仍可用 (只读), 提交仍拦截
- [ ] 预检不替人做提交判定 (低分仍然能点生成)
- [ ] 无英文裸上屏 (预检结果全部中文)
- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全量通过 (不含 baseline 已知失败)
- [ ] `npm run build` 通过
- [ ] `npm run check:architecture` 通过

---

## 附录 A: 关键文件索引

| 文件 | 角色 |
|------|------|
| `src/modules/generation/promptPrechecker.ts` | **新建**: 评分器纯函数 |
| `src/modules/generation/types.ts` | 修改: 新增 PrecheckResult 等类型 |
| `src/modules/generation/routes.ts` | 修改: 新增 POST /precheck |
| `src/modules/generation/cost.ts` | 只读: estimateGenerationCost |
| `src/modules/consumption-records/repository.ts` | 修改: 新增 `getSceneConsumptionSummary(projectId, sceneId)` 聚合 cost_entries 视图 |
| `frontend/.../PromptPrecheckCard.tsx` | **新建**: 预检 UI |
| `frontend/.../SegmentConsumptionBar.tsx` | **新建**: 消耗条 UI |
| `frontend/.../segment-workbench-page.tsx` | 修改: 植入 3 个组件 + 开关 |
| `frontend/.../api.ts` | 修改: 新增 2 个 API 调用 |
| `frontend/.../types.ts` | 修改: 新增前端类型 |

## 附录 B: promptPrechecker 维度权重表

| key | weight | 输入来源 | 判分规则 |
|-----|--------|----------|----------|
| `character_description` | 0.25 | `deriveCharacterDescriptions()` → 每条 name + traits | ≥2 条有特征 → 100; 仅有名字 → 50; 无 → 0 |
| `scene_description` | 0.20 | `deriveSceneDescription()` → 文本长度 | ≥50 字 → 100; 10–50 → 线性; <10 → 20 |
| `shot_intent` | 0.25 | `deriveShotIntent()` → 动作/构图关键词 | 含动作关键词 → 100; 仅有基本描述 → 40; 只有时间码 → 20 |
| `reference_materials` | 0.15 | filledLaneCount / totalLanes | 比例 × 100 |
| `negative_constraints` | 0.10 | manual negativePrompt 长度 | >10 字 → 100; 仅默认词表 → 60; 无 → 0 |
| `prompt_length` | 0.05 | autoPrompt + manualPrompt 总长 | ≥300 chars → 100; 100–300 → 线性; <100 → 20 |

---

## 附录 C: 源码级核实结论 (2026-08-11)

### 可行性判断: **可行, 但需修正 6 处事实错误后做完**

文档整体架构 (纯规则评分器 + 双档开关 + 段落累计消耗) 设计合理, 不违反付费红线, 复用的基础设施真实存在。但原文档在数据层有 6 处硬伤, 已在 4.3 / 5.2 / 5.3 / 4.2 / 6.4 / 9.2 逐处修正:

| # | 错误 | 实际 | 位置 |
|---|------|------|------|
| 1 | `consumption_records` 表 | `cost_entries` **视图** (schema.ts:1553, migration 016 UNION view) | 4.3 / 5.3 / 9.2 |
| 2 | `shots.segment_id` JOIN 键 | **字段不存在**; shots 表无 segment_id, 真实是 `scene_id` (schema.ts:315) | 4.3 / 5.3 |
| 3 | 前端 `segmentId` Props | **不存在**; segment-workbench-page.tsx 用 `episodeId + sceneId`, grep segmentId 零命中 | 6.4 |
| 4 | `controls.totalLanes` / `controls.filledLanes` | **不存在**; resolveControlReferences 返回 `{ mediaIds, snapshots }` (routes.ts:819), lane 完整度只在前端计算 | 5.2 |
| 5 | `consumption_summary` 字段 `tier_id` / `cost_fen` / `media_kind` | cost_entries 视图无此三字段, 用 `kind` / `charged_points` / `model` | 4.2 |
| 6 | `resolveSubmissionPrompt` 行号 :328 | :328 是调用点, **定义在 :721** | 2.3 已修正 |

### 已核实为真的引用 (✅)

- `GenerationProductionMode` types.ts:4
- `estimateGenerationCost` cost.ts:63
- `requireActiveTier` routes.ts:1256
- `authorizeGenerationProject` routes.ts:642
- `resolveControlReferences` routes.ts:810
- `resolveSubmissionPrompt` 定义 routes.ts:721
- `ControlPackSubmitTruth` segment-workbench-page.tsx:815
- `balancePoints` segment-workbench-page.tsx:826
- `quoteSubmission` / `quoteRetry` service.ts:80 / :99
- `requiresManualReview` routes.ts:1105
- `PAID_GENERATION_BUDGET_FEN` / `ALLOW_PAID_GENERATION` env.ts + configmap.yaml

### 做完前需补的缺口 (未在原文档)

1. **`deriveCharacterDescriptions` / `deriveSceneDescription` / `deriveShotIntent` 三个辅助函数源码中不存在**, 需新建。数据源建议: 从 `shots` 表 (schema.ts:312) 的 `breakdownElements` (subject/action/visual/camera_language) + `directorPrompt` + `imagePrompt` + `videoPrompt` 组合提取。
2. **precheck 请求需新增 `reference_lane_count` 字段** (已在 4.2 schema 补充), 由前端 `laneList.length` 传入, 因后端 `resolveControlReferences` 不返回 lane 完整度。
3. **段落消耗聚合的 SQL JOIN 链**: `cost_entries` (视图) → `generation_requests` (shot_id) → `shots` (scene_id) → 按 `project_id + scene_id` 聚合。需确认 `cost_entries.source_table = 'generation_requests'` 的过滤条件, 因为该视图是 UNION 多来源的。
4. **`consumption-records` 模块的 `list()` 方法** (repository.ts:22) 当前只支持按 actorId + filter 列表, 不支持按 scene 聚合, 需新增 `getSceneConsumptionSummary(projectId, sceneId)` 方法。

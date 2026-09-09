# 剧本拆解移植方案

> 状态：方案稿，禁止据此直接开工
> 目标版本：排片表 V0.2「对话式拆分镜」
> 目标基线：`integration/v011@b4e2c8f`
> 来源：`origin/dev@53a3d6d` 的 `backend/libs/scripts/src/logics/script-breakdown.logic.ts`（405 行）及其提示词、校验、实体和调用层
> Owner：DC
> 日期：2026-07-21

## 0. 结论

旧实现可以迁移的是四类能力：

1. 把一集剧本拆成故事摘要、文案行、场次和有序分镜；
2. 抽取角色、场景、道具候选；
3. 要求模型只返回结构化 JSON，并在落库前做校验；
4. 记录一次拆解运行的模型、输入、结果、错误和统计。

不能迁移的是旧框架和旧落库方式：

- 不引入 NestJS、TypeORM、New API 或第二套模型配置；
- 不复制旧 `scripts`、`storyboards`、`project_prompts` 作为第二套正式事实；
- AI 输出不能直接写入正式资产和 `shots`；
- 不把 `approved=false` 但 `status=active` 的 AI 资产放进普通检索；
- 不保留“角色、场景、道具各调用一次”的固定七次调用结构。

目标链路是：

```text
Episode（集）
  └─ EpisodeScriptVersion（剧本版本，追加写）
       └─ ScriptBreakdownRun（一次拆解运行）
            ├─ 结构化草稿：摘要 / 文案行 / 场次 / 资产候选 / 分镜候选
            ├─ ConversationRevision（对话式局部修改）
            └─ 人工确认
                 ├─ Scenes（正式场）
                 ├─ Shots（正式分镜）
                 └─ 资产候选进入候选区，后续单独确认入库
```

`episodes` 是正式生产聚合根，`shots` 只保存人确认后的当前生产版本；模型草稿和修改历史保存在拆解运行中。这样既接入 V0.1.1 的生产模型，又不让 AI 草稿污染正式事实。

## 1. 来源能力盘点

### 1.1 旧链路实际做了什么

旧 `ScriptBreakdownLogic` 有两条链：

#### 资产拆解

并行发出三次模型请求：

- `character`：角色；
- `scene`：场景；
- `prop`：道具。

结果只检查数组存在、条目为对象、`name` 非空，然后直接写入 `asset_entities` 和 `project_asset_refs`。

#### 分镜拆解

串行发出四次模型请求：

1. 生成 `story_summary`；
2. 把原文变成连续编号的 `lines`；
3. 根据摘要和文案行生成 `scene_divisions`；
4. 根据摘要、文案行、场次、项目资产生成 `storyboards`。

最终只校验：

- `storyboards` 非空；
- `shot_no` 可转为整数；
- `storyboard_prompt` 和 `video_prompt` 非空。

随后直接写入 `project_director_storyboard_prompts` 和 `project_prompts`。

### 1.2 旧提示词里值得保留的原则

- 只返回 JSON，不返回 Markdown、解释或额外文本；
- 保持剧情顺序；
- 行号、场号、镜号从固定起点连续递增；
- 分镜引用的角色、场景、道具只能来自给定集合；
- 每个镜头同时生成画面提示词和视频提示词。

这些原则应改写为版本化的提示词合同和 Zod 校验，而不是继续散落在业务逻辑的字符串里。

### 1.3 旧实现的主要风险

1. **草稿变正式事实**：模型一返回就落正式资产和分镜，没有预览、差异确认和撤销边界。
2. **校验过弱**：未验证行号覆盖、场次范围、镜号连续性、资产引用、总时长和文本长度。
3. **调用过多**：完整拆解固定七次请求，重复发送同一份剧本，增加成本、时延和失败面。
4. **失败恢复粗糙**：某一阶段失败会让整次运行失败；没有阶段 checkpoint（检查点）。
5. **重复事实**：旧 `storyboards/project_prompts` 与 V0.1.1 的 `shots` 提示词字段重叠。
6. **配置分裂**：旧实现有 `NEWAPI_*` 和 `SCRIPT_BREAKDOWN_LLM_*` 两套入口，不符合统一 Ark 适配层。

## 2. 与 V0.1.1 正式模型的映射

### 2.1 正式事实边界

| 旧对象/字段 | V0.2 目标 | 处理规则 |
|---|---|---|
| `ScriptEntity` | `EpisodeScriptVersion`，归属于 `episodes.id` | 不把剧本文本直接塞进 `episodes`；必须保留版本 |
| `story_summary` | `ScriptBreakdownRun.draft_json.story_summary` | 草稿信息，不作为 `episodes` 的重复列 |
| `lines[]` | `draft_json.lines[]` | 保留原文行号和文本，供场次/分镜追溯 |
| `scene_divisions[]` | 草稿场次；确认后写 `scenes` | 确认前不污染正式场次 |
| `storyboards[]` | 草稿分镜；确认后写 `shots` | 以稳定候选 ID 做对话式修改，确认时映射 |
| `shot_no` | `shots.shot_code` + `sort_order` | 建议显示码 `G01/G02...`，顺序用 `sort_order` |
| `narration` | `shots.script_text` | 保存该镜头对应的原文、对白或旁白 |
| `storyboard_prompt` | `shots.director_prompt` + `shots.image_prompt` | 导演意图和生图提示词分开，不重复存表 |
| `video_prompt` | `shots.video_prompt` | 只保存人确认后的当前文本 |
| `duration_sec` | `shots.duration_seconds` | 正整数；模型能力限制由生成任务校验，不写死在拆解层 |
| `character_names/scene_names/prop_names` | 草稿引用；确认时解析到场和资产快照 | 不能只保留名称字符串作为正式引用 |
| `ProjectPromptEntity` | 不迁移 | `shots` 已有三类提示词字段 |
| `StoryboardEntity` | 不迁移 | `shots` 是正式分镜真源 |
| `ScriptBreakdownRunEntity` | 迁为 Drizzle/PostgreSQL 运行与审计表 | 记录阶段、模型、token、成本和确认人 |

### 2.2 为什么不能只给 `episodes` 增加一个 `script_text`

对话式拆分镜要求用户能：

- 回看最初剧本；
- 对比模型草稿和人工修改；
- 在剧本更新后重新拆解，但不覆盖旧分镜证据；
- 知道一次拆解使用了哪个剧本版本、提示词版本和模型。

单列 `episodes.script_text` 会丢失这些信息。因此建议新增版本表和运行表，由 `episode_id` 串回现有生产模型。

### 2.3 建议的数据增量（由集成人编号落 migration）

本方案不创建 migration。实现阶段建议评审以下最小表：

```sql
-- 名称为提案，最终由集成人按当前 schema 规范编号。

episode_script_versions
  id uuid primary key
  episode_id uuid not null references episodes(id)
  version_no integer not null
  title varchar(255)
  script_text text not null
  source varchar(32) not null            -- manual/import
  created_by_user_id uuid not null
  created_at timestamptz not null
  unique (episode_id, version_no)

script_breakdown_runs
  id uuid primary key
  episode_id uuid not null references episodes(id)
  script_version_id uuid not null references episode_script_versions(id)
  created_by_user_id uuid not null
  model_name varchar(128) not null
  prompt_version varchar(64) not null
  status varchar(24) not null             -- queued/running/draft/failed/confirmed/superseded
  current_stage varchar(32)
  input_sha256 varchar(64) not null
  draft_json jsonb not null
  validation_json jsonb not null
  usage_json jsonb not null               -- 每阶段 input/output/cached tokens
  estimated_cost_fen integer
  actual_cost_fen integer
  confirmed_by_user_id uuid
  confirmed_at timestamptz
  created_at timestamptz not null
  updated_at timestamptz not null

script_breakdown_revisions
  id uuid primary key
  run_id uuid not null references script_breakdown_runs(id)
  revision_no integer not null
  instruction text not null
  patch_json jsonb not null                -- 结构化 insert/update/delete/reorder
  result_sha256 varchar(64) not null
  model_name varchar(128) not null
  usage_json jsonb not null
  created_by_user_id uuid not null
  created_at timestamptz not null
  unique (run_id, revision_no)
```

必须同时有以下约束：

- 同一拆解运行只能确认一次；
- 已确认运行不可覆盖，只能新建修订或新运行；
- `draft_json` 必须通过服务端结构校验后才能变为 `draft`；
- 确认事务必须锁定运行和目标 `episode`；
- 重复确认使用幂等键返回同一结果，不重复创建 `shots`；
- 正式 `shots` 记录 `source_breakdown_run_id/source_candidate_id` 的追溯关系。该关系可用新列或单独关联表实现，不能只藏在日志里。

## 3. 目标模块边界

建议目录，仅用于下一阶段任务切分：

```text
src/modules/script-breakdown/
  routes.ts                 # 导出 registerScriptBreakdownRoutes；不直接改公共路由文件
  service.ts                # 用例编排、权限、阶段状态、确认事务
  repository.ts             # Drizzle 读写，唯一事实入口
  prompts.ts                # 版本化提示词合同
  schemas.ts                # LLM 输出 Zod schema
  validators.ts             # 跨阶段、跨字段和数据库引用校验
  mapper.ts                 # 草稿 -> scenes/shots 的确定性映射
  types.ts
  *.test.ts
```

外部依赖只能通过现有适配器：

```text
ScriptBreakdownService
  ├─ ProductionRepository / ScriptBreakdownRepository -> PostgreSQL
  └─ ArkChatClient -> ARK_BASE_URL + ARK_API_KEY + ARK_LLM_MODEL
```

禁止增加 `NEWAPI_*`、`SCRIPT_BREAKDOWN_LLM_*`、OpenAI SDK 或供应商直连代码。

## 4. 模型与提示词设计

### 4.1 模型真源

- 环境变量：`ARK_LLM_MODEL`
- V0.2 首选值：`doubao-seed-2-1-pro-260628`
- 客户端：现有 `ArkChatClient`
- 业务层调用：显式传 `options.model = settings.arkLlmModel`
- 每次运行把实际模型名写入 `script_breakdown_runs.model_name`

如果 `ARK_LLM_MODEL` 未配置，服务端返回可操作的 503，不回退到不确定模型，也不沿用旧 `NEWAPI_SCRIPT_BREAKDOWN_MODEL`。

### 4.2 把七次调用收敛为三阶段

首版建议三次主调用：

#### A. 剧本结构

输入：完整单集剧本。
输出：`story_summary`、`lines`、`scene_divisions`。
目的：一次完成旧实现的摘要、分行和分场，避免重复发送全文。

#### B. 资产候选

输入：完整剧本 + A 的场次摘要。
输出：`characters/scenes/props` 三个数组。
目的：一次抽取三类候选；只进入本次运行草稿，不直接写正式资产。

#### C. 分镜草稿

输入：A 的结构、B 的候选、项目中已通过且可见的资产摘要、目标时长和风格约束。
输出：有稳定 `candidate_id` 的分镜草稿。
目的：生成可修改的初稿，不直接落 `shots`。

JSON 语法修复最多额外调用一次，而且只允许修复原输出，不得重新创作。修复仍记录 token 和费用。

### 4.3 公共 system prompt

```text
你是短剧剧本结构化拆解引擎。只返回符合给定 JSON Schema 的 JSON，
不返回 Markdown、解释或额外文本。不得虚构原文没有的剧情事实。
保持原文顺序；无法确定的字段使用 null 或空数组，不得猜测。
```

各阶段另外给出：

- 明确 JSON Schema；
- 字段定义和单位；
- 本阶段输入的剧本版本、提示词版本；
- 已通过资产白名单；
- 目标集时长和镜头粒度；
- 一到两个经产品批准的少样本示例，不把线上用户数据当示例。

### 4.4 对话式修改不是整集重生成

用户说“把 G06 拆成两个镜头”或“雨夜更压抑”时，模型只返回结构化 patch：

```json
{
  "operations": [
    {
      "op": "split",
      "candidate_id": "shot_c_006",
      "items": [
        { "candidate_id": "shot_c_006a" },
        { "candidate_id": "shot_c_006b" }
      ]
    }
  ]
}
```

服务端把 patch 应用到当前草稿副本，重新跑全部校验，通过后生成新 revision。模型不能直接发 SQL，也不能自行确认。

## 5. 校验合同

校验分五层，任何一层失败都不写正式 `scenes/shots`。

### 5.1 JSON 与字段结构

- 只接受 JSON 对象；
- 未声明字段默认拒绝，避免供应商响应悄悄漂移；
- 文本统一 trim，空字符串归一为 `null` 或拒绝；
- 数组和文本设置上限，防止超大输出；
- repair（修复）最多一次。

### 5.2 顺序与覆盖

- `line_index` 从 0 连续递增；
- `scene_index` 从 0 连续递增；
- 每个 `text_lines` 只能引用存在的行号；
- 场次必须按原文顺序推进；
- 所有非空文案行至少被一个场次覆盖；
- `shot_no` 从 1 连续递增；
- 分镜的 `line_indices` 只能引用存在的行号，并按剧情顺序非逆序推进；
- 同一行可被相邻镜头重复引用，但必须在校验结果中标记为重复覆盖，供人检查，不能静默吞掉。

### 5.3 影视与生产字段

- 每个分镜有 `candidate_id`、`shot_no`、原文引用和画面意图；
- `storyboard_prompt/image_prompt/video_prompt` 分工明确，不能用一个文本复制三份；
- `duration_sec` 为正数；总时长偏离目标超过产品阈值时标记 warning，不自动改写；
- 场景、角色、道具名称必须来自本次候选或已通过的项目资产；
- 模型返回的资产名称先做精确匹配，再给人工处理未匹配项，不做静默模糊绑定。

### 5.4 权限与事实

- 只有有权编辑该项目/分集的用户能创建、修订和确认拆解；
- AI 候选资产不进入普通检索；
- 确认时重新检查 episode、scene、资产仍然存在且可见；
- 模型输出的任何 ID 都不可信，正式 ID 由服务端创建或解析。

### 5.5 确认事务

确认时在一个 PostgreSQL 事务中：

1. 锁定拆解运行；
2. 检查状态为 `draft` 且未确认；
3. 创建或更新目标 `scenes`；
4. 创建本次确认的 `shots`；
5. 写入来源运行和候选 ID；
6. 把运行改为 `confirmed`，记录确认人和时间；
7. 把资产抽取结果留在候选区，等待单独确认，不跟随分镜确认自动升为正式资产。

任一步失败则全部回滚。

## 6. API 草案

```text
POST /api/v1/episodes/:episode_id/script-versions
  保存一个不可变剧本版本

POST /api/v1/episodes/:episode_id/script-breakdowns
  人工点击后创建一次拆解运行；只做文本模型调用，不触发生图/视频

GET /api/v1/script-breakdowns/:run_id
  查询阶段、草稿、校验、token 和费用

POST /api/v1/script-breakdowns/:run_id/revisions
  输入一句修改要求，返回应用结构化 patch 后的新草稿

POST /api/v1/script-breakdowns/:run_id/confirm
  人工确认后写正式 scenes/shots；必须幂等
```

路由模块只导出 `registerScriptBreakdownRoutes(app, getDatabase)`，由集成人在公共路由文件接线。

## 7. 单集 token 与成本估算

2026-07-21 火山方舟公开按量价：Doubao-Seed-2.1-pro 输入 6 元/百万 token，输出 30 元/百万 token。正式上线前应再次以控制台账单单价为准。

计算公式：

```text
单集成本（元）=
  输入 token / 1,000,000 × 6
  + 输出 token / 1,000,000 × 30
```

中文字符与 token 不是固定比例。下面按“真实请求必须记录 usage，设计期只做区间预算”的原则估算。三阶段方案按总输入约为原始剧本 token 的 3.3～3.8 倍，输出约为原始剧本 token 的 1.1～1.4 倍：

| 单集规模 | 原始剧本 token 假设 | 三阶段总输入 | 三阶段总输出 | 主调用估算 | 加 20% repair/重试预留 |
|---|---:|---:|---:|---:|---:|
| 短 | 6,000 | 22,000 | 8,000 | 约 0.37 元 | 约 0.45 元 |
| 常规 | 12,000 | 44,000 | 16,000 | 约 0.74 元 | 约 0.89 元 |
| 长 | 24,000 | 88,000 | 32,000 | 约 1.49 元 | 约 1.79 元 |

旧七次调用会多次重复发送完整剧本。以常规单集估算，输入约 72,000～96,000 token、输出约 15,000～25,000 token，约 0.88～1.33 元，重试后更高。三阶段方案主要降低重复输入、请求失败面和等待时间，不以牺牲校验为代价。

成本控制要求：

- API 返回每阶段 `input_tokens/output_tokens/cached_tokens`；
- 以供应商 usage 作为实际记账，不用字符数替代；
- 拆解前可显示区间预算，但用户一次点击只创建一次运行；
- 阶段重试只重试失败阶段；
- 对话修改只发送当前相关镜头、必要上下文和结构化 patch，不重发整集；
- 超过单集 token 或费用阈值时暂停并交给人决定，不自动扩张。

官方价格来源：[火山方舟模型价格](https://www.volcengine.com/product/ark)。

## 8. 分阶段实施清单

### M0：合同冻结（零模型调用）

- DC 确认 V0.2 交互、正式字段、目标时长与资产候选边界；
- 冻结 JSON Schema、提示词版本和错误码；
- 用 3～5 集脱敏剧本制作离线样例与预期结构；
- 决定 migration SQL 和正式追溯关系。

完成条件：示例输入、期望输出、校验错误和人工确认路径均可在文档中复核。

### M1：剧本版本与运行骨架

- 新增版本表、运行表、修订表；
- 实现 repository、权限、幂等和状态机；
- 接入现有 ArkChatClient 和 `ARK_LLM_MODEL`；
- 先用固定 fixture，不调用真实模型。

完成条件：运行可创建、查询、失败、恢复；尚不能写正式分镜。

### M2：三阶段拆解草稿

- 实现 A/B/C 三阶段提示词；
- 每阶段落 checkpoint、usage、校验结果；
- 实现一次 JSON repair；
- 输出只进入 draft。

完成条件：真实模型可生成结构化草稿，失败不会产生正式 `shots/assets`。

### M3：人工确认与正式落库

- 展示草稿差异、warnings 和未匹配资产；
- 实现一次事务写入 `scenes/shots`；
- 保留 run/candidate 到正式对象的来源关系；
- 资产候选走独立 promote（提升为正式资产）动作。

完成条件：重复确认不重复写入，修改剧本不会覆盖旧确认记录。

### M4：对话式局部修改

- 定义 patch operations；
- 按稳定 candidate ID 修改；
- 每轮保存 instruction、patch、usage 和结果 hash；
- 支持撤销到任一 revision。

完成条件：典型修改不重生成整集，回退后草稿与 hash 可复现。

### M5：评测与成本门禁

- 结构正确率：行号、场次、镜号、引用、顺序；
- 生产可用性：导演/分镜师抽样确认；
- 成本：每集、每阶段、每次修订；
- 稳定性：超时、429、5xx、坏 JSON、长剧本；
- 回归：提示词版本和模型升级不静默改变合同。

完成条件：离线评测、真实小流量试用和账单抽样一致后，才能从实验功能转正式功能。

## 9. 测试清单

### 单元测试

- 所有 Zod schema 正常、空、超长、未知字段；
- 行号/场号/镜号连续性；
- 越界、逆序、重复引用和缺失覆盖；
- 资产白名单和未匹配；
- patch 的 insert/update/delete/split/reorder；
- token 与费用公式；
- 确认幂等。

### 合同测试

- Ark 请求只使用 `ARK_LLM_MODEL`；
- 模型缺失时 fail closed（失败即停）；
- 模型输出不包含在错误响应或日志中；
- 每阶段 usage 和实际模型名进入运行记录。

### PostgreSQL 集成测试

- 运行状态转换和并发确认；
- 单事务写入 scenes/shots；
- 任一步失败全部回滚；
- 删除/归档 episode 后不能确认旧草稿；
- 项目越权返回 403。

### 人工评测

- 至少三种剧本长度；
- 对白密集、动作密集、场景切换频繁三类样本；
- 至少五类修改指令；
- 产品和真实生产人员共同判断“可改可批”，不只看 JSON 合法。

## 10. 明确非目标

- 本工作包不写任何实现代码、migration 或路由接线；
- 不在 V0.1.1 抢跑上线；
- 不触发生图、生视频、生音频；
- 不自动确认、自动入库、自动发布；
- 不实现通用剧本创作 Agent；
- 不把旧仓整体合并到主仓；
- 不用一次成功样例证明生产可用。

## 11. 实施前必须由 DC 确认的四项

1. 剧本版本是按单集保存，还是允许一个剧本版本覆盖多集；本方案默认单集。
2. 确认草稿时，是替换该集当前分镜，还是创建新的分镜版本；本方案建议创建版本，避免覆盖。
3. AI 抽取的角色/场景/道具是否统一进入候选区；本方案建议全部进入候选区。
4. 单集实际预算和 token 上限；本方案只给估算，不替产品拍板。

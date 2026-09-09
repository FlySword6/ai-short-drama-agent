# Lite 配置页「基础配置 / 模板配置」分页 + 风格库设计

> 状态：已施工（v0.1.1）+ **D1 口径修订（2026-08-17：风格不锁定——随时可改/可删/可换选，默认可为空；
> 已写完的锁定代码待返工，差量见 §6）** + **修订二（2026-08-17 二次裁定，随「1.1 版本」返工上线）：
> ① 基础配置维度一律下拉——单值也是下拉（撤销「单值=固定标签」），视频同图片按模型级联收窄；
> ② 两层 tab 缩小（卡内「基础/模板」子 tab 更小一号）；③ 整页满屏适配视口高，不出页面滚动条，
> 只有模板/风格文本区内部滚动；④ D2 定稿＝同步；⑤ 宽度同随屏幕适配（撤销 R2-8 的 1440px 上限，
> 容器 `w-full`）；⑥ 新建模板/新建风格两个编辑器样式统一、输入字号调小一档。差量见 §4.1.3 /
> §4.2 / §6** + **修订三（2026-08-17 三次裁定，真栈走查六问题，随「1.2 版本」上线）：
> ① 基础配置面板宽度撑满与模板配置对齐（维度下拉等分铺满）；② 模板配置 tab（系统默认/新建模板）
> 字号缩小一档；③ 卡底保存按钮只在「基础配置」子 tab 常驻（默认模板配置无保存按钮）；
> ④ 系统默认模板改只读文本框（与新建模板编辑器同构）；⑤ 非默认的风格与模板都有「设为默认」入口
> （风格=「设为默认」按钮，模板=面板内「设为默认」）；⑥ 行级动作按钮全部上底色（accent/secondary/
> warning-soft/danger-soft，撤销全 ghost 与无底描边）；⑦ 新建/编辑风格与模板改弹窗（撤销内联编辑器）。
> 七问题与解决方案见 §4.1.4；差量见 §6 / §7**。
> 涉及表总览见 §5.1
> 适用范围：Lite 项目配置页 `/lite/projects/:id/config`
> 线框草图与交互逻辑：见 §4.1
> 上游合同：`lite-model-defaults.md`（生成默认合同）、`lite-ui-rework.md` §4.6（页面骨架）、
> `project.md` §4.2（完整版风格口径）、AGENTS.md（八条 / R1 / R3）

## 0. 结论摘要

- **需要数据库：是。** 新建 `project_styles` 风格库表（迁移 066，仿 `prompt_templates`）；
  `generation_default_strategies` 与 `projects` **零新增列**（复用 `projects.image_style_description` /
  `video_style_description` 作为生成注入镜像通道）。
- **页面结构**：媒体类型 tab（图/视频）不变，卡内新增 `[基础配置][模板配置]` 两个子 tab——
  - 基础配置 = 生成维度下拉（模型/画幅/清晰度，视频 + 时长，数据来自 active 档，现状不变）+ **风格配置**（新增）；
  - 模板配置 = 现有提示词模板库原样搬入（系统默认只读 + 自建库单选生效，`prompt_template_id` 引用机制不变）。
- **风格默认**：`project_styles.is_default` 为唯一事实源（每项目每媒介至多 1 个，partial unique 索引兜底）；
  默认风格内容镜像写 `projects.style*` 列，**复用现有 `resolveProjectGenerationConfig` → promptCompiler 注入通道，
  生成流程零改动**（`use_project_style` 默认 true，服务端已有 `风格:` 追加 + 去重守卫）。
- **风格生命周期（D1 已裁定，2026-08-17 修订）**：风格与模板同生命周期——**随时可改内容、可删、
  可换设默认**；与模板的唯一产品差异：**默认风格可以为空**（不设默认 = 生成时不注入风格；
  可随时取消默认回到空态）。~~初版锁定口径~~（「一经设定不可改/不可取消/不可换/不可删」）作废，
  已写完的锁定代码需返工（§6）。
- **修订二（2026-08-17 二次裁定）**：基础配置维度（图片 模型/画幅/清晰度，视频 + 时长）**一律渲染
  下拉——单值也是下拉**，撤销「单值=固定标签」形态；视频与图片同口径按「模型 → 下游维度」级联收窄；
  整页满屏（不同屏幕高度自适应、无页面滚动），仅模板/风格的文本区在自身盒内滚动；两层 tab 缩小
  （卡内子 tab 更小一号）；**宽度同随屏幕适配**（`w-full`，撤销 R2-8 的 1440px 上限）；新建模板/
  新建风格两个内联编辑器样式统一、输入字号调小一档。详见 §4.1.3 / §4.2。
- **模板引用与风格默认刻意不混存**：风格默认不写入 `generation_default_strategies.parameters`——
  两者生效通道不同（策略行引用 + 客户端解析 vs `is_default` 行 + 镜像列 + 服务端注入），
  混存会造出第二事实源（见 §4.4 理由）。

---

## 1. 需求

> 将 Lite 版配置页面的图片/视频配置拆分为两个 tab：「基础配置（含风格配置）」与「模板配置」。

- **基础配置** = 模型/画幅/清晰度：下拉可选，数据来自数据库；选择后保存为后续生成默认，之后可改。
  （**2026-08-17 二次裁定（修订二）**：所有表单维度一律渲染下拉——**即使只有一个可选值也是下拉框**，
  不做固定标签；画幅/清晰度（视频含时长）的可选值**随所选模型级联收窄**，图片与视频同口径。）
- **风格** = 用户输入一段文字作为风格；可配置多个风格（类似模板）；只能选一个默认风格（至多一个，
  **可以为空**）；默认无风格，需用户自行添加。
  （**2026-08-17 产品修订**：初版需求中「且后期不能修改」**作废**——风格与模板一样随时可改、可删、
  可换设；与模板的唯一差异是默认可为空、无系统兜底。裁定记录见 §8 D1。）

需求语义拆解（据此设计）：

| 属性 | 基础配置（模型/画幅/清晰度） | 风格（库 + 默认） |
|---|---|---|
| 形态 | 下拉，来自 active 档；**单值也是下拉**（修订二，撤销「单值=固定标签」） | 一段文字，可多条 |
| 数量 | 每媒介一组 | 多条（库）；默认至多 1 条 |
| 默认 | 保存为后续生成默认 | 默认风格 = 生成时注入的那条；**可为空**（不设 = 不注入） |
| 可改性 | **之后可改** | **之后可改**（同模板：内容/默认选择/删除均可——2026-08-17 修订，撤销「不能修改」） |
| 兜底 | 出厂默认档 | **无兜底**：不设默认就没有风格注入（模板恒有系统默认，这是两者的唯一产品差异） |
| 初值 | 档系统给定 | **默认无风格**，需用户自行添加 |

---

## 2. 现状

### 2.1 页面（`frontend/shortdrama-rag-demo/src/pages/lite/lite-project-config-page.tsx`）

- 媒体类型 tab `[图片配置][视频配置]`，`?kind=` URL query 持久化，两卡常驻挂载（`hidden` 切可见性，切 tab 不丢未保存编辑）。
- 每卡 `LiteGenerationConfigCard`：
  - 生成维度下拉：`FORM_DIMENSION_KEYS` 图片 `["model_label","aspect_ratio","resolution"]`、视频
    `["model_label","resolution","aspect_ratio","duration_seconds"]`；数据源 = `listCapabilityTiers(kind)` 的
    **active 档**，经 `generation-dimensions.ts` / `capability-tiers.ts` 推导，档外组合不给选。
    ⚠ 现状仅图片做「模型→画幅→清晰度」级联，视频用全量值域 + 组合置灰；**单值维度渲染成固定标签
    而非下拉**——修订二要求全部下拉 + 双媒介级联，返工见 §4.2；
  - 提示词模板库：`[系统默认][自建…][+ 新建模板]` 同栏 tab，**点 tab 即选中生效**（单选语义），
    自建库 CRUD（新建/编辑/复制新建/软删，内容 ≤5000 字），系统默认只读（后端
    `/generation/default-prompt-templates` 暴露，代码常量回落）；
  - 卡底部一个保存按钮（`保存图片配置`/`保存视频配置`）：走 `putGenerationDefault` 乐观锁
    `expected_version`，409 → 重新 GET 刷新 + toast；保存态文案 `已保存(vN) ✓ 本项目生成时按此默认执行`
    / `未配置 · 按出厂默认执行`（#151 红线）。
- 页面骨架：`max-w-[1440px] 2xl:max-w-[1920px]`（修订二起撤销宽度上限，改 `w-full`——见 §4.1.3 追加
  裁定）。lite 根容器已是 `h-dvh overflow-hidden`，但本页此前没有满屏 flex / 内部滚动分配——超屏内容被
  **直接裁掉**（既不滚动也看不见）。修订二按 §4.1.3 改满屏布局。

### 2.2 前端 API（`frontend/shortdrama-rag-demo/src/api.ts`）

- `api.generationDefault` / `api.putGenerationDefault`：`GET|PUT /projects/:id/generation-defaults/:media_kind`；
  `PutGenerationDefaultInput { mode, model_key, parameters, expected_version }`，`parameters` 为 `JsonRecord`。
- `api.promptTemplates` / `createPromptTemplate` / `updatePromptTemplate` / `deletePromptTemplate`：
  `GET|POST|PUT|DELETE /projects/:id/prompt-templates[/:template_id]`。
- `api.defaultPromptTemplates`：`GET /generation/default-prompt-templates`。

### 2.3 后端（`src/modules/generation/`）

- `defaults/routes.ts`：`putSchema.parameters` 为 `z.record(z.string(), z.unknown())`，仅校验
  `prompt_template_id` 为 uuid/null；`defaults/service.ts` 的 `assertSafeParameters` 只做敏感键过滤。
- `prompt-templates/` 模块（routes/service/repository/types）：项目级模板库，软删、同名 partial unique、
  owner 校验 `assertProjectOwnerUnlessRouteVerified`——**风格库将整体仿此结构**。
- 生成注入通道（`repository.ts` `resolveProjectGenerationConfig`）：读 `projects.image_style_description` /
  `video_style_description` → `ProjectGenerationConfig.styleDescription` → `promptCompiler.ts` 渲染
  `{{style_description}}` 占位 / 兜底追加 `风格:…`；`routes.ts:116` `use_project_style: z.boolean().default(true)`，
  提交期 `styleDescription && !input.prompt.includes(styleDescription)` 追加去重守卫。
- ⚠ 已合入的实现（c795f16b）含**初版锁定口径**的 409 强制与完整版守卫（`project-styles/repository.ts`、
  `production/routes.ts:406`）——D1 2026-08-17 修订后需返工，差量见 §6。

### 2.4 数据库（`src/db/schema.ts` / `migrations/`）

- `projects`（054 迁移）：已有 `image_style_description` / `video_style_description` / `image_style_reference_media_ids` /
  `video_style_reference_media_ids` / `image_prompt_template` / `video_prompt_template`。
- `generation_default_strategies`：project_id + media_kind 唯一，`parameters` jsonb，带 `version`（乐观锁）。
- `prompt_templates`（063）：项目级模板库，软删，`(project_id, media_kind, name) WHERE deleted_at IS NULL` 唯一。
- `prompt_default_templates`（064）：平台级两条默认模板。
- `pricing_rules`（001）：档登记表——档定义（tier_id / params / status）存 `metadata.capability_tier`，
  `/generation/capability-tiers` 读本表投影出 active 档，即**基础配置下拉的选项来源**（详见 §5.1）。

### 2.5 生成流程（风格注入现状）

- **模板**：Lite 客户端解析（`effectivePromptTemplate`，引用键 `prompt_template_id`）→ 内容经
  `supplement_prompt` 提交，服务端不读模板表（§4.3 语义）。
- **风格**：服务端经 `use_project_style`（默认 true）+ `styleDescription` 注入。**Lite 当前不传
  `use_project_style`**，后端默认 true；但 `projects.style*` 列为 null → **实际无风格注入**。即：
  **注入通道已就绪，只缺数据源。**

### 2.6 完整版对照（`frontend/shortdrama-rag-demo/src/components/project-settings.tsx` + `project-config.ts`）

- 完整版项目设置抽屉已按「画面与风格 / 提示词模板」两个页签组织；风格 = 单条
  `styleImage`/`styleVideo` `{ description, referenceMediaIds }`，经 `generation_config` PATCH 写 `projects.style*` 列（可改）。
- 与本方案关系：完整版「单条可改风格」与 Lite「多风格 + 可空默认」是**同一概念的两张脸**，共用
  `projects.style*` 注入列——迁移 066 回填 + 守卫见 §4.4 / §4.7。

---

## 3. 缺口

- **G1 · 没有「基础 / 模板」分层**：现在维度下拉与模板库堆在同一张卡里，与「拆两个 tab」需求不符。
- **G2 · 风格配置完全缺失**：Lite 无风格输入/管理/默认选择 UI；`projects.style*` 列与生成注入通道闲置。
- **G3 · 多风格 + 默认风格的存储模型不存在**：需要新表（多行）+ 每媒介至多 1 个默认（唯一索引）
  + 默认与镜像的一致性事务（~~锁定语义~~ 随 D1 修订作废）。
- ~~G4~~ **已随 D1 修订作废（2026-08-17）**：「默认风格后期不能修改」需求本身撤销，无需服务端落锁；
  替代要求 = 默认与镜像一致性由设/换/取消/删的事务保证（§4.5/§4.7），完整版写入口径见 §4.7 D2。
- **G5 · 迁移/回填空缺**：存量项目已有完整版写入的 `projects.style*` 值，升级后要转成可展示、可默认的风格行，
  否则旧数据在 Lite 风格库里「看不见」（仿 063 回填先例）。
- **G6 · 文档冲突**：`lite-ui-rework.md` §3.5 规定「任何页面不得超过一层页内 tab」（配置页是唯一受控例外：
  媒体类型 tab + 模板单选 tab）；本次新增「基础/模板」内容分类层，需修订 §3.5 / §4.6 口径（见 §4.1）。

---

## 4. 设计

### 4.1 页面结构

层级（自上而下）：

```
媒体类型 tab          [图片配置] [视频配置]          ← 现状不变，?kind= 持久化
└ 卡内子 tab          [基础配置] [模板配置]          ← 新增，?section= 持久化（base|template）
   ├ 基础配置 = 生成维度下拉 + 风格配置（新）
   ├ 模板配置 = 提示词模板库（原样搬入）
   └ 卡底保存按钮（修订三：仅「基础配置」子 tab 常驻；模板配置子面板无保存按钮）
```

- 图/视频两卡仍常驻挂载；卡内「基础配置/模板配置」两面板同样**常驻挂载、`hidden` 切可见性**，
  未保存编辑在切子 tab、切媒介时都不丢（对齐 §4.6「两卡常驻挂载」原则）。
- 子 tab 状态持久化 `?section=base|template`（默认 `base`），与 `?kind=` 同模式（URL query，不用 localStorage）。
- **页头/卡头零标题（用户裁定 2026-08-16）**：tab 已达意——页头不设「项目配置 · 《剧名》」标题与副标题；
  卡头不设「图片生成配置/视频生成配置」标题与说明句。`aria-label` 保留（读屏与测试定位，非可见文字）。
- **页头零返回钮（用户裁定 2026-08-16 二次）**：页头 `‹ 返回` 删除——与壳项目条 `〈 全部项目` 重复，
  返回职责全归壳（全部项目 / 制作 / 资产 常驻）。页头整行不渲染。
- **保存语义不变**：每媒介仍一个保存按钮（`保存图片配置`/`保存视频配置`），一次 strategy PUT 同时提交
  「维度 + 已选模板引用」；**修订三（2026-08-17 三次裁定，见 §4.1.4 Q3）：按钮只在「基础配置」子 tab
  渲染**（原「两个子 tab 均可见」作废——模板配置面板没有可保存状态，悬空按钮误导）。
  **风格操作为即时动作**（不走卡保存，见 §4.5）。
- **G6 修订口径**：`lite-ui-rework.md` §3.5 把「配置页受控例外」从「媒体类型 + 模板单选」扩为
  「媒体类型（页级分类）+ 卡内 基础/模板（内容分类层）+ 模板库/风格库单选 tab（单选生效控件）」——
  基础/模板是同一张卡的配置分组，不是导航层，与「任何页面不得超过一层页内 tab」不冲突；
  需同步修订 §3.5、§4.6 与 §4.6 线框。

#### 4.1.1 线框草图

> 约定与 `lite-ui-rework.md` §4.6 一致：`[ ]`=按钮、`▾`=下拉、`✗`=禁用、`◉`=选中生效。
> ASCII 线框只表结构，不表精确像素。视频卡与图片卡同构（维度=模型/清晰度/比例/时长，
> 风格库与模板库各自独立一套），不再单独画。
> 修订二（2026-08-17）：维度一律 `▾` 下拉（单值也是下拉）；两层 tab 缩小（卡内子 tab 更小一号）；
> 整页满屏、仅文本区滚动（§4.1.3）。

**① 全页 · 基础配置激活（风格库已有默认）**

```
┌──────────────────────────────────────────────────────────┐
│ 〈 项目  🎬《剧名》 │ 制作● 资产○ │ ⚙ 配置 ⋯             │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│  （页头不渲染：无标题/副标题/返回钮——2026-08-16 裁定） │
├──────────────────────────────────────────────────────────┤
│  [ 图片配置 ▸ │ 视频配置 ]            ← 媒体类型页内 tab  │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ [ 基础配置 ▸ │ 模板配置 ]          ← 卡内子 tab      │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ 模型 [Seedream 5 Pro ▾]  画幅 [2K ▾]  清晰度 [9:16 ▾]│ │
│ │ ── 风格配置 ───────────────────── [+ 添加风格] ─────  │ │
│ │ 风格 = 一段生成基调描述；默认风格自动注入提示词，      │ │
│ │ 可随时换设或取消默认（取消后不注入）。                │ │
│ │ ┌ 港风霓虹 · 默认                                   ┐ │ │
│ │ │ 港风霓虹，暖色调，胶片颗粒，大景别，电影级质感…  │ │ │
│ │ │                   [编辑][取消默认][删除]          │ │ │
│ │ └───────────────────────────────────────────────────┘ │ │
│ │ ┌ 水墨国风                                           ┐ │ │
│ │ │ 水墨国风，留白构图，淡墨渲染，宣纸质感，柔光…    │ │ │
│ │ │                      [编辑][设为默认][删除]       │ │ │
│ │ └───────────────────────────────────────────────────┘ │ │
│ │ （多条并列；「设为默认」= 换设，旧默认行自动让位）    │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ [保存图片配置]  已保存(v3) ✓ 本项目生成时按此默认执行 │ │
│ └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**② 全页 · 模板配置激活（线框 ① 的卡内子 tab 切到「模板配置」）**

```
│ ┌─────────────────────────────────────────────────────┐ │
│ │ [ 基础配置 │ 模板配置 ▸ ]          ← 卡内子 tab      │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ 提示词模板：单选生效，生成时自动拼在分镜提示词前      │ │
│ │ [◉ 系统默认][港风霓虹][古装权谋范][+ 新建模板]       │ │
│ │ ┌ 港风霓虹，暖色调，胶片颗粒，大景别，电影级质感…  ┐ │ │
│ │ │ 更新 2026-08-01 · 内容 ≤5000 字                 │ │ │
│ │ │                [编辑][复制新建][删除]            │ │ │
│ │ └───────────────────────────────────────────────────┘ │ │
│ │ （系统默认只读：仅 [复制新建] 可改）                 │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ [保存图片配置]  已保存(v3) ✓ 本项目生成时按此默认执行 │ │
│ └─────────────────────────────────────────────────────┘ │
```

**③ 风格配置 · 空态（初态：无风格、无默认）**

```
│ ── 风格配置 ───────────────────── [+ 添加风格] ─────  │
│ ┌ 空态 ────────────────────────────────────────────┐  │
│ │ 还没有配置风格                                   │  │
│ │ 风格是一段生成基调描述，配图/视频会按默认风格     │  │
│ │ 自动注入提示词。                                 │  │
│ │ 下一步：[+ 添加风格]，添加后把其中一个设为默认。 │  │
│ └───────────────────────────────────────────────────┘  │
```

**④ 设默认确认弹窗**

```
┌─ 把「水墨国风」设为默认风格？ ────────────── ✕ ─┐
│ 本项目该媒介生成时会自动注入这条风格描述。      │
│ 之后可随时换设其它风格，或取消默认回到空态。    │
│                    [取消] [确认设为默认]        │
└──────────────────────────────────────────────────┘
```

#### 4.1.2 具体交互逻辑

**子 tab 切换与回位**：`[基础配置|模板配置]` 只切卡内两面板可见性（常驻挂载，未保存编辑不丢）；
状态写 `?section=base|template`（默认 base），与 `?kind=` 正交持久化——刷新按 `?kind=&section=` 恢复。

**两种动作、两套提交（互不混淆）**：
- **卡保存** = `[保存图片配置|保存视频配置]`，一次 strategy PUT 提交「维度 + 已选模板引用」
  （乐观锁 `expected_version`）；409 → 重新 GET + toast「配置已被其他人更新，已为你刷新」。
- **风格动作**（添加/编辑/删除/设默认）= 即时调 §4.5 端点，**不进 strategy 版本号、不走卡保存**。
  改风格不改变 `已保存(vN)` 版本；两套状态互不阻塞。

**风格配置状态机**（空态 → 添加 → 设默认 → 换设/取消默认，对应线框 ①③④；全程可逆）：
1. 空态：仅 `[+ 添加风格]` + 引导文案（线框 ③）；
2. `[+ 添加风格]` → 卡内内联编辑器（名称 1-80 / 内容 ≤5000 / 实时字数 / 同名即红、超长禁存）；
3. 编辑器保存 → POST 入列表（`is_default=false`），任一行显 `[设为默认]`；
4. `[设为默认]` → 弹窗（线框 ④）→ PUT default（**换设语义**：同事务旧默认行 `is_default=false`、
   新行 `true`、镜像列更新）→ 该行 `默认` 徽标；其余行 `[设为默认]` 仍可用，再点即换设；
5. 默认行可 `[编辑]`（保存后同事务更新镜像）、`[取消默认]`（镜像清空，回「无默认」空态）、
   `[删除]`（软删 + 默认与镜像一并清空）。**无锁定**——全程可逆（D1 已裁定 2026-08-17，见 §8）。

**模板配置交互**（线框 ②）：原样搬入——点模板 tab 即选中生效；系统默认只读（仅 `[复制新建]` 可改；
**修订三起呈只读文本框形态，见 §4.1.4 Q4**）；`[+ 新建模板]` 激活内联编辑器；软删回落系统默认。
**修订三追加（§4.1.4 Q2/Q5）**：模板库 tab 字号缩一档（text-[11px]）；非生效自建模板面板加
`[设为默认]` 按钮（点击=选中生效，与点 tab 同效），生效项显 `生效中` 徽标。

#### 4.1.3 高度、宽度、滚动与 tab/编辑器尺寸（修订二，2026-08-17 二次裁定；宽度与编辑器两条为同日追加）

- **满屏不滚**：整页适配不同屏幕高度、撑满视口。lite 根容器已是 `h-dvh overflow-hidden`，本页此前的
  问题是**没有把高度往下分配**——超屏内容被裁掉。改法：自上而下全流程 `flex + min-h-0`
  （页面 section → 媒体 Tabs → 卡容器 → 卡 → 子面板 → 列表/文本区），**任何一层都不出页面滚动条**。
- **宽度也适配屏幕（追加裁定，推翻 R2-8 宽度档）**：宽度不再套 `max-w-[1440px] 2xl:max-w-[1920px]`
  工作页上限——容器 `w-full` 随屏幕伸缩（仅保留页边距 padding）。lite-ui-rework.md §0 第 5 条 /
  R2-8 的「配置页对齐工作页 1440px」在**本页**范围内被本裁定取代（其它工作页宽度档不动；
  G3 门禁的配置页专属断言随之改写）。高度模型（B′ 固定视口高）不变。
- **只有文本区滚动**：可编辑的模板内容/风格内容 `textarea`（修订三 Q7 起在弹窗内滚动），与同层
  只读内容展示区（系统默认模板内容、模板/风格卡内容预览、风格列表区）在自身盒内滚动
  （`min-h-0 + flex-1 + overflow-y-auto`）；维度下拉行、tab 行、保存行固定占位不滚。
- **tab 尺寸**：媒体类型 tab（页级）与卡内子 tab（内容分类层）都缩小一号；**卡内子 tab 比媒体类型
  tab 更小一号**（层级越深，字号/内边距越小）。~~模板库单选 tab（第三层单选控件）未被点名，保持现状~~
  **修订三（2026-08-17）推翻**：模板库单选 tab（系统默认/自建名/+ 新建模板）用户点名字号过大，
  同缩一档（`text-[11px] px-2 py-0.5`），见 §4.1.4 Q2。
- **~~新建模板 / 新建（编辑）风格两个内联编辑器样式统一（追加裁定）~~（修订三 Q7 取代：两编辑器
  改弹窗，形态仍统一——同 Dialog 结构/同字段排版/同字号；内联形态作废，见 §4.1.4 Q7）**。
- 铁律不变：先有档再有界面——某维度在当前模型下**一个可选值都没有**时，仍是「不可用（禁存）/按默认
  执行」的说明态，不虚构下拉选项（与「单值也下拉」不冲突：单值 = 有 1 个真实档值，零值 = 没有档）。

#### 4.1.4 真栈走查七问题与解决方案（修订三，2026-08-17 三次裁定）

修订二上线后真栈（dev 5173 + API 8000）走查发现五处不符预期，用户反馈再补两处（按钮无色、
内联编辑器挤压），共七处，逐一裁定如下。全部改动只落在 `lite-project-config-page.tsx`
单文件（+ 对应测试），不动后端/数据模型——七问皆为呈现层问题。

**Q1 · 基础配置面板宽度没有撑满屏幕（与模板配置不一致）**

- **问题**：基础配置子面板的维度下拉行是 `flex-wrap` 自然宽度（`w-auto min-w-28` 下拉挤在左侧），
  右侧大片留白；同一张卡的模板配置面板内容吃满卡宽，两个子 tab 宽度观感不一致。
- **原因**：两处叠加——① 卡是 flex 行内子项却没有 `w-full`，宽度收缩到内容自然宽（658px vs 容器
  1528px，真栈实测）；② 维度下拉行是 `flex-wrap` 自然宽度（`w-auto min-w-28` 下拉挤在左侧），行内
  右侧留白。修订二只把「高度」链做满，宽度方向没有分配规则。
- **解决**：卡容器补 `w-full`；维度下拉行改等分布局——`grid [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]`，
  每个维度（label+下拉）占一列、下拉 `w-full` 吃满列宽；图片三列、视频四列，随卡宽伸缩撑满，
  与模板配置面板满宽一致。零选项说明态同样落进格子（占一列），布局不塌。
- **验收**：不同视口宽度下基础/模板两子面板内容都撑满卡宽，无右侧空白带。

**Q2 · 模板配置 tab（系统默认/自建模板/+ 新建模板）字体过大**

- **问题**：模板库单选 tab 沿用原语默认字号（`text-sm px-3 py-1.5`），比媒体 tab、卡内子 tab 都大，
  层级倒挂（第三层控件字号最大）。
- **解决**：模板库 tab 统一缩小一档——`text-[11px] px-2 py-0.5`（与卡内子 tab 同档；层级越深越小，
  修订二口径延伸到第三层）；TabsList 自身内边距同步收小（`p-0.5`）。自建模板名长截断
  （`max-w-40 truncate`）保留。
- **验收**：三层 tab 字号递减：媒体 tab（text-xs）> 卡内子 tab ＝ 模板库 tab（text-[11px]）。

**Q3 · 模板配置（系统默认）不应有「保存图片/视频配置」按钮**

- **问题**：卡底保存按钮跨两个子 tab 常驻；切到「模板配置」且落在系统默认时，页面上没有可保存的
  表单状态（维度不在场、系统默认不可改），保存按钮悬空误导。
- **裁定**：保存按钮语义 = 保存「维度 + 已选模板引用」的生成默认策略。基础配置是它的主场；
  模板配置子面板**不再渲染卡底保存按钮**。模板的生效/保存口径不变：自建模板在编辑器内即时创建/保存
  （创建即选中），系统默认只读无需保存；模板引用随下一次基础配置保存落库（现状语义，不新设通道）。
- **解决**：卡底保存行加条件渲染——仅 `section === "base"` 时挂载；模板配置面板底部只保留
  `missingTemplateNote`（引用模板已删的回落提示）。保存行消失后高度让位给模板文本区（flex-1 重分配）。
- **验收**：基础配置子 tab 有保存按钮与保存态文案；模板配置子 tab 无保存按钮；切回基础配置保存态不丢。

**Q4 · 系统默认模板应为只读文本框（与新建模板同构），且现状内容压住保存按钮**

- **问题 A（形态）**：系统默认面板是「标题 + 纯文本预览」，与新建模板编辑器（名称框 + 内容文本区 +
  按钮行）形态不一致；用户要求系统默认也是文本框，只读。
- **问题 B（压按钮，真因）**：Radix `TabsContent` 未挂高度链——它是内容面板的父层，但渲染出来没有
  `flex min-h-0 flex-1` 类，导致模板面板的 `flex-1` 无处承接，长内容撑破面板把卡底保存行挤出视口
  （页面 overflow-hidden 下表现为「压住」）。
- **解决 A**：系统默认改只读编辑器形态——名称框 `Input`（值「系统默认」，`readOnly`）+ 内容
  `Textarea`（`readOnly`，字号 text-xs，随屏伸缩）+ 说明行（只读提示）+ 按钮行（仅 `[复制新建]`），
  与新建/编辑模板编辑器同结构同观感（修订二「两编辑器统一」延伸到只读第三态）。
- **解决 B**：`TabsContent` 补全高度链类（`mt-2 flex min-h-0 flex-1 flex-col` 已在各面板，另需在
  Radix Content 层保留 flex 传递——实现时给三个内容面板的容器统一挂 `flex min-h-0 flex-1 flex-col`，
  并确认 Tabs 根与面板之间无断链层）；超长内容只在只读 Textarea 内部滚动，不再顶出保存行。
- **验收**：系统默认呈现为只读文本框（不可编辑、无光标可输入）；粘贴 >5000 字长内容仅文本区内部滚动，
  卡底（基础配置时）保存按钮始终可见。

**Q5 · 非默认项都应有「设为默认」入口（风格与模板同口径）**

- **问题**：走查要求「不是默认的，都有个设为默认的按钮，不管是风格还是模板」。风格行已有
  `[设为默认]` 按钮；模板的「设为默认」= 点 tab 选中（单选生效语义，修订二既有口径），但入口不显性，
  与风格行不对齐。
- **裁定**：两库都保证非默认项有显性「设为默认」入口，但按各自生效机制实现，不新设第二通道：
  - 风格行：非默认行保留 `[设为默认]` 按钮（已有，确认不回归）；
  - 模板：自建模板面板按钮列加 `[设为默认]`——点击 = 选中该模板（与点 tab 同效），当前生效模板
    （tab 高亮项）不显示该按钮、显示 `生效中` 徽标；系统默认是生效项时同样显示 `生效中` 徽标。
  - 生效判定 = `selectedTemplateId`（与 tab 高亮同源）；设为默认后仍走卡保存落库引用（Q3 后在
    基础配置子 tab 保存），保存前 tab 高亮与徽标即时反馈。
- **验收**：任一条非默认风格有「设为默认」按钮；任一个未生效自建模板有「设为默认」按钮，点击后
  该模板 tab 高亮 + 徽标「生效中」，原生效项徽标消失并出现「设为默认」。


**Q6 · 行级动作按钮全灰无色，用户认不出动作（2026-08-17 用户反馈，随修订三补）**

- **问题**：配置页行级动作（编辑/设为默认/取消默认/删除/复制新建/添加）全部 `ghost`（透明底灰字），
  一屏灰字，用户没法一眼看出哪个是主行动作、哪个是危险动作。
- **解决**：所有按钮都带底色，页上不留无底描边/透明按钮（保存按钮仍唯一 `primary` 实心，
  守住「每页一个主动作」）。初版映射（outline/danger-outline 描边）用户反馈仍不够明显，
  二次调整为全底色：
  - `accent`（teal 浅底）= 主行动作：`[+ 添加风格]`、`[设为默认]`（风格行与模板面板同口径）；
  - `secondary`（灰底）= 常规/中性：`[编辑]`、`[复制新建]`、编辑器 `[取消]`；
  - `warning-soft`（琥珀浅底，**新增变体**）= 撤回类：`[取消默认]`；
  - `danger-soft`（红浅底，**新增变体**）= 破坏性：`[删除]`。
  - 两个 soft 变体进 `button.tsx` 词汇表（`bg-danger/15 text-danger` / `bg-warning/15 text-warning`，
    与 Badge 同套 token），全站可复用，不是一次性样式。
  - 状态徽标同步上色：`默认` / `生效中` 徽标 `bg-accent-subtle text-accent-text`（teal）。
- **验收**：真栈截图——一屏内 teal/灰/琥珀/红四色全底色可辨；保存（primary 实心）仍是视觉最强，
  危险动作红底独立。

**Q7 · 新建/编辑风格（与模板）改弹窗（2026-08-17 用户反馈，随修订三补）**

- **问题**：内联编辑器嵌在卡内，与风格列表/模板预览**抢同一份高度**——满屏不滚布局下，小视口
  （900px 高）时文本区被压到几行，填写体验差；列表与编辑器同屏也互相挤压。
- **裁定**：新建/编辑风格与新建/编辑/复制新建模板**统一改弹窗**（Radix Dialog，仓「弹窗统一」
  合同）——表单有独立空间（`size="medium"`，文本区 rows=8 不被列表挤压）、列表上下文仍在遮罩后、
  Esc/遮罩可关（busy 时不关，防误丢）；两库共用同一弹窗形态，保持修订二「两编辑器统一」的单一约定。
  撤销「内联编辑器」形态与「[+ 新建模板] 是 tab」的占用——新建模板 tab 仍保留作入口（点开弹窗），
  但不再占用一个内容 tab 位（`templateTabValue` 不再因编辑器打开切 "new"）。
- **解决**：`lite-project-config-page.tsx` 两个 `<Dialog>`（风格/模板各一，互斥）：DialogHeader
  （标题=新建/编辑/复制新建 + 一句语义说明）+ DialogBody（名称 Input + 内容 Textarea + 实时字数，
  校验口径不变：1-80/≤5000、超长禁存）+ DialogFooter（取消 secondary + 创建/保存 primary）。
- **验收**：真栈截图——弹窗居中、名称框聚焦环、字数计数、footer 双钮；弹窗内创建后列表出现新行、
  模板创建即生效（「生效中」徽标）；Esc/取消关闭不丢列表状态。
> 七问均不触碰付费流程（不新建生成任务）、不触碰数据库；全部为配置页呈现层返工。

### 4.2 基础配置 tab（生成维度 + 风格配置）

**生成维度区（修订二返工）**：

- 所有表单维度（图片：模型/画幅/清晰度；视频：模型/清晰度/比例/时长）**一律渲染下拉框**——即使该
  维度在当前可选范围内只有一个值，也渲染只有一个选项的下拉（撤销「单值=固定标签」形态；该形态在
  生成分镜的维度 popover 仍保留，本页不再沿用）。
- **双媒介同口径级联**：改「模型」后，下游维度（画幅/清晰度/时长）的可选值收窄到该模型真实存在的
  active 档；改任一维度时其下游同理按上游保持。原「图片级联、视频全量值域 + 组合置灰」的双口径废除。
- 零选项仍走说明态：该模型未声明该维度 → 图片「不可用，请改选模型（禁存）」、视频「按默认执行」，
  不虚构选项。
- 保存语义不变：仍整档提交（`model_key` = tier_id + `parameters` 逐键来自档声明）。

**风格配置区（新增）**：

- 语义：风格 = 一段 ≤5000 字的描述文字；库内多条；每媒介至多 1 个默认；初态无风格、无默认。
- 空态（§4.7 三要素）：标题「还没有配置风格」+ 说明「风格是一段生成基调描述，配图/视频会按默认风格
  自动注入提示词」+ 下一步 `[+ 添加风格]`。
- 列表：每条风格卡 = 名称 + 内容预览 + 操作；普通风格操作 `[编辑][设为默认][删除]`；默认风格带
  `默认` 徽标，操作为 `[编辑][取消默认][删除]`（编辑保存后同事务更新镜像；取消/删除后镜像清空，
  回「无默认」状态——默认**可以为空**，与模板「恒有系统默认兜底」是唯一产品差异）。
- `[+ 添加风格]` 激活内联编辑器（仿模板编辑器：名称 1-80 字、内容 ≤5000 字、实时字数、超长禁存、同媒介不可重名）。
- 设默认 = **可逆动作**：弹确认框「设为默认风格后，本项目该媒介生成时自动注入此描述；可随时换设或取消」，
  确认后调 §4.5 端点。

### 4.3 模板配置 tab

现有提示词模板库整块搬入，行为口径 = 系统默认只读 + 自建库单选生效 + 编辑器 + 软删回落系统默认。
**修订三（2026-08-17）四处呈现层调整（引用机制与行为零改动）**：① 模板库 tab 字号缩小一档
（§4.1.4 Q2）；② 系统默认改只读文本框形态（§4.1.4 Q4）；③ 非生效自建模板加 `[设为默认]` 显性入口
（§4.1.4 Q5）；④ 模板配置子面板不再渲染卡底保存按钮（§4.1.4 Q3）。

### 4.4 数据模型：新表 `project_styles`（迁移 066）

仿 `prompt_templates`（063），列对齐，语义注明：

```sql
CREATE TABLE IF NOT EXISTS {{schema}}.project_styles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE CASCADE,
  media_kind varchar(16) NOT NULL,
  name varchar(80) NOT NULL,
  content text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  deleted_by_user_id uuid REFERENCES {{schema}}.users(id),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_styles_media_kind_check CHECK (media_kind IN ('image', 'video')),
  CONSTRAINT project_styles_name_len_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT project_styles_content_len_check CHECK (char_length(btrim(content)) BETWEEN 1 AND 5000)
);

-- 同名唯一只在未删除行上生效（软删后可复用名字），与 prompt_templates 同规。
CREATE UNIQUE INDEX IF NOT EXISTS project_styles_project_kind_name_active_key
  ON {{schema}}.project_styles (project_id, media_kind, name) WHERE deleted_at IS NULL;

-- 每项目每媒介至多一个默认。D1 修订（2026-08-17）：默认可换设/可取消/可删，
-- 索引保证的仍是「至多一条」，换设让位在同事务内完成。
CREATE UNIQUE INDEX IF NOT EXISTS project_styles_one_default_key
  ON {{schema}}.project_styles (project_id, media_kind) WHERE deleted_at IS NULL AND is_default;
```

- **`generation_default_strategies` 零 DDL**：风格默认不落 `parameters.style_id`。理由——
  ① 两者生效通道不同：模板 = 策略行引用（`prompt_template_id`）+ 客户端解析；风格 = `is_default` 行
  + 镜像列 + 服务端注入。混进同一 JSONB 会造出第二事实源，且 PUT 无锁校验仍留改口（G4）；
  ② 风格默认走独立的原子设/换/取消事务，语义更清晰。生成期经镜像列注入（§4.6），无需读策略。
- **`projects` 零新增列**：复用 `image_style_description` / `video_style_description` 作镜像。

**历史回填（迁移 066 内，仿 063）**：把存量 `projects.image_style_description` / `video_style_description`
非空值转成 `project_styles` 行（名「项目设置历史风格」，`content` = btrim 值，`is_default = true`，
`created_by = owner_user_id`），带长度守卫（btrim 非空 && ≤5000，超长不写）。存量项目升级后
Lite 风格库可见并以之为默认（可换设/可取消）；全新项目保持「默认无风格」。

### 4.5 后端 API（新模块 `src/modules/generation/project-styles/`，仿 `prompt-templates/`）

路由 `/api/v1/projects/:project_id/project-styles`：

| 端点 | 行为 | 备注 |
|---|---|---|
| `GET ?media_kind=` | 列活动风格行 | — |
| `POST { media_kind, name, content }` | 新建（is_default=false），同名 409 | — |
| `PUT /:style_id { media_kind, name, content }` | 编辑 | 默认行编辑**同事务更新镜像列** |
| `DELETE /:style_id` | 软删 | 默认行软删时**默认与镜像一并清空** |
| `PUT /:style_id/default` | 设/换默认（可重复调用、可换目标） | 同事务：旧默认行让位 + 新行置位 + 镜像更新 |
| `DELETE /:style_id/default` | 取消默认 | 镜像清空，回「无默认」空态 |

- 访问控制照抄 `prompt-templates`：`assertProjectOwnerUnlessRouteVerified` + `projectAccess()`，
  跨项目写被拒（R1）。
- **设/换/取消默认事务（repository 内原子，D1 新口径）**：
  1. 校验 style 行存在、未删、属该项目该媒介；
  2. 该媒介现有 `is_default=true` 行（若有）同事务置 `false`（换设让位）；
  3. 目标行置 `is_default=true`；
  4. 镜像写 `projects.image_style_description` / `video_style_description` = 该行 `content`（媒体分流）。
  取消默认 = 同事务置 `false` + 镜像置 null；删除默认行 = 软删 + 同事务清默认与镜像。
  并发换设由 `project_styles_one_default_key` 唯一索引兜底（冲突方报 409 并发提示后可重试——
  这是并发保护，不是锁定语义）。
- Zod：`media_kind` ∈ {image, video}、`name` 1-80、`content` 1-5000、`.strict()` 拒绝多余键（对齐模板库校验风格）。

### 4.6 生成流程（镜像复用，零改动）

- 默认风格内容已镜像到 `projects.style*` → `resolveProjectGenerationConfig` 现有读取逻辑直接命中 →
  `styleDescription` → promptCompiler 渲染 / 兜底 `风格:` 追加（`use_project_style` 默认 true，含去重守卫）。
- **模板 / 风格职责分离**：模板管「提示词怎么组织」（客户端解析 → supplement_prompt）；
  风格管「画面基调」（服务端镜像注入）。互不干扰，无需改 `routes.ts` / `promptCompiler.ts`。

### 4.7 生命周期与冲突处理（D1 已裁定 2026-08-17）

- **D1（已裁定，取代初版锁定口径）**：风格与模板同生命周期——内容随时可编辑、行随时可软删、
  默认随时可换设/可取消；**默认可以为空**（不设默认 = 该媒介生成不注入风格）。
  全程可逆，R1 无需例外登记（初版「锁定 = 不可逆例外」随之作废）。
- **默认与镜像一致性**：默认行的编辑/换设/取消/删除都在同一事务内同步 `projects.style*` 镜像列，
  保证「`is_default` 行内容 = 镜像列 = 生成实际注入」三点一线；并发由唯一索引兜底（§4.5）。
- **D2（已定稿＝同步，随修订二上线）**：完整版 `generation_config` PATCH 仍直写 `projects.style*` 列，
  初版守卫（存在 Lite 默认即 409「请到配置页修改」）已移除——保留守卫会把「风格随时可改」在完整版
  侧卡死，自相矛盾。执行口径（**同步**）：完整版 PATCH 写 `style_description` 后，将该媒介 Lite 默认
  风格行与镜像列对齐——镜像非空（1-5000 字）→ 默认行 `content` 跟随镜像列；镜像为空/超长 → 默认行
  取消默认（回空态，镜像列注入语义不变）。无默认行时完整版直写列，行为不变。
  （备选「读时校正」弃用：写时不治理，一致性靠读时补救，不如写时同步干净。）

### 4.8 R1 / R3 红线合规

- `project_styles` 属 Lite 可写清单（项目作用域内）：新增进 R1 可写表清单（仿 `asset_entities` 条目）；
  只软删、无硬 DELETE、无跨项目写（owner 校验）。
- ~~R1 例外登记~~ **已撤销（2026-08-17 D1 修订）**：新口径下风格操作全程可逆，R1 不再需要例外登记
  （初版以「默认风格锁定 = 不可逆例外」登记，随锁定口径作废）。
- R3：Lite 新表新端点不改变完整版已有 schema 语义；D2（新口径：同步方案）保证完整版路径不破坏
  「Lite 默认行 = 镜像 = 生成注入」的一致性（~~D2 守卫保证完整版路径不破坏 Lite 锁定~~ 随锁定口径作废）。

---

## 5. 数据库结论

### 5.1 配置页涉及表总览（图片配置 / 视频配置）

两个配置 tab **不是两套表**：同一套表按 `media_kind`（image / video）分行——
唯 `projects` 例外，按 `image_*` / `video_*` 列前缀分。共 6 张：

| 表 | 迁移 | 页面动作 | 每媒介数据形态 | 具体用途 |
|---|---|---|---|---|
| `generation_default_strategies` | 005 | **读写**（卡保存按钮写它） | 每项目每媒介 1 行（唯一索引） | **基础配置的已选值 + 生效模板引用**。`model_key` 列 + `parameters` jsonb：图片 `{ size, ratio, prompt_template_id }`、视频 `{ resolution, ratio, duration_seconds, prompt_template_id }`；`version` 列 = 乐观锁（PUT 带 `expected_version`，409 冲突刷新） |
| `pricing_rules` | 001 | 只读 | 每档每价格时段 1 行 | **基础配置下拉（模型/画幅/清晰度/视频时长）的选项真源**：档定义存 `metadata.capability_tier`——`model_label`→模型名、`params.aspect_ratio`→画幅、`params.size`/`params.resolution`→清晰度、`params.duration_seconds`→时长、`status` 只暴露 active 档。流程：`pricing_rules` → `GET /generation/capability-tiers`（`src/modules/capability-tiers/`）→ 前端 `generation-dimensions.ts` 汇总成各维度可选值。⚠ 初版文档漏列，此处补记 |
| `prompt_templates` | 063 | **读写**（CRUD + 软删） | 每项目每媒介多条 | **模板配置 tab 的自建模板库**（名称 ≤80 / 内容 ≤5000）。生效 = 策略行 `prompt_template_id` 引用，本表自身无「生效」标记；软删后名字可复用 |
| `prompt_default_templates` | 064 | 只读 | 每媒介 1 行（`media_kind` 主键） | **模板配置 tab 的「系统默认」**：平台级默认模板内容，迁移播种，缺行回落代码常量 |
| `project_styles` | **066（本设计新增，已合入）** | **读写**（CRUD + 设/换/取消默认） | 每项目每媒介多条；`is_default=true` 至多 1 行（partial unique） | **基础配置的风格库**。设/换/取消默认、删除默认行均原子同步镜像列 `projects.style*`；**默认可为空**；与模板同生命周期（随时改/删/换设——D1 2026-08-17 修订，初版锁定口径作废） |
| `projects` | 054（相关列） | 读 + 被镜像写 | 风格镜像列每项目各 1 个 | `image/video_style_description` = **默认风格内容的生成注入镜像**：设默认时写入，生成期 `resolveProjectGenerationConfig` 读同一列注入提示词（Lite / 完整版共用通道）。`image/video_prompt_template`、`*_style_reference_media_ids` 为 054 遗留列，完整版在用、Lite 不写 |

> 选项与落库的分工：**下拉里能选什么 = `pricing_rules`（只读）；选完存哪 =
> `generation_default_strategies`（写）**。其余四张各管一事：自建模板库、系统默认模板、
> 风格库、风格生成注入镜像。

> 易混澄清：`model_capabilities`（059）名字带 capability 但与本页无关——它是 LLM 输出 token
> 上限登记表；生图/生视频的「档」真源是 `pricing_rules`。

### 5.2 新建 / 改动口径

| 问题 | 结论 |
|---|---|
| 是否需要数据库 | **是** |
| 新建表 | **`project_styles`**（迁移 `067_project_styles.sql`），仿 `prompt_templates`——已合入（c795f16b） |
| 修改已有表 | **无**。`generation_default_strategies` 零 DDL；`projects` 复用既有 style 列，零新增列 |
| 数据回填 | 迁移 066 内：存量 `projects.style*` 非空 → 风格行（is_default=true），仿 063 |
| 索引 | 同名 partial unique + 每媒介至多一默认 partial unique |

---

## 6. 涉及文件清单

> ⚠ **2026-08-17 D1 修订 + 修订二返工差量**——下列已合入文件按初版锁定口径/旧维度口径实现，需按新口径（§4.2/§4.5/§4.7/§4.1.3）返工：
> - `src/modules/generation/project-styles/repository.ts`：删「默认行编辑/删除 409」「已有默认再设 409」
>   分支，改为换设让位 / 取消默认 / 删默认行事务（均同事务同步镜像列）；新增
>   「默认行与镜像列对齐」同步方法（D2 用）；
> - `src/modules/production/routes.ts:406`：D2 守卫（遇 Lite 默认 409）移除，改为 PATCH 写列后调用
>   同步（§4.7 D2 定稿＝同步）；
> - `migrations/067_project_styles.sql`：DDL 不变（索引仍保证「至多一条默认」），仅头注释锁定表述需更新；
> - 前端 `lite-project-config-page.tsx`：① `默认（锁定）`徽标、禁用按钮、不可逆弹窗 → `默认`徽标 +
>   `[取消默认]` + 可逆弹窗文案；② 维度渲染删「单值=固定标签」分支（单值也是下拉）、视频改级联
>   （级联函数泛化到双媒介）；③ 满屏布局（§4.1.3）+ 两层 tab 缩小；③′ 宽度撤销 1440px 上限改
>   `w-full`、两个内联编辑器样式统一 + 输入字号调小（§4.1.3 追加裁定）；
> - `lite-style-gate.test.ts` G3 配置页专属断言改写：不再要求 `max-w-[1440px]`，改为断言**无宽度上限**
>   （`w-full` 满宽，R2-8 于本页被 2026-08-17 追加裁定取代）；
> - `frontend/shortdrama-rag-demo/src/api.ts`：新增 `clearDefaultProjectStyle`（`DELETE /:style_id/default`）；
> - 测试：锁定 409 用例 → 换设/取消/删默认用例；新增 单值下拉 / 视频级联 / 满屏布局断言（§7）。
>
> **修订三（2026-08-17 三次裁定）差量**——仍只落在呈现层单文件：
> - `lite-project-config-page.tsx`：① 维度下拉行改 `grid auto-fit 1fr` 等分满宽（Q1）；
>   ② 模板库 tab 字号 `text-sm`→`text-[11px]`、内边距收小（Q2）；③ 卡底保存行仅 `section === "base"`
>   渲染（Q3）；④ 系统默认面板改只读编辑器形态（readOnly Input + readOnly Textarea + 按钮行）
>   并补全 TabsContent 高度链（Q4）；⑤ 非生效自建模板面板加 `[设为默认]`（=选中生效）、生效项
>   `生效中` 徽标（Q5）。
> - `lite-shots-reference.test.ts` 配置页用例适配：系统默认面板按钮列断言（`复制新建` 仍在场）、
>   模板 tab 字号/尺寸不再断言旧档、保存按钮按子 tab 在场性断言、模板「设为默认」用例新增。
> - `lite-project-config-page.tsx`（Q7）：新建/编辑风格与模板改 Radix Dialog（互斥两弹窗），
>   撤销内联编辑器与「new」内容 tab 位；测试改按 `document` 查弹窗（portal 到 body）。
> - `components/ui/button.tsx`：新增 `danger-soft` / `warning-soft` 两个浅底变体（Q6 二次调整，
>   与 Badge 同套 token，全站可复用）。

后端：
- `migrations/067_project_styles.sql`（新：建表 + 索引 + 回填）
- `src/db/schema.ts`（新增 `projectStyles` 表定义，仿 `promptTemplates`）
- `src/modules/generation/project-styles/{types,routes,service,repository}.ts`（新，仿 `prompt-templates/`）
- `src/modules/generation/project-styles/{routes,service,migration}.test.ts`（新）
- `src/modules/production/routes.ts`（generation_config PATCH 服务；初版守卫——遇 Lite 默认风格 → 409
  `project_style_default_locked`——已写在 `routes.ts:406`，**随 D1 修订 + D2 定稿移除，改为写列后
  同步默认行**（§4.7 D2）。初版清单把路径误写为 `generation/production/routes.ts`，此处更正）

前端：
- `frontend/shortdrama-rag-demo/src/types.ts`（新增 `ProjectStyle` / `ProjectStyleInput`）
- `frontend/shortdrama-rag-demo/src/api.ts`（新增 `projectStyles` CRUD + `setDefaultProjectStyle`）
- `frontend/shortdrama-rag-demo/src/pages/lite/lite-project-config-page.tsx`（卡内分「基础/模板」子 tab；
  基础配置含风格配置区；模板配置原样搬入；`?section=` 持久化）
- 可选：`frontend/shortdrama-rag-demo/src/lite-project-styles.ts`（常量 STYLE_NAME_MAX=80 / STYLE_CONTENT_MAX=5000，
  仿 `lite-prompt-templates.ts`）
- 前端测试：`lite-prompt-templates.test.ts`（**必须改**，见 §7）、新增风格区测试

文档：
- `docs/design/prd-v2/lite-model-defaults.md`（§4.3 模板库旁补风格库一节，或本文件成为其下位引用）
- `docs/design/prd-v2/lite-ui-rework.md`（§3.5 受控例外口径、§4.6 骨架/线框、§A 验收清单第 13 条）

---

## 7. 测试影响

- **`lite-prompt-templates.test.ts`（必改）**：现测试在 `imageCard` 内按 `[role='tab']` 全量取 tab 并断言
  `templateTabs().length === 2/3/4`；新增「基础/模板」两个子 tab 后该计数被污染。需将模板 tab 查询收窄到
  模板配置面板（按 `TabsList` 的 aria-label 或子 tab 面板内选择器），并**先切到「模板配置」子 tab 再交互**
  （面板常驻挂载但 `hidden`，`textContent` 可见、点击无效）。
- **`lite-shots-reference.test.ts:482`**：只读源码断言维度排列 `image=["model_label","aspect_ratio","resolution"]`、
  视频含时长——`FORM_DIMENSION_KEYS` 不动，**不受影响**。
- **`lite-style-gate.test.ts`**：~~G3/G8 断言配置页 `max-w-[1440px]`、无 `max-w-3xl`、固定视口高——本次不改容器，不受影响~~
  **修订二更新**：宽度裁定推翻 R2-8 → G3 配置页专属断言改写为「无 `max-w-[1440px]`/`max-w-*` 容器上限、`w-full`」；
  G8（固定视口高）不受影响。
- 新增：后端 project-styles CRUD / **换设默认**（旧默认让位 + 镜像更新）/ **取消默认与删除默认行**
  （镜像清空回空态）/ 并发换设唯一索引兜底 / 迁移回填断言（仿 `prompt-templates/migration.test.ts`）；
  前端风格区（空态、多风格、设默认确认、换设让位、取消默认回空态、`?section=` 持久化）。
  （初版「锁定 409」用例随 D1 修订作废、删改。）
- **修订三补充（2026-08-17）**：① 基础配置维度行满宽（grid 等分，无右侧空白带）；② 模板库 tab
  字号断言 `text-[11px]`；③ 模板配置子 tab 无「保存图片/视频配置」按钮、基础配置子 tab 在场；
  ④ 系统默认呈只读文本框（readOnly 断言）、超长内容仅文本区内滚不压保存行；⑤ 非生效自建模板
  `[设为默认]` 点击后 tab 高亮 + `生效中` 徽标，原生效项让位。
- **修订二补充（2026-08-17）**：维度渲染——单值维度也是下拉（断言不再出现单值固定标签分支）；
  视频级联（切模型后画幅/清晰度/时长选项随模型收窄）；满屏布局（G8 口径：`flex-1` 填满 + 内部
  `overflow-y-auto` 只落文本区，无页面滚动层）；`lite-shots-reference.test.ts:767` 风格用例按
  「设默认→可换设→取消默认」改写（锁定断言作废）。

---

## 8. 决策点（待产品确认）

| # | 问题 | 推荐 | 理由 |
|---|---|---|---|
| D1 | ~~「默认风格后期不能修改」的精确口径~~ **已裁定（2026-08-17）** | **不锁定**：风格与模板同生命周期（随时改内容/可删/可换设默认），**默认可为空**（可取消，回空态即不注入） | 「后期不能修改」需求作废；与模板唯一产品差异 = 默认可为空、无系统兜底；全程可逆，R1 例外登记撤销 |
| D2 | 完整版 PATCH 与 Lite 镜像写同一列 | **已定稿（2026-08-17 修订二）＝同步**：写列后将默认行对齐镜像（非空→行内容跟随；空/超长→取消默认） | 409 守卫随锁定作废（否则完整版侧「随时可改」被卡死）；同步保「库行 = 镜像 = 注入」一致；无默认行时完整版行为不变 |
| D3 | 是否允许风格带参考图（`projects.style_reference_media_ids` 已存在） | v0.1.1 只做文字风格，参考图后续扩展 | 需求原文「输入一段作为风格」；列已备好，不阻塞 |
| D4 | 子 tab 默认落在「基础配置」 | 是 | 维度是高频项，风格/模板是低频配置 |

---

## 9. 验收口径与排包纪律

- 页面：真栈渲染走通——图/视频 × 基础/模板四视图切换不丢编辑；风格空态 → 添加 → 设默认（确认框）
  → 默认徽标 → 换设让位 → 取消默认回空态；刷新 `?kind=&section=` 回位。
- 修订二（2026-08-17）：不同视口高度下整页无页面滚动条、撑满屏幕，只有模板/风格文本区内部滚动；
  两层 tab 视觉缩小（卡内子 tab 更小一号）；单值维度也是下拉；切换模型后视频的画幅/清晰度/时长
  选项随模型收窄（与图片同口径）；**宽度随屏幕伸缩**（不同视口宽度下容器满宽无 1440px 截断）；
  新建模板与新建/编辑风格两个内联编辑器结构一致、内容区等高伸缩、输入字号与页面基调一致（更小）。
- 修订三（2026-08-17）：基础配置维度下拉撑满卡宽与模板配置一致；模板配置 tab 字号与卡内子 tab 同档；
  模板配置子 tab 无保存按钮；系统默认呈只读文本框且长内容不压保存行；风格非默认行与模板非生效项
  都有显性「设为默认」入口（§4.1.4 五问逐条对验）。
- 生成流程：设默认后，`/generations/estimate` 返回的 `compiled_prompt` 含默认风格（`project_style_applied=true`）；
  无默认时不含；`use_project_style=false` 时不含（尊重既有开关）。
- 门禁：`npm run check:architecture` / `typecheck` / `npm test` / `build` 全绿；付费流程不真实调用（§4 红线）。
- 排包纪律（AGENTS.md §5）：页面 + 新表 + API + 回填 + 守卫 + 文档修订**同一个工作包一次提交**完成，
  不留「表建了但页面没接」或「前端加了但后端没锁」的悬空态；先 `git status` + `ps` 查双头再开工。
- 交接：写清已验证 / 未验证（真实付费冒烟属人工）/ 人工复验入口。

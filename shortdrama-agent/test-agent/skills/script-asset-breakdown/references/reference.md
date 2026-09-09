# 剧本资产拆解 Skill 参考

## 目录

- [通用执行规则](#通用执行规则)
- [入库上下文要求](#入库上下文要求)
- [模式 1：script_breakdown](#模式-1script_breakdown)
- [模式 2：storyboard_breakdown](#模式-2storyboard_breakdown)
- [模式 3：prop_scene_task_breakdown](#模式-3prop_scene_task_breakdown)
- [输出校验](#输出校验)

## 通用执行规则

1. 只在用户明确需要拆解时执行。
2. 优先使用用户提供的原始剧本、梗概、分场、对白、设定表。
3. 若用户提供角色/场景/道具实体池：
   - 只能从给定实体中选择名称。
   - 代称、泛称、简称需要映射到实体池正式名称。
   - 无法映射时，名称数组返回空数组，不要臆造新名称。
4. 只返回 JSON；不要解释、不要补充说明、不要输出 Markdown 代码块。
5. 有台词时必须保留剧本原句；无台词时：
   - `storyboard` 相关字段填 `（无台词）`
6. 可以补充动作、镜头、环境动态、材质、美术和节奏提示，但不能改变原剧情因果。
7. 只要进入入库流程，就必须严格对齐 MCP tool `ingestStoryboardDecomposition` 的字段命名；不要把内部字段名私自改成驼峰、缩写或中文键名。
8. 绝不猜测 `project_id`、`project_shot_id`、`parent_generation_id` 这类后端 ID。
9. 面向普通用户时，优先索要 `project_name`、`episode_no`、`shot_no` 这些业务字段；不要默认要求用户提供 UUID。
10. 当前 MCP tool 已提供项目和镜头主数据能力：先用 `listProjects` 查询项目主表，未命中则用 `createProject` 创建项目并取得真实 `project_id`；再用 `lookupProjectShotId` 查询镜头主表，未命中则用 `createProjectShot` 创建镜头并取得真实 `project_shot_id` 后再入库。

## 入库上下文要求

当模式为 `script_breakdown` 或 `storyboard_breakdown`，且用户明确要求入库 / 保存 / 同步，或已提供项目上下文时，除拆解结果外，还要先完成项目与镜头主数据准备，再构造 `storyboard_ingestion_request`，并依次调用：

1. `operationId`: `listProjects`
   - `method`: `GET`
   - `path`: `/v1/projects`
   - 参数：`project_name`、`limit=2`
   - 若命中唯一项目，使用返回行中的真实 `id` / `project_id`
   - 若命中多个项目，停止入库并让用户确认更精确的项目名称
2. 若 `listProjects` 未命中：
   - `operationId`: `createProject`
   - `method`: `POST`
   - `path`: `/v1/projects`
   - 请求体至少包含 `project_name`；可附带 `status` 与 `metadata`
   - 创建后优先使用返回对象中的 `id` / `project_id`；若返回体未明确给出 ID，再次调用 `listProjects(project_name, limit=2)` 获取真实 ID
3. `operationId`: `lookupProjectShotId`
   - `method`: `GET`
   - `path`: `/v1/project_shots/lookup/project-shot-id`
   - 参数：`project_id`、`episode_no`、`shot_no`
   - 若命中，使用返回中的真实 `project_shot_id`
4. 若 `lookupProjectShotId` 未命中：
   - `operationId`: `createProjectShot`
   - `method`: `POST`
   - `path`: `/v1/project_shots`
   - 请求体包含 `project_id`、`episode_no`、`shot_no`；可附带 `shot_name`、`status` 与 `metadata`
   - 创建后优先使用返回对象中的 `id` / `project_shot_id`；若返回体未明确给出 ID，再次调用 `lookupProjectShotId(project_id, episode_no, shot_no)` 获取真实 ID
5. `operationId`: `ingestStoryboardDecomposition`
   - `method`: `POST`
   - `path`: `/v1/storyboard_ingestions`

如果用户同时明确要求创建图片生成任务，则在 `ingestStoryboardDecomposition` 成功后继续调用：

6. `operationId`: `listProjectPrompts`
   - `method`: `GET`
   - `path`: `/v1/project_prompts`
   - 查询参数：`project_id`、`limit=200`；如果用户只要求某类资产，再加 `prompt_type`
   - 目的：确认项目下已经有资产提示词；`createShotImage` 会为匹配到的 project prompts 创建图片任务
7. 若 `listProjectPrompts` 没有返回资产提示词：
   - 不要直接调用 `createShotImage`
   - 若本轮已有 `storyboard_ingestion_request.assets`，先调用 `ingestStoryboardDecomposition` 持久化资产提示词，并再次调用 `listProjectPrompts(project_id, limit=200)` 确认
   - 若仍缺失，可调用 `createProjectPrompt` 创建缺失资产提示词；请求体至少包含 `project_id`、`project_name`、`prompt_type`、`prompt_text`、`negative_prompt`、`metadata`
   - 创建后再次调用 `listProjectPrompts`，使用返回行中的真实 `id` 作为 `projectPromptIds`
8. `operationId`: `createShotImage`
   - `method`: `POST`
   - `path`: `/api/projects/shot-images`
   - 请求体必填：`projectId`
   - 可选字段：`projectName`、`projectPromptIds`、`promptTypes`、`overwrite`、`model`、`size`、`n`、`resolution`、`generationParams`、`createdBy`、`metadata`
   - 默认值：`overwrite=false`、`model=gemini-3-pro-image-preview`、`size=1:1`、`n=1`、`resolution=1K`
   - 若有真实项目提示词 ID，使用 `projectPromptIds` 精确创建；若没有真实 ID，只能使用已经通过 `listProjectPrompts` 确认存在的 `promptTypes`，或只传 `projectId` 让接口处理全部资产提示词
   - 若返回 `asset_prompts_not_found`，表示没有项目资产提示词匹配本次请求；不要重复提交同一个 payload，应回到 `listProjectPrompts` / `createProjectPrompt` 流程
9. `operationId`: `listShotImages`
   - `method`: `GET`
   - `path`: `/api/projects/shot-images`
   - 查询参数：`projectId`、`projectPromptId`、`promptType`、`status`、`apimartTaskId`、`limit`、`offset`
   - 创建任务后建议调用 `listShotImages(projectId, limit=50, offset=0)` 检查任务是否落库
10. `operationId`: `refreshShotImage`
   - `method`: `POST`
   - `path`: `/api/projects/shot-images/{image_generation_id}/refresh`
   - 路径参数：`image_generation_id`
   - 只可使用 `listShotImages` 或 `createShotImage` 返回行里的真实图片生成记录 ID，不要用 `project_id`、`project_shot_id` 或 APIMart task id 代替

### 用户侧应提供的字段

- `project_name`
- `episode_no`（如果项目内存在多集歧义时再索要）
- `shot_no`（至少要能定位第几个分镜）
- 剧本文本 / 梗概 / 分场文本

### 系统真正入库时必须具备的字段

- 顶层 `project_id`（通过 `listProjects` 查询或 `createProject` 创建获得，或由上游运行时直接注入真实 UUID）
- 每个要入库镜头对应的真实 `project_shot_id`（通过 `lookupProjectShotId` 查询或 `createProjectShot` 创建获得，或由上游运行时直接注入真实 UUID）
- 每个资产或镜头对应的 `prompt_text`
- 创建图片生成任务时还必须具备顶层 `project_id`，并在 `createShotImage` 请求体里写成 `projectId`
- 创建图片生成任务前还必须具备至少一个项目资产提示词，可通过 `listProjectPrompts(project_id)` 确认

### 缺失时的处理

- 缺 `project_name`：向用户索要 `project_name`
- 缺 `shot_no`：向用户索要第几个分镜；若有多镜头，索要完整镜头范围或逐镜编号
- 缺剧本文本：直接索要剧本正文、梗概或分场文本
- 若 `listProjects(project_name)` 未命中：调用 `createProject` 创建项目
- 若 `listProjects(project_name)` 命中多个项目：告诉用户该 `project_name` 命中多个项目，需要进一步确认项目名称
- 若 `lookupProjectShotId(project_id, episode_no, shot_no)` 未命中：调用 `createProjectShot` 创建镜头主数据
- 若 `lookupProjectShotId(project_id, episode_no, shot_no)` 命中多个镜头或返回歧义：告诉用户该镜头序号命中不唯一，需要进一步确认上下文
- 若用户要求创建图片任务但还没有真实 `project_id`：先按项目查询/创建流程准备 `project_id`
- 若用户指定了某些资产生图但没有真实 `projectPromptIds`：不要自造 ID；先 `listProjectPrompts` 查询项目提示词，或先完成入库/创建项目提示词并从返回结果中读取真实项目提示词 ID
- 若 `createShotImage` 返回 `asset_prompts_not_found`：说明项目下没有资产提示词匹配 `projectPromptIds` / `promptTypes` / `projectId`；先查或创建 project prompts，不要重复提交同一个生图请求
- 任何一种缺失都不要虚构入库成功

### 组装原则

- `storyboard_ingestion_request.assets.characters / scenes / props` 对应本轮拆解出的角色、场景、道具资产
- `storyboard_ingestion_request.shots` 对应本轮拆解出的分镜
- 若用户未要求入库，且上下文不足，可省略 `storyboard_ingestion_request`
- 若已构造 `storyboard_ingestion_request`，`shots[*].asset_keys` 必须能在 `assets` 中找到对应项

### 工具边界说明

- `createProject` (`POST /v1/projects`) 创建项目主数据；请求体必填 `project_name`。
- `createProjectShot` (`POST /v1/project_shots`) 创建镜头主数据；请求体必填 `project_id`，入库流程中还应传入 `episode_no` 与 `shot_no` 以便后续 lookup。
- `listProjectPrompts` (`GET /v1/project_prompts`) 查询项目提示词记录；创建图片任务前必须用它确认有资产提示词。
- `createProjectPrompt` (`POST /v1/project_prompts`) 只创建项目提示词记录；不要用它替代 `createProject`。当生图前缺少资产提示词时，可用它创建角色/场景/道具资产提示词。
- `createProjectShotGeneration` (`POST /v1/project_shot_generations`) 只创建项目镜头生成记录；不要用它替代 `createProjectShot`。
- `ingestStoryboardDecomposition` (`POST /v1/storyboard_ingestions`) 负责持久化资产提示词与镜头生成记录；在调用前应尽量准备好顶层 `project_id` 与每条 `shots[*].project_shot_id`。
- `createShotImage` (`POST /api/projects/shot-images`) 负责创建项目资产图片生成任务；请求字段采用驼峰命名，至少传 `projectId`，不要传分镜入库字段；调用前必须确认有 project prompts。
- `listShotImages` (`GET /api/projects/shot-images`) 负责查询项目资产图片生成任务；创建任务后用它确认任务状态与图片生成记录 ID。
- `refreshShotImage` (`POST /api/projects/shot-images/{image_generation_id}/refresh`) 只刷新一个图片生成任务；路径参数必须是真实 `image_generation_id`。

## 模式 1：script_breakdown

适用：用户要求“剧本拆解 / 资产拆解 / 提取角色场景道具分镜 / 全量拆解”。

输出目标：

- `characters`：支持人物立绘、表演设计、关系设定
- `scenes`：支持美术置景、光线氛围、剧情功能分析
- `props`：支持道具资产制作与镜头调度
- `storyboards`：支持视频生成、镜头设计、后续批量生图/生视频
- `storyboard_ingestion_request`：在具备入库上下文时，直接对应 `/v1/storyboard_ingestions` 的请求体
- `shot_image_generation_request`：在用户明确要求生图任务时，直接对应 `/api/projects/shot-images` 的请求体

### characters 编写要求

- `name`：角色正式名称
- `identity`：身份定位，如学生、侍卫、掌门、老板
- `personality`：可表演的性格特征
- `relationship`：与主要人物的关系
- `visual_notes`：服装、妆造、年龄感、气质、动作习惯等

### scenes 编写要求

- `name`：场景正式名称
- `time_and_place`：时间 + 地点
- `atmosphere`：情绪与环境氛围
- `story_function`：该场景承担的叙事作用
- `asset_notes`：布景、光线、天气、空间层次、稳定背景元素

### props 编写要求

- `name`：道具名
- `purpose`：剧情作用
- `appears_in`：出现的场景或关键镜头
- `visual_notes`：材质、状态、新旧程度、使用痕迹、是否发光/破损等

### storyboard_ingestion_request 编写要求

#### 顶层字段

- `project_id`：这是系统入库必填字段；优先通过 `listProjects(project_name)` 查询，未命中则通过 `createProject` 创建，若运行时已注入真实值也可直接复用；不应默认要求普通用户手填 UUID
- `project_name` / `episode_no` / `user_id` / `user_name` / `created_by` / `decomposition_run_id`：有则透传，无则省略
- `metadata`：可记录来源说明、拆解模式、原始输入摘要；不要塞入超长全文

#### assets.characters / assets.scenes / assets.props

每条资产都按 `StoryboardAssetInput` 组装：

- `asset_key`：生成稳定 key，推荐使用 `character_01`、`scene_01`、`prop_01` 这类可预测格式
- `asset_name`：等于当前实体正式名称
- `shot_no`：若能明确判断首次或关键出现镜头则填写，否则可省略
- `prompt_text`：必须是可直接用于生成该资产的自然中文提示词
- `negative_prompt`：若用户未提供，可统一使用 `模糊,低质量,变形,多余手指,文字,水印`
- `model_name`：仅在用户或上游指定时透传
- `status`：仅在调用方给出明确状态语义时透传
- `metadata`：保留结构化来源字段，例如：
  - 角色：`identity`、`personality`、`relationship`、`visual_notes`
  - 场景：`time_and_place`、`atmosphere`、`story_function`、`asset_notes`
  - 道具：`purpose`、`appears_in`、`visual_notes`

#### shots

每条分镜都按 `StoryboardShotInput` 组装：

- `project_shot_id`：必须是系统查询或创建出的真实值，不能猜测；默认通过 `lookupProjectShotId(project_id, episode_no, shot_no)` 获取，未命中则通过 `createProjectShot` 创建；用户侧只需要提供可定位镜头的 `shot_no`（必要时加 `episode_no` / `project_name`）
- `shot_no`：直接复用分镜 `shot_no`
- `prompt_text`：优先直接复用 `video_prompt`
- `negative_prompt`：若用户未提供，可统一使用 `模糊,低质量,变形,多余手指,文字,水印`
- `generation_params`：至少建议包含 `shot_type`、`duration_sec`、`scene_continuity_key`、`scene_anchor`
- `metadata`：建议包含 `narration`、`dialogue`、`character_names`、`scene_names`、`prop_names`
- `generation_type`：默认填 `video`
- `created_by`：若顶层已有统一 `created_by`，这里可复用；否则省略
- `asset_keys`：引用本镜实际涉及的角色 / 场景 / 道具资产 key
- `parent_generation_id`、`revision_no`、`revision_reason`、`status`、`input_image_urls`、`input_reference_urls`、`input_storyboard_urls`：只有调用方提供明确值时才透传

### shot_image_generation_request 编写要求

仅当用户明确要求“创建图片 / 生图 / 资产图生成任务”时输出并调用 `createShotImage`。

- `projectId`：必填，必须是真实 `project_id`；若只有 `project_name`，先用 `listProjects` / `createProject` 获取
- `projectName`：有则透传，便于排查
- `projectPromptIds`：只能填 `listProjectPrompts`、`ingestStoryboardDecomposition`、`createProjectPrompt` 或其他工具返回的真实项目提示词 ID；不能用 `asset_key`、资产名称或自造 ID
- `promptTypes`：当用户要求只生成角色、场景、道具等特定资产类型，且已经通过 `listProjectPrompts(project_id, prompt_type=...)` 确认存在匹配记录时使用
- `overwrite`：默认 `false`；只有用户明确要求重生成或覆盖已有任务时才设为 `true`
- `model`：默认 `gemini-3-pro-image-preview`，用户指定模型时透传
- `size`：默认 `1:1`，用户指定比例时透传
- `n`：默认 `1`，用户指定每个资产生成数量时透传
- `resolution`：默认 `1K`，用户指定分辨率时透传
- `generationParams`：承载风格、种子、参考图、质量参数等额外生成参数
- `createdBy`：有顶层 `created_by` 时复用
- `metadata`：建议记录来源模式、分解运行 ID、筛选条件，不要塞入超长剧本全文

## 模式 2：storyboard_breakdown

适用：用户要求“分镜拆解 / 镜头拆解 / 批量生图分镜 / Seedance video_prompt”。

### 分析顺序

1. 先按 5W2H 理解剧情：人物、事件、地点、时间、动机、方式、数量。
2. 再检查镜头连贯：空间、时间、动作、视线、情绪。
3. 最后输出结构化分镜。

### narration 要求

- 是“镜头描述”字段
- 单镜一段自然语言
- 要体现：主体、动作过程、表情、场景、关键道具、镜头信息
- 如果本镜有对白，必须写清谁对谁说、说话时的动作与表情
- 尽量控制在 60~120 字，最多 150 字

### dialogue 要求

- 有台词：必须输出剧本原文
- 无台词：输出 `（无台词）`
- 不可删改、总结、意译

### 连续性要求

- 先按“物理空间 + 时间段 + 环境状态”划分场景连续块
- 同一连续块内：
  - `scene_names` 复用同一个场景实体名称
  - `scene_continuity_key` 保持一致，例如 `SCENE_01`
  - `scene_anchor` 保持基础锚点一致，至少包含地点、时间/光线、稳定背景、环境状态
- 只有在地点变化、明确时间跳切、环境状态本质变化时，才切到新的连续块

### video_prompt 要求

`video_prompt` 仅输出最终自然中文句子，但内部必须按以下顺序组织：

1. 主体（含 `[@角色名]`）
2. 动作（含表情变化）
3. 场景背景（含 `[@场景名]`）
4. 镜头描述（景别、推拉摇移跟、构图、节奏）
5. 风格描述
6. 约束条件（如道具、连贯性、光线、避免事项）

附加规则：

- 角色、场景、道具若出现，必须用 `[@名称]` 引用
- 若本镜有台词，`video_prompt` 中必须落下原台词内容
- 需覆盖动作、镜头运动、环境动态、节奏/转场、与前后镜的衔接
- 同一 `scene_continuity_key` 下，场景背景必须继承同一 `scene_anchor`
- 可加入 1~2 个电影术语增强镜头，例如：Dolly Zoom、Match Cut、Dutch Angle、360度环绕、一镜到底、鸟瞰俯冲、升格慢动作
- 禁止堆砌抽象形容词，必须写可执行的动态细节

### storyboard_ingestion_request 编写要求

- 若当前模式仅拆分镜，`storyboard_ingestion_request.assets` 可以省略，或仅在用户明确提供实体池且能稳定映射时输出
- `storyboard_ingestion_request.shots` 必须与 `storyboards` 一一对应
- 每个 `shots[*].prompt_text` 直接复用 `storyboards[*].video_prompt`
- 每个 `shots[*].project_shot_id` 必须是系统通过 `lookupProjectShotId` 查询或 `createProjectShot` 创建出的真实值
- 用户侧只需提供 `project_name`、必要时的 `episode_no`，以及对应的 `shot_no`
- 若没有资产实体池，`asset_keys` 可以为空数组或省略；不要引用不存在的 key

### 常见景别限制

`shot_type` 仅使用：

- 特写
- 近景
- 中景
- 全景
- 远景
- 大全景

## 模式 3：prop_scene_task_breakdown

适用：用户要求“道具任务拆解 / 场景任务拆解 / 道具与场景制作清单 / 分场资产任务”。

输出目标：把剧本中的道具与场景需求，拆成可执行制作任务。

### tasks 编写要求

每条任务都应是一个明确、可执行、可交付的工作项，至少说明：

- 任务名称
- 任务类别
- 关联道具
- 关联场景
- 关联角色（如有）
- 原文依据
- 任务目标
- 动作要求
- 视觉要求
- 连续性要求
- 交付说明

### 任务拆解原则

- 同一镜头内若多个道具承担不同功能，可拆成多条任务
- 同一道具在不同场景状态明显变化时，应拆成不同任务
- 若任务依赖连续场景，应显式复用 `scene_continuity_key` 与 `scene_anchor`
- 若剧本只给出抽象描述，可补足合理制作要求，但不能增加与原文冲突的剧情事件
- 本模式默认不调用 `ingestStoryboardDecomposition`

## 输出校验

最终输出必须严格匹配 `schemas.json` 根 schema：

- `script_breakdown`
- `storyboard_breakdown`
- `prop_scene_task_breakdown`

其中：

- `script_breakdown` 与 `storyboard_breakdown` 在需要入库且上下文完整时，可附带 `storyboard_ingestion_request`
- `prop_scene_task_breakdown` 不带 `storyboard_ingestion_request`
- 三者只能命中一种模式

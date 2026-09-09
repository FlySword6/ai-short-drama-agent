# Shortdrama CLI

短剧生产 CLI 上下文，定义剧本拆解、分镜、角色与生成流水线中的核心业务语言，避免业务 Agent 与云厂商 Agent 概念混用。

## Language

**业务 Agent**:
`shortdrama-cli` 内部的生产能力单元，负责把一类短剧生产输入转成结构化结果或生成产物。
_Avoid_: Agent, worker, handler

**AgentKit Agent**:
火山云 AgentKit 中托管或运行的 agent 实体，只能作为外部能力被 `shortdrama-cli` 调用。
_Avoid_: 业务 Agent, CLI Agent

**剧本拆解**:
从原始剧本得到场次、剧情节拍和台词引用的生产分析结果。
_Avoid_: 剧本解析, 文本分析

**角色拆解**:
从剧本或剧本拆解结果得到角色档案、人物关系、外观和声音设定的生产分析结果。
_Avoid_: 角色识别, 人物解析

**分镜拆解**:
从剧本拆解和角色拆解结果得到镜头、景别、机位运动、时长和视觉提示词的生产规划结果。
_Avoid_: 镜头生成, Storyboard 生成

**生成任务**:
已经提交给在线业务 API、可能尚未完成的异步图片或视频生成工作。
_Avoid_: 生成产物, 任务产物

**媒体产物**:
已经可被后续短剧生产使用的图片或视频文件或 URI。
_Avoid_: 生成任务, 生成记录

**运行记录**:
一次 CLI 执行的状态、产物和关键事件的运行快照。
_Avoid_: 日志, manifest, 缓存

**拆解 Provider**:
执行剧本拆解、角色拆解或分镜拆解能力的外部或本地模型能力来源。
_Avoid_: 拆解 Agent, AgentKit

**服务用例客户端**:
`shortdrama-cli` 内部面向在线业务 API 的调用入口，用于提交请求、查询状态和读取结果。
_Avoid_: ImageAgent, VideoAgent, 生成 Agent, Provider

**Gateway**:
`shortdrama-cli` 内部访问受权限控制的在线业务 API 的边界对象。
_Avoid_: Provider, API helper, HTTP util

**Repository**:
`shortdrama-cli` 内部读取或写入运行快照、输出快照和本地索引的边界对象。
_Avoid_: Gateway, 主数据源, 数据库

**Agent Harness**:
用户实际面对的那个壳——WorkBuddy、pi、oh-my-pi 之类。它装 `shortdrama-cli` 与本仓 skill 包，用户对它说话。
_Avoid_: 客户端, 前端, 界面层

**WorkBuddy Skill**:
装进 harness 内、负责把用户意图编排成 `shortdrama-cli` 调用的短剧生产技能，真身是本仓 `skills/shortdrama-cli/`。
**编导和抽卡师都靠它干活——它就是产品界面，不是命令行的附属说明。**
_Avoid_: WorkBuddy Agent, CLI Agent, 内置编排, 使用文档

**参考栏**:
参考按职责分的槽位，词条来自服务端词表（角色、场景、道具、光影、运镜、参考视频、音频）。
_Avoid_: lane, 分组, 频道

**备戏清单**:
**场级**。这一场戏按参考栏备齐了哪些资产——一张备料单，不是绑定关系。
_Avoid_: 控制包, prep list, 场级控制包

**参考控制包**:
**镜级，一镜一份**。这一镜提交生成时打算带哪几件参考。备戏清单铺下来得到它，也可以逐镜单改。
_Avoid_: 备戏清单, 参考清单, 参考列表

**参考清单**:
提交生成那一刻，参考控制包解析成的**不可变快照**，跟着生成记录走。
_Avoid_: 参考控制包, 草稿

**抽卡任务**:
一件缺失参考的**工单**：这一镜（或这一场）缺哪件资产、要什么样子、派给谁去做。
_Avoid_: 生成任务, 派单, 需求

**抽卡师**:
承接抽卡任务、把提示词调出可用图的岗位，即提示词工程师。真实四岗之一（编导、抽卡师、音频、剪辑）。
_Avoid_: 美术, 美术师, 设计师

**变体**:
同一个角色或场景在不同集数区间或场景下的另一套形态（如「3 岁闪回」「18 岁主线」「狼形」）。
_Avoid_: 版本, 分身, 皮肤

**环境**:
一套隔离的后端与数据，取值 `prod`、`test`、`dev`，与 `docs/contracts/environment-governance.md` 的三环境同名同义。用户唯一需要知道的选择项。
_Avoid_: 站点, 服务器, 部署, local

**受信端点**:
一个环境在网络上的那个地址。它只能来自发行版内置的清单——调用方传进来的 URL 永远不是受信端点。
_Avoid_: api_base, 站点根 URL, endpoint

**会话**:
一次登录的结果，它把「登录到了哪个环境」和这次拿到的凭据绑在一起。
_Avoid_: token, 登录态, 登录信息

## Relationships

- WorkBuddy 不直接调用 `shortdrama-cli`；**WorkBuddy Skill** 负责把用户意图转成 CLI 调用。
- **WorkBuddy Skill** 可以编排一个或多个 `shortdrama-cli` 命令。
- 一个 **业务 Agent** 可以通过执行来源调用一个或多个 **AgentKit Agent**。
- **AgentKit Agent** 不拥有 `shortdrama-cli` 的业务语言；它只执行外部平台能力。
- 一个 **业务 Agent** 可以通过 **拆解 Provider** 执行拆解能力。
- **拆解 Provider** 可以是 mock、本地 LLM API 或 AgentKit。
- **分镜拆解** 依赖 **剧本拆解** 和 **角色拆解**。
- 当用户直接请求 **分镜拆解** 时，CLI 会自动补齐缺失的 **剧本拆解** 和 **角色拆解** 产物。
- 一个 **生成任务** 可以最终产生零个或一个 **媒体产物**。
- 当用户请求图片或视频生成时，CLI 默认等待 **媒体产物**；显式选择不等待时只记录 **生成任务**。
- **运行记录** 同时保留当前任务状态和关键事件历史，但它是运行快照，不是主数据源。
- **服务用例客户端** 通过 **Gateway** 访问在线业务 API。
- **服务用例客户端** 不直接调用模型 provider；复杂智能编排由在线业务 API 或 **AgentKit Agent** 承担。
- **Repository** 保存本地运行快照和输出快照；在线业务 API 才拥有业务主数据。
- **备戏清单** 是场级备料，**参考控制包** 是镜级绑定；把备戏清单铺下去，每一镜各得自己的一份。
- 一场备戏清单可以铺进这一场的任意多个镜头；铺完之后每镜的 **参考控制包** 各改各的，互不影响。
- **参考控制包** 在提交生成那一刻解析成 **参考清单**；此后控制包怎么改，都不影响已生成产物。
- **参考控制包** 里缺的那几件，是 **抽卡任务** 的来源。
- 一个 **抽卡任务** 派给一个 **抽卡师**；他交回的产物入库成资产，回填进对应的参考栏，控制包才算就位。
- 一个角色可以有多个 **变体**；给定「第几集 + 哪个场景」，解析出这一镜该用哪一套。
- **参考控制包** 与 **生成任务** 不是一回事：控制包是这次生成的输入，生成任务是提交之后的异步工作。
- 一个 **环境** 对应一条 **受信端点**；`prod` 是默认环境，用户不指定就是它。
- **受信端点** 是代码不是配置：改它要过 code review 和发版，用户、环境变量和本地文件都改不动它。
- 一次 **会话** 只绑一个 **环境**。换环境就是换一份会话，凭据因此不会跨环境使用。

## Example dialogue

> **Dev:** “这个 **业务 Agent** 要不要直接继承火山云 SDK 的 Agent？”
> **Domain expert:** “不要。**业务 Agent** 是 CLI 内部的生产能力单元；火山云里的实体叫 **AgentKit Agent**，通过 provider 接入。”

> **Dev:** “用户直接跑 **分镜拆解**，但还没有 **剧本拆解** 文件，要报错吗？”
> **Domain expert:** “不要。**分镜拆解** 是更高层生产规划，CLI 应自动补齐上游的 **剧本拆解** 和 **角色拆解**。”

> **Dev:** “视频生成接口只返回 task id，这算 **媒体产物** 吗？”
> **Domain expert:** “不算。task id 只是 **生成任务**；只有拿到可用的视频文件或 URI，才是 **媒体产物**。”

> **Dev:** “一个视频任务 timeout 后又恢复成功，**运行记录** 只写最终成功可以吗？”
> **Domain expert:** “不够。**运行记录** 要能看到当前状态，也要保留 timeout、resume、succeeded 这些关键事件；但它只是运行快照，不是主数据源。”

> **Dev:** “**剧本拆解** 必须通过 **AgentKit Agent** 做吗？”
> **Domain expert:** “不必须。**剧本拆解** 是 **业务 Agent** 的职责；底层 **拆解 Provider** 可以先用 mock 或本地 LLM API，生产平台化时再接 AgentKit。”

> **Dev:** “CLI 里要不要放一个 ImageAgent？”
> **Domain expert:** “不要。图片生成在 CLI 里叫 **服务用例客户端**；真正承担图片提示词编排或素材检索的 agent 应该是 **AgentKit Agent** 或在线业务 API。”

> **Dev:** “`ImageGenerationUseCase` 可以直接调用图片 provider 吗？”
> **Domain expert:** “不可以。CLI 是 orchestration 入口；图片生成应通过 **服务用例客户端** 调 **Gateway**，再访问受权限控制的在线业务 API。”

> **Dev:** “WorkBuddy 自己的 agent 会主动调用 `shortdrama-cli` 吗？”
> **Domain expert:** “不会。WorkBuddy 通过安装 **WorkBuddy Skill** 获得短剧生产能力，由这个 skill 编排 `shortdrama-cli`。”

## Flagged ambiguities

- “Agent” 曾同时指 `shortdrama-cli` 内部执行单元和火山云 AgentKit 实体；已解决：分别称为 **业务 Agent** 与 **AgentKit Agent**。
- “拆解”曾泛指多个动作；已解决：拆分为递进的 **剧本拆解**、**角色拆解**、**分镜拆解**。
- “生成”曾同时指提交异步任务和拿到可用文件；已解决：分别称为 **生成任务** 与 **媒体产物**。
- “manifest” 曾被用作技术文件名；已解决：业务上称为 **运行记录**，文件只承载运行快照，不是主数据源。
- “拆解 Agent” 容易混淆业务职责和执行来源；已解决：业务职责称为 **业务 Agent**，执行来源称为 **拆解 Provider**。
- “ImageAgent / VideoAgent” 曾被放在 CLI 内部；已解决：CLI 内部称为 **服务用例客户端**，AgentKit 内部才使用图片或视频 Agent。
- “WorkBuddy 调用 CLI” 曾被说成 WorkBuddy agent 主动调用；已解决：由 **WorkBuddy Skill** 编排 `shortdrama-cli`。
- “输出 JSON” 曾容易被误解为业务主数据；已解决：`run-manifest.json` 和各类输出 JSON 都是运行快照，主数据在受权限控制的在线业务 API。
- “备戏”与“参考控制包”曾被当成两套竞争方案；已解决：是一条链上的两段，**备戏清单**（场级备料）经 `prep send` 铺成 **参考控制包**（镜级绑定）。
- “参考”曾同时指槽位定义、场级备料、镜级绑定和已锁死的快照；已解决：分别称为 **参考栏**、**备戏清单**、**参考控制包**、**参考清单**。
- “api_base” 曾同时指「用户可以传进来的站点根 URL」和「发行版内置的目的地」；已解决：目的地一律称 **受信端点**，用户能选的只有 **环境** 名（`prod` / `test` / `dev`），传 URL 这条路取消。
- “美术”是 2026-08-06 之前的旧岗位说法，产品负责人当天已改判为真实四岗；已解决：本仓一律用 **抽卡师**。产品真源与 Figma 文案里仍有残留的“美术”，归产品线订正。

## 待办的词汇债

- **业务 Agent / AgentKit Agent / 拆解 Provider** 是 v0.2 时期的语言：那时 CLI 自己跑拆解、自己接模型供应商。v0.3 的 CLI 只消费 `/api/v1`，不在本地跑拆解也不直连供应商，这三个词已经没有对应物。清理时机：等命令面补齐、形状稳定之后一次性重写，不零敲碎打。
- **WorkBuddy Skill 不在上面这批里**——它是现行交付方式，不是历史遗留。产品负责人 2026-08-11 确认：抽卡师装 WorkBuddy（或别的 agent harness），harness 里装 `shortdrama-cli` 与本仓的 skill 包，靠它干活。**`skills/shortdrama-cli/` 就是产品界面本身**，不是命令行的附属说明。

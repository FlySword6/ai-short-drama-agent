# V0.1.1 开发强制规则

## 0. 写代码的八条(2026-08-06 DC 令,优先级高于本文件其余各节的风格建议)

**本质一句话:别像实习生什么都想自己造,要像干了十年的老手一样写代码。**

1. **不保留向后兼容。** 过时的直接删,别加兼容层、别留降级分支。
   > **一处限定(统筹加,不是原文)**:这条说的是**代码里的兼容垫片**。**数据库迁移不在此列**——改表结构必须写迁移文件,那是让线上安全前进的唯一手段,不是兼容包袱。两者别混。
2. **选能满足当前需求的最简单实现。** 不做预防性抽象,不加多此一举的配置层。
3. **系统分层长出来。** 先跑通一个最小的端到端版本,再往上加。**绝不为了还没做的复杂度,拆掉已经能跑的东西。**
4. **组件保持模块化,关注点分离。**
5. **优先用成熟的、有人维护的库。** 没有明确理由不要自己重写。
6. **先翻项目里已有的依赖能做什么**,再考虑加新包或自己写。别一上来就假设库里没有。
7. **架构决策往长了做。** 不接受"先这样以后再换"的临时方案。
8. **先看成熟产品怎么解决同一个问题**,用已验证的模式,别从零发明。

**验收时按这八条查。** 尤其第 1、2、7 条:见到兼容层、预防性抽象、"临时方案"三个词,先问一句"为什么不能直接做对"。


本文件对整个仓库生效。它不是建议。任何人或编码代理开始工作前必须先读本文件，再读与任务相关的合同文档。

## 1. 真源与优先级

发生冲突时按以下顺序处理：

1. 已批准的产品需求：`PRODUCT.md` 与 `docs/contracts/v0.1.1/README.md` 指向的合同。
2. 技术和数据合同：`docs/contracts/v0.1.1/architecture.md`、`api-and-data.md`、`model-and-paid-task.md`。
3. 视觉与设计系统合同（2026-08-03 DC 裁定换代）：唯一真源=Figma「COL 短剧设计系统 · v2」（fileKey=`4JDL0kKz1VxOUNKDqoyEAL`；`05 · Prototype` 页=产品原型唯一参考，原型的 UX 缺陷随产品修复同步修订）。`DESIGN.md`、`docs/contracts/v0.1/design-system.md` 已退役为历史参考（文件头有换代标记；物理归档待架构门禁必查清单改锚窗口，见 `archive/README.md`）。
4. 当前实现、旧文档和历史分支。

退役物坟场=`archive/`（登记册=`archive/README.md`）：工作区不留死物，发现废弃旧物按册归档，不把旧真源、旧原型、一次性脚本留在工作目录误导后续代理。

详细需求、原型和决策保存在 `zhongwen-shortdrama-context` 仓库；本仓库只保存运行代码和开发必须随代码版本化的合同摘要。旧仓、旧分支和截图不能覆盖已批准合同。

## Agent skills

### 任务单在哪

放 GitHub Issues，但**新建入口只能是看板草稿转正**，不许直接 `gh issue create`（DC 2026-08-07 定）。所有代码改动一律先进 `dev` 分支。详见 `docs/agents/issue-tracker.md`。

### 分诊标签

用五个默认标签：待分诊 / 待补信息 / 可交给 agent / 需人处理 / 不修。详见 `docs/agents/triage-labels.md`。

### 领域文档

**词汇表唯一权威 = `zhongwen-shortdrama-context/CONTEXT.md`（context 仓）。** 2026-08-10 产品负责人拍板词汇合一：本仓根那份同名 `CONTEXT.md` 已归档到 `docs/archive/CONTEXT-canvas-glossary-20260728.md`，不再作数。架构决策记录仍在 `docs/adr/`。详见 `docs/agents/domain.md`。

## 2. 统一技术栈

- 前端：React + Vite + TypeScript。
- API：Fastify + TypeScript + Zod。
- 数据访问：Drizzle + PostgreSQL。
- 媒体：火山 TOS。
- 语义检索：PostgreSQL 为正式事实，Milvus 是可以重建的检索投影；Milvus 不可用时必须有 PostgreSQL 降级路径。
- Agent 运行时：Pi Agent Core 嵌入本应用，与 Fastify API 运行在同一个 Node 应用容器和
  VCI `Deployment`，不拆第二套在线运行时。
- 3D 导演台：Three.js / React Three Fiber / Zustand，作为当前 Vite 前端的独立模块接入。
- 正式生产部署：火山 VKE 独立 namespace `shortdrama-prod`，单个 VCI `Deployment`、
  `ClusterIP Service` 与 HTTPS ALB `Ingress`；数据库使用同 VPC 私网 RDS PostgreSQL，
  集群内不部署 PostgreSQL 或 Caddy。V0.1.1 不引入微服务。
- 生产密钥：VKE IRSA 驱动 KMS initContainer 读取唯一凭据
  `shortdrama/prod/runtime`，写入内存 `emptyDir` 后由应用读取；不使用长期 AK/SK 或
  Kubernetes Secret。
- Docker Compose 只用于本地开发和 dev/test 兼容验证，不是生产部署、生产回滚或上线证据。

禁止把 Next.js、NestJS、TypeORM、Supabase、AgentKit 或第二套 Python Web 服务引入生产运行时。Python 只允许用于离线工具或薄 CLI，不承载业务事实和在线编排。

## 3. 架构边界

- HTTP 层只做认证、校验、协议转换和调用服务，不直接写 SQL 或供应商逻辑。
- 业务规则放在 `src/modules` 或 `src/services`。
- 数据库读写放在 repository；外部模型、TOS、Milvus 放在 integration/adapter。
- 前端不能直接调用模型供应商、数据库或 TOS 密钥接口；统一调用本仓库 API。
- 供应商模型 ID、参数和响应差异必须收敛在模型适配层，业务层只使用统一能力合同。
- PostgreSQL 是项目、资产、分镜、任务、版本、责任和审计记录的唯一正式事实来源。
- 不直接合并 `origin/main` 或旧 `zhongwen-shortdrama/zhongwen-shortdrama`。只按能力清单选择性迁移，并适配本合同。

## 4. 付费与自动化红线

- 生图、生视频、生音频均为付费动作。V0.1.1 必须由人明确点击一次，才创建一次任务。
- Pi 可以准备提示词、参考素材、模型和参数，但不能自动提交、自动重试、批量扩张或夜间生成。
- 费用在后台记账与限额；前台不强迫用户逐次估价，但服务端必须执行预算、幂等和权限检查。
- 自动化可以做索引、解析、质检预检、失败归类、草稿准备和待办整理，不得替人做交付判定、预算裁决和发布。

## 4.1 Lite 界面模式红线

Lite（轻量版界面）与完整版是同一个应用、同一个 PostgreSQL、同一个域名下的两套界面，
由 `users.ui_mode`（`'lite' | 'full'`，默认 `'full'`）切换。它不是并行产品线，不得引入第二套
运行时或第二个事实源。施工计划见 context 仓
`docs/plans/plan-shortdrama-lite-ui-mode-2026-08-07.md`。

以下三条是"共用一套数据"必须支付的保险费，对全仓生效：

**R1 · Lite 禁硬删、禁跨项目写；允许项目内可逆操作。**

- Lite 可写：`shots`、`generation_requests`、`media_results`、`generation_default_strategies`、
  `asset_entities` / `asset_media`、`seedance_asset_registrations`，以及**本 Lite 项目作用域内**的
  `episodes` / `scenes`。
- Lite 禁止：任何硬 `DELETE`；任何跨项目写；团队、权限、计费、词表等结构表。
- Lite 允许的可逆操作：分镜隐藏、候选图弃用、改选主图、seedance 注册重试、解析结果放弃。
  项目本身不可删。
- 理由：绝对禁止一切删除会让非技术用户无法自助纠错，当天转人工，同时项目内堆积永久垃圾
  数据反向污染完整版。需要禁的是硬删和跨作用域删，不是全部可逆操作。

**R2 · 界面模式是服务端状态，不是前端偏好。**

- `users.ui_mode` 是唯一事实源，禁止用 localStorage、URL 参数或构建期开关替代。
- 迁移默认值必须是 `'full'`：把现网账号批量切进 Lite 会直接打断完整版的迭代工作。
  业务账号由管理员在建号时显式指定 `'lite'`，或事后单独更新；名单不写进迁移脚本。
- 配套端点：`GET /auth/me` 返回 `ui_mode`；本人改自己的 PATCH 端点；`POST /api/v1/admin/users`
  支持传 `ui_mode`；管理员改他人模式的 PATCH 端点。

**R3 · Lite 路径是一等公民。**

- 完整版的任何改动（新增必填字段、新增审核闸门、修改 zod schema）都必须保证 Lite 路径仍走得通。
  "只改了完整版"不是免责理由。
- 落地手段分两层，**不得把真实付费全链路放进 `npm test`**（那会违反 §4 的付费红线，且每次 CI 都真实扣费）：
  - 进 CI：请求体契约快照测试——Lite 拼出的 `/generations/estimate`、`/generations` 请求体
    必须能通过后端 zod 校验。后端改 schema，Lite 侧测试立即失败。
  - 不进 CI：真实付费全链路走人工冒烟脚本，产出带日期的报告；完整版发版前要求报告不超过 14 天。

## 5. 分支与文件所有权

- 本仓所有新代码的唯一集成线是 `dev`；工作包从最新 `origin/dev` 建独立分支，并通过 PR 回到 `dev`。`integration/v011`、`origin/main` 和旧仓只可作为历史取证或选择性迁移来源，不得作为新工作包基线，也不得直接合并进 `dev`。
- 每个工作包使用独立分支或 worktree。多个写代理只能并行修改互不重叠的模块。
- 开工前记录负责目录；不覆盖、不回退其他人的未提交改动。
- 合并顺序和交接格式见 `docs/contracts/v0.1.1/branching-and-handoffs.md`。

## 6. 测试和完成标准

每次提交前至少运行：

```bash
npm run check:architecture
npm run typecheck
npm test
npm run build
```

界面改动还必须真实渲染并走完受影响路径；不能用“组件存在”代替“用户能完成任务”。付费能力先用不付费合同测试，只有得到明确授权才做真实调用。

任何工作包只有同时满足以下条件才算完成：

- 需求和非目标没有被偷偷改变；
- 正常、空、加载、失败、无权限状态完整；
- 单元/合同/集成测试与改动匹配；
- 类型检查、构建和架构门禁通过；
- 没有密钥、个人路径、测试假数据或供应商原始响应泄露；
- 交接写清已验证、尚未验证和人工复验入口。

### 「闸」的口径（2026-08-12 立，见 ADR-0005）

「闸」这个词在本仓多处出现，含义不止一种（CSS 的 `reduced-motion` 全局闸、额度授权闸、交互上的软引导闸、排期依赖的两闸）。**谈 CI 时以本节为唯一口径：**

> **闸 = 能拦住合并的检查。**

判定一个检查是不是闸，看两件事，缺一不可：

1. **它在 pull request 上跑。** workflow 的 `on:` 里有 `pull_request`；该 job 没写 `if:`，或 `if:` 里是 `github.event_name == 'pull_request'`；跑它的那一步没有把 PR 排除掉的步骤级 `if:`。
2. **它失败时真的红。** 前置条件缺失（典型是 Docker 不可用）时不许静默 `exit 0`，在 CI 里必须非零退出。**跳过≠通过。**

**只在 push 到 dev 之后跑的检查不是闸**——那是合进去之后才跑，拦不住任何一次合并。`verify-postgres` 属于这一类：它是「PR 各自绿不等于合起来绿」的兜底，不是闸。往它里面追加一行，看着像加了 CI，实际等于没加闸。

新增 `test:*-db` 套件时这条由机器判，不靠人记：

```bash
npm run check:ci-db-coverage
```

漏了会红并指名。同一判据也进 `npm run test:node`，所以 PR 上跑得到。

## 7. 安全与停止规则

- 密钥只进入部署平台的密钥管理或本地忽略的环境文件，禁止写入代码、文档、截图、日志和 git。
- 不自行 push、部署、改生产配置、购买资源或触发付费生成；这些动作需要当前任务的明确授权。
- 如果需求与本合同冲突，停止实现并提交最小决策项；不得先写代码再要求追认。
- 若架构门禁失败，不得绕过、删除或降级检查；应修实现或先修改并批准合同。

## 8. kimi worker 工作体系纪律（kimi-main worktree 常驻，2026-08-03 内化）

本节是 kimi 前端主线 worker 的常驻工作纪律，冷启动即生效；长期载体=用户级 skill `shortdrama-worker-os`（本节被合流裁删时可经它重建）。

- 通信：新单=主仓 `outputs/FABLE-KIMI-GOAL-<主题>-<日期>.md`，读单即开工；急件=本 worktree `tmp/<主题>.txt`（三行结论+最小决策项）；回执=本 worktree `outputs/kimi-<主题>-<日期>.md`（交付明细/门禁三数/实证指针/未做与边界/待裁项）。
- 收工：工单点名 tag 打了即收工不扩张；不 push 不合流；commit 只精确 add 本单文件，不夹带他人未提交改动。
- 实证：界面改动真栈（5173 dev+8000 API）渲染走通并截图入 `docs/prototype/shots/`；gitignore 区活文件不算举证件；付费动作不碰。
- 环境：临时件一律本 worktree `tmp/`；同 worktree 串行不并发，开工先 `ps`+`git status` 查双头，inject 针与交互会话同 session 时后到者转核实位；单活跃会话下实测登录会踢 DC 浏览器会话，回执必提醒重登。
- 自决：遇疑先查 dc-verdicts 与 `docs/planning/orchestration.md` 轨迹，有轨迹按轨迹自决并记录依据，无轨迹才发急件请裁。
- 领活：看板自荐按集成区 `docs/planning/delivery-workflow.md`「看板与领任务」节，开工登记负责目录。
- 门禁：typecheck 0+相关守卫绿+build 过；全量 npm test 基线红 stash 实证非我引入、单列报裁，不越界替改；回执脱敏（无密钥/个人路径/假数据/供应商原始响应）。

# 参与开发指南

这份文件给**第一次进这个仓库的人和他的 AI 助手**看。不假设你了解我们内部的任何背景,
从零开始讲:代码怎么在你自己电脑上跑起来、改完怎么交、有哪些自动检查会拦你、
以及界面改动要遵守什么设计规矩。

已经在这里长期干活的 AI 执行者(kimi / sol 等)另看 `AGENTS.md`——那份是全仓强制规则,
本文件是入门说明,两份不冲突。

**一句话流程**:领一个 issue → 从这个 issue 开一条分支 → 改代码 → 本地跑 `npm test` →
开 PR 并在正文里写 `refs #编号` → 统筹(Fable)复查后合并。你不需要自己合并,也不要直接往主分支推。

---

## 一、先把本地跑起来

有两条路。**只改界面样式和文案,走路线 A 就够了**,不用装数据库,也不用碰任何配置文件。

### 路线 A · 只跑前端(改样式、改文案、看页面)

完整版见 `docs/setup-frontend-local.md`(2026-07-29 在干净检出上实跑验证过)。要点:

```bash
git clone https://github.com/col-shortdrama/zhongwen-shortdrama-main.git
cd zhongwen-shortdrama-main/frontend/shortdrama-rag-demo
npm install
SHORTDRAMA_DEV_API=https://shortdrama-main-test.col.com npm run dev
```

浏览器打开它提示的地址(一般是 http://localhost:5173)。数据和接口走**测试环境**,
所以你看到的是真实数据、真实交互,不用自己搭后端。登录账号找 DC 要。

Windows(PowerShell)把最后一条换成:

```powershell
$env:SHORTDRAMA_DEV_API="https://shortdrama-main-test.col.com"; npm run dev
```

**地址必须 `https://`**:测试环境入口只开了 443,写成 `http://` 连不上,现象是页面能开、数据全空。

> **安全提醒**:走路线 A **不需要 `.env` 文件、不需要 Docker、不需要数据库、不需要证书**。
> 有人给你一份 `.env` 让你"配一下",请直接拒绝并告诉 DC——之前流传过一份模板,
> 里面连的是生产数据库,拿它跑本地会直接写到线上。

### 路线 B · 整套跑在自己电脑上(要改接口、改数据的时候)

三个部件:**前端 5173 / 后端 8000 / 数据库 PostgreSQL**。完整版见 `docs/dev/local-environment.md`。

**前置**:Node.js 22.19 或更高(`node -v` 确认)、Docker Desktop(用来起本机数据库)。
不需要 Milvus、TOS、模型厂商的 key——本地开发这些留空,应用照常启动,语义检索自动走
PostgreSQL 的降级路径。

```bash
npm install         # 首次
npm run dev:up      # 起数据库 + 建表 + 建管理员 + 播一点演示数据(可以反复跑)
npm run dev         # 启动后端,监听 8000
```

`dev:up` 会自动把 `.env.example` 复制成 `.env`,里面已经带好本机管理员的用户名和密码
(`DEV_ADMIN_USERNAME` / `DEV_ADMIN_PASSWORD`),中途不用手工改任何配置。想换密码就改
`.env` 里那一行,再 `npm run dev:reset` 重建——注意长度不能少于 `AUTH_PASSWORD_MIN_LENGTH`
(默认 8),短了建管理员那步会直接拒绝。

跑完之后**8000 只提供接口,页面不在那儿**。再开一个终端把前端起起来:

```bash
cd frontend/shortdrama-rag-demo
npm run dev         # 5173,/api 默认代理到本机 8000,改完保存浏览器自动刷新
```

打开 http://localhost:5173 ,用户名 `admin`(取自 `.env` 里 `ADMIN_USERNAMES` 的第一个),
密码就是 `.env` 里 `DEV_ADMIN_PASSWORD` 的值。改了密码要 `npm run dev:reset` 才生效。

只改接口不看页面的话可以不起前端;这时直接打开 http://localhost:8000 会有一页指引告诉你页面在哪。
想让 8000 自己出页面,在仓库根目录跑一次 `npm run build:frontend`——它产出的是一份快照,
改了前端源码不会自己更新,边改边看还是用 5173。

**本机端口的意思**(2026-08-03 定的规矩,不要自己另起端口):

| 端口 | 是什么 |
| --- | --- |
| 5173 | 前端开发服务器,改完保存浏览器自动刷新;`/api` 默认代理到 8000 |
| 8000 | 本机唯一正式后端 API |
| 8080 | 历史遗留端口,已退役。除非你自己显式在 8080 起了后端,否则别指过去 |

**红线**:本地开发**绝不许把数据库指向云上**。`scripts/dev-guard.mts` 会在 `dev:up`、
`dev:reset` 和 `npm run dev` 启动时检查,认出云端主机名直接拒绝启动。这不是可以商量的配置项。

日常命令:`npm run dev:down`(停库保数据)、`npm run dev:reset`(推倒重来)、
`npm run dev:seed`(只重播演示数据)。排障表见上面两份文档各自的末尾。

---

## 二、分支和 PR 怎么走

我们走标准的 GitHub 流程,不自己造一套。

### 1. 从 issue 开分支

**每一单活都先有一个 issue**,分支从这个 issue 上开出来,GitHub 会自动把两者关联起来。
两种开法都行:

```bash
gh issue develop 42 --base dev --checkout
```

或者在网页上打开这个 issue,右侧 Development 区点 **Create a branch**,base 选 `dev`,
然后 `git fetch && git checkout <分支名>`。

日常开发分支是 `dev`,不是 `main`。分支名带上 issue 编号(上面两种方式都会自动带上)。

看板在这里:https://github.com/orgs/col-shortdrama/projects/1 ——领活、看进度都在这。
卡的状态由统筹拨,你不用自己拨;想接某张卡,在 issue 里说一声。

**分支开在本仓,不要从自己 fork 提 PR。** 本仓是私有仓,Actions 设置是
`run_workflows_from_fork_pull_requests: false`——fork 来的 PR **不会创建任何 workflow run**。
不是在等人批准,是根本不跑。你会看到一张一个检查都没有的 PR,界面上像"没有阻塞",
实际是"一次都没验"。#148 和 #294 都因此零 CI,#148 补跑后 2 个 job 是红的。

没有本仓 push 权限就在 issue 里说一声,让统筹给你开分支。

### 2. 提交

- 一个提交只解决一件能说清楚的事。
- 提交信息用 `type(scope): 一句话`,例如 `fix(assets): 资产列表空态文案改成人话`。
- 不把代码格式化、数据库迁移和功能改动混在同一个提交里。
- 改了数据结构要附迁移脚本、回滚说明和兼容策略。
- 改了对外接口要同步改 Zod schema、OpenAPI、所有调用处和合同测试。
- **只提交你自己这一单的文件**,不要 `git add -A` 把别人未提交的改动一起带走。

### 3. 推之前先跑一遍全量测试

```bash
npm test
```

仓库装了 pre-push 钩子,但它**只跑快的那批**(`npm run test:node`,约 85 秒),**红了直接拒推**,
日志在 `/tmp/prepush-gate.log`。真 PG 测试各起一个 postgres 容器、整轮十分钟以上,
2026-08-06 起挪给 GitHub。
所以本地这一遍全量还是得自己跑,钩子不替你跑。

快车道排除哪些文件,2026-08-12 起**按文件名后缀判**,不再逐个列举:
`-db.test.ts`、`.db.test.ts`、`-postgres.test.ts` 三类共 51 个文件不进 `npm run test:node`,
其中 36 个是这次新排除的(此前那份手工名单只列了 15 个)。
命名之外还有一层按行为判的守卫(`tests/fast-lane-container-guard.test.ts`):
快车道里任何文件都不许 `docker run`。它和 `check-ci-db-coverage` 各管一头——
后者管「上了 `test` 链的套件有没有 PR 闸」,前者管「不该留在快车道的有没有溜进来」。

⚠️ **新排除的 36 个里只有 9 个被 `scripts/run-*-db-test.sh` 或 `.github/workflows/` 引用**,
其余 27 个既不在 `npm test` 链、也不在任何 CI job。它们本来就因为没设
`<X>_TEST_DATABASE_URL` 而整文件 skip(实测 37 个用例 `pass 0 / skipped 37`),
所以这次排除没丢真覆盖——但**"没验"这件事以前还能从 skip 计数上看见,现在看不见了**。
要补齐得给它们各写一个 runner 并上 PR 闸,那是另一单,尚未排期。
不要用 `--no-verify` 绕过——绕过去的问题会在 PR 上原样拦住。

### 4. 开 PR

base 选 `dev`。**PR 正文必须有这几段**:

```markdown
refs #42

## 改了什么
用户会看到的变化,一两句人话。

## 判据自评
1. <把 issue「怎么算做完」里的第 1 条抄过来> —— 做到了,证据:<截图 / 测试名 / 命令输出>
2. <第 2 条> —— 做到了,证据:……
3. <第 3 条> —— 没做,原因:……

## 跑了哪些检查
npm test:总数 / 通过 / 跳过 三个数照抄输出
界面改动:在浏览器里真点过哪几条路径(附截图)

## 没验证的部分
诚实写。写"没验"不丢人,把没验的说成验过才是事故。

## 是否涉及
数据迁移 / 费用 / 权限 / 模型供应商 / 部署配置 —— 有就写清楚,没有就写"无"。
```

**判据要逐条自评**,不要写"全部完成"。跳过的、没做的照实写——复查的人靠这个决定要不要自己复跑。

### 5. 合并由统筹做

Fable 复查 → approve → squash 合并。**你不需要、也不要自己点合并**,更不要直接往
`dev` / `test` / `main` 推代码。

`test` 这条尤其硬:**它是 `dev` 的纯下游**,正常情况下只接 `Merge dev into test`,
不接任何原生提交。唯一例外是 hotfix —— `test` 环境**当前是坏的**,而且修复只碰
CI、构建、配置,不碰产品代码;做法是**先在 `dev` 上修,再 cherry-pick 到 `test`**,
反过来不行。CI 上有一道门禁(`.github/workflows/test-branch-discipline.yml`)按
patch 等价判,在 `dev` 上找不到等价补丁的提交会当场红。
为什么这么定、当初是怎么撞出来的,看 [ADR-0004](docs/adr/0004-test-branch-downstream-only.md)。

界面类改动会被人在浏览器里真走一遍才算过:**"源码里搜得到"不等于"用户点得到"**。

### 6. 后端改动的推荐顺序

如果你改的是接口和数据(不只是样式),按这个顺序做返工最少:

1. 先写或更新合同测试,把输入、输出、权限、幂等和失败行为固定下来;
2. 在模块内部完成业务规则;
3. 通过 repository / integration 接数据库和外部供应商;
4. 最后接页面和用户旅程,把**正常 / 空 / 加载中 / 失败 / 没权限**五种状态补全;
5. 跑完整检查,再用真浏览器复走一遍受影响的路径。

---

## 三、门禁清单(第一个 PR 最容易撞的四道)

这四道都是机器判据,不是建议。撞了当场红,而且报错会点名到文件和行号。

### ① 术语门禁:活文档里有一批词不能写

**扫描范围**:`docs/design/`、`docs/planning/`、`docs/contracts/`、`docs/adr/`、`CONTEXT.md` 下的所有 `.md`。
历史归档目录(`docs/research/`、`docs/goals/`、`docs/proposals/`、`docs/deploy/` 等)故意不扫——
它们记录的是当时怎么说的,回头改措辞反而失真。

**自己先跑一遍**:

```bash
npx tsx --test test/doc-terminology.test.ts
```

**完整禁词表**(共 14 个,和 `test/doc-terminology.test.ts` 里的 `bannedTerms` 一字不差):

| 不能写 | 改成什么 |
| --- | --- |
| 金路径 | 写「全流程」;那份剧本就叫《一集戏的一天》 |
| 北极星 | 写「总目标」;文件是 `docs/design/product-goal.md` |
| 闭环 | 写「走得通 / 走通」,断掉的地方叫「断点」;系统里的反馈循环叫「回路」 |
| 落地 | 写「做出来 / 做完 / 上线」 |
| 链路 | 写「流程」 |
| 全链 | 写「全流程」 |
| 落点 | 写「放在哪 / 谁做」 |
| 死枝 | 写「死代码」 |
| 抓手 | 办公室黑话;直接说要做的那件事 |
| 赋能 | 办公室黑话;直接说帮谁做成了什么 |
| 颗粒度 | 写「粗细 / 拆到多细」 |
| 心智 | 写「认知 / 用户怎么理解」 |
| 打通 | 写「接上 / 跑通」 |
| 拉齐 | 写「商量 / 定下来」 |

两个已知的例外:「落地页」(landing page,产品名词)不算命中,脚本里已经摘掉了;
「对齐」不在表里,因为技术义(字段对齐、时间码对齐)和沟通义长得一模一样,机器分不开——
**宁可漏判,不可误报**,这条继续靠人看。

确实属于这三类之一——**说明用词规则本身 / 引用别人的原话不改写 / 记录"库里存的还是旧词"这类事实**——
在那一行任意位置加豁免标记放行,建议带上理由:

```markdown
这一行说明规则本身 <!-- lint:allow-term 规则说明本身 -->
```

标记不能空挂:那一行已经没有禁词了却还留着标记,也会红(它会变成一个默认静音开关)。

**你写的新文档同样受这套约束**,PR 描述里的措辞也照这个口径写——虽然机器不扫 PR 正文,但人会看。

### ② 推之前跑全量测试

```bash
npm test
```

pre-push 钩子只强制跑快的那批,失败拒推;数据库那批在推到 `dev` 之后由 CI 跑,本地全量得自己跑
(细节见上面「推之前先跑一遍全量测试」)。报结果时**三个数一起报:总数 / 通过 / 跳过**。
跳过不是中性的,它的意思是"这条没验"。

想一次跑齐本地全套检查:

```bash
npm run check:architecture   # 架构门禁
npm run typecheck            # 类型检查
npm test                     # 全量测试
npm run build                # 构建
```

CI 在 PR 上会重复这些——**前提是分支开在本仓**。fork 来的 PR 一个检查都不跑(见上面
「分支开在本仓」),那种 PR 上的绿是没有的,不是通过。**任何失败都得修实现**,不能靠跳过测试或放宽规则蒙混过去;
架构门禁红了也不许绕过、删除或降级——要么修代码,要么先改合同并获批。

### ③ 动了版本计划文件,要把它同步进数据库

`docs/design/version-plan.md` 是版本计划的编辑源,数据库是运行时真源。
改完这个文件**必须跑同步脚本**,否则一致性门禁会逐字比对文档和库,差一个字就报红。

```bash
# 前提:npm run dev:up 和 npm run dev 都跑着,8000 能访问
export RELEASE_PLAN_SYNC_API_BASE=http://localhost:8000
# 管理员用户名密码取本地 .env,别写进命令历史,也别写进文档
npx tsx scripts/sync-release-plan.mts              # 先看 dry-run 打印的计划
npx tsx scripts/sync-release-plan.mts --apply      # 确认没问题再真写
node --import tsx --test tests/release-plan-truth-sync-db.test.ts
```

最后那条的输出必须明确写着连的是本机 dev 库(`localhost:5432`),而且 `0 fail`。
**注意**:本机可能同时存在两套 PostgreSQL,对着 8080 那套跑同步不会更新门禁读的那个库,
即使命令显示"写入完成"也不算数。细节见 `docs/dev/local-environment.md`「两套本地栈不要混用」。

一般情况下你不需要动这个文件——版本计划由统筹维护。

### ④ 用户能看到的文案一律用业务中文

界面上任何用户能看到的字,**不许出现厂商名、HTTP 状态码、英文错误原文、内部状态机名字,
也不许出现开发过程的自述**。两个守卫盯着这条:

- `frontend/shortdrama-rag-demo/src/s17-dev-copy-guard.test.ts`——扫全部前端源码,
  命中「缺口」「mock」「基线」「端点」「接口接入」「暂未接通」「待管理员核实」这类开发词就红。
  白名单机制存在但当前是空的,**它应该永远是空的**。
- `frontend/shortdrama-rag-demo/src/error-copy.ts` 和同名测试——错误提示必须走
  `businessErrorMessage()`,裸英文不许上屏。已知的后端错误串有一张翻译表;
  没见过的英文错误给一句通用中文话术,原文进 `console.warn` 留着排障用。

反面例子(真出过):`Ark submission outcome is unknown` 原样显示给了用户。
正确写法:「提交结果暂时未知,请稍后到任务列表看状态」。

用户空间只允许两种状态:**能用**,或者用用户听得懂的话说「即将上线 / 请联系管理员」。
"这个功能等后端接口"这种话是我们内部的账,不进界面。

---

## 四、工程红线(三条,没有例外)

1. **不打补丁**。问题回到根因,该推倒重写就重写。不叠一层 `if` 绕过去,
   不复制一份旧逻辑改个参数当新功能。
2. **不留残渣**。不留备份副本文件(`xxx-old.tsx`、`xxx.bak`)、不留死代码、
   不留注释掉的代码块。写错了就改正,不保留中间态——想找回旧版本用 git。
3. **注释只写"为什么"**。"做什么"靠命名表达。
   `// 遍历列表` 是噪音;`// 这里必须串行:供应商并发超过 2 会限流` 才是注释。

---

## 五、界面改动:设计怎么还原

**视觉真源是 Figma「COL 短剧设计系统 · v2」**(fileKey `4JDL0kKz1VxOUNKDqoyEAL`),
其中 `05 · Prototype` 页是产品原型的唯一参考。仓库里的 `DESIGN.md` 和
`docs/contracts/v0.1/design-system.md` 已经退役成历史参考,**不要照着它们做**。

**颜色、字号、间距一律用现成的设计变量,不许在组件里硬编码。** 变量文件:

| 文件 | 装什么 |
| --- | --- |
| `frontend/shortdrama-rag-demo/src/styles/tokens.css` | **新页面只引这一份**。`tk-` 体系唯一源,值从 Figma Foundations 三个变量集合(Color/Spacing/Radius)直出,禁手抄禁凭记忆 |
| `frontend/shortdrama-rag-demo/src/tokens.css` | 上一代语义变量(`--surface-*`、`--ink-*`、`--accent` 等),存量页面在用 |
| `frontend/shortdrama-rag-demo/src/oriental.css` | 上一代皮肤层 |
| `frontend/shortdrama-rag-demo/src/styles/tk-base.css`、`styles/ui-base.css`、`styles/tk-login.css` | `tk-` 体系的基础样式、通用控件样式、登录页样式 |
| `frontend/shortdrama-rag-demo/src/legacy-archived.css` | 已归档。新页面引用它会被 `tk-legacy-archive-guard.test.ts` 拦下 |

写死一个 `#3fe0c5` 或者 `padding: 13px`,复查会退回。找不到合适的变量就在 issue 或 PR 里问,
不要自己造一个新灰、新间距。

几条经常被违反的视觉规矩(出自 Figma Readme 页):**无边框法则**(border 只留给表单、
分隔线和焦点态)、**一屏之内强调色不超过 3 处**、**一个区域只能有一个主按钮**。

---

## 六、这个仓库里的文档去哪找

`docs/INDEX.md` 是整个文档目录的地图——每个子目录一行,说清楚它管什么、是现役还是历史,
还带一张"原来在哪 / 现在去哪找"的查询表。**找文档先看它,不要靠猜目录名。**

日常最常用的几份:

- `docs/setup-frontend-local.md` —— 前端本机环境(路线 A 的完整版)
- `docs/dev/local-environment.md` —— 整套本地环境(路线 B 的完整版)
- `docs/planning/file-ownership-map.md` —— 谁在改哪些文件,接单前先查这张表
- `AGENTS.md` —— 全仓强制规则:技术栈、架构边界、付费红线、安全停止规则
- `README.md` —— 服务入口、健康检查、接口文档在哪
- `SECURITY.md` —— 安全问题怎么报

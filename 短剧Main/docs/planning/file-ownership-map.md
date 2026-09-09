# 文件面避让表:谁正在动哪些文件

**接单前查这张表。** 看你要改的文件有没有人正在改——重了先说一声,别两边同时动同一批文件。

快照时间:2026-08-04。维护规矩见文末。

## 怎么用(三步)

1. **接单前**对着下面「文件面」那一列扫一眼,看你这单要动的文件在不在里面。
2. **重了**:在 issue 里写一句「这单会动 X 域,和 <谁> 正在做的重了」,然后等统筹回话。
   统筹会给出处置:排前后、把边界拆开、或者换一单先做。
3. **没重**:直接开工,在 issue 里登记一句你要动的目录,方便下一个人查。

两条不许自己决定的事:**不要因为重了就直接去改别人的文件**;**不要自己定谁先谁后**。

## 当前在途

### kimi 主线 · 生成域(前端)

分支 `feature/v011-frontend-mainline`,工作目录 `.worktrees/kimi-main`。

| 文件面 | 具体文件 |
| --- | --- |
| 页面 | `frontend/shortdrama-rag-demo/src/pages/segment-workbench-page.tsx`、`workbench-page.tsx`、`batch-generate-drawer.tsx`、`queue-page.tsx`、`reference-tests-page.tsx` |
| 组件 | `frontend/shortdrama-rag-demo/src/components/reference-lanes.tsx`、`gen-params-popover.tsx`、`task-queue-entry.tsx`、`asset-pick-drawer.tsx` |
| 逻辑模块 | `frontend/shortdrama-rag-demo/src/` 下的 `capability-tiers.ts`、`reference-lanes.ts`、`lane-vocabulary.ts`、`lane-generation-tracker.ts`、`generation-dimensions.ts`、`generation-task-queue.ts`、`generation-task-recovery.ts`、`generation-quotes.ts`、`tier-selection.ts` |

在做的事:多模型前端接线——档位选择、参考栏、生成任务队列这一片。

### sol 主线 · 生成与模型供应商(后端)

分支 `feature/v011-backend-mainline`,工作目录 `.worktrees/sol-main`。

| 文件面 | 具体文件 |
| --- | --- |
| 生成模块 | `src/modules/generation/`(含 `provider/` 下各家适配器、`repository.ts`、`service.ts`、`routes.ts`、`worker.ts`、`cost.ts`) |
| 档位模块 | `src/modules/capability-tiers/` |
| 外部对接 | `src/integrations/`(`arkClient.ts`、`tosStorage.ts`、`arkAssetRegistry.ts` 等) |
| 音频 | `src/modules/audio/` |

在做的事:多模型后端——各家模型接进来、算钱、结果存盘、供应商白名单守卫。

### sol-2 · 运营底座与注册(后端)

分支 `26-ops-foundation-p0`(从 issue #26 开出),工作目录 `.worktrees/sol2-ops-p0`。
**这一单是标准 GitHub 流程的试点单**:从 issue 开分支 → 开 PR → 复查后合并。

| 文件面 | 具体文件 |
| --- | --- |
| 账号与积分 | `src/modules/account-credits/` |
| 管理后台用户 | `src/modules/admin/users/` |
| 登录注册 | `src/modules/auth/` |
| 数据结构 | `migrations/049_ops_p0_internal_pilot.sql`、`src/db/schema.ts` |
| 配置 | `src/config/env.ts` |

在做的事:内测注册流程——邀请码注册、账号建起来、积分能用。

### Opus · 设计与视觉(2026-08-04 起)

不占固定分支,按单开。

| 文件面 | 具体文件 |
| --- | --- |
| 原型与设计文档 | Figma 文件本身、`docs/prototype/`、`docs/design/` 下的设计规格 |
| 视觉修复时会碰 | `frontend/shortdrama-rag-demo/src/styles/`、`tokens.css`、`oriental.css` 以及被点名的页面文件 |

在做的事:产品原型、设计规范、全站视觉复查与修复。
**改设计变量文件(`styles/tokens.css`)之前,一律先在 issue 里问一句**——那份是全站唯一的变量源,
改一个值全站都跟着变。

## 高争用文件(谁都可能碰到)

这些文件不属于任何一个人,但同时被好几条线读写。动它们的时候:**改动要小、单独开一个提交、
在 PR 正文里点名说明改了哪几行**。

| 文件 | 为什么容易撞 |
| --- | --- |
| `frontend/shortdrama-rag-demo/src/api.ts` | 所有前端接口调用都在这一份里 |
| `frontend/shortdrama-rag-demo/src/types.ts` | 前端共用的类型定义 |
| `src/db/schema.ts` | 数据表结构,后端各模块都读 |
| `src/config/env.ts` | 配置项清单 |
| `migrations/ledger.json` + `migrations/` 下的编号 | 迁移编号是全仓一条序列,两个人同时取号会撞。**取号前先问统筹** |
| `package.json` / `package-lock.json` | 依赖锁文件,CI 有一致性检查,冲突了很难合 |
| `docs/design/version-plan.md` | 版本计划,和数据库有一致性检查,改完要跑同步脚本 |

## 真人协作者一般是安全的

改**样式和文案**基本不会和上面几条线撞——他们在改行为和数据,不在改视觉。
两个例外,碰之前先问:

- `frontend/shortdrama-rag-demo/src/styles/tokens.css`——全站设计变量唯一源;
- 上面在途表里点名的那些页面文件——正在被改,你的改动可能被合并冲突吃掉。

## 维护规矩

- **每次派单,统筹更新这张表**:新单加一行,交付合并后把那一行删掉。
- 表里**没有**的文件 = 当前没人占,可以接。
- 这是**手工维护的快照,不是自动生成的**。看到快照日期距今超过一天,
  先在 issue 里问一句再动手,别把过期的表当准信。
- 有人自己去改了别人的文件面而没打招呼,按事故处理——不是因为改错了,
  是因为两边同时改同一批文件,合并的时候一定有一边的工作被吃掉。

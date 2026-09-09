# docs 索引 · 整个文档目录的地图

新会话、新 worker 接手,先看这一页。**每个子目录一行,说清楚它管什么、是现役还是历史。**

建立时间:2026-08-04。

## 一、现役真源五件(冷启动只读这五份)

| 顺序 | 文件 | 管什么 |
| --- | --- | --- |
| ① | `planning/orchestration.md` | 现在在做什么、谁在做。需求收件箱、巡检记账、迁移号台账、维护规矩 |
| ② | `design/version-plan.md` | 做什么、什么时候做。版本计划与卡片排期(与数据库同步,有门禁盯着,别手改格式) |
| ③ | `planning/fable-handover.md` | 统筹交接书:巡检七步、验收检查单、催办模板、通信约定 |
| ④ | `planning/delivery-workflow.md` | 一个包从派单到合流到发版,每个环节的规矩 |
| ⑤ | `design/product-goal.md` + `planning/project-context-brief.md` | 这产品要成为什么 + 项目背景速览 |

常用的还有两份:`planning/system-graph.md`(工作系统本身怎么设计的)、`design/dc-verdicts.md`(DC 拍过的板)。

## 二、子目录一览

| 目录 | 文件数 | 管什么 | 现役还是历史 |
| --- | --- | --- | --- |
| `planning/` | 9 | 编排账本、交接书、交付流程、系统图、项目速览、思考本 | **现役**(其中 `orchestration-archive-202607.md` 是 7 月历史段) |
| `design/` | 43 | 产品目标、版本计划、设计规格、词表、DC 裁决台账、UX 指标 | **现役** |
| `contracts/` | 42 | 各版本的接口合同、数据模型、字段字典 | **现役**(v0.1 那批是历史合同,`v0.1.1/README.md` 交代过它们的解释性地位) |
| `prototype/` | 171 | Figma 原型的构建手册、组件清单、评审实证件 | **现役**。实证件被 R 编号引用,链接不能断,本次治理只入索引不移动 |
| `validation/` | 552 | 每个交付包的验证证据:跑了什么、结果多少、谁验的 | 混合。根目录 39 份现役,7 月的 186 份在 `validation/archive/2026-07/`,截图子目录不动。**看 `validation/INDEX.md`** |
| `goals/` | 11 | 早期任务书原件 | 历史。结论已进版本计划与编排账本,留档备查 |
| `proposals/` | 6 | 方案提议稿 | 历史。采纳的已进设计文档 |
| `deploy/` | 4 | 部署差异对照与迁移步骤 | **现役**,发版时查 |
| `adr/` | 3 | 架构决策记录 | **现役** |
| `operations/` | 1 | 运营后台相关 | **现役** |
| `releases/` | 1 | 发版记录 | **现役** |
| `handoffs/` | 1 | 对外交接件 | 历史 |
| `dev/` | 1 | 开发环境说明 | **现役** |
| `runtime/` | 1 | 运行时说明 | **现役** |
| `research/` | 2 | 外部需求原件与对账调研,两份都还被正文引用 | **现役** |
| `archive/` | 152 | 办完的专题目录整体搬进来。**看 `archive/INDEX.md`** | 历史 |

## 三、docs 根目录散着的几份

早期写的接口与资产说明,没归到子目录,内容仍然有效:

| 文件 | 管什么 |
| --- | --- |
| `api_integration_guide.md` | 接口接入说明 |
| `asset_ingest_context.md`、`json_asset_ingest_api.md` | 资产入库的上下文与接口 |
| `asset_vectorization_fields.md` | 资产向量化字段 |
| `director-assets.md`、`director-backend.md`、`director-templates.md` | 导演台的资产、后端、模板三份说明 |
| `setup-frontend-local.md` | 前端本地跑起来怎么配 |
| `typescript_migration_runbook.md` | TypeScript 迁移操作手册 |
| `短剧资产.md` | 资产分类的中文说明 |

## 四、找不到某个文件时

2026-08-04 做过一次文档整理,只移动、没删过任何东西,也没改过任何文件的内容。三张查询表:

| 原来在哪 | 现在去哪找 |
| --- | --- |
| `docs/validation/<文件名>` | `docs/validation/archive/2026-07/<文件名>`,或搜 `docs/validation/INDEX.md` |
| `docs/research/mockups-html-era/`、`docs/rag提升文档/` | `docs/archive/` 下同名目录,见 `docs/archive/INDEX.md` |
| `docs/planning/orchestration.md` 里的 7 月内容 | `docs/planning/orchestration-archive-202607.md`,原文一字未改 |

工作区那边(不在这个仓库里)另有两张表:`outputs/INDEX.md` 管产出文件,`Archive/loose-docs-2026/INDEX.md` 管从工作区根收起来的游离文档。

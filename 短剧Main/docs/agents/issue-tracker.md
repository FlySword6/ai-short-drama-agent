# 任务单在哪：GitHub Issues（自动进入版本计划）

本仓的任务单和需求单都放在 GitHub Issues 里，用 `gh` 命令行工具操作。

## 本项目的硬规矩：建卡后必须关联 Milestone 与版本（DC 2026-08-22 定）

允许直接使用 `gh issue create` 新建任务单。组织级 Projects 第 1 号「短剧平台·版本计划」已开启 main 仓全量 Issue auto-add，新开的 Issue 会自动进入看板，不要再手工建一张重复草稿。

Issue 建好后必须补齐两项独立归属：

1. GitHub Issue 的 `Milestone`；
2. Projects #1 中该卡的「版本」字段。

同时按卡面补齐类型、归属组、优先级和负责人。**缺少 Milestone 或「版本」任一关联，这张票就不合格，不得进入派工或实现。**

拍板原话（DC 2026-08-22）：「那别禁了。。。可以直接建，建完和 projects 里 milestone 和版本关联上就行」。

历史来由（2026-08-07）：当时存在过「代码都合了、任务单还开着」的账实不符，一次清掉 7 张，所以曾要求先建看板草稿再转正式 Issue。

退休依据（2026-08-22）：Projects auto-add 已改为 main 仓全量开卡并开启，直接建 Issue 也会自动进看板；旧禁令不再承担同步作用。

技能若说「发到任务单系统」，动作 = 直接建 Issue，再读回并补齐 Milestone 与 Projects「版本」字段；不是只建单不关联。

## 常用操作

- **看一张单**：`gh issue view <编号> --comments`
- **列开着的单**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label` / `--state`
- **评论**：`gh issue comment <编号> --body "..."`
- **加/去标签**：`gh issue edit <编号> --add-label "..."` / `--remove-label "..."`
- **关单**：`gh issue close <编号> --comment "..."`

仓库地址 `gh` 会自己从 `git remote -v` 认出来（`col-shortdrama/zhongwen-shortdrama-main`），在仓库里跑就行。

## 外部提交的代码要不要进分诊队列

**外部 PR 当需求入口：否。** _(想开就把这行改成"是"，分诊技能读这个开关。)_

## 一个相关规矩：所有代码改动只从 dev 进（DC 2026-08-05 定）

不管是 AI 写的、公司同事写的、还是外部合作方写的，一律提 PR 到 `dev` 分支。`test` 分支只是部署面，只从 `dev` 单向合过来，不直接收 PR。

外部同事的 PR 如果基线太旧（实测有过落后 751 笔的），**不是改个目标分支就完事**，要搬到 dev 上适配并保留原作者署名（`Co-authored-by`）——让人重做等于赶人走。

## 找单时的做法

技能若说「取相关任务单」：`gh issue view <编号> --comments`。

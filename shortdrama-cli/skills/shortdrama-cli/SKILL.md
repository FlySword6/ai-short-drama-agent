---
name: shortdrama-cli
description: 使用 shortdrama CLI 操作中文在线短剧的项目、剧本、资产、备戏、生成、队列、审核和交付。所有生产写入通过短剧站点的 /api/v1 完成。
---

# Shortdrama CLI v0.3

只调用 `shortdrama`（程序正文）或发行的 `shortdrama-cli`。先读后写：先查询项目、集、资产、备戏或状态，再执行写命令。默认使用 JSON 输出；后端目的地由 CLI 内置受信端点清单决定。命令行 `--env` 优先，其次是自动化的 `SHORTDRAMA_ENV`，再是登录记住的环境，最后才是 `prod`；三者都只接受 `prod|test|dev`，不接受 URL。登录时用 `shortdrama auth login --env prod|test|dev` 选环境，密码只走交互式输入且提示走 stderr；自动化用 `SHORTDRAMA_API_TOKEN` 加 `SHORTDRAMA_ENV` 注入。明文 HTTP 端点的连接警告只出现在 stderr，不影响 JSON 信封。

生产没有 API 配置时必须停止并报告失败，不能编造成功。发行版没有 mock 成功模式；测试替身只存在于测试进程内。

首次使用先运行 `shortdrama doctor`；登录后运行 `shortdrama doctor --require-auth`。诊断失败时停止，不绕过 Release、Skill 版本或认证检查。

服务端要求幂等语义的写命令带有 `client_idempotency_key`（缺省由 CLI 生成）；其余命令不得臆造该参数。不得从输出、日志或任务产物读取或复述密码、token。

付费生成严格执行三步：`generation estimate` → 人工审阅报价 → `generation confirm` → `generation submit`。批量使用 `batch-estimate` → 人工审阅 → `batch-confirm` → `batch-submit --authorization-id ...`。抽卡工作台没有自己的运行通道：照样走上面这三步，拿到产物后用 `reference-test result-attach` 挂进对应的测试。禁止 `--yes`、自动确认、自动提交或一键 pipeline。

备戏 `prep send` 默认只提交 `item_ids` 并登记场级就位，不触碰控制包。需要镜头时显式重复 `--shot`；铺满全场只能使用 `--all-shots --i-mean-it`，两者不可与 `--shot` 混用。

备戏清单是**场级备料**——这一场按参考栏备齐了哪些资产，是一张备料单，不是绑定关系。参考控制包是**镜级绑定**，一镜一份。两者是一条链上的两段，不是两套竞争方案：把场级清单铺下去，每一镜各得自己的一份。

参考控制包是镜级绑定，一镜一份；先 `reference lanes` 读服务端参考栏，再 `reference get --shot-id ID` 回读。`reference add`、`reference remove` 逐镜修改，人工核对后 `reference ready` 标记就位。`reference missing` 只报服务端词表减去已有绑定的差集，不判断该不该补。场级备戏清单铺到镜头后，每镜控制包各改各的，互不影响。

资产登记必须先读取 `asset registration-schema`，再把用户确认后的同版本表单通过 `asset register --registration-json` 提交。交付清单和 CSV 均按 episode 读取；需要留下交付事实时显式执行 `delivery record`，不使用不存在的 project 级交付别名。

媒体审核和设置主版本都是人工裁决。执行 `review decide`、`review set-primary` 或 `asset version-set-primary` 前必须向用户复述项目/镜头、资产、媒体和动作；只有用户确认后才传 `--i-mean-it`。拒绝媒体必须把用户给出的中文业务原因传给 `--rejection-reason`，不得由 Agent 自行判定通过、拒绝或主版本。

当目标只给出项目名、集号和「交付清单」时，零指导路径固定为：`project list` 找项目 → `project episode-list` 找集 → `delivery manifest --partial` 读取事实 → `delivery csv --partial --output ...` 落清单。若同名或无匹配，停止并如实列出候选；不得猜 ID。

按领域选择下列安装包内技能：

- [项目](./domains/project.md)
- [剧本](./domains/script.md)
- [资产](./domains/assets.md)
- [备戏](./domains/prep.md)
- [生成](./domains/generation.md)
- [参考控制包](./domains/reference.md)
- [抽卡工作台](./domains/reference-test.md)
- [队列](./domains/queue.md)
- [审核](./domains/review.md)
- [交付](./domains/delivery.md)

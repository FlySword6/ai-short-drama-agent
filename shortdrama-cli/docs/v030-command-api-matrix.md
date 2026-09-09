# CLI 命令集 × v0.3.0 功能对齐表

状态：核心命令面冻结于 2026-08-02；2026-08-03 追加媒体审核与镜头主版本两项既有合同补口；2026-08-18 追加项目盘点补口：项目成员、项目花费与消费明细、项目生成记录与失败任务、项目资产解绑。所有路径自动带 `/api/v1`，所有响应只接受 `{ok:true,data:{...}}`。CLI 通过 `X-Shortdrama-Client: cli` 留审计来源，不接受调用方在 body 伪造来源。

| 领域 | CLI 命令 | 主服务 method/path | v0.3 用途 |
| --- | --- | --- | --- |
| 诊断 | `doctor [--require-auth]` | 本地 Release/Skill/CA 证书；已登录时 `GET /auth/me` | 安装后与登录后健康检查 |
| 诊断 | `doctor --tls-probe <https-url>` | 对该地址发一次匿名 HTTPS 握手，不带任何凭据 | 发版冒烟与代理/证书排查 |
| 认证 | `auth login [--env prod\|test\|dev]` | `POST /auth/cli/login` | 登录并按环境私存会话；缺省连 `prod` |
| 认证 | `auth whoami` | `GET /auth/me` | 核验当前身份 |
| 认证 | `auth logout` | `POST /auth/logout` | 服务端注销并删本地会话 |
| 项目 | `project list` | `GET /projects` | 可见项目 |
| 项目 | `project create` | `POST /projects` | 建项目 |
| 项目 | `project get` | `GET /projects/:project_id` | 项目详情 |
| 项目 | `project update` | `PATCH /projects/:project_id` | 改名称或说明 |
| 项目 | `project episode-list` | `GET /projects/:project_id/episodes` | 集列表 |
| 项目 | `project episode-create` | `POST /projects/:project_id/episodes` | 建集 |
| 项目 | `project episode-get` | `GET /episodes/:episode_id` | 集详情 |
| 项目 | `project scene-list` | `GET /episodes/:episode_id/scenes` | 拆解确认后的场列表 |
| 项目 | `project shot-list` | `GET /episodes/:episode_id/shots` | 拆解确认后的镜头列表 |
| 项目 | `project shot-get` | `GET /shots/:shot_id` | 回读一镜的景别、机位运动、时长和视觉提示词 |
| 项目 | `project shot-update` | `PATCH /shots/:shot_id` | 局部修改一镜的景别、机位运动、时长或视觉提示词；至少传一项 |
| 项目 | `project shot-delete` | `DELETE /shots/:shot_id` | 删除多余镜头；不可逆，必须 `--i-mean-it` |
| 项目 | `project shot-media-list` | `GET /shots/:shot_id/media` | 列出一镜已生成的媒体产物 |
| 项目 | `project episode-production-status` | `GET /episodes/:episode_id/production-status` | 查看整集生产状态汇总和阻塞环节 |
| 项目 | `project episode-playback` | `GET /episodes/:episode_id/playback` | 读取整集播放信息 |
| 项目 | `project member-directory` | `GET /users/directory?q=...` | 按名称搜索成员目录，返回真实用户 ID；派单前先选人 |
| 项目 | `project member-list` | `GET /projects/:project_id/members` | 列项目成员与项目角色 |
| 项目 | `project member-add` | `POST /projects/:project_id/members` | 以 `user_id` 和 `role` 添加成员 |
| 项目 | `project member-update` | `PATCH /projects/:project_id/members/:user_id` | 修改成员项目角色 |
| 项目 | `project member-remove` | `DELETE /projects/:project_id/members/:user_id` | 不可逆移除成员；必须 `--i-mean-it` |
| 项目 | `project costs` | `GET /projects/:project_id/costs?group_by=...` | 看项目花费汇总，按成员、模型或日期分组 |
| 项目 | `project consumption-records` | `GET /projects/:project_id/consumption/records` | 看项目消费明细 |
| 剧本 | `script paste` | `POST /episodes/:episode_id/script-versions` | 粘贴原文并固化版本 |
| 剧本 | `script versions` | `GET /episodes/:episode_id/script-versions` | 版本与正文回读 |
| 剧本 | `script breakdown` | `POST /episodes/:episode_id/script-breakdowns` | 发起拆解 |
| 剧本 | `script status` | `GET /script-breakdowns/:run_id` | 查拆解候选层 |
| 剧本 | `script resume` | `POST /script-breakdowns/:run_id/resume` | 续跑可恢复拆解 |
| 剧本 | `script confirm` | `POST /script-breakdowns/:run_id/confirm` | 人审转正 |
| 资产 | `asset search` | `GET /assets` | 结构化浏览；project scope 必带 project_id |
| 资产 | `asset semantic` | `POST /asset-search` | 自然语言检索 |
| 资产 | `asset get` | `GET /assets/:asset_id` | 资产详情 |
| 资产 | `asset registration-schema` | `GET /assets/registration-schema` | 读取因子字典驱动表单 |
| 资产 | `asset register` | `POST /asset-upload-tasks` | 图片上传并登记个人资产 |
| 资产 | `asset register-status` | `GET /asset-upload-tasks/:task_id` | 查询入库任务 |
| 资产 | `asset add-to-project` | `POST /projects/:project_id/assets` | 采用到项目 |
| 资产 | `asset project-list` | `GET /projects/:project_id/assets` | 项目资产 |
| 资产 | `asset remove-from-project` | `DELETE /projects/:project_id/assets/:ref_id` | 不可逆解绑项目资产；必须 `--i-mean-it` |
| 资产 | `asset version-list` | `GET /assets/:asset_id/versions` | 列出一个资产的全部媒体版本 |
| 资产 | `asset version-add` | `POST /assets/:asset_id/media` | multipart 追加图片为同一资产的新媒体版本；可挂变体、可即时设主 |
| 资产 | `asset version-set-primary` | `POST /assets/:asset_id/media/:media_id/set-primary` | 人工设置资产主媒体版本；后端 human_only，必须 `--i-mean-it` |
| 资产 | `asset variant-list` | `GET /assets/:asset_id/variants` | 列出一个资产的全部变体 |
| 资产 | `asset variant-create` | `POST /assets/:asset_id/variants` | 给资产新建变体：名称、类别、使用场景、适用集数 |
| 备戏 | `prep list` | `GET /scenes/:scene_id/prep-list` | 场级备戏真源 |
| 备戏 | `prep pull` | `POST /scenes/:scene_id/prep-list/items` | 拉件到场 |
| 备戏 | `prep remove` | `DELETE /scenes/:scene_id/prep-list/items/:item_id` | 撤回未提交条目 |
| 备戏 | `prep send` | `POST /scenes/:scene_id/prep-list/commit` | 默认场级就位；显式送镜头或铺全场 |
| 参考控制包 | `reference lanes` | `GET /vocabulary/reference-lanes` | 读取服务端参考栏词表 |
| 参考控制包 | `reference get` | `GET /shots/:shot_id/control-package` | 回读一镜一份的控制包 |
| 参考控制包 | `reference add` / `reference remove` | `POST /shots/:shot_id/control-package/refs` / `DELETE /control-package-refs/:ref_id` | 逐镜增删一件参考；删除按 ref 而非按镜头 |
| 参考控制包 | `reference ready` | `PUT /shots/:shot_id/control-package/ready` | 编导确认参考已就位；`--cancel` 撤销 |
| 参考控制包 | `reference missing` | `GET /vocabulary/reference-lanes` + `GET /shots/:shot_id/control-package` | 纯词表减已有栏，报告空参考栏 |
| 生成 | `generation models` | `GET /generation-models` | 模型能力目录 |
| 生成 | `generation capability-tiers` | `GET /generation/capability-tiers?media_type=...` | 按媒体类型查档 |
| 生成 | `generation estimate` | `POST /generations/estimate` | 简单成本预览或正式报价 |
| 生成 | `generation confirm` | `POST /generation-quotes/:quote_id/confirm` | 单项人工确认 |
| 生成 | `generation submit` | `POST /generations` | 单项付费提交 |
| 生成 | `generation batch-estimate` | `POST /generations/batch-estimate` | 批量估价 |
| 生成 | `generation batch-confirm` | `POST /generations/batch-confirm` | 冻结并确认清单，不创建任务 |
| 生成 | `generation batch-submit` | `POST /generation-batches/:authorization_id/submit` | 只提交服务端授权，不重传清单 |
| 生成 | `generation default-get` | `GET /projects/:project_id/generation-defaults` | 读取项目生成默认策略（独立后端模块，非参考测试） |
| 生成 | `generation default-update` | `PUT /projects/:project_id/generation-defaults/:media_kind` | 直接更新项目生成默认策略；`--expected-version` 是默认策略记录版本 |
| 生成 | `generation project-list` | `GET /projects/:project_id/generations` | 列本项目全部生成记录 |
| 生成 | `generation failed-list` | `GET /generations/failed` | 列当前用户失败的生成任务 |
| 抽卡工作台 | `reference-test create` | `POST /projects/:project_id/reference-tests` | 建直接参考或素材转提示词测试 |
| 抽卡工作台 | `reference-test list` | `GET /projects/:project_id/reference-tests` | 项目内的参考测试 |
| 抽卡工作台 | `reference-test get` | `GET /projects/:project_id/reference-tests/:reference_test_id` | 单条测试详情 |
| 抽卡工作台 | `reference-test update` | `PUT /projects/:project_id/reference-tests/:reference_test_id` | 原位改模型、提示词、参数或参考媒体；`--expected-version` 是参考测试记录版本 |
| 抽卡工作台 | `reference-test delete` | `DELETE /projects/:project_id/reference-tests/:reference_test_id` | 删除不再需要的测试；`--expected-version` 同上 |
| 抽卡工作台 | `reference-test result-list` | `GET /projects/:project_id/reference-tests/:reference_test_id/results?page=&page_size=` | 横向查看该测试历次结果及关联请求、媒体 |
| 抽卡工作台 | `reference-test result-stream` | `GET /projects/:project_id/reference-test-results?page=&page_size=&media_kind=` | 项目级结果流，查看其他抽卡师结果 |
| 抽卡工作台 | `reference-test result-attach` | `POST /projects/:project_id/reference-tests/:reference_test_id/results` | 把一次已完成的生成挂到这个测试下 |
| 抽卡工作台 | `reference-test set-default` | `POST /projects/:project_id/reference-tests/:reference_test_id/results/:result_id/set-default` | 将挑中的结果定为项目默认策略；`--expected-version` 是默认策略记录版本 |
| 队列 | `queue list` | `GET /generations/in-flight` | 当前用户跨项目在途任务 |
| 队列 | `queue status` | `GET /generations/:request_id` | 单任务状态 |
| 队列 | `queue retry-estimate` | `POST /generations/estimate` | 重试报价 |
| 队列 | `queue retry-confirm` | `POST /generation-quotes/:quote_id/confirm` | 重试人工确认 |
| 队列 | `queue retry-submit` | `POST /generations/:request_id/retry` | 重试付费提交 |
| 审核 | `review decide` | `POST /projects/:project_id/media-reviews/decisions` | 人工通过或拒绝一项媒体结果 |
| 审核 | `review set-primary` | `POST /shots/:shot_id/media/:media_id/set-primary` | 人工设置镜头主版本 |
| 交付 | `delivery manifest` | `GET /episodes/:episode_id/deliverables` | 集交付清单 |
| 交付 | `delivery history` | `GET /episodes/:episode_id/deliveries` | 交付记录 |
| 交付 | `delivery record` | `POST /episodes/:episode_id/deliveries` | 留下实际交付事实 |
| 交付 | `delivery download` | `GET /media/:media_id/download` | 登录保护的媒体下载 |
| 交付 | `delivery csv` | `GET /episodes/:episode_id/deliverables.csv` | 集级 CSV |

## 冻结行为

- `prep send` 不带镜头参数时只建 `project_asset_ref` 并登记场级就位，不碰控制包。
- `prep send --shot ID...` 只为指定镜头建控制包引用。
- `prep send --all-shots --i-mean-it` 才铺全场；缺二次确认直接失败。
- 单项和批量生成都不提供 `--yes`、自动确认、一键提交或 pipeline。
- `generation batch-confirm` 只确认费用和清单；付费就绪检查与任务创建只发生在 `generation batch-submit`。
- 抽卡工作台没有自己的运行通道：生成一律走 `generation estimate` → 人工审阅报价 → `generation confirm` → `generation submit`，再用 `queue status --generation-id` 轮询到完成、取出 `media_result_id`（`queue list` 只打在途任务，完成后无从回查），最后用 `reference-test result-attach` 挂进这个测试。不得增加 `--yes`、自动确认、自动提交或一键跑批。
- 项目生成默认策略属于 `/generation-defaults` 后端模块，挂在 `generation` 组（`default-get` / `default-update`），不在 `reference-test` 组；`set-default` 与 `update`/`delete` 的 `--expected-version` 分别是默认策略记录与参考测试记录的乐观锁版本，来源不同、互不通用。
- `review decide` 与 `review set-primary` 都必须由人类复核目标后显式传 `--i-mean-it`；拒绝媒体必须给出中文业务理由。
- 发行版不包含 mock 成功模式，不配置 API 或认证失败时以非零退出码停止。
- 后端目的地只来自发行版内置受信端点清单（ADR 0001）：`prod` → `http://101.126.6.208/`、`test` → `http://shortdrama-main-test.col.com/`、`dev` → 本机 loopback。命令面没有 `--api-base`，也不读 `SHORTDRAMA_API_BASE`；`--env` 只接受环境名，不接受 URL。
- 环境在 `auth login` 时选一次并粘住；会话按环境分开存（文件权限 0600，只存必要字段），凭据不跨环境；`auth logout` 注销并清除当前环境的本地会话。
- 明文 HTTP 受信端点每次连接都向 stderr 打一行警告，不进入 JSON 信封，不影响自动化。
- 登录密码只走交互式输入（没有 `--password`，也不读 `SHORTDRAMA_PASSWORD`）；自动化用 `SHORTDRAMA_API_TOKEN` 和只接受 `prod|test|dev` 的 `SHORTDRAMA_ENV` 注入。环境优先级是命令行 `--env`、`SHORTDRAMA_ENV`、登录记住的环境、最后 `prod`。

## 旧模块处置

1. v0.1 本地 provider、pipeline、文件工作流和错位 API 别名从发行命令面退役，避免两套合同并存。
2. 主服务旧 `/create/image`、`/runs/sync`、`/runs/:id/status` 默认进入 `deprecated`，响应带后继入口提示。
3. 环境确认调用方完成迁移后，可把 `CLI_COMPAT_MODE` 改为 `disabled`，旧入口返回业务语言 410。
4. `cli_runs` 历史表暂留，不在本包删除或迁移历史记录。

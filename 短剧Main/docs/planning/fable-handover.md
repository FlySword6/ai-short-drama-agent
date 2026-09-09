# Fable 统筹交接书

> 立于 2026-07-29 晨。写给**任何接手统筹的模型**,尤其是幻觉率偏高的(opus-5 值夜班用)。
> 起因:07-28 夜班其实干了活——验收两包、裁了族表闭包、抓到 kimi 403 卡死三小时并推动重启——
> 但 DC 早上看到的是「测试版能验的版本一夜没变」加「汇报没法核实」,信任直接崩掉。
> 复盘出两条病根:**①二十多个包验收完堵在合流,合流只有主会话能做而主会话整夜没人唤醒;
> ②干了活只写进工作区文件、没 commit,从 git 看统筹像睡了一夜。**
> 这份文档把统筹工作机制化:每个论断可核实、每轮循环留 git 痕迹、每个状态靠命令不靠记忆。
> 相关真源:`delivery-workflow.md`(团队怎么协作)、`orchestration.md`(当前进展)、
> `../design/version-plan.md`(做什么)、`../design/product-goal.md`(为什么做)。

---

## 0. 接手序列(顺序执行,不许跳步)

1. 读本文档;
2. 读 `orchestration.md` **最后两节**——上一轮停在哪、待 DC 的事有哪些;
3. 读 `version-plan.md` 当前在途的版本档;
4. 跑 §1 的状态命令,拿到**此刻的**任务图;
5. 按 §2 的循环从中断处继续。

**禁止**:凭对话记忆、交接摘要或上一轮汇报断言任何状态。摘要是二手信息,命令输出才是一手。
07-28 实证:Fable 拿重启前的快照报 S79/S84 未合流,而它们两小时前就合了。

## 1. 任务图(graph):状态只认命令,不认记忆

包的生命周期,每一步都有 git 上可查的凭据:

```
派出 ──在做──> commit ──门禁绿──> DONE tag ──> 验收 ──> 合流 ──> 回写状态
└────────── 主线自己走 ──────────┘          └──────── 统筹的活 ────────┘
```

**图的形状(这是结构,不随日期过期)**:所有包的终点汇进「合流」一个闸口。
主线再能干,闸不开,`version-plan.md` 的版本就不往前走,DC 能验的东西就不变。
**所以循环里合流环节的优先级永远最高,积压数是统筹的第一健康指标。**

状态查询命令表(在 `.worktrees/v011-integration` 下执行;引用输出,不许背数字):

| 想知道什么 | 命令 |
| --- | --- |
| 待合流积压(第一指标) | `for p in $(git branch --format='%(refname:short)' \| grep feature/v011-); do git merge-base --is-ancestor "$p" HEAD 2>/dev/null \|\| { t=$(git tag -l --points-at "$p" \| head -1); [ -n "$t" ] && echo "$p → $t"; }; done` |
| 前端主线最新产出 | `git -C ../kimi-main log -3 --format="%h %ad %s" --date=format:"%m-%d %H:%M"` + `status --short` |
| 后端主线最新产出 | 同上,路径 `../sol-main` |
| kimi 会话存活 | **首选**:`ls -t /Users/user/Workspace/02_AI工具开发/tmp/kimi-inject-*.log /tmp/kimi-inject-*.log 2>/dev/null \| head -1` 的 mtime 与尾部内容(`-p` 非交互模式不更新 state.json,别用它)。**主线 = `session_67fe41fa-6b3d-4f96-8c8d-72ba55a2bd52`**(08-03 11:57 冷启动接棒 dbc16ead)。⚠️ 两会话写同一 worktree 会互相覆盖;resume 崩 step_uuid 错误 ≠ 会话损坏,先查同会话是否有存活进程占用(08-03 教训) |
| sol 会话存活 | 主线=**`019fc5e7-ff79-7042-8a05-56bfa4e694af`**(08-03 12:37 DC 在 Codex Desktop 全新开的,判活看 `ls -lt ~/.codex/sessions/2026/*/*/rollout-*019fc5e7*.jsonl | head -1` 的 mtime)。旧线沿革:019fa7ec→019fb270(07-30 交接)→019fc478(08-03 凌晨轮替,午间坏)→019fc5dd(12:23 fork 自 019fb270,609MB,随即坏)→当前。⚠️ 三个注意:①任何时刻只认一条 sol 主线,双会话写同一 worktree 会互相覆盖(07-29 教训);②本会话**全新无历史上下文**,首针=完整冷启动剧本(sol 身份+三仓职责+「前身已交付 ARK 修复并合流 dev(048 已应用),回执 outputs/sol-ark-breakdown-fix-20260803.md」);③DC 在桌面端与它交互期间**禁止 exec resume 注入**——并发占用会撞坏会话(08-03 kimi step_uuid 崩溃即此病),发针前确认 rollout mtime 已静止 ≥10 分钟 |
| 集成线是否落后远端 | `git status -sb`(看 `ahead N`) |
| 统筹自己昨晚干没干活 | `git log --oneline --since="12 hours ago"`——**空 = 没干,说什么都不算** |
| 8000 三元组读回(服务换代后必做) | 码:`curl -s localhost:8000/api/v1/health`(sha 字段)+`ls -la dist/server.js`(mtime 对 commit);env:进程 cwd=`lsof -p $(lsof -tiTCP:8000 -sTCP:LISTEN) \| grep cwd`;库:`ls migrations/ \| tail -1` vs 库内 schema_migrations;三项读回(health/login/最新路由)全绿才算换代完成 |

## 2. 循环(loop):每轮七步,少第⑦步等于这轮没发生

heartbeat 每 30 分钟一轮;主会话被 DC 唤醒时同样先走这个序列再答话。
**heartbeat 的载体是主对话里的 cron job(CronCreate,07-29 DC 定:「我说的 heartbeat 是指 cron」)**——
巡检输出直接滚在 DC 眼前的对话里,这本身就是防幻觉机制的一部分(可见即可信)。
当前 job:`2a899749`,每小时 11/41 分,durable(重启恢复)。**cron 任务 7 天自动过期,到期要续建**;
不要用独立后台 scheduled-task 跑 heartbeat——07-28 夜实证:它干了活但 DC 看不见,信任照样崩;
**执行降配(DC 2026-08-03「heartbeat 用 sonnet5 就行」+「被 sonnet/opus5 唤起」)**:heartbeat 触达后,①②⑤⑥⑦(状态采集/对账/落账 commit)转派 `model=sonnet` 子代理(Agent 工具)执行,主会话只收三行结论(在途/积压/异常)——**sonnet 采集报告里含裁决项(新 DONE tag/亲启来件/停摆/门禁红/授权类)时,Fable 本尊在同轮接手处置,这就是「sonnet 唤起 Fable」的实现形态**;③验收、④合流、催针、打回等裁决动作永远主会话亲做。**采集代理只许执行采集单列明的动作**——不自起任务、不调 skill、不派生子代理、不给其他会话发消息;发现单外该做的事,写进回报的裁决项交 Fable 定(08-03 23:0x 教训:采集代理自称「顺手起后台调研」,单内无此授权,追查+补此条)。
**可见性铁律(07-28+08-03 两次教训)**:一切巡检自动化只走本会话 cron(CronCreate)+subagent,过程滚在 DC 眼前的对话里;**禁系统 crontab/launchd/独立 headless 循环**——DC 看不见的自动化等于没干,且信任受损。08-03 曾试装 shell 触发器+系统 cron,DC 否,已拆。
**收件箱轮已退役(08-03 DC 批,cron 0f927e00 已删)**:来件扫描并进 heartbeat 第①步——`ls -t $WS/tmp/fable-inbox-*.txt /tmp/fable-inbox-*.txt` + `find $WS/outputs -maxdepth 1 -mmin -31 -name '*.md'`(窗口跟 30 分钟轮距);**外加 worktree 兜底扫(08-03 漏件教训)**:`find $WS/.worktrees/*/outputs $WS/.worktrees/*/tmp -maxdepth 1 -mmin -31 \( -name '*.md' -o -name '*.txt' \) 2>/dev/null`——worker 投错位置的件也要被看见;标「Fable 亲启」的处理动作(验收/裁决/转派)回主会话;
**项目动态摘要机制(DC 2026-08-04 立,R186)**:固定文件=集成区 `docs/planning/project-context-brief.md`(context 仓 docs/ 同步副本,该仓治理改造收口前暂缓)。纪律=累积式更新不替换、保留初始目标、记录关键决策点、四触发(新目标/重要新信息/范围增减/里程碑);每次阶段性工作(验收/合流/拍板/派单)后**派 sonnet 增量更新**(只加不删、逐条带日期、禁编造);heartbeat 采集单固定第 0 步=读该文件全文注入回报开头(主会话冷启动/压缩后靠它找回全局)。**任务依赖网(同日立)**:统筹自任务用 Claude 任务工具维护成 DAG(原子子问题自包含可验证,每步后更新不靠初始计划);派 sol/kimi 的 goal 文件加「子问题 DAG 与状态」段,worker 每收口一个子问题更新该段+看板卡评论。
**工作系统自进化(DC 2026-08-04「也要自动更新升级工作系统,包括 kimi 和 codex 的」,R187)**——升级随每单自动发生,不靠专门维护轮:①**worker 回执固定节「体系升级建议」**:每单回执必带(本单踩的坑/该立的规矩/过时条目;没有就写「无」),Fable 验收时逐条裁,批的当场入册(kimi→其 AGENTS.md §8 由 kimi 自己写,sol→信箱契约与本书 sol 节,Fable→skills/本书),台账登记;②**派单模板固定行「本单生效的新契约(增量)」**:新规矩随单下发即生效,不靠 worker 自己翻史;③**发版后一致性对账轮**:每次发版后派 sonnet 对三端体系文件找漂移(本书+dc-ground-rules ↔ kimi AGENTS §8 ↔ sol 信箱契约),报告 Fable 裁;④既有向外看机制(graph-engineering R169 每日调研)不变,与本条互补=向内长。sol 的 FABLE-008 自适配旧欠并入①,首单回执起生效。
**收件契约(08-03 R184,kimi sgoal06 急件漏收 2 小时教训)**:worker 急件指针一律=**工作区根** `$WS/tmp/fable-inbox-<HHMM>.txt`(固定通配名,不许自创文件名),回执一律落**工作区根** `$WS/outputs/`;写在自己 worktree 里=未送达,统筹兜底扫只是保险不是许可。同时:worker 说「已投」不算投——收件方以文件存在于约定位置为准(「自报不等于事实」适用于通信,不只验收);**DC 直接下给 worker 的令,产物回流也走同一收件口**(motionsites 调查即此形态)。派单与 ACK 模板里带这条口径。
且两个 heartbeat 并存会在合流上撞车(V-39 后果)。旧 scheduled-task 版已删,45 轮记录归档。

| 步 | 做什么 | 判据 |
| --- | --- | --- |
| ① 查 | 跑 §1 命令表,拿实时任务图 | 有命令输出 |
| ② 判活 | 两条主线:worktree 有新产出 **或** 会话 60 分钟内活动 = 活;否则按 §5 模板催 | git 证据 |
| ③ 收 | 新出现的 DONE tag → 按 §3 验收检查单验 | 检查单逐项 |
| ④ 合 | 验过的包 → 合流(护栏见 §3);无合流权时做预检,产出「可安全合流清单」 | 门禁三个数 |
| ⑤ 对账 | 合到哪个版本档、离下一个可发版本差几张卡 | version-plan.md |
| ⑥ 归集 | 要 DC 拍板的事,更新 `orchestration.md`「待 DC」节(见 §4) | 文件可查 |
| ⑦ 留痕 | `orchestration.md` 追加一行巡检记录并 **commit**,格式:`chore(heartbeat): HH:MM 巡检——<一句话实况>` | **git log 可见** |

**R147 期巡检形态(2026-08-02 起,至核心重构标杆验收止;DC 13:2x「heartbeat也得更新」)**:两线待命、拆包冻结期间,①-④收缩为状态扫描(预期无 tag,来件照收),**每轮心跳必须推进 R147 主线一格并在⑦里写明推进物**——顺序:台账逐域评审(docs/design/dc-feedback-ledger.md,九域+横切节)→ PRD 逐章重写(180 条理解梳理后收敛进章,台账是账本、PRD 是交付物,DC 13:3x「180条还是得理解梳理下更新prd的」)→ Figma 原型补全(欠件五项+动效流程)→ 核心页骨架重构(Fable 亲写)。「本轮无推进」不是合法巡检结果,除非在处理来件/发版/事故。

**⑦ 的两条附加纪律(07-30 立)**:①commit 前必跑 `node --import tsx --test test/doc-terminology.test.ts`——当日实证:门禁抓的禁用词全部是统筹自己写的,长段落集中发作;**门禁判定不许用管道 grep 接 commit 链**(2026-08-03 实证:`node --test … | grep -E "pass|fail" && git commit` 的退出码是 grep 的——匹配到「fail 1」也算成功,红着 commit 打出去了。正确写法:测试输出落文件,`grep -q "fail 0"` 判定后才走 commit);②**下达停手令 = 通知会话 + 终止在途进程并记录退出时刻**——当日教训:13:47 派出的 run 从头到尾没见过 15:13 的停手令(另一进程代答),「已通知」通知到的是会话不是进程;判 run 状态只看进程日志 mtime,不看会话回复。
②b **并发共区纪律(08-04 教训:git add -A 把后台治理代理在途的一批 rename 卷进主会话 commit 推走)**:集成区有任何后台 agent 施工期间,主会话 commit 一律指名 add 文件(`git add <路径>...`),禁 `git add -A`/`git add .`;commit 前 `git status --porcelain` 扫一眼,见到不是自己改的 staged/renamed 条目就停手先问工地归属。
③**push 成败只认 `git fetch` 后 origin/dev 的实际水位,不认包装命令的 exit code**——07-31 实证:`git push … | tail -3; echo EXIT=$?` 的探针测的是 tail 不是 push,两次失败被报成成功,还向 DC 报了「已推上 dev」;正确写法是 `git push > log 2>&1; echo $? >> log`,且报「已推」前必须 fetch 对水位。
④**version-plan.md 每加一张卡,commit 前必跑 release-plan 同步**(起本地服务→`scripts/sync-release-plan.mts --apply`→复跑 `tests/release-plan-truth-sync-db.test.ts`)——07-31 同一晚被逐卡对齐守卫挡了两次 push,两次都是加卡没同步。
⑤**同会话串行派发**(2026-08-02 卡7并行写手事件,三起同根):上一 run 未退不发下一单。**查活判据(04:5x 修正;08-03 22:1x 二修——本机 ps 有时只显短程序名,按「resume」关键字计数会假 0)**:主判据=注入 log mtime 新鲜度(≤10min=在跑),辅判据=`ps aux | grep '/Users/user/.kimi-code/bin/kimi' | grep -v grep` 按可执行路径计数;两者矛盾时以 log 新鲜度为准,都静止>60min 才判停摆。log 出 resume 脚≠必然已退;派发验活(60-90s 看 log 实质响应)与本条配套。
⑤b **kimi 推理档全局 max**(DC 2026-08-01:「kimi的reasoning都要开max」)——已改 `~/.kimi-code/config.toml` `[thinking] effort="max"`(全局生效,含 resume;col/k3 模型位本就 default max);新会话/新机器接手时核这一行。
⑤c **注入命令模板与送达判据(2026-08-02 双路假送达事故,五坑连环)**——nohup 丢 PATH、二进制真身叫 `kimi` 不叫 kimi-code、codex 交互 resume 在 nohup 下 stdin 报错、根 workdir 非 git 仓要 skip 检查、kimi resume 只认全长 id。能直接抄的两条:
  - kimi(2026-08-03 ⑤e 二犯后模板硬化——验退检查编进命令,忘不了):
    `cnt=$(ps aux | grep '/Users/user/.kimi-code/bin/kimi' | grep -v grep | grep -c resume); [ "$cnt" -gt 0 ] && echo "拒发:上针 $cnt 个 run 未退" || { cd .worktrees/kimi-main && nohup /Users/user/.kimi-code/bin/kimi --resume session_67fe41fa-6b3d-4f96-8c8d-72ba55a2bd52 -p "<指针>" > /Users/user/Workspace/02_AI工具开发/tmp/kimi-inject-<名>.log 2>&1 & }(**-p 非交互模式不接受任何权限旗**——08-04 实证 --auto/-y 与 -p 均互斥直接报错;-p 本身即自动模式,历史两单纯 -p 全程未被权限卡。08-04 上午双针因加 --auto 停摆 53 分钟,教训=模板改动首用前必须小验,自己写的注意事项自己先执行)`(**日志一律工作区 tmp,不用 /tmp**——DC 08-03 令,重启不清)
  - sol:`cd <根workdir> && nohup /Users/user/.npm-global/bin/codex exec resume 019fc5e7-ff79-7042-8a05-56bfa4e694af --skip-git-repo-check -m gpt-5.6-sol -c model_reasoning_effort=max "<指针>" > /Users/user/Workspace/02_AI工具开发/tmp/sol-inject-<名>.log 2>&1 &`(**主线档位=max**,08-03 众测 103 分/$9.1 优于 xhigh;轻中档独立包可用 `-m gpt-5.6-luna -c model_reasoning_effort=max`,91 分/$2.4,首用前小验模型名)
  - **sol 通道升级(08-03,sol 提案 Fable 批)**:内容走双向信箱 `outputs/sol-to-fable-mailbox.md`(sol 单写)/`outputs/fable-to-sol-mailbox.md`(Fable 单写),消息号+类型+ACK;急件同时写 `$WS/tmp/fable-inbox-*.txt` 指针。注入只用于唤醒(一行「读信箱」),发针前锚会话 id 验退;**DC 桌面端在线期间不注入**(并发写撞会话,08-03 双会话报废实证)。协议全文 outputs/SOL-FABLE-DIRECT-COMMS-20260803.md。
  - **送达判据只有一条:60-90s 后注入 log 出现会话实质响应(sol 另加 session 文件 mtime 更新)。进程计数不算送达证据**——`rg kimi-code` 匹配的是安装路径串,数的是别人;log 里只有报错=没送达,重发前先修根因。
  - **发针前必验上针已退(2026-08-02 「83858 系」事故)**:`ps aux | rg '[k]imi' | rg -v 'rg|esbuild|node_modules'` 数无头发动机进程——>0 且属上一针=不发,等退或显式处置;长任务(Figma/大 goal)期间的追加指令攒批,等 run 退了一针带全。违者后果实证:多针重叠→同 worktree 多进程并行→run 互见产出拟「幽灵会话」叙事(83858),统筹向 DC 两次报错账。
  **判活 grep 锚可执行文件,不锚命令行文本**(2026-08-03 实证:`grep '[c]odex exec'` 匹配到自己上一条 Bash 的 bash 残壳——壳的命令文本里含这串字,真 codex 早退了,裁决针被假进程堵了半小时;同款=凌晨 kimi 数到安装路径串。正确:按 `/Users/user/.npm-global/bin/codex` 或 `/Users/user/.kimi-code/bin/kimi` 可执行路径过滤,再排 bash/eval 壳)。
⑤d **合流带迁移的包后,立即对本地 dev 库跑 npm run db:migrate**(2026-08-02 实证:043-045 合流后 dev 库停 042,代码查新列全项目 500——代码与库漂移在 dev 环境的形态);测试站先库随发版链照旧。
  **⑤d 补(2026-08-03 047 事故)**:共享 dev 库跑 schema 迁移前,先盘点谁在连这个库(`lsof -nP -iTCP:8000` 级别的进程盘点+问在跑的主线),协调窗口再迁——047 落库时 kimi-main 旧码后端(046 水位)还连着,登录成功路径撞新 NOT NULL 列 500,UX 基线连跑全断俩小时。库新码旧与码新库旧是同一病的两面,⑤d 只防了后者。另:tsx watch 会随合流自动热重启子进程(集成区 8000 因此自愈),但**别的 worktree 的独立后端不会**——它们的码水位归各自主线,迁移协调是统筹的活。
⑤f **E2E 套件全局互斥(2026-08-03 立,根因=047 单活跃会话)**:createHumanSession 每次人工登录 revoke 同用户全部旧 web/cli 会话——**任何两套 E2E 并发=登录互踢=数据必脏**(B2 4/6 污染实证:失败 7 跑里 5 跑终点 /login)。铁律:同一时刻全机只跑一套 E2E(不分 worktree 不分套件);派 E2E 类任务前 ps 查 playwright 进程,>0 不派。**查活与列详情一律带套件名过滤 `[p]laywright.*(ux-baseline|zeroguide|smoke)`,禁中途降级成裸 `[p]laywright`**——裸模式会把 MCP 常驻和命令行含该词的无关进程(含 Fable 自己的桌面会话)误当 E2E(08-03 实证:把 Fable 会话进程 21737 误定性成测试跑,进了给顾问的证据包)。DC 演示注意:演示中他处 admin 登录会踢演示机下线,产品语义如此(安全设计),演示前知会。
⑥**巡检必查最新自动化测试报告**(DC 2026-08-01 直接指示:「每次自动化测试都向你汇报结果……你要做思考和统筹任务」)——sol 每次冒烟/体验门跑完投报告到 outputs/e2e-reports/;巡检轮读最新一份,红项由统筹思考定性再派活,不许执行方自行扩修;发版后必跑体验门是发版检查项之一(阈值:首屏 3000ms/媒体读取 1500ms/切换 500ms,R139)。

**为什么第⑦步是硬的**:07-29 02:10 heartbeat 把「kimi 额度 403」写进了 orchestration.md,
但没 commit——DC 早上从 git 看,统筹像睡了一整夜。**写回不 commit = 白写。**
巡检行没新东西就写「无变化,积压 N」,一行,别为了有输出制造工作。

**对话回执样式=仪表盘(R156,DC 2026-08-03:「heartbeat 的回执样式对我不够直观」)**——每轮心跳对 DC 的输出五件套,数字全现算:
①版本进展(当前可验版本+在造版本+最近里程碑倒计时);②工作项完成率(GitHub Projects #1 现算 Done/总数(gh project item-list 1 --owner col-shortdrama));③双线状态(kimi/sol 各一行:🟢干活+干什么 或 ⚪闲+多久);④质量指标表(门禁三数/E2E 两套/体验门三值对阈值/漂移收敛态);⑤待 DC(无=写「无」;有=每件一行带「做什么+多久见效」)。git 巡检行(⑦)照旧不变——仪表盘是给 DC 的窗口,git 是审计账,两层各自为政。收件箱轮不出仪表盘(保持一行纪律)。

## 3. 执行框架(harness):闸门检查单

**验收一个 DONE tag(逐项,缺一项就打回,不许「看起来没问题」)**:

- [ ] 回执逐条对过,**自报不等于事实**——关键项自己复跑;
- [ ] 门禁三个数(总/过/skip),skip 要说明哪条没验;
- [ ] 变异验证:改坏一处看守卫红不红(守卫不红 = 保护是纸糊的,S83 的守卫曾把假话断言成期望值);
- [ ] 文案/交互类:浏览器真点到,「源码里搜得到」不等于「用户点得到」;
- [ ] 跨包接缝过一遍 `outputs/SEAM-02-contract.md`——**本仓最贵的缺陷全长在包与包之间**
      (S38×S39 音频、S46-A 消耗页 400、S85×S88 零文件重合却互相引爆);
- [ ] 涉库迁移:编号对台账、在影子库跑过、**数过会隔离/删除多少行**(039 差点清空 121 条待审队列);
- [ ] **实证快照入库**(顾问裁,08-03 断头单教训):`artifacts/` 整目录在 .gitignore,是**可覆写活文件,不算举证件**——DONE 前把终态产物快照拷到入库路径(outputs/ 或 docs/prototype/)并在 commit message 带产物 sha256;引用更早轮次数据要写明产物路径+mtime+口径合法性;
- [ ] **验收复跑锚 tag checkout**,先 stash 工作区未提交改动——工作区合成态(tag 码+未提交改动+热更)跑绿不算 tag 实证;
- [ ] **GitHub Projects 写操作按分级执行**:L1 日常自主/L2 结构变更三硬要求/L3 破坏性 DC 指名;整组替换载体纪律五条跨级强制——全文见 delivery-workflow.md「GitHub Projects 写操作分级」节(R178);
- [ ] **tag 即收工**(08-03 实害:tag 后加跑套件把终态实证覆写成崩轮数据+又追 commit 推离 tag):打完 DONE tag 后执行方停一切套件与 commit,后续动作必须有新指令;tag 后追加的 commit 一律按未验收件另行处理。

**合流一批包(护栏)**:

- [ ] 一批 ≤ 5 包,按依赖顺序,先 `git merge-tree` 预检冲突;
- [ ] **合流命令锚 tag/commit,不锚分支名**(2026-08-03 实证:后台 merge 引用分支名,执行时分支已被主线续推新 commit,未验收件搭车进 dev——幸全量门禁绿+事后补验变异红兜住;正确写法 `git merge --no-ff <tag>` 或先 `git rev-parse` 钉死 commit);
- [ ] 冲突处置(V-42,07-29 DC 批):**仅 import/依赖声明类的单行机械并集**可由合流者当场解,
      且必须在 merge 说明里写明解法;**其余一切冲突(含语义冲突、多行、业务代码)即停退回对应主线**;
- [ ] 每批合完的门禁=**合流后本地跑一次全量 `npm test`,再 commit+push**(2026-08-03 消重裁定的「一批只跑一次」不变;变的是执行方式:2026-08-06 起 pre-push hook 只跑快批 `test:node`,不再替你跑全量,`/tmp/prepush-gate.log` 里只有快批的三数,全量三数得从本地这一跑取,数据库那批另由 CI 在推到 dev 后跑)。红了回滚该批再排查。**任何时刻不双跑全量**(后台收编链与前台 push 错开);
      **db 回放间歇红真根(2026-08-03 二次定性,思考本首页)**:不是并发(单跑也红过)——是 pg_isready/psql 走容器 unix socket,把 postgres 官方镜像 entrypoint 的「临时初始化实例」误判为就绪,抢跑撞其关闭窗口(报错=`shutting down` 或 socket `No such file`)。已修:九个 run-*-db-test.sh 探测与 psql 全部改走 TCP `-h 127.0.0.1`(临时实例不听 TCP,天然区分;psql 加 `-e PGPASSWORD`)。**新脚本铁律:容器内 postgres 就绪探测必须走 TCP,不许走 unix socket**;消重裁定保留(并发是放大器,省资源仍值得);
      **改 spec/页面文件前先 grep 谁锚着它**(同名 .contract.test.ts、readFileSync/readSource 源码级守卫遍地——2026-08-03 改 sgoal06 漏查 contract 伙伴白烧一轮全量门禁);
- [ ] 合流即回写三处:version-plan 卡状态、GitHub Projects #1 卡状态、orchestration DAG;
- [ ] 最后 push;push 被门禁挡住时,把挡着的那条测试名字写进「待 DC」或派给对应主线,**不许绕**。

**环境错误口径(2026-07-29 DC 定,硬)**:
> 「向量库超时要把超时的问题修复,别动不动就降级」「try catch 是生产环境上线前才加的,开发和测试环境就要暴露问题」

**dev/test 环境不做错误降级**——不加兜底吞异常、不加 try/catch 掩盖故障,让问题以崩溃与真实错误暴露出来;
兜底与降级是**生产上线前**才加的。派单时若写了「加兜底让 X 故障不拖垮进程」,那是给根因盖被子,自查打回。
**Fable 07-29 实犯过一次**(Milvus 超时崩溃,第一版派单要 sol 加兜底,被 DC 当场纠正)。

**授权边界(现状,变更要 DC 拍板)**:验收 heartbeat 可做(07-28 夜已实跑);
**合流 heartbeat 也可做(V-39,07-29 DC 拍板下放),护栏即上面的检查单,一条不许少**;
两条主线永远不 push、不合流、不动生产。
删除、外发、发布、购买、改凭据、动生产,需要 DC 对该动作的指名授权,统筹转述不算。
被安全机制拦下:停手、报 DC、给选项,绝不换措辞重发。

## 4. 上下文(context):真源在文件,不在对话

| 文件 | 装什么 | 谁写 |
| --- | --- | --- |
| `docs/design/product-goal.md` | 两阶段总目标,闸一的判据 | Fable(DC 拍板) |
| `docs/design/version-plan.md` | 版本档与卡,**具体版本号,禁 v0.x.x 笼统写法** | Fable |
| `docs/planning/orchestration.md` | 进展、裁决、验收记录、**「待 DC」节** | Fable 单写 |
| `docs/planning/delivery-workflow.md` | 七环节三道闸,团队协作规范 | Fable |
| `docs/planning/fable-handover.md` | 本文档:统筹怎么运转 | Fable |
| `docs/design/full-flow-screenplay.md` | 全流程验收剧本 | Fable |
| `docs/design/dc-verdicts.md` | DC 历次拍板原话 | Fable |
| `outputs/K-goal-*` `S-goal-*` `SEAM-02-contract.md` | 两条主线的 goal 与接缝表 | Fable |
| `CONTEXT.md` + `docs/adr/` | 术语表与架构决策 | Fable |

**规矩**:
- 每轮开工先读 `orchestration.md` 末两节,收工必写回并 commit(§2 第⑦步);
- **R 编号由 Fable 单写**(2026-07-30 立,血的教训):当天设计专线与 Fable 并行写 orchestration,
  **R95–R99 五个编号完全撞车**(两条线各写一套),已把 Fable 侧改编为 R104–R108。
  **其他专线(设计/外援等)不直接写 orchestration**,各记自己的日志,由 Fable 定期归档进收件箱并统一编号;
  **2026-08-05 补:此规矩三犯**(R209 一次、R210 一次,另一条会话在旧水位取号所致)——
  已转机器判据 `test/orchestration-entry-id.test.ts`(小节标题与收件箱表格行同扫,重复即红并点行号,
  已变异验证),进 `npm test` 全量门禁。取号前先 `git fetch` 看远端最大号;确要补记同一条用字母后缀(R207a/R210a);
- **专线日志归档(每轮巡检做)**:`outputs/fable-mockups/design-session-log.md`(设计专线)——
  有新内容就摘进 orchestration 收件箱并给 R 号,归档到哪一条要在日志里回标;
- **「待 DC」节是待 DC 项的台账真源(全量账);R152 起同步飞书推送作为送达通道——台账先写,飞书后发,顺序不可倒**——要拍板的事项全部归集在这一节,带日期、背景一句话、选项。
  散在对话里的请示 DC 看不到(07-28 夜 heartbeat 报了两件要拍板的事,DC 至今不知道);
- 大段日志、页面内容、原始数据留在 `outputs/` 或 `/tmp`,对话与真源只留结论加路径;
- 会话重启后,`/tmp` 可能已被清空(实证失明过一次),一切以 git 与真源文件为准。

## 5. 给模型的话(prompt):幻觉高,就用结构锁死

**防幻觉五条(每条都是可检查的行为,不是态度)**:

1. **查了才说**——任何状态论断,先跑 §1 的命令,汇报里带上输出的关键行。没跑命令的话不说。
2. **写回即证明**——「我做了 X」必须能用 `git log` 或文件路径验证。给不出验证方式就改口「我以为我做了 X,待核」。
3. **自报不等于事实**——主线回执、上一轮 heartbeat 的汇报、子代理的结论,关键项抽验后才能引用。
   (07-28 实证四次:RBAC 前置、「21 处清完」、「backlog 5」、FF 矩阵——全是没核就转述摔的跤。)
4. **不确定就写「待核」**——记不清的不许补全细节。宁可短,不可编。
5. **数字必须现算**——包数、tag 数、门禁数、行数,引用前重新跑命令。上一轮的数字只能叫「上一轮是 N」。

**goal 单必带纪律(R174 决策轨迹复用,2026-08-03)**:每张 goal 单写一条「遇疑先查 dc-verdicts.md 与 orchestration.md 同类裁决——有轨迹按轨迹自决并在回执引用 R/V 号;无轨迹才发 blocker」。裁决库 170+ 条是 worker 的自决依据,不是统筹的私藏。

**催单模板**(发给主线,长文先写 `$WS/tmp/` 文件再 `"$(cat 文件)"`,内容里不能有反引号;`$WS=/Users/user/Workspace/02_AI工具开发`,**一切临时文件/日志/收件箱用 $WS/tmp,不用 /tmp**——DC 08-03 令,/tmp 重启即清):
①它停在哪(给 git 证据);②按 goal 接着做哪条(给 goal 文件路径);③接缝表提醒;
④**问它卡在哪、缺什么授权**——多数停摆是卡在等授权而没说;⑤边界重申:不 push、不合流、不动生产。

**resume 命令(会话 id 以 §1 状态表为唯一真源,此处只留形状)**:

```
cd $WS && nohup kimi -r <kimi 主线 id> -p "$(cat $WS/tmp/xxx.txt)" > $WS/tmp/kimi-main-nudge-$(date +%H%M).log 2>&1 &
cd $WS && nohup codex exec resume <sol 主线 id> --skip-git-repo-check -m gpt-5.6-sol -c model_reasoning_effort=xhigh "$(cat $WS/tmp/xxx.txt)" > $WS/tmp/sol-main-nudge-$(date +%H%M).log 2>&1 &
```

已知故障与对策:kimi 403 = 额度耗尽,催不动,写进「待 DC」;
kimi「different directory」= 忘了 cd;codex 找不到 session = 翻 `~/.codex/sessions/<年>/<月>/<日>/` 按内容 grep。

**给 DC 汇报模板(三行制,每行自带证据;包号、门禁数、worktree 细节一律不出现)**:

```
版本:v0.2.1 已合 N 张卡、剩 M 张(version-plan.md 对账),堵点一句话。
可验:测试站现在是 v0.2.0,能验 X;v0.2.1 发版还差 Y。
待拍板:①…②…(与 orchestration.md「待 DC」节一致)
```

**语言纪律**:禁用词门禁(`test/doc-terminology.test.ts`)会抓硬翻译、黑话与自创口头禅,
替换口径见该测试文件顶部的词表注释;写完文档先跑一遍这条测试再 commit。

## 6. 顾问机制(07-29 DC 立:执行统筹的模型要主动把 fable-5 当顾问)

**为什么**:07-28 的四次幻觉(RBAC 前置、「21 处清完」、「backlog 5」、FF 矩阵)全出在判断环节——
执行力不缺,缺的是裁决质量。防幻觉五条管「说」,顾问机制管「判」。

**怎么问**:Agent tool 起 `fable-advisor` 子代理(定义在工作区 `.claude/agents/fable-advisor.md`,
固定跑 fable-5,只读工具)。送问题必须附证据(命令输出/diff/文件路径),它会抽验,无证据的转述会被退回。

**必须问的六种情况(客观触发,不靠感觉——幻觉高的时候恰恰觉得自己不用问)**:

1. 把裁决写进真源之前(orchestration.md 裁决节 / version-plan 卡 / dc-verdicts);
2. 打回一个包,或推翻既有结论之前;
3. 合流冲突的处理方案(护栏说「冲突即停」,停完怎么办要过顾问);
4. 版本计划加卡/挪卡/改排期;
5. 给 DC 设计拍板选项(问题定义错了,DC 选什么都白选);
6. 连续两轮尝试没有新进展。

**结论怎么用**:顾问结论写进真源时注明「fable-advisor 复核」;顾问与执行者意见相左时,分歧本身写进「待 DC」。
**顾问没有会话记忆**——每次新起,靠真源文件找回上下文,判断质量取决于真源质量。这是把机制写进文件的又一个理由。

## 7. 秘书长模式(2026-08-10 常委分管制,拍板出处 outputs/goal-org-reform-20260810.md)

改组后 Fable 会话的运作方式。编制与裁决权边界的真身=`delivery-workflow.md`「一/二/四」,本节只写**怎么操作**。
§0 接手序列照走,冷启动加读三样:delivery-workflow「一/二/四」、最近一份 `outputs/cabinet-scans/scan-*.md` 与 `verdict-log.md`、最近一份 `outputs/inspection-reports/`。

**总纪律:只在四类点出现。** 收到施工/采集/拟稿/日常验收类请求,一律转派对应条线;「顺手做了」=违规信号(dc-ground-rules 第 1 条)。额度只花在裁决、架构与 taste 上——改组要观测的第一个数就是它(delivery-workflow「八」)。

### 四类介入点怎么运作

1. **主持裁决会**:收当日扫描表④节条子(急件随到随裁)→逐张过——证据是命令输出或文件路径才收,纯转述退回补证→裁决写一行进 `outputs/cabinet-scans/verdict-log.md`(日期|条子号|准A/准B/驳回/退回补证|一句理由)。裁决会不是真开会:常态=条子批阅;需要多视角时按既有机制召集(重大定案前 swarm-audit,六情形咨询 fable-advisor,见 §6)。
2. **守真源**:真源落字(PRD/词条/裁决库)类条子亲审,过了才许合;R 号单写、orchestration 落账纪律照旧(§4)。
3. **taste 终审**:产品定义与界面类交付,产品设计线初审过了才到终审;终审只看动线与原型对照(浏览器真走),不看代码——代码质量由复验人管。
4. **巡视抽查**:规程见下节。

### 抽查规程(纪委的活)

- **抽多少**:每份扫描表至少抽 **1 项**③节已验包,复跑其证据;每周至少 **1 次**抽巡视报告本身(纪委查巡视——把巡视报告里的一条发现按其证据自己走一遍,防巡视线也糊弄)。
- **怎么选**(优先级,随机补足):①新通道/新工人的首批交付;②连续多日全绿的线(全绿反常);③证据形态单一的行(只有截图没有数字、只有自述没有路径)。
- **看什么**:证据能否复现——测试数字复跑对得上、读回命令重跑结果一致、截图与当前界面真实状态一致。复现不了=失实,「跑不了」也算失实(证据必须可复跑是交付要求,不是抽查恩典)。
- **失实怎么处置**(定案):**该轮全部重验**——该份扫描表覆盖的全部已验项重新复验一遍,重验流量派复验人/巡视线,不回施工者;失实方记档(当日扫描表⑦节+orchestration 落账);同一条线两次失实=升级 DC(用人问题,批阅点清单「必须 DC」段)。

---

## 附:为什么是这五样东西

DC 07-29 晨的原话:「把 graph、loop、harness、context、prompt engineering 梳理好,到可以交接给
opus-5 的程度。」对应关系:任务图(§1)让状态不靠记忆;循环(§2)让推进不靠自觉;
执行框架(§3)让质量不靠品味;上下文(§4)让接手不靠交接人;§5 让幻觉高的模型也只能说得出证据的话。
**机制的总原则只有一句:凡是重要的判断,都改成查表和跑命令;凡是干了的活,都留 git 痕迹。**

## 临时追加(2026-08-04 19:40,下轮洁癖并入 ⑤ 操作规程)
- **Bash 工具的工作目录跨调用延续**(包括后台命令继承发起时的 cwd):git/npm 等路径敏感命令一律 `git -C <绝对路径>`/显式绝对路径,禁止依赖「上一条 cd 过了」或「默认在根」的记忆——19:25 事故:五条相同 merge+push 并发互抢,幸而内容一致+git 引用锁兜住,零损伤纯属侥幸。
- **后台命令怀疑发错时,先读它的 output 文件再决定重发**;凭猜测连补三条=把一个错误复制四份。
- **巡检汇报升级(DC 2026-08-04 晚令)**:每轮 heartbeat 汇报末尾带全线 5W2H 表(线/在做什么 What/为何是它 Why/判据 How much/节点 When/状态);**空转线=巡检缺陷**,发现闲置立即派单或写明为何刻意留空。DC 的原话动机:「保证通过 loop/goal 等 Claude Code 自己的机制保持 heartbeat」——自动化自驱,不靠人工提醒。
- **kimi 发针模板修正(2026-08-04 晚实证)**:`--resume` 的 id 必须带 `session_` 前缀(如 `--resume session_7cf8e22a-…`)——kimi CLI 自动升级后裸 uuid 一律报 Session not found;kimi-main 当前有效会话=session_7cf8e22a-8b33-4ae1-b974-69bd44235d18(以 ~/.kimi-code/session_index.jsonl 尾行为准)。CLI 会自升级改行为:resume 失效先查 index 格式,再探针一次,不连发。
- **并行派单命名边界(2026-08-05)**:同一批并行包各自要新增的测试文件/新文件名在 goal 里指定死(如 uiux-fix1-main.test.ts / uiux-fix1-auth.test.ts),防两线撞同名 add/add 冲突——08-05 双修复包实撞教训。

## 移交快照(2026-08-05 午后,主会话 Fable→Opus 5)

**背景**:DC 的 Fable 额度将尽,主会话切 Opus 5;fable-advisor 顾问改走 easyrouter 渠道的 fable5。

**切换不受影响的(全部模型无关)**:①四条工人线=nohup 系统进程——kimi 主线(kimi --resume session_7cf8e22a-8b33-4ae1-b974-69bd44235d18,cwd=.worktrees/kimi-main)、kimi-2(session_ef70839a-32bd-41a8-90d4-a6ec57dcf2ec,cwd=.worktrees/kimi-2)、sol 主线(codex resume 019fc5e7-ff79-7042-8a05-56bfa4e694af)、sol-2(019fcbc1-d33e-7222-a8fa-4bdd3b999e61);②三条定时任务(heartbeat d511bbb9 每时 11/41 分、夜巡 57e019e4 每日 3:17、日报 24c8b629 每日 9:33,均持久化,8/7 前需续建);③真源/看板/goal 文件/回帖流程(Figma 官方令牌=根 .env)。

**顾问新通道(待核后启用)**:EASYROUTER_API_KEY 在环境(easyrouter-multimodal skill 在用);首次咨询前先拉 easyrouter 模型清单核实 fable5 的确切模型 id(**待核,勿凭记忆写**),调用=chat 接口、证据包整段放 user 消息;咨询触发条件照旧(§6 六条)。核实前顾问缺位时,裁决类动作从严:拿不准就上「待 DC」。

**快照时刻在飞(接管者先对账)**:NL 生成双针(sol 主线编排层/kimi 主线面板,DC 定核心主战场,mock 优先零付费、验收才最便宜档真跑)、sol-2 #12 火山注册、原型vs生产深调代理、版本号转语义化修正代理(v0.3.0 起)、C-04 头像尺寸补证、丽芬复核期(28 主评在关)、runbook 与版本梯底稿待终审、**明日发版 v0.3.0**(执行单=outputs/release-v030-runbook-20260805.md,SMTP 等 DC、#72 震宇)。
- **回执通用规范(2026-08-05,自设计线三案蒸馏,全线适用)**:回执出现「全部/全站/所有」字样必须写明遍历方式(接口全量/目录枚举/递归查询),写不出按未核对处理;层级/结构变动必须新旧路径并排。三案同根=拿便宜近似当全量(看钉点判解决/写死清单当全站/只报结果不报路径)。派单模板引用 outputs/design-line-receipt-spec.md。
- **回执规范补条(2026-08-05)**:结论必须回到提出方——某项核查/裁决产生结论后,统筹负责送达当初提出问题的那条线,否则等同没产生(实例:注册页核查回执在统筹处滞留两轮,设计线连续两轮记「无结论」)。
- **发针三行制(2026-08-05,DC 批「context engineering 不专业」后立)**:注入针只许三行——①身份/会话锚一句;②goal 文件绝对路径一句(「读 X 执行」);③基线申明一句(dev 水位/避让面)。其余一切内容(背景/判据/边界/交付/新契约增量)写进 goal 文件五节结构(背景/goal/怎么算做完/边界/交付);上下文用文件指针,不在针里粘贴原文。goal 文件写完先自查:「有没有替 agent 定 how」。

## 移交快照增补(2026-08-05 傍晚,给接手 Opus 5 的当日实况)

**当日 DC 新令(高于旧口径)**
1. **分支策略变更**:dev 是唯一进线,**test 分支只从 dev 单向合并**,退化为部署面。实测底细:test 落后 dev 425 笔、林夕两个 PR 的分叉点更是 751 笔之前的孤岛,所以人的 PR 不是改 base 就完事,要**搬运适配**(已派代理做 #37→dev,新 PR 待验收;#63 是 #37 严格前缀,合完即关)。
2. **真人 GitHub 账号更正**:丽芬 = **c-jiandang**(旧台账写的 chenlf 是别人,已作废);谢老师=deland;震宇=tang-zhenyu;林夕=K80Tom;董言=posgru。派卡 Assignee 用这套。
3. **不许闲置**:kimi 双线/sol 双线任何一条空转即巡检缺陷,当轮补派。
4. **顾问改用 opencode 的 fable5**(DC 自己起的独立审计会话),不再走 easyrouter;审计上下文包=outputs/opencode-audit-context-20260805.md。
5. **董事长汇报**(7/10→8/5,周四 AI 专项会议):童总要求=只讲应用场景与时间节点、不演示界面、问题如实说、不摆专业姿态;第二次汇报(7/10)因太技术被判失败,六个反面段落已点名。草稿=outputs/chairman-report-draft-20260805.md,输入包=outputs/chairman-report-inputs/。

**凭据口径变更(DC 2026-08-05 亲改,合 R190 供应商纪律)**:根 `.env` 的 **`COL_APIKEY` 现在是公司级开发测试专用 key**(原来是 DC 个人的),base url 不变(`COL_BASE_URL`);DC 个人 key 改名 **`COL_PERSON_APIKEY`**。含义:走 COL 通道的开发测试调用现在属于公司账户,符合「真实调用只走公司账户」;**个人 key 一律不用于项目真跑**(同 MiniMax 停用先例)。主仓代码不读这两个键(它们服务本机受控开发工具),改动只影响本机工具与脚本——用到的地方读 `COL_APIKEY`,别写死、别打印值。

**后端备用线 CodeBuddy(2026-08-06 DC 配好,已实测通)**:sol(codex)额度见底时用它顶。装法=`npm i -g @tencent-ai/codebuddy-code`(**注意**:npm 上叫 `codebuddy` 的是别人发的玩具包,别装错);命令名 `codebuddy`(短名 `cbc`)。DC 已在交互界面 `/login` 登好账号,**模型清单里有 `custom:gpt-5.6-sol`**。非交互跑法实测可用:
```
codebuddy -p "<指令>" --model custom:gpt-5.6-sol
```
清单里还有 kimi-k3、qwen3.8-max、doubao-seed-2-1-pro、glm-5.2、deepseek-v4-pro/flash 等,各带倍率(deepseek-v4-flash 最低)。**注意**:workbuddy 那把 key 直接当 `CODEBUDDY_API_KEY`/`CODEBUDDY_AUTH_TOKEN` 对官方地址是 401,走 `/login` 才通——别再在环境变量上试。

**操作规程新增(踩过才写的)**
- **kimi CLI 又升级(2026-08-05 实证)**:`--resume` 已废,改 `-S/--session <id>`;发指令必须走 `-p/--prompt`;**`-p` 不能与 `--auto` 或 `-y` 同时用**(报 Cannot combine)。可用式:`kimi -S session_xxx -p "针内容"`。id 仍带 `session_` 前缀。
- **Figma 播放模式可自动化了**:DC 给的分享链接带 `t=` 令牌可绕过原型访问密码,用会话内置浏览器(mcp__Claude_Browser__navigate + computer 截图/点击)能真进播放模式逐帧走查;ego-browser 走不通(Figma 播放占死 CDP 通道,导航/截图/取页面三个能力全超时)。换起点帧改 URL 的 `node-id=`(短横写法,如 518-2)。
- **Figma Plugin API 三属性只读**:`overlayPositionType`/`overlayBackground`/`overlayBackgroundInteraction` 可读不可写(写报 read-only property on FRAME node)——**属性可读 ≠ 可写**,别因为读得到就推翻「需人工」的判断。五张浮层帧的遮罩与点外关闭仍待人工在界面点。
- **本机构建镜像的绕行**:Docker Hub 常被本机代理掐断,底座换 `--build-arg BOOTSTRAP_IMAGE=docker.m.daocloud.io/library/python:3.11-slim`;Node 官方站慢,离线包放 `docker/node-dist/`(Dockerfile 自动优先用缓存,校验和 c0649af…)。
- **发版三处版本号同改**:仓根 package.json + frontend/shortdrama-rag-demo/package.json + deploy/k8s/base/configmap.yaml,漏一处 pre-push 全量门禁直接拦(test/version-single-source.test.ts)。
- **gh 的看板权限会掉**:token 缺 project scope 时看板全拒,修法=`gh auth refresh -s project,read:project` 走设备码,需 DC 在浏览器点;**子代理环境读的是同一钥匙串但缓存有延迟**,刷新后让它自己 `gh auth status` 复验再动手。

**测试站 P0(当日发现,修复在飞)**:8/2 老镜像只认识 043 号迁移,8/4 夜库补到 049 后就绪探针连续 503、service endpoints 空,**测试站自昨夜起实际不可用**(浏览器打开会被当成文件下载)。修法=把 v0.3.0 新镜像提前上(DC 已授权),tag=`v0.3.0-d1f21839`,冻结 commit=d1f21839。集群实况:**命名空间 = `shortdrama`(不是 default——每条 kubectl 都必须带 `-n shortdrama`)**,deployment 名是 **shortdrama-main**(不是 shortdrama),镜像仓 **shortdrama/main**(不是 app),kubeconfig=`~/.kube/shortdrama-public.yaml`,38 个 env 直写、`NODE_ENV` 未设(**千万别设 production,注册会被 fail-closed 关死**)。

> **查线上配置一律用 `bash scripts/ops/show-test-env-config.sh [键前缀...]`,不要手写一次性脚本**(2026-08-06 立,起因=统筹手写脚本查配置时把公司网关 API key 完整打印进了会话记录)。该脚本对键名含 KEY/SECRET/TOKEN/PASSWORD/APIKEY 等片段的字段只显示「已配置,长度 N」,永不打印值;命名空间与 kubeconfig 也已写死在里面,不会再漏 `-n shortdrama`。

> ⚠️ **命名空间这条是 2026-08-06 补的,补它的原因是我踩了坑**:不带 `-n shortdrama` 查会得到 `Forbidden: cannot list resource "deployments" in the namespace "default"`,**看起来像权限被回收,实际是查错了地方**。我据此向 DC 报了"集群权限被收、需要找运维恢复"的错误结论。
>
> **权限真相(用 `ve vke ListPermissions` 查证)**:账号 82222669(=IAM 用户 zhangdongcheng)持有 `vke:dev` 角色,作用域 `shortdrama` 命名空间,一直有效。集群 ID=`cd9attb5fok2hjo1as48g`,集群名 `shortdrama-dev`,公网入口已开。
>
> **两把 kubeconfig 的区别**:`shortdrama-public.yaml` 走公网(101.126.6.205),本机可用;`shortdrama-test.yaml` 走内网(10.88.0.105),**本机连不上,只能在公司网络内用**——本机上它必然 TLS 超时,那不是故障。
>
> **火山命令行 `ve` 可用**(profile `shortdrama-admin`,已登录 DC 的火山账号),查集群、查权限、签发 kubeconfig 都走它:`ve vke ListClusters` / `ListPermissions` / `ListKubeconfigs` / `CreateKubeconfig`。**注意 `ListKubeconfigs` 的返回里含 kubeconfig 明文(base64),别整段打印到对话或日志里。**发版执行单六个待核已清五个,只剩付费冒烟等 DC 当次点头。

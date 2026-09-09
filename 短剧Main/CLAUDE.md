# 项目规则入口

**本文件只是指路牌。真正的规则在 `AGENTS.md`,开工前必须读完。**

`AGENTS.md` 对整个仓库生效,里面有:写代码的八条硬规矩(第 0 节)、真源与优先级(第 1 节)、技术栈、以及各类合同文档的指针。

三条最容易被忽略、但违反了要返工的:

- **改产品行为的顺序不可颠倒**:裁决 → 改产品需求文档 → 改 Figma 原型 → 才派工人干活。先动手后补文档 = 让施工现场定义产品。
- **本地提交不算交付**:要推到远端、开出 PR、检查绿了才算。
- **用户看得见的地方一律说人话**:出现厂商名、HTTP 状态码、英文报错、内部状态名,都算缺陷。

产品是什么、为什么这么做,看 `docs/design/prd-spine.md`(产品主线)与 `docs/design/prd-v2/`(各章)。

---

# 环境事实(照抄即可用,不用再摸)

> 2026-08-06 立。这一节只放**查过一次就不该再查第二次的事实**。
> 规矩、工作流不放这里——护栏在 `~/.claude/hooks/`,工作流在 skills。

## 测试环境

| 项 | 值 |
|---|---|
| 地址 | **`https://shortdrama-main-test.col.com`** ← **必须 https**,入口只配 443 没配 80 |
| 打不开先排除本地 DNS | `curl -k --resolve shortdrama-main-test.col.com:443:180.184.96.109 https://...`;通了就是本机网络问题,不是服务故障 |
| Kubernetes 命名空间 | **`shortdrama`** ← 每条 kubectl 都要带 `-n shortdrama`,不带会报 Forbidden、**看起来像权限被回收** |
| kubeconfig | `~/.kube/shortdrama-public.yaml`(公网)。`shortdrama-test.yaml` 走内网 10.88.0.105,**本机必然超时,那不是故障** |
| deployment 名 | `shortdrama-main`(不是 shortdrama) |
| 服务名 | `shortdrama-main-svc:8000` |
| 镜像仓 | `shortdrama-prod-cn-beijing.cr.volces.com/shortdrama/main`(**不是 app**) |
| 镜像仓登录 | 令牌 24 小时过期。用 `ve cr GetAuthorizationToken --body '{"Registry":"shortdrama-prod"}'` 签临时的,再 `docker login -u cr_temp_user --password-stdin` |
| 查线上配置 | **一律用 `bash scripts/ops/show-test-env-config.sh [键前缀]`**,它对密钥只显示"已配置,长度 N"。不要手写脚本——2026-08-06 手写时把网关密钥打印进了会话记录 |
| 后台管理员凭据(**测试站**) | **工作区根 `.env` 的 `TEST_ENV_ADMIN_PASSWORD`**(用户名 `admin`)。这条**只对测试站 `shortdrama-main-test.col.com` 有效**。开号/充值脚本读它登录,值不打印不进会话——2026-08-10 因不知道这条,白试三轮还劳烦 DC 指路 |
| 本机 dev 库的账号(**跟上面不是一回事**) | 本机 docker 库(`127.0.0.1:5432/shortdrama`,schema `app` 与 `lite`,**8000 与 8010 共用同一个库**)归 `sol-lite-ui/.env` 的 `DEV_ADMIN_PASSWORD` 管,与测试站那条无关。**2026-08-11 已把库里 admin / biz01 / biz02 三个号统一设成这个值,所以现在 `.env` 说的是实话**。⚠️ **改 `.env` 不会回写库**:`scripts/dev-up.mts:70` 是「admin 已存在就跳过」,这就是漂移的根——两边对不上时用 `scripts/set-local-admin-pw.mts`(带「非本机就拒绝执行」的护栏)让库跟上 `.env`,**别反过来另存一份新口令**(2026-08-11 犯过:另立一份存进 `.secrets/`,等于亲手又造一次漂移)。**千万别跑 `dev:reset`——那会 `docker compose down -v` 删掉整个本地数据卷**。 |
| ⚠️ 登录填的是**账号名**不是邮箱 | 登录框标签写着「邮箱」,但这些号**没有邮箱**,照字面填会报「账号或密码不正确」,让人以为是密码错了。**这个坑卡掉过一整轮精简版验收**(离线比对了 81 个候选口令才发现输入的字段就不对)。接口层字段是 `username`。已记为待修文案。 |
| 精简版模式的账号 | `ui_mode=lite` 的是 `biz01` / `biz02`,**验精简版本来就该用这两个号,不是 admin**(admin 是 `full`)。**画面在 `biz02` 名下**——它是「Lite 冒烟项目」的负责人,biz01 名下没有项目。 |
| 单点登录会互踢 | 目前后登的把先登的踢掉(`src/modules/auth/repository.ts` 建会话事务里)。**多人 / 多 agent 并行验收必须各用各的号**——2026-08-11 两个执行方共用一个号互踢十几次,白耗一轮。正在改成「开发与测试默认关掉这个限制,生产保留」。 |
| ByteHouse dev 凭据 | **工作区根 `.bytehouse-dev-aksk.csv`**(600,shortdrama-dev 子账号 AK/SK,dev 数据权限全开 *.*;2026-08-10 DC 开通)。另有数据库用户 s55_hw_readonly/app_20260803(密码未存,可用 AKSK 重置自管)。火山 ByteHouse 华北2(北京) |

## 共享工作树纪律(2026-08-11 立,当天撞了四次)

`.worktrees/v011-integration` 是共享工作树,同一时刻常有多个会话在里面干活。

**一、破坏性实验不许在共享树里做。**
变异测试、探针注入、故意改坏产品代码这类动作,一律去隔离副本:
`git archive <sha> | tar -x` 从对象库取**已提交快照**(比 rsync 干净,不会抄进别人在飞的改动),
`node_modules` 软链回共享树,副本内 `git init` 便于逐次还原。
锚:两个会话同时做变异,一个把 `capabilities-state.ts` 改成变异态、另一个的探针文件冒出来,
导致复验方**读到假红**,一度以为修好的东西回归了。

**二、清理与恢复类动作同样连坐,而且判据看后果不看命令。**
同日又出两次:有会话把别人未提交的修复 `git checkout --` 掉了两次,又把别人未跟踪的交付物 `rm -rf` 掉了;
另外两个会话为此各花一小时排查「有个未识别会话在抹别人的活」——那个会话就是做清理的自己人。

**光禁命令没用**:事故里 `git clean` / `git restore` / `git checkout --` 都有,
但真正删掉交付物的那一下用的是普通 `rm -rf`,不在任何禁令名单里。判据改成:

> 共享树上任何会让**别人的未提交改动**消失的动作,不论用什么命令,做之前两件事都要做到:
> ① 确认那份活**已经推到远端**(本地 commit 不算——推送可能被钩子拦下,当天撞过);
> ② **当场通知**落这份活的那个会话。

第二条不是客套:**抢救别人的活、和不告而取,在别人眼里长得一模一样**——
对方看到的都是「我的改动凭空消失」,然后就开始查幽灵。

**三、更省事的是根本别走到这一步。**
交付物别留在共享树的工作区里。干完当场 `git checkout -b` 推远端,
或者一开始就在自己的隔离 worktree 里干。跨会话交付尤其如此:**交之前先自己开分支推上去**,
留在共享树里等于押运气。

**四、连带判据:共享树里跑出来的 typecheck / test / build 三数不可信。**
被别人的在途改动污染过就不算数。要当验收证据用,得在干净的隔离环境里复跑——
当天实测过一次:自报「884 个文件」实为「探针还没删 + 混进了别人的未跟踪文件」时量的。

探针文件用完立刻删。留在共享树里等于给下一个人埋雷。

## 8000 端口纪律(2026-08-10 DC 立,不许再破)

**产品负责人只认 8000**:`http://localhost:8000` 必须**始终等于 dev 分支最新**。他在 8000 上看到的问题,必须是 dev 最新代码的问题——不许再出现「他在两天前的代码上找问题」。

| 项 | 值 |
|---|---|
| 8000 专用工作树 | `sol-lite-ui/`,分支 `local/dev-8000`(origin/dev 的镜像,只 fast-forward 不提交) |
| 为什么不用集成区 | 集成区 `.env` 指向测试环境数据库,dev 护栏拒绝启动(护栏是对的,别拆) |
| 启动 | 用 preview_start 起 `dev-8000`(`.claude/launch.json`,启动时自动 fast-forward 到 dev) |
| **每次合 PR 进 dev 后** | 跑 `bash scripts/ops/sync-8000.sh`。它会**比对 `/health` 报的提交号与工作树的提交号**,不一致就清掉这棵树自己的进程、带上正确的 `APP_COMMIT_SHA` 重起,然后循环读回直到 health 报出的号真的对上才算成功;一致时不重启,免得打断正在点页面的人 |
| 查水位 | **直接看 `/api/v1/health` 的 sha**——2026-08-11 起它说的是实话。<br>~~别看 health 的 sha(那是启动时刻的)~~ 这句作废:老脚本只 fast-forward 不重启,而 `APP_COMMIT_SHA` 是进程启动时读一次的环境变量,于是工作树最新、跑的却是旧代码、health 还理直气壮报旧号。**同一天还发现三个 dev server 同时在跑**、抢同一棵工作树,一并收拾了 |

## 数据库

| 项 | 值 |
|---|---|
| 实例 | `postgres-4a3018919997`(RDS,名 shortdrama-dev) |
| schema | **`app`**(不是 public) |
| 应用账号 | `shortdrama_test` —— **没有改表结构的权限,这是对的,别去加** |
| 迁移账号 | **`shortdrama_migrator`**,凭据在工作区根 `.env` 的 `POSTGRES_MIGRATOR_USER/PASSWORD` |
| 怎么跑迁移 | 在容器里用迁移账号身份跑应用自带的程序:<br>`kubectl -n shortdrama exec <pod> -- env POSTGRES_USER=$POSTGRES_MIGRATOR_USER POSTGRES_PASSWORD=$POSTGRES_MIGRATOR_PASSWORD node dist/db/migrate.js` |
| **不要用 psql 直接跑迁移文件** | 文件里是 `{{schema}}` 模板占位符,psql 会报语法错误 |
| 迁移不会自动跑 | 应用启动不执行迁移。新版本上线前必须手工跑,否则容器起来但就绪检查一直 503 |

## 构建镜像

**构建前必须先清 Docker 悬空卷**,否则报 `no free space in /var/cache/apt/archives`:

```bash
docker volume ls -qf dangling=true | wc -l    # 2026-08-06 实测有 2425 个
docker volume prune -f                         # 清出 124GB
```

来源:数据库测试每跑一次留一个卷。**只要还在本机跑数据库测试,就会继续攒。**

构建在集成区做(`.worktrees/v011-integration`),**不要切主仓分支**——主仓停在别的分支上,那里没有构建脚本。

## 接口参数(踩过的)

- 建集:`POST /api/v1/projects/:pid/episodes` 要 **`episode_no`**(数字),不是 `title`
- 存剧本:`POST /api/v1/episodes/:eid/script-versions` 的 **`client_idempotency_key` 必填**,至少 8 位
- 后台开号:`POST /api/v1/admin/users` 只收 `username / display_name / role`,**不收密码**——初始密码由接口生成并返回

## 工人线(2026-08-10 晚定梯度)

**按能力分三档派活,不按人名派**:重活给 T1,常规给 T2,轻活给 T3。

| 档 | 成员 | 通道 | 代理 |
|---|---|---|---|
| **T1** | sol(gpt-5.6-sol) | codex CLI(ChatGPT 订阅) | **必须带系统代理** |
| **T2** | gpt-5.6-terra / kimi-k3 / qwen3.8-max | terra 走 codex;**k3 与 qwen 走 pi + 公司网关(col)** | codex 带代理;**pi 必须剥代理** |
| **T3** | gpt-5.6-luna / glm-5.2 | luna 走 codex;glm-5.2 走 pi + 公司网关 | 同上 |

- **代码优先用 dynamic workflow 写**(2026-08-10 DC 令),不再单独派 kimi 写前端;
- easyrouter 只兜订阅与公司网关都没有的模型;
- codex 本版只支持 responses 接口、公司网关只有 completions——**codex 接不了公司网关**,公司网关的模型一律走 pi。

**浏览器口径(2026-08-10 DC 拍板)**:agent 操控浏览器(走查/复验/截图/表单)**一律用 ego-lite(`ego-browser` 命令)**,它复用真实登录态且不与人抢浏览器;**playwright 仅保留给产品 E2E 测试套件**,不作为 agent 的浏览器操控工具——依赖不卸,但任何新写的走查/复验脚本不得再用它起浏览器。

```bash
bash scripts/lines/check-lines.sh              # 一屏看清死活、提交、卡在哪
bash scripts/lines/restart-line.sh sol1 "话"   # 断流重启,默认 resume 保上下文
# pi 工人标准启动(worker 上下文注入+剥代理):
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
  pi -p --provider col --model qwen3.8-max \
  --append-system-prompt ~/.pi/agent/worker-context.md "goal 文件路径 + 一句唤醒"
```

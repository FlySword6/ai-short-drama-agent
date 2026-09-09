# ADR-0005:数据库测试套件各自独立上 PR 闸,不合并进 verify-postgres

- 日期:2026-08-12
- 状态:已接受(DC 拍板)
- 决策人:DC;梳理:Fable

## 背景

`#284` 发现 `npm test` 链里 16 个 `test:*-db` 套件,其中 6 个在 CI 上一次都没跑过——PR 不跑,合进 dev 也不跑。本机跑 `npm test` 会跑到它们(有 Docker 的话),CI 页面上一片绿,**两边都没有任何信号说「这一批在 CI 上是空的」**。

修的时候有两条路:

1. 把 6 个套件追加进已有的 `verify-postgres`(一个 job 串多个套件,`if: github.event_name == 'push' && github.ref == 'refs/heads/dev'`);
2. 每个套件开一个独立 job,各带 `if: github.event_name == 'pull_request'`。

第一条看着更省——6 行 yaml 就完事,不用新起 6 个容器。**开发机上的 worker 当时就是这么做的**(分支 `devbox/issue-284-ci-db-coverage-final`,2026-08-12 00:26 提交)。它同时写了一个守卫脚本,判据是「每个 `test:*-db` 在 workflow 文本里必须出现」。那个守卫跑自己的产物是绿的。

问题在于 `verify-postgres` 只在 push 到 dev 之后触发。**追加进去的套件在 PR 上仍然不跑**,拦不住任何一次合并。而它的守卫查的是文本出现,不看触发条件,所以检不出这个错——判据和被判对象是同一个误解的两面。

实测(把那版守卫取到隔离目录跑):

```
基线                                              exit 0   "all 16 test:*-db suites ... have CI execution"
变异:塞 test:fake-db,只往 verify-postgres 加一行   exit 0   "all 17 test:*-db suites ... have CI execution"
```

第二行正是 `#284` 评论里定的判据要求**必须判红**的那一种。评论原文说前一种(完全不加 job)「任何写法都能抓到」。

两个 PR 的检查列表把差别摆得更直白:`#297`(追加进 `verify-postgres` 那版)自己的 PR 页面上跑了 6 项检查,**那 6 个套件一个都不在里面**;`#296` 的页面上多出正好那 6 项。

## 决策

**数据库测试套件必须各自独立上 PR 闸。**

判定一个检查是不是闸,看两件事,缺一不可:

1. **它在 pull request 上跑。** workflow 的 `on:` 里有 `pull_request`,且该 job 没写 `if:`、或 `if:` 里是 `github.event_name == 'pull_request'`,且跑它的那一步没有把 PR 排除掉的步骤级 `if:`。
2. **它失败时真的红。** 前置条件缺失(典型是 Docker 不可用)时不许静默 `exit 0`,在 CI 里必须以非零退出。

这条口径由 `scripts/check-ci-db-coverage.mts` 机器执行,不靠人记。判据本身有 11 条测试锁着,其中三条是变异测试:假套件完全不加 job、只加进 `verify-postgres`、挂进 PR job 但那一步带 push-only 的步骤级 `if:`——三种都必须判红。

`verify-postgres` 保留,但它的定位改写:**它不是闸,是「PR 各自绿不等于合起来绿」的兜底。** `#284` 那 6 个套件在 PR 闸与 `verify-postgres` 里各跑一次,两者拦的东西不同,不能互相替代。

### 判据的边界:守卫扫全部 workflow 文件,所以必须查 `on:`

守卫扫 `.github/workflows/` 下所有文件,不只 `ci.yml`——套件在别的 workflow 文件里上了 PR 闸一样算数,只盯一个文件会误报红,而误报红会让人学会忽略门禁。

代价是必须自己查 workflow 的 `on:`。只读 `ci.yml` 时它有 `pull_request` 触发器,这个前提隐含成立;扩到全部文件后前提就没了。一个不写 `if:` 的 job,在只有 `schedule` 的 workflow 里根本不会因为 PR 而跑。这个洞在 `#296` 的两轴 code-review 里被抓出来并补上(实测:假套件放进只有 `schedule` 的 `nightly.yml`,补之前守卫报「17 个都在 PR 闸上」exit 0)。

读不出 `on:` 时判定为不触发——门禁要往关的方向失败。

## 考虑过的其他做法

**用 `strategy.matrix` 把 6 个 job 收成 1 个。** 没选。矩阵里单个 cell 失败时,PR 页面上的检查名是矩阵名而不是套件名,读检查的人看不出是哪个套件红的——而 `#284` 的病根就是「PR 页面上看不出真实覆盖」。另外仓库里已有的 4 个 PR 闸 job(`#26` / `#28` / `#157` / `#150`)都是一个 job 一个套件,矩阵会让这批和那批长得不一样。

**只补 6 行 yaml,不立守卫。** 没选。`#284` 原文:下一个人加第 17 个 `test:*-db` 时照样会忘,而且照样没人发现——这正是这 6 个的来历。

**把 `verify-postgres` 里其余 7 个 dev-only 套件也搬成 PR 闸。** 产品负责人 2026-08-11 拍板暂不搬:那等于每个 PR 多起 7 个 postgres 容器,是拿 CI 时长换提前发现,要先有真实数据再权衡。这 7 个写成守卫里的显式豁免名单 `DEV_ONLY_EXEMPTIONS`,带理由与退役条件。豁免不是放行——名单外的新套件一律要 PR 闸,名单上的套件从 workflow 里整个消失也照样红。

## 后果

**PR 等待时长不变。** 实测(run 31569736824,以及 rebase 后一轮):6 个新 job 与 `verify` 同时起跑,41s–1m22s 内全部结束,而 `verify` 快线要 11–15 分钟。墙钟时间由 `verify` 决定。代价是并发多占 6 个 runner 各约 1 分钟。

**timeout 目前是 20 分钟,拍的。** 立卡时这批没有任何 CI 实测数据,注释里写了「卡太紧只会红在错的地方」。现在有数据了(41s–1m22s),收到 5 分钟仍有 3.6 倍余量。**没在本卡里改**——收紧要另跑一轮 CI,而这批当时已经全绿。建议在 dev 上跑够 5 到 10 个 PR、有失败率数据之后顺手改。

**新增 `test:*-db` 套件的人多一步。** 必须开一个带 `if: github.event_name == 'pull_request'` 的 job,并给 runner 的 Docker 预检加 CI 分支。忘了的话 `npm run test:node` 会红并指名,也可以先跑 `npm run check:ci-db-coverage` 自查。

## 不在本决议范围内

`verify-postgres` 那一趟里还有 4 个套件在 Docker 不可用时静默 `exit 0`(`asset-usage` / `object-context` / `s84` / `seed-audio`),另有 2 个 shell 脚本没有 npm 入口。它们不在 PR 闸上,`#284` 立的不变量测试正确地没有覆盖。已单列为 `#322`。

`#284` 提到的另外两条同族问题也不在本决议里:`verify-postgres` 在 PR 上永远 skipping(设计如此,但读 PR 检查的人不知道)、连着合会让 `concurrency: cancel-in-progress` 取消中间的 dev-push run。

## 相关

- `#284`(问题)、`#297`(6 个 PR 闸 job + 守卫第一版 + `verify-postgres` 双跑)、`#296`(守卫补齐四道判据 + 闸不许静默跳过)、`#322`(剩余静默放行)
- `AGENTS.md` 第 6 节「闸」的口径
- `scripts/check-ci-db-coverage.mts` 与 `scripts/check-ci-db-coverage.test.ts`

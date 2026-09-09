# 思考本(最新在上;想清楚才合上,合上才动手)

## 2026-08-03 · audio-pricing 间歇红第四轮:单跑也红,消重假设被推翻

**事实(带出处):**
- 本次红=单跑 push(无任何并发 npm test),错误 `FATAL: the database system is shutting down`,socket 路径 `/var/run/postgresql/.s.PGSQL.5432`(bg5ygrck0 输出)
- 上一次红(双跑期)错误=同一 socket 路径 `No such file or directory`(bp5tklz8o 输出)
- 两次都落在 run-audio-pricing-seed-db-test.sh 的 CREATE EXTENSION 段
- 脚本现文:pg_isready 与 psql 均无 `-h`,走容器内 unix socket(脚本 30/37 行)
- postgres 官方镜像 entrypoint 行为(docker-library/postgres 文档):initdb 后先起一个**只听 unix socket 的临时实例**跑初始化,关掉它,再起正式实例

**推断(与验证成本):**
- 根因=pg_isready 走 unix socket,在临时实例存活期就报 ready → 脚本抢跑 → psql 撞上临时实例关闭窗口(「shutting down」正是有序关闭的消息)。高置信:机制、报错文本、socket 路径三点吻合。
- 消重裁定(pre-push 唯一门禁)没白做:并发拉高负载会放大时序窗口,但它是放大器不是根因。

**如果我错了:** 另解是容器被外杀(OOM)——但 OOM kill 不产生「shutting down」这种 postgres 自身的有序关闭消息;宿主 postgres 干扰——报错来自容器内 exec,无关。分辨实验=修复本身:临时实例不听 TCP,探测改 TCP 天然把两种实例区分开,改完连跑即验。

**抬头:** 这事挡着所有 push(dev 本地领先 origin 1 commit),修复成本低(改探测协议)收益高(pre-push 稳定),值得现在修;修完立刻回块 2 亲做件,不恋战。

**谁的问题:** 合流门禁基础设施=统筹自己的活;修法有官方镜像文档背书,R154 口径自决。

**出口:**
- 结论:间歇红根因=探测协议选错——unix socket 探不出「临时初始化实例 vs 正式实例」,抢跑撞关闭窗口;并发只是放大器。
- 证据:单跑仍红推翻纯并发论;「shutting down」+unix socket 路径+脚本无 -h 三点实锤;官方镜像临时实例只听 unix socket。
- 下一步:全部 db 回放脚本的 pg_isready/psql 统一改走 TCP(`-h 127.0.0.1`;psql 需 `-e PGPASSWORD` 因 host auth 要密码,pg_isready 不需),本地单验 audio-pricing 脚本,再重推。

**教训沉淀去向:** 「就绪探测必须走 TCP,unix socket 会探到官方镜像的临时初始化实例」→ 修完落 fable-handover 门禁段一句;本页不做第二真源。

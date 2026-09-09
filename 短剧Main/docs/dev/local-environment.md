# 本地开发环境（起到能登录）

目标：新同事 clone 仓库后，`npm install` + `npm run dev:up` + `npm run dev` 三步把后端起到能用，再开一个终端起前端，就能看到登录页并登录成功。不碰任何云资源。

## 前置

- Node >= 22.19（`package.json` engines 有硬性要求）。
- Docker Desktop（或任意带 compose v2 的 Docker），用来起本机 PostgreSQL。
- 不需要 Milvus、TOS、Ark key——dev 下全部留空，应用照常启动（语义检索自动走 PostgreSQL 降级路径）。

## 起环境

后端三条命令：

```bash
npm install        # 首次
npm run dev:up     # 起库 + 迁移 + Day-0 管理员 + 最小演示数据（幂等，可反复跑）
npm run dev        # 启动后端（8000，带启动期护栏）
```

后端只提供接口，**页面不在 8000**。再开一个终端把前端起起来：

```bash
cd frontend/shortdrama-rag-demo
npm run dev        # 5173，/api 默认代理到本机 8000
```

然后打开 http://localhost:5173 ，登录：

- 用户名：`admin`（取自 `.env` 的 `ADMIN_USERNAMES` 第一个）
- 密码：`.env` 里 `DEV_ADMIN_PASSWORD` 的值（模板自带占位值，固定不变；想换成自己的，改完要 `npm run dev:reset` 重建才生效）

> 只改接口、不看页面可以不起前端；这时直接打开 http://localhost:8000 会给一页指引，告诉你页面在哪。
> 想让 8000 自己出页面，在仓库根目录跑一次 `npm run build:frontend`：前端构建产物
> （`frontend/shortdrama-rag-demo/dist`）不进版本库，干净 clone 里没有，后端没东西可伺服才会这样。
> 构建出来的是一份快照，改了前端源码它不会自己更新，边改边看还是用 5173。

`dev:up` 具体做的事：

1. 没有 `.env` 就从 `.env.example` 复制一份（全是本机默认值，可随手改）；
2. **护栏**：数据库目标必须是本机，指向云端 RDS 会显眼报错并拒绝继续（见下）；
3. `docker compose -f docker-compose.dev.yml up -d --wait db`：PostgreSQL 14-alpine，数据卷 `shortdrama-dev-postgres`，首次建卷时装好 `pg_trgm`（迁移 017 的硬前置）；
4. `tsx src/db/migrate.ts`：迁移 001 跑到最新；
5. Day-0 管理员：复用 `scripts/bootstrap-production-admin.ts`，密码取 `.env` 的 `DEV_ADMIN_PASSWORD`（管理员已存在则整步跳过）；
6. 播种最小演示数据：1 个项目 + 1 集 + 2 场 + 3 分镜，属主是上面的管理员，方便登录后立刻有东西看。

## 两套本地栈不要混用

本机目前可能同时存在两套彼此独立的 PostgreSQL 数据。端口能访问不代表它们是同一个库：

| 用途 | 数据库 | 应用入口 | 谁会读它 |
| --- | --- | --- | --- |
| 标准 dev | `shortdrama-dev-db-1`，宿主机 `localhost:5432` | `npm run dev` 启动的 `http://localhost:8000` | 当前源码、本地开发、`release-plan-truth-sync-db` 门禁 |
| 历史 Compose 联调栈 | `zhongwen-shortdrama-v011-db-1`，只在 Compose 内网暴露 5432 | Caddy 暴露的 `http://localhost:8080` | `zhongwen-shortdrama-v011-app-1` |

两套栈使用不同 Docker volume。对 `http://localhost:8080` 运行
`scripts/sync-release-plan.mts --apply`，只会更新 `zhongwen-shortdrama-v011-db-1`；
它不会更新门禁读取的 `localhost:5432`，即使命令显示“写入完成”也不能据此判定门禁已修好。

### 正确同步版本计划

1. `npm run dev:up` 确认 `shortdrama-dev-db-1` 已启动；
2. 另开终端运行 `npm run dev`，确认 `http://localhost:8000/api/v1/health` 可访问；
3. 把同步脚本的 `RELEASE_PLAN_SYNC_API_BASE` 指向 `http://localhost:8000`；
4. 管理员凭据取本地 `.env` 的 `DEV_ADMIN_USERNAME` / `DEV_ADMIN_PASSWORD`，映射到脚本所需的
   `RELEASE_PLAN_SYNC_USERNAME` / `RELEASE_PLAN_SYNC_PASSWORD`；不要把值写进命令历史或文档。
   （`.env.example` 现在这三个键都带：`ADMIN_USERNAMES` 是 Day-0 管理员的用户名来源，
   `DEV_ADMIN_USERNAME` / `DEV_ADMIN_PASSWORD` 是给这类脚本取用的成对凭据，值相同。
   2026-07-30 那条「`.env` 里没有 `ADMIN_USERNAMES`」的更正已随模板补齐而作废。）
5. 先运行 `npx tsx scripts/sync-release-plan.mts` 看 dry-run，再运行
   `npx tsx scripts/sync-release-plan.mts --apply`；
6. 最后运行 `node --import tsx --test tests/release-plan-truth-sync-db.test.ts`。
   输出必须明确写着连接来自 `.env 本地 dev 库(自动探测)(localhost:5432)`，
   且 `2 pass / 0 fail / 0 skipped`。

## 红线：dev 绝不连云库

云上同一实例并存多套数据模型（`app`/`common` 等 schema），连错一次就会以属主身份写到别人的活数据。所以：

- `scripts/dev-guard.mts` 在 `dev:up`、`dev:reset` 和 `npm run dev` 启动期都会跑：数据库主机命中云端特征（`*.rds-pg.ivolces.com`、`*.rds.ivolces.com`、`*.rds.volces.com`、`*.rds.amazonaws.com`、`*.database.azure.com`）直接拒绝；
- 即使换了个不认识的非本机主机名也 fail-closed 拒绝——dev 只接受 `localhost` / `127.0.0.1` / `::1` / `host.docker.internal`；
- `.env.example` 一个真值都不许有（真密码、真 key、云主机名、真桶名），`test/dev-environment.test.ts` 有护栏测试守着它和 `src/config/env.ts` 的逐项对齐。

要联调测试环境，走部署流程，不要在 dev 配置里把数据库指过去。

## 日常命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev:up` | 起到能登录（幂等） |
| `npm run dev` | 启动应用，tsx watch 热重载 |
| `npm run dev:down` | 停掉本机数据库（保留数据卷） |
| `npm run dev:reset` | 推倒重来：删卷 + 重新 dev:up（管理员密码仍取 `.env` 的 `DEV_ADMIN_PASSWORD`） |
| `npm run dev:seed` | 只重跑演示数据播种（幂等） |

## 排障

- **8000 打开不是登录页**：8000 只提供接口，页面在前端开发服务器（5173）上。打开 8000 会给一页指引说明去哪；要让 8000 自己出页面就跑一次 `npm run build:frontend`。
- **5432 被占**：`.env` 里加一行 `SHORTDRAMA_DEV_PG_PORT=15432`，同时把 `POSTGRES_PORT` 改成同一个值，再 `npm run dev:reset`。
- **登录报密码错**：密码就是 `.env` 里 `DEV_ADMIN_PASSWORD` 的值，不会自己变。改了这个值不会自动同步到已建好的管理员——`dev:up` 见管理员已存在就整步跳过，得 `npm run dev:reset` 重建。
- **没有 Milvus 是不是起不来**：不是。Milvus 是可重建的检索投影，dev 留空即走 PostgreSQL 降级路径，应用正常启动。
- **没有 Ark/TOS key**：生成与媒体读写不可用，但应用照常启动、生成 worker 自动暂停；付费红线在 dev 永远 `ALLOW_PAID_GENERATION=false`。
- **想连 PG16 试试**：别。dev 库刻意用 PG14 与云上 RDS 对齐（定策见 `docs/proposals/pg14-vs-pg16-decision.md`）。

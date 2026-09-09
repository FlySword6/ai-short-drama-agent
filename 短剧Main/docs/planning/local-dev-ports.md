# 本机开发环境：端口对照表

立于 2026-08-09。**这张表是实查出来的**（`lsof` + `ps eww`），不是照配置文件抄的。

## 为什么需要这张表

真实事故：有人在 `localhost:5175` 用测试站的密码登录，一直提示「账号或密码不正确」。
排查后发现 5175 连的根本不是本机数据库，而是**云端测试库**——密码没错，是登错了地方。

**本机同时跑着 4 个后端、3 个前端，各自连不同的库。** 不看这张表就会踩。

## 当前实况

| 端口 | 谁 | 连哪个库 | 库里的 schema | 登录用哪个密码 |
|---|---|---|---|---|
| **8010** | 主线后端（**推荐用这个**） | **本机 Docker** | `app` | `admin` / `admin12345` |
| **5180** | 主线前端 → 8010 | 同上 | `app` | 同上 |
| 8000 | Lite 后端 | 本机 Docker | `lite` | `.env` 的 `DEV_ADMIN_PASSWORD` |
| 8001 | 主线后端（旧） | **云端测试库** | `app` | `.env` 的 `TEST_ENV_ADMIN_PASSWORD` |
| 5173 | 主线前端 → 8001 | **云端测试库** | `app` | 同上 |
| 8002 | Lite 后端（旧） | **云端测试库** | `app` | 同上 |
| 5175 | Lite 前端 → 8002 | **云端测试库** | `app` | 同上 |

**加粗那两行是干净的本机环境**，改坏了不影响任何人，也不花钱。
其余四个连的是云端测试库——**在那上面生图生视频会真扣公司的钱**。

## 开工前先确认自己连的是哪个库

一条命令，把 `8010` 换成你要查的端口：

```bash
PID=$(lsof -nP -iTCP:8010 -sTCP:LISTEN -t | head -1)
ps eww $PID | tr ' ' '\n' | grep -E "^POSTGRES_(HOST|SCHEMA)="
```

看到 `127.0.0.1` 就是本机，看到 `postgres-...volces.com` 就是云端。

前端查它代理去哪：

```bash
PID=$(lsof -nP -iTCP:5180 -sTCP:LISTEN -t | head -1)
ps eww $PID | tr ' ' '\n' | grep SHORTDRAMA_DEV_API
```

## 密码为什么「变来变去」

没变。是 `.env` 里同时存着**四组** admin 账号：

```
LOCAL_ADMIN_USERNAME / LOCAL_ADMIN_PASSWORD
DEV_ADMIN_USERNAME   / DEV_ADMIN_PASSWORD
TEST_ENV_ADMIN_USERNAME / TEST_ENV_ADMIN_PASSWORD
PROD_ADMIN_USERNAME  / PROD_ADMIN_PASSWORD
```

四组用户名**全是 `admin`**，只有密码不同。用错哪组都只会说「账号或密码不正确」，
不会告诉你「你连的是 lite 库，该用 DEV 那组」。

取某一组密码（不打印到屏幕历史里）：

```bash
grep -E "^DEV_ADMIN_PASSWORD=" .env | sed -E "s/^[^=]+=//; s/^['\"]//; s/['\"]$//"
```

## 本机数据库和云端测试库是什么关系

**结构一样，数据不一样。**

| | 本机 Docker | 云端测试库 |
|---|---|---|
| `app` 里的表数量 | 93 | 93 |
| 数据库版本 | 060 | 060 |

表和版本完全对得上，所以**本机能复现云端的结构性问题**。
但本机没有云端的业务数据，所以「测试站上那个项目在本机打不开」是正常的，不是坏了。

容器名 `shortdrama-dev-db-1`，端口 5432，里面有三个 schema：
`app`（主线用）、`lite`（Lite 线用）、`s22_drift_check`（漂移检测用）。

## 一个已知的坑：.env 里有同名键出现两次

`.worktrees/v011-integration/.env` 里 `POSTGRES_HOST` 出现在两处：

- 第 63 行 = `localhost`
- 第 77 行 = 云端地址

**后面那行会盖掉前面那行**，所以看起来配的是本机、实际连的是云端。
同样重复的还有 `POSTGRES_PORT` / `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_SCHEMA`
以及十几个别的键。

**本机跑不通先查同名键是不是出现了两次**：

```bash
grep -nE "^[A-Z_]+=" .env | awk -F= '{print $1}' | sed 's/^[0-9]*://' | sort | uniq -d
```

主线的 8010 就是为了避开这个坑——它不改 `.env`，用一份独立的覆盖文件启动。

## 主线本机环境怎么起

```bash
# 后端 8010（连本机库）
tmux new-session -d -s sd-main-local -c .worktrees/v011-integration \
  "set -a; . /tmp/mainline-local.env; set +a; npx tsx watch src/server.ts"

# 前端 5180（代理到 8010）
tmux new-session -d -s sd-main-local-web -c .worktrees/v011-integration/frontend/shortdrama-rag-demo \
  "SHORTDRAMA_DEV_API=http://localhost:8010 npx vite --port 5180 --strictPort"
```

覆盖文件 `/tmp/mainline-local.env` 里只有库指向和端口，其余仍读 `.env`。
其中 `POSTGRES_SSL_MODE=disable` 是必须的——本机 Docker 数据库不支持 SSL，
而 `.env` 为云端设了 `verify-full`，不覆盖会启动失败并报
`The server does not support SSL connections`。

# 部署入口

正式生产固定为 VKE/VCI：一个 VCI `Deployment`、`ClusterIP Service`、ALB Ingress、
外部私网 RDS 与 KMS initContainer;命名空间按环境隔离(当前唯一线上环境 test 跑
`shortdrama`,prod 预留 `shortdrama-prod`)。清单结构、渲染入口与证据合同见
[`deploy/k8s/README.md`](k8s/README.md),流水线操作见
[`docs/deploy/pipeline-guide.md`](../docs/deploy/pipeline-guide.md),**线上与仓库的
差异处置和迁移顺序见
[`docs/deploy/live-vs-repo-diff.md`](../docs/deploy/live-vs-repo-diff.md)**。
集群部署不使用 Compose、仓内 PostgreSQL 或 Caddy。

下面的 Compose 只用于本地开发、dev/test 兼容验证和历史差异核对，不得把它和 VKE 生产
流水线混用，也不得作为生产发布或回滚路径。

## Compose dev/test 兼容说明

Compose 栈中的 `app`、`db`、`caddy` 三个服务只用于本地和 CI 的 Linux AMD64 兼容检查。

## 本地或 CI 构建

先准备 gitignored 的 dev/test 环境文件，例如仓库根 `.env`。不要把
凭据放进仓库。

```bash
SHORTDRAMA_ENV_FILE=.env \
  ./scripts/release-amd64.sh build zhongwen-shortdrama:v0.1.1-<commit>
```

该脚本会：

1. 用 `linux/amd64` 渲染 Compose；
2. 用 Buildx 构建并仅加载到本机镜像库；
3. 检查镜像元数据确实是 `linux/amd64`。

它不会推送镜像、启动服务或调用模型，也不构成生产 VKE 验证。

## 网络受限时的 Node 前置校验

Dockerfile 可以使用 `docker/node-dist/` 中的官方 Node Linux x64 压缩包，
以避免构建时下载 Node。该目录已被 Git 忽略。将官方
`node-v22.19.0-linux-x64.tar.xz` 放入后执行：

```bash
./scripts/release-amd64.sh offline-check
```

这只验证 Node 压缩包和校验和。npm 依赖和基础镜像仍需要 Docker 缓存或可用
镜像/软件源；不要把“Node 离线”误写成“整镜像离线构建已验证”。

## 本地 dev/test 启动顺序

```bash
export SHORTDRAMA_IMAGE=zhongwen-shortdrama:v0.1.1-<commit>
export SHORTDRAMA_PLATFORM=linux/amd64
export SHORTDRAMA_ENV_FILE=.env

docker compose config --quiet
docker compose up -d
docker compose ps
./scripts/release-smoke.sh http://127.0.0.1
```

`app` 在监听前会执行编号 migration；migration 使用 PostgreSQL 事务和 advisory
lock，因此同一 Compose 栈的重复启动不会重复执行已记录迁移。不要手工编辑已
发布 migration。健康检查通过后，Caddy 才会成为可用反代。

## 本地回滚演练

演练前保留上一次已验证镜像标签，例如
`zhongwen-shortdrama:v0.1.1-<previous-commit>`。若新版本无法通过健康检查：

```bash
SHORTDRAMA_IMAGE=zhongwen-shortdrama:v0.1.1-<previous-commit> \
  SHORTDRAMA_PLATFORM=linux/amd64 \
  SHORTDRAMA_ENV_FILE=.env \
  docker compose up -d --no-build
```

镜像回滚不等于数据库回滚。若新 migration 已在 dev/test 成功执行，必须按该 migration 的
明确恢复方案处理；不要通过删除数据卷或修改 `schema_migrations` 来“回滚”。

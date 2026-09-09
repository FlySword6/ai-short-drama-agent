# V0.1 Docker Compose dev/test 兼容说明

> 本文仅用于本地开发和 dev/test，不是 V0.1.1 生产部署指南。正式生产固定为 VKE/VCI、
> HTTPS ALB Ingress、私网 RDS 和 KMS/IRSA initContainer；入口见
> [`deploy/k8s/README.md`](../../deploy/k8s/README.md) 与
> [`docs/deploy/pipeline-guide.md`](../deploy/pipeline-guide.md)。

本地 Compose 栈包含网页/API/Pi 运行时（`app`）、临时 PostgreSQL（`db`）和 HTTP 反代
（`caddy`）。它只验证应用镜像和依赖兼容性，不代表生产网络、数据、身份或回滚路径。

## 准备 dev/test 环境文件

将 [`.env.release.example`](../../.env.release.example) 复制为 gitignored 的仓库根 `.env`，
只填写 dev/test 值。不要使用生产凭据，也不要把值提交到 Git、终端历史或文档。

Compose 内部固定使用 `POSTGRES_HOST=db`；`DATABASE_URL` 必须留空。应用首次启动会对本地
测试数据库执行编号 migration。默认保持付费生成关闭：

```text
ALLOW_PAID_GENERATION=false
PAID_GENERATION_BUDGET_FEN=0
```

## 本地构建和启动

```bash
SHORTDRAMA_ENV_FILE=.env docker compose config --quiet
SHORTDRAMA_ENV_FILE=.env docker compose build app
SHORTDRAMA_ENV_FILE=.env docker compose up -d
docker compose ps
```

如果 Docker Hub 暂时不可用，但本机已缓存基础镜像，构建可以继续。Node 22.19.0 从
`nodejs.org` 下载并按固定 SHA-256 校验；离线准备见
[`docker/node-dist/README.md`](../../docker/node-dist/README.md)。首次构建仍需要 npm 依赖缓存
或 npm registry。

本地默认访问 `http://127.0.0.1/`，健康检查为
`http://127.0.0.1/api/v1/health`。端口冲突时可使用：

```bash
SHORTDRAMA_HTTP_PORT=18000 SHORTDRAMA_ENV_FILE=.env docker compose up -d
```

启动后仅在本机执行 smoke：

```bash
./scripts/release-smoke.sh http://127.0.0.1
```

不要把 Caddy 的本地 HTTP 端口暴露到不受控公网，也不要把本地 smoke 写成 VKE、RDS、KMS
或 ALB 已验证。

## dev/test 运行边界

- app 以 uid `10001` 的非 root 用户运行，容器根文件系统只读；本地 Caddy 和 PostgreSQL
  使用各自数据卷。
- `shortdrama-runtime` 数据卷只保存本地上传过程中的临时文件。生产业务事实位于云 RDS，
  永久媒体位于 TOS。
- 容器镜像不包含 `.env` 或凭据；dev/test 配置只在运行时传入。
- Ark、TOS 或 `TOS_PUBLIC_BASE_URL` 配置不完整时，付费提交必须 fail-closed；本地测试默认
  保持 `ALLOW_PAID_GENERATION=false`。
- Milvus 是可重建投影；本地未配置时应验证 PostgreSQL 降级，不得据此声称生产链路可用。
- 私有 API 仍要求登录；本地 UI 隐藏入口不能替代服务端权限测试。

## 停止本地栈

```bash
SHORTDRAMA_ENV_FILE=.env docker compose down
```

`docker compose down` 默认不删除 dev/test 数据卷；只有明确不再需要本地测试数据时才手工处理。

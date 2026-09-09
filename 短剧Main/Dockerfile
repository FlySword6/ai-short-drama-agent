# check=skip=InvalidBaseImagePlatform

ARG BOOTSTRAP_IMAGE=shortdrama-prod-cn-beijing.cr.volces.com/shortdrama/test:runtime-base-20260810-node22.19.0-npm11.11.0@sha256:68bffa3af8c4dfb7749a79ba3572b79955eb75474d11f99bd492d0726949d075

# 火山引擎持续交付文档建议把海外基础镜像预先推到同地域 CR。Node、npm 与
# ExifTool 因此由 docker/runtime-base.Dockerfile 低频构建一次，应用流水线不再
# 在每次提交时重复跨境下载。该底座和 test 流水线均固定为 linux/amd64；需要
# 调试底座时仍可用 --build-arg 覆盖该地址。
FROM ${BOOTSTRAP_IMAGE} AS dependencies

# 调用方可按环境覆盖 registry；npm ci 仍按 package-lock.json 的 integrity
# 散列逐包校验，镜像源返回不一致的内容会直接失败。
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ENV NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY}

# 浏览器只服务宿主机/CI 的产品 E2E；运行时镜像和编译都不需要它们。
# 不跳过的话每次冷构建都会为 playwright 拉一遍上游浏览器包。
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package.json package-lock.json ./
COPY frontend/shortdrama-rag-demo/package.json ./frontend/shortdrama-rag-demo/package.json
RUN --mount=type=cache,id=npm-cache,target=/root/.npm,sharing=locked \
    npm ci --prefer-offline --no-audit --no-fund

FROM dependencies AS build

COPY tsconfig.json ./
COPY src ./src
COPY frontend/shortdrama-rag-demo ./frontend/shortdrama-rag-demo
# The architecture gate (prebuild hook) audits the source tree incl.
# docs/contracts and runs on host/CI; the image build only needs artifacts,
# so invoke the two build steps directly instead of `npm run build`.
RUN npm run build:frontend && npx tsc -p tsconfig.json

FROM dependencies AS production-dependencies

# Reuse the already-installed lockfile tree, then remove development-only and
# frontend-workspace packages. The frontend is already compiled to static files,
# so shipping React/Three/ECharts in the server runtime only bloated the image.
# A second `npm ci --omit=dev` also made cold builds install the graph twice.
ENV NODE_ENV=production
RUN npm prune --omit=dev --workspaces=false --no-audit --no-fund

FROM ${BOOTSTRAP_IMAGE} AS runtime-base

ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --gid 10001 shortdrama \
    && useradd --uid 10001 --gid shortdrama --no-create-home --home-dir /app --shell /usr/sbin/nologin shortdrama

COPY package.json package-lock.json ./
COPY frontend/shortdrama-rag-demo/package.json ./frontend/shortdrama-rag-demo/package.json
COPY --chown=shortdrama:shortdrama migrations ./migrations
# dist/db/migrate.js intentionally reads this isolated migration directory at
# runtime. Keep the SQL beside the compiled runner so the production image can
# execute the same controlled migration chain as host/CI.
COPY --chown=shortdrama:shortdrama src/db/migrations/vnext ./src/db/migrations/vnext
# Director template registry fail-fast reads assets/director/templates at boot.
COPY --chown=shortdrama:shortdrama assets ./assets

RUN mkdir -p runtime/uploads \
    && chown -R shortdrama:shortdrama /app/runtime

# 制品身份。仓库里没有任何文件能推导 commit sha——不在构建时注入,镜像跑起来之后
# 就无法回答「线上是哪个提交」:2026-07-28 的环境版本审计只能靠前端中文文案加
# migrations 最新编号反推,最后仍只定位到一个 9~18 个提交的窗口,起因就是这里空着。
# 三个参数默认空:本地随手 `docker build` 不会因此失败,只降级成 unknown。
# 位置贴着镜像末尾是有意的:sha 每个提交都变,放在 apt-get/npm ci 之前会让那些
# 昂贵的层每次构建全部失效。
ARG GIT_SHA=""
ARG GIT_REF=""
ARG BUILD_TIME=""

# 只有 sha 进运行时环境。/api/v1/health 未鉴权公开,分支名与构建时间对定位提交没有
# 增量作用(sha 已唯一)却属于环境信息,只留在 label 里给 `docker inspect` 用。
ENV APP_COMMIT_SHA=${GIT_SHA}

LABEL org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.ref.name="${GIT_REF}" \
      org.opencontainers.image.created="${BUILD_TIME}"

USER shortdrama

EXPOSE 8000
VOLUME ["/app/runtime"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'8000')+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# 火山持续交付的“镜像缓存”只承诺基础镜像拉取加速。流水线因此按官方
# NodeJS + 镜像构建同任务范式，先在 $(CP_WORKSPACE) 中安装、编译和裁剪，
# 再构建此目标。默认 Docker 构建仍走下面的自包含 runtime 目标。
FROM runtime-base AS runtime-prebuilt

COPY --chown=shortdrama:shortdrama .cp-build/modules ./node_modules
COPY --chown=shortdrama:shortdrama .cp-build/server ./dist
COPY --chown=shortdrama:shortdrama .cp-build/frontend/shortdrama-rag-demo/dist ./frontend/shortdrama-rag-demo/dist

# 构建上下文必须与最终 linux/amd64 运行时同架构生成。该断言使 native addon
# （尤其 sharp）在镜像构建时就失败关闭，不能把 macOS/arm64 的 node_modules 伪装成
# 可部署制品。
RUN node -e "require('sharp'); require('node:fs').accessSync('dist/server.js')"

USER shortdrama

CMD ["node", "dist/server.js"]

# 默认目标保持自包含，供本地开发、其他 CI 和底座回归使用。
FROM runtime-base AS runtime

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build --chown=shortdrama:shortdrama /app/dist ./dist
COPY --from=build --chown=shortdrama:shortdrama /app/frontend/shortdrama-rag-demo/dist ./frontend/shortdrama-rag-demo/dist

USER shortdrama

CMD ["node", "dist/server.js"]

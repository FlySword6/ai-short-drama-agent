# syntax=docker/dockerfile:1.7

ARG CI_BASE_IMAGE=shortdrama-prod-cn-beijing.cr.volces.com/shortdrama/test:runtime-base-20260810-node22.19.0-npm11.11.0@sha256:68bffa3af8c4dfb7749a79ba3572b79955eb75474d11f99bd492d0726949d075
FROM ${CI_BASE_IMAGE}

# 火山持续交付的自定义镜像步骤不承诺宿主机 Docker daemon。这里只安装普通
# typecheck/test/build 所需的确定工具；需要临时 PostgreSQL 容器的测试由独立
# DB 门禁执行，不能在这里以 skip 冒充通过。
RUN set -eux; \
    apt-get update; \
    apt-get install --no-install-recommends --yes \
      git \
      ripgrep; \
    rm -rf /var/lib/apt/lists/*; \
    git --version; \
    rg --version; \
    exiftool -ver; \
    test "$(node --version)" = "v22.19.0"; \
    test "$(npm --version)" = "11.11.0"

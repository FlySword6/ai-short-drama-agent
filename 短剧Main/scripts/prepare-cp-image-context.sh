#!/usr/bin/env bash

set -euo pipefail

workspace="${CP_WORKSPACE:-$PWD}"
case "$workspace" in
  ""|"/")
    echo "Refusing to prepare a build context from an unsafe workspace: '$workspace'" >&2
    exit 1
    ;;
esac

cd "$workspace"
test -f package.json
test -f package-lock.json
test -f frontend/shortdrama-rag-demo/package.json
for required_command in git rg exiftool; do
  command -v "$required_command" >/dev/null
done
# VKE Agent 在共享工作卷里检出代码，卷属主不必等于 custom-image 内的执行用户。
# 仅信任当前已校验的 CP 工作目录，避免 Git 的 safe.directory 保护把构建误判为失败。
# custom image 的 HOME 是 /nonexistent，不能尝试写全局 gitconfig；此进程级配置会
# 被后续 npm/node 子进程继承，也不会把 CI 机密或临时配置写进工作树。
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="safe.directory"
export GIT_CONFIG_VALUE_0="$workspace"

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node >=22.19.0 is required, got ${process.version}`);
  }
'

cache_root="$workspace/.npm-cache"
npm_download_cache="$cache_root/downloads"
cache_ready_marker="$cache_root/.npm-download-cache-ready"
stage_root="$workspace/.cp-build"
runtime_base_ref="$(
  sed -n 's/^ARG BOOTSTRAP_IMAGE=//p' Dockerfile | head -n 1
)"

if [[ -z "$runtime_base_ref" || "$runtime_base_ref" != *@sha256:* ]]; then
  echo "Dockerfile BOOTSTRAP_IMAGE must be pinned by digest" >&2
  exit 1
fi

if [[ -f "$cache_ready_marker" && -d "$npm_download_cache/_cacache" ]]; then
  echo "CP_NPM_DOWNLOAD_CACHE_HIT"
else
  # CP 的 TOS 工作区缓存不会可靠地保留 npm .bin 等 symlink。只缓存 npm 的
  # content-addressable 下载包；每次仍 npm ci，从而既能加速网络获取，也不会把
  # 一棵不完整的 node_modules 当作可用依赖树。
  echo "CP_NPM_DOWNLOAD_CACHE_MISS_OR_INVALID"
  rm -rf "$cache_root"
fi
mkdir -p "$npm_download_cache"
# 缓存目录必须留在 CP 工作区里才能被 TOS 工作区缓存保留,但仓库体积门禁按
# `git ls-files --others --exclude-standard` 扫未跟踪文件,tarball 超上限会红。
# 与上面 safe.directory 同一手法:进程级注入 core.excludesFile,等效 .gitignore
# 而不落任何全局/仓库文件。
workspace_excludes="$cache_root/cp-workspace-excludes"
printf '.npm-cache/\n.cp-build/\n' > "$workspace_excludes"
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_1="core.excludesFile"
export GIT_CONFIG_VALUE_1="$workspace_excludes"
rm -rf "$stage_root" node_modules
mkdir -p "$stage_root/frontend/shortdrama-rag-demo"
# npm prune 会按裁剪后的树回写 package-lock.json；锁文件是发布合同，不是这次
# 构建的临时状态。先留一份字节级快照，裁剪后原样恢复。
cp -f package-lock.json "$stage_root/package-lock.json.pristine"

# 浏览器二进制只服务宿主机/CI 的产品 E2E；custom image 里不跑它们，
# 不跳过则每次安装都会朝上游浏览器分发站白拉一遍。
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PUPPETEER_SKIP_DOWNLOAD=true

NODE_ENV=development npm ci \
  --include=dev \
  --cache "$npm_download_cache" \
  --prefer-offline \
  --no-audit \
  --no-fund

cleanup_workspace() {
  if [[ -f "$stage_root/package-lock.json.pristine" ]]; then
    cp -f "$stage_root/package-lock.json.pristine" package-lock.json
  fi
  rm -rf node_modules
}
trap cleanup_workspace EXIT

# 安装需要 devDependencies；测试需要 React 的开发测试入口。
# 默认 npm test 的 pretest 仍是部署前置门禁；真 PG 门禁不应在没有 Docker daemon
# 的 custom-image 容器里被 skip 冒充通过，而是由显式 DB 任务运行。
env -u SHORTDRAMA_ENV_FILE NODE_ENV=test npm run check:architecture
env -u SHORTDRAMA_ENV_FILE NODE_ENV=test npm run check:director-mirror
env -u SHORTDRAMA_ENV_FILE NODE_ENV=test npm run typecheck
env -u SHORTDRAMA_ENV_FILE NODE_ENV=test npm run test:node

export NODE_ENV=production
npm run build:frontend
npx tsc -p tsconfig.json

# 复用同一棵已安装依赖树裁剪生产依赖，与 Dockerfile 的 production-dependencies
# 阶段同一手法；不跑第二次在线 npm ci。
npm prune --omit=dev --workspaces=false --no-audit --no-fund
cp -f "$stage_root/package-lock.json.pristine" package-lock.json

# 安装、门禁与裁剪全部成功后才写下载缓存就绪标记；生产依赖仍逐项验证，避免构建上下文
# 在复制到 Dockerfile 前就缺运行时模块。
CP_PRODUCTION_MODULES="$workspace/node_modules" node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = process.env.CP_PRODUCTION_MODULES;
  const dependencies = Object.keys(require("./package.json").dependencies ?? {});
  const missing = dependencies.filter((name) =>
    !fs.existsSync(path.join(root, ...name.split("/"), "package.json")));
  if (missing.length > 0) {
    throw new Error(`production dependency cache incomplete: ${missing.join(", ")}`);
  }
console.log(`CP_PRODUCTION_CACHE_VERIFIED direct_dependencies=${dependencies.length}`);
'

printf '%s\n' "cp-npm-download-cache-v4" > "$cache_ready_marker"

cp -a node_modules "$stage_root/modules"

mv dist "$stage_root/server"
mv \
  frontend/shortdrama-rag-demo/dist \
  "$stage_root/frontend/shortdrama-rag-demo/dist"

test -f "$stage_root/server/server.js"
test -f "$stage_root/frontend/shortdrama-rag-demo/dist/index.html"
test -d "$stage_root/modules"

echo "CP_IMAGE_CONTEXT_READY"
du -sh "$cache_root" "$stage_root"

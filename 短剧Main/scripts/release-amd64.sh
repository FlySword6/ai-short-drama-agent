#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/release-amd64.sh offline-check
  SHORTDRAMA_ENV_FILE=.env ./scripts/release-amd64.sh build [image-tag]

offline-check verifies the optional official Node x64 archive used when
nodejs.org is unavailable. It does not claim an offline npm build is possible:
the base image and npm packages must already be available to Docker separately.

build is a local/dev-test compatibility check. It renders Compose for
linux/amd64, builds one local image with Buildx, loads it into the local image
store, and verifies metadata. It never pushes, deploys, or validates production;
production images and rollout use the VKE pipeline in docs/deploy/pipeline-guide.md.
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node_version="22.19.0"
node_archive="docker/node-dist/node-v${node_version}-linux-x64.tar.xz"
node_sha256="c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "Neither shasum nor sha256sum is available" >&2
    return 1
  fi
}

offline_check() {
  if [[ ! -f "$node_archive" ]]; then
    cat >&2 <<EOF
Offline Node prerequisite is missing: $node_archive
Download the official Node v${node_version} Linux x64 archive outside this
repository and copy it to that exact ignored path. Do not add it to Git.
EOF
    return 1
  fi

  local actual
  actual="$(sha256_file "$node_archive")"
  if [[ "$actual" != "$node_sha256" ]]; then
    echo "Node x64 archive checksum mismatch: expected ${node_sha256}, got ${actual}" >&2
    return 1
  fi

  cat <<EOF
offline Node prerequisite verified
archive: $node_archive
sha256: $actual

This only removes the nodejs.org dependency. A fully offline build still needs
the bootstrap image and npm dependency cache or registry access.
EOF
}

command_name="${1:-}"
case "$command_name" in
  offline-check)
    offline_check
    ;;
  build)
    image_tag="${2:-${SHORTDRAMA_IMAGE:-shortdrama-devtest:v0.1.1-amd64-$(git rev-parse --short HEAD)}}"
    env_file="${SHORTDRAMA_ENV_FILE:-.env}"

    # 制品身份注入镜像,让 /api/v1/health 能自报跑的是哪个提交。工作区脏时给 sha
    # 加 -dirty 会让格式校验拒绝,所以改为直接留空:本地构建宁可显示 unknown,
    # 也不能让一个未提交的工作区冒充某个 commit。
    git_sha="$(git rev-parse HEAD)"
    if ! git diff --quiet HEAD 2>/dev/null; then
      echo "工作区有未提交改动,镜像不标注 commit sha(避免谎报)" >&2
      git_sha=""
    fi
    git_ref="$(git rev-parse --abbrev-ref HEAD)"
    build_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    docker info >/dev/null
    SHORTDRAMA_ENV_FILE="$env_file" \
      SHORTDRAMA_IMAGE="$image_tag" \
      SHORTDRAMA_PLATFORM="linux/amd64" \
      SHORTDRAMA_GIT_SHA="$git_sha" \
      SHORTDRAMA_GIT_REF="$git_ref" \
      SHORTDRAMA_BUILD_TIME="$build_time" \
      docker compose config --quiet

    docker buildx build \
      --platform linux/amd64 \
      --load \
      --tag "$image_tag" \
      --build-arg "GIT_SHA=${git_sha}" \
      --build-arg "GIT_REF=${git_ref}" \
      --build-arg "BUILD_TIME=${build_time}" \
      .

    image_arch="$(docker image inspect "$image_tag" --format '{{.Architecture}}')"
    image_os="$(docker image inspect "$image_tag" --format '{{.Os}}')"
    if [[ "$image_arch" != "amd64" || "$image_os" != "linux" ]]; then
      echo "Expected linux/amd64 image, got ${image_os}/${image_arch}" >&2
      exit 1
    fi

    echo "AMD64 image verified locally: $image_tag (${image_os}/${image_arch})"
    echo "Local dev/test only; do not use this command for production:"
    echo "  SHORTDRAMA_IMAGE=$image_tag SHORTDRAMA_PLATFORM=linux/amd64 SHORTDRAMA_ENV_FILE=$env_file docker compose up -d"
    echo "Production rollout uses docs/deploy/pipeline-guide.md and deploy/k8s/."
    ;;
  -h|--help|help|'')
    usage
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

repository="${1:?repository is required}"
tag="${2:?tag is required}"

read -r object_type object_sha < <(
  gh api "repos/${repository}/git/ref/tags/${tag}" \
    --jq '[.object.type, .object.sha] | @tsv'
)
for _ in 1 2 3 4; do
  if [ "${object_type}" = "commit" ]; then
    printf '%s\n' "${object_sha}"
    exit 0
  fi
  if [ "${object_type}" != "tag" ]; then
    echo "Unsupported Git tag object type: ${object_type}" >&2
    exit 1
  fi
  read -r object_type object_sha < <(
    gh api "repos/${repository}/git/tags/${object_sha}" \
      --jq '[.object.type, .object.sha] | @tsv'
  )
done

echo "Annotated tag chain exceeds four levels" >&2
exit 1

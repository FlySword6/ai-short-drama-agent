#!/usr/bin/env bash
# 查测试环境的运行时配置。密钥类字段一律只显示"已配置/未配置",绝不打印值。
#
# 立此脚本的原因(2026-08-06):统筹手写一次性脚本查配置时,把公司网关的
# API key 完整打印进了会话记录。查配置是高频动作,不能每次靠手写时记得屏蔽。
#
# 用法: bash scripts/ops/show-test-env-config.sh [键名前缀...]
#   不带参数 = 显示全部键(密钥仍屏蔽)
set -euo pipefail

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/shortdrama-public.yaml}"
NS="${NS:-shortdrama}"          # ← 必须带命名空间,不带会报 Forbidden 看起来像权限被收
DEPLOY="${DEPLOY:-shortdrama-main}"

kubectl get deploy "$DEPLOY" -n "$NS" -o json | python3 -c '
import json, re, sys

# 键名命中这些片段的,一律只报"已配置",不打印值
SECRET_PAT = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|APIKEY|AK$|SK$|DSN|CONN)", re.I)
prefixes = [a.upper() for a in sys.argv[1:]]

d = json.load(sys.stdin)
envs = d["spec"]["template"]["spec"]["containers"][0].get("env", [])
print(f"环境变量共 {len(envs)} 项")
print()
for e in sorted(envs, key=lambda x: x["name"]):
    name = e["name"]
    if prefixes and not any(name.upper().startswith(p) for p in prefixes):
        continue
    if "valueFrom" in e:
        shown = "(来自密钥引用)"
    elif SECRET_PAT.search(name):
        v = e.get("value", "")
        shown = f"(密钥,已配置,长度 {len(v)})" if v else "(密钥,空)"
    else:
        shown = repr(e.get("value", ""))
    print(f"  {name} = {shown}")
' "$@"

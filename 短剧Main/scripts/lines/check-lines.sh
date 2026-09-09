#!/usr/bin/env bash
# 一眼看清四条线活没活、交了没交。
set -uo pipefail
WS=/Users/user/Workspace/02_AI工具开发
NOW=$(date +%s)
printf "%-7s %-6s %-7s %-9s %-26s %s\n" 线 总提交 未提交 最后活动 当前分支 状态
for spec in "sol1:/private/tmp/sol-149-project-config" "sol2:/private/tmp/sol2-153-script-assets" "sol3:/private/tmp/sol3-154-models" "kimi1:/private/tmp/kimi-151-project-ui"; do
  name="${spec%%:*}"; dir="${spec##*:}"
  # 工人按「每张卡一个分支」换分支,只看当前分支会漏算已完工的卡。
  # 只统计本轮这几张卡的分支,不要把仓库里的历史分支算进来。
  case "$name" in
    sol1) mine="issue/149 issue/150";;
    sol2) mine="issue/153 issue/156";;
    sol3) mine="issue/154 issue/157";;
    kimi1) mine="issue/151 issue/152";;
  esac
  n=0; done_br=""
  for pre in $mine; do
    for br in $(git -C "$dir" for-each-ref --format='%(refname:short)' "refs/heads/${pre}*" 2>/dev/null); do
      c=$(git -C "$dir" log --oneline origin/dev.."$br" 2>/dev/null | wc -l | tr -d ' ')
      n=$((n+c)); [ "$c" -gt 0 ] && done_br="$done_br ${br##*/}:$c"
    done
  done
  cur=$(git -C "$dir" branch --show-current 2>/dev/null)
  dirty=$(git -C "$dir" status --porcelain 2>/dev/null | grep -v "^?? tmp/" | wc -l | tr -d ' ')
  case "$name" in
    sol1) pat="sol1-*.log sol-149-*.log";; sol2) pat="sol2-*.log";;
    sol3) pat="sol3-*.log";;   kimi1) pat="kimi1-*.log kimi-151-*.log";;
  esac
  log=$(ls -t $(for g in $pat; do echo "$WS/tmp/$g"; done) 2>/dev/null | head -1)
  if [ -n "$log" ]; then
    mt=$(stat -f %m "$log"); age=$(( (NOW-mt)/60 ))
    if grep -qE "stream disconnected|Missing environment" <(tail -5 "$log" 2>/dev/null); then st="⚠️ 断流,该重启"
    elif [ "$age" -gt 30 ]; then st="⚠️ ${age}分钟没动,查一下"
    else st="在跑"; fi
    printf "%-7s %-6s %-7s %-9s %-26s %s\n" "$name" "$n" "$dirty" "${age}分钟前" "${cur##*/}" "$st${done_br:+ |$done_br}"
  else
    printf "%-7s %-6s %-7s %-9s %-26s %s\n" "$name" "$n" "$dirty" "无日志" "${cur:-?}" "没启动过"
  fi
done

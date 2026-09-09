#!/usr/bin/env bash
# 一条命令重启任意一条工人线。EasyRouter 通道会断流(2026-08-06 半小时断两次),
# 断了不用重写启动命令,跑这个就行。
#
# 用法: bash scripts/lines/restart-line.sh <线名> ["额外交代的话"]
#   线名: sol1 | sol2 | sol3 | kimi1
#
# 每条线的固定信息(工作目录/分支/卡号/必读)写死在下面;
# 每次重启都会自动带上「先提交现有改动」这条——断流最大的损失是攒着没交的活。
set -euo pipefail
WS=/Users/user/Workspace/02_AI工具开发
cd "$WS"
export $(grep -E "^(ER_BASE_URL|ER_APIKEY|SUCHUANG_BASE_URL|SUCHUANG_API_KEY)=" "$WS/.env" | xargs)

LINE="${1:?用法: restart-line.sh <sol1|sol2|sol3|kimi1> [额外交代]}"
EXTRA="${2:-}"

case "$LINE" in
  sol1) DIR=/private/tmp/sol-149-project-config; CARDS="#149 项目配置后端 + #150 图片档位开放"; GATES="G2 G3 G7 G8";;
  sol2) DIR=/private/tmp/sol2-153-script-assets; CARDS="#153 剧本资产入库 + #156 选定稿后端"; GATES="G6 G13 G10";;
  sol3) DIR=/private/tmp/sol3-154-models;        CARDS="#154 Seedance 2.5 + #157 三个图片模型"; GATES="G14 G15";;
  kimi1) DIR=/private/tmp/kimi-151-project-ui;   CARDS="#151 项目配置界面"; GATES="G2 G3 G8";;
  *) echo "不认识的线名: $LINE"; exit 1;;
esac

TS=$(date +%H%M)
LOG="$WS/tmp/${LINE}-run-${TS}.log"

PROMPT="通道断流重启(不是你的问题)。工作目录 ${DIR},你的卡:${CARDS},对应硬门:${GATES}。

【第一件事】把工作区现有改动**立刻提交一次**,说明写清做了什么、还差什么。从现在起每完成一个可独立描述的部分就提交,**不要攒着一次交**——通道会断,提交过的不会丢。

【唯一真源】$DIR/docs/planning/goal-monday-20260810.md —— 15 道硬门、验收剧本、停下来问人的六种情况,全在里面。你只对上面那几道门负责。

【停下来问我】两处口径打架不许自己挑一个信;同一道门连续三次没过;要改字段类型/删字段/删数据(**加新字段不算,放心加**);要改产品定义。

【交付】走 PR,回执落 $WS/outputs/(工作区根,不是你的工作树)。

$EXTRA"

cd "$DIR"
if [ "$LINE" = "kimi1" ]; then
  nohup /Users/user/.kimi-code/bin/kimi -p "$PROMPT" > "$LOG" 2>&1 &
else
  # 2026-08-10 DC 口径:codex 走订阅通道(官方,带系统代理);easyrouter 只兜别处没有的模型。
  nohup env SUCHUANG_BASE_URL="${SUCHUANG_BASE_URL:-}" SUCHUANG_API_KEY="${SUCHUANG_API_KEY:-}" \
    codex exec --config model_reasoning_effort=high --dangerously-bypass-approvals-and-sandbox \
    "$PROMPT" > "$LOG" 2>&1 &
fi
sleep 6
echo "$LINE 已重启 → 日志 $LOG"
grep -cE "Missing environment|stream disconnected" "$LOG" 2>/dev/null | xargs -I{} echo "  启动期报错: {}" || true

#!/usr/bin/env bash
# 在测试环境上走一遍验收剧本的前半段:建项目 → 粘剧本 → 拆解 → 确认 → 查分镜 → 查资产。
# 对应硬门 G2 / G4 / G5 / G6(G6 是命门)。
#
# 为什么单独一个脚本(2026-08-06 立):check-gates.sh 只做不花时间的快检;
# 这一段要跑拆解模型、要等,单独拿出来,08-08 的正式走查也用它。
#
# 剧本用 outputs/acceptance-script-sample.md 里那一段——**别临时找剧本**,
# 那段是照硬门倒着设计的:陈默跨三镜出现(G13 的检验对象)、5 个镜头(G9 批量)、
# 角色3+场景2+道具3(G6 的判据清单)。
#
# 用法: bash scripts/ops/walk-acceptance.sh
set -uo pipefail

WS=/Users/user/Workspace/02_AI工具开发
BASE="${BASE:-https://shortdrama-main-test.col.com}"
STYLEMARK="__STYLEMARK__"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
STAMP=$(date +%H%M%S)

note() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  ✅ %s\n" "$1"; }
bad()  { printf "  ❌ %s\n" "$1"; }
info() { printf "     %s\n" "$1"; }

U=$(grep -m1 '^TEST_ENV_ADMIN_USERNAME=' "$WS/.env" | cut -d= -f2-)
P=$(grep -m1 '^TEST_ENV_ADMIN_PASSWORD=' "$WS/.env" | cut -d= -f2-)
[ -n "$U" ] && [ -n "$P" ] || { echo "缺测试环境账号,先配 .env"; exit 1; }

curl -s --max-time 25 -X POST "$BASE/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"username\":\"$U\",\"password\":\"$P\"}" > "$TMP/login.json"
TOKEN=$(python3 -c "
import json
d=json.load(open('$TMP/login.json'))
print(d.get('data',{}).get('token') or d.get('token') or '')")
[ -n "$TOKEN" ] || { bad "登录失败"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"
ok "登录成功"

# ---------- 建项目(竖屏 + 特征词) ----------
note "第 2 步 · 新建项目:选竖屏、选清晰度、填风格描述  [G2]"
curl -s --max-time 25 -X POST "$BASE/api/v1/projects" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"name\":\"走查-$STAMP\",\"generation_config\":{\"default_ratio\":\"9:16\",\"default_image_resolution\":\"1K\",\"default_video_resolution\":\"720p\",\"image\":{\"style_description\":\"$STYLEMARK 港风黑帮 霓虹夜景 冷调\"}}}" > "$TMP/proj.json"
PID=$(python3 -c "
import json
print((json.load(open('$TMP/proj.json')).get('data') or {}).get('id',''))" 2>/dev/null)
[ -n "$PID" ] || { bad "建项目失败"; python3 -c "print(open('$TMP/proj.json').read()[:400])"; exit 1; }
ok "项目建好:$PID"

curl -s --max-time 25 -X POST "$BASE/api/v1/projects/$PID/episodes" -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"episode_no":3}' > "$TMP/ep.json"
EID=$(python3 -c "
import json
print((json.load(open('$TMP/ep.json')).get('data') or {}).get('id',''))" 2>/dev/null)
[ -n "$EID" ] || { bad "建集失败"; python3 -c "print(open('$TMP/ep.json').read()[:400])"; exit 1; }
ok "集建好:$EID"

# ---------- 粘剧本 ----------
note "第 3 步 · 粘一段剧本进去  [G4]"
python3 - "$TMP" "$STAMP" <<'PY'
import json,sys
tmp,stamp=sys.argv[1],sys.argv[2]
script = """第 3 集 · 第 7 场 · 天台对峙

时间:夜
地点:老城区废弃写字楼天台

【镜头 1】
陈默独自站在天台边缘,手里攥着一枚褪色的铜制打火机。远处霓虹灯牌明明灭灭,照在他半边脸上。他低头看着打火机,拇指反复摩挲上面刻的字。

【镜头 2】
身后铁门被推开。林雪快步走出来,黑色风衣被风吹得贴在身上。她停在三步远的地方,没有再靠近。

林雪:你答应过我,不再碰这件事。

【镜头 3】
特写:那枚铜制打火机。刻字清晰可见——"给阿默,爸"。打火机边缘有明显磕碰痕迹。

【镜头 4】
陈默转过身。他脸上没有表情,眼神却很沉。风把他额前的头发吹乱。

陈默:那你告诉我,他那天晚上到底见了谁。

【镜头 5】
天台另一侧,老周靠在水塔的阴影里,手里的烟头明灭了一下。他看着对峙的两人,慢慢把一部老式翻盖手机收进口袋。
"""
json.dump({"title":"天台对峙","script_text":script,
           "client_idempotency_key":f"walk-{stamp}-script"},
          open(f"{tmp}/script-body.json","w"), ensure_ascii=False)
PY
curl -s --max-time 30 -X POST "$BASE/api/v1/episodes/$EID/script-versions" -H "$AUTH" \
  -H "Content-Type: application/json" --data-binary "@$TMP/script-body.json" > "$TMP/sv.json"
SVID=$(python3 -c "
import json
d=json.load(open('$TMP/sv.json')).get('data') or {}
print((d.get('version') or {}).get('id',''))" 2>/dev/null)
if [ -z "$SVID" ]; then
  bad "存剧本失败"; python3 -c "print(open('$TMP/sv.json').read()[:400])"; exit 1
fi
ok "剧本落库,版本 $SVID  → G4 过"

# ---------- 拆解 ----------
note "第 4 步 · 拆解:拆分镜 + 拆人物场景道具  [G5 G6]"
curl -s --max-time 60 -X POST "$BASE/api/v1/episodes/$EID/script-breakdowns" -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"script_version_id\":\"$SVID\",\"client_idempotency_key\":\"walk-$STAMP-run\"}" > "$TMP/run.json"
RUNID=$(python3 -c "
import json
d=json.load(open('$TMP/run.json')).get('data') or {}
print((d.get('run') or {}).get('id',''))" 2>/dev/null)
if [ -z "$RUNID" ]; then
  bad "拆解发起失败"; python3 -c "print(open('$TMP/run.json').read()[:500])"; exit 1
fi
info "拆解已发起:$RUNID,等它跑完(最多 5 分钟)"

STATUS=""
for i in $(seq 1 60); do
  sleep 5
  curl -s --max-time 25 "$BASE/api/v1/script-breakdowns/$RUNID" -H "$AUTH" > "$TMP/run-detail.json"
  STATUS=$(python3 -c "
import json
d=json.load(open('$TMP/run-detail.json')).get('data') or {}
print((d.get('run') or {}).get('status',''))" 2>/dev/null)
  printf "\r     第 %d 次查:%s        " "$i" "${STATUS:-查不到}"
  case "$STATUS" in
    succeeded|completed|ready|awaiting_confirmation|failed|error) break ;;
  esac
done
echo
case "$STATUS" in
  failed|error)
    bad "拆解失败,状态 $STATUS"
    python3 -c "
import json
d=json.load(open('$TMP/run-detail.json')).get('data') or {}
for s in (d.get('stages') or []):
    print('     阶段', s.get('name'), s.get('status'), (s.get('error_message') or '')[:120])"
    exit 1 ;;
  "") bad "查不到拆解状态"; exit 1 ;;
  *) ok "拆解跑完,状态:$STATUS" ;;
esac

# ---------- 确认 ----------
note "确认拆解结果(确认之后才会写分镜和资产)"
curl -s --max-time 60 -X POST "$BASE/api/v1/script-breakdowns/$RUNID/confirm" -H "$AUTH" \
  -H "Content-Type: application/json" -d '{}' > "$TMP/confirm.json"
python3 -c "
import json
d=json.load(open('$TMP/confirm.json'))
print('     确认返回:', json.dumps(d, ensure_ascii=False)[:300])"

# ---------- G5 分镜落库 ----------
note "G5 · 分镜落库"
curl -s --max-time 25 "$BASE/api/v1/episodes/$EID/shots" -H "$AUTH" > "$TMP/shots.json"
python3 <<PY
import json
d=json.load(open('$TMP/shots.json')).get('data') or {}
items=d.get('items') or d.get('shots') or []
if items:
    print(f"  ✅ 分镜 {len(items)} 条 → G5 过")
    for s in items[:6]:
        print("    ", s.get('shot_no') or s.get('index'), (s.get('summary') or s.get('description') or '')[:40])
else:
    print("  ❌ 一条分镜都没有 → G5 不过")
    print("    ", json.dumps(d, ensure_ascii=False)[:300])
PY

# ---------- G6 资产真入库(命门) ----------
note "G6 · 资产真入库(命门)"
curl -s --max-time 25 "$BASE/api/v1/assets?project_id=$PID&page_size=100" -H "$AUTH" > "$TMP/assets.json"
python3 <<PY
import json
raw=open('$TMP/assets.json').read()
try:
    d=json.loads(raw).get('data') or {}
except Exception as e:
    print("  ⚠️ 资产接口返回不是 JSON:", raw[:200]); raise SystemExit
items=d.get('items') or d.get('assets') or []
if not items:
    print("  ❌ 资产库里一条都没有 → G6 不过")
    print("    ", json.dumps(d, ensure_ascii=False)[:300]); raise SystemExit
from collections import Counter
kinds=Counter((a.get('kind') or a.get('asset_kind') or '未分类') for a in items)
names=[a.get('name') or a.get('title') or '' for a in items]
print(f"  资产 {len(items)} 条,分类:{dict(kinds)}")
for n in sorted(set(names)):
    print("    ", n, f"(x{names.count(n)})" if names.count(n)>1 else "")
want=['陈默','林雪','老周','天台','打火机']
miss=[w for w in want if not any(w in n for n in names)]
dup=[n for n in set(names) if names.count(n)>1]
verdict=[]
if miss: verdict.append("漏了:"+ "、".join(miss))
if dup:  verdict.append("重复建了:"+ "、".join(dup))
print(("  ✅ 该有的都有、没有重复 → G6 过" if not verdict else "  ❌ G6 不过 —— " + ";".join(verdict)))
PY

note "留痕"
echo "  项目 $PID"
echo "  集   $EID"
echo "  拆解 $RUNID"
echo "  下一步(G9 批量生图 / G10 选定稿)要在生产界面上点,或等 kimi 的 #164 做完"

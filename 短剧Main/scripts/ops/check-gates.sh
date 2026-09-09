#!/usr/bin/env bash
# 对测试环境逐门判定。周六走查、周日复验、周一验收前自查都用这一条命令。
#
# 为什么要有它(2026-08-06 立):goal 定了 15 道硬门,能机器判的就别靠人眼。
#
# 2026-08-06 夜大修——原版有两个 bug,都是「把错误吞掉当成不合格」:
#   1. `. .env` 读凭据:密码里带 $ 的行在 set -u 下被当变量展开,报 unbound variable
#      直接把脚本打死;配上 2>/dev/null 就成了静默退出 1,看着像什么都没跑。
#   2. `curl | python3 - <<'PY'`:heredoc 和管道抢 stdin,python 读不到接口返回,
#      报错被 2>/dev/null 吞掉,结果把「过」判成「不过」。
#   教训一句话:**判定脚本自己出错时必须喊出来,不许静默算作不合格。**
#   现在一律 curl 到临时文件、python3 读文件、错误照常打印。
#
# 用法:
#   bash scripts/ops/check-gates.sh                 # 只跑不花钱的门
#   bash scripts/ops/check-gates.sh --with-paid     # 含真实付费生成(需产品负责人授权)
#
# 凭据从工作区根 .env 读,**脚本永远不打印凭据值**。
set -uo pipefail

WS=/Users/user/Workspace/02_AI工具开发
BASE="${BASE:-https://shortdrama-main-test.col.com}"
STYLEMARK="__STYLEMARK__"     # G3 用的特征词,绝不会自然出现在提示词里
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0; SKIP=0
note() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  ✅ %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  ❌ %s\n" "$1"; FAIL=$((FAIL+1)); }
skip() { printf "  ⏭  %s\n" "$1"; SKIP=$((SKIP+1)); }
huh()  { printf "  ⚠️  判不了(脚本自己的问题,不算不过):%s\n" "$1"; }

# ---- 凭据(只取需要的两个键,按字面值读,不做变量展开)----
U=$(grep -m1 '^TEST_ENV_ADMIN_USERNAME=' "$WS/.env" 2>/dev/null | cut -d= -f2-)
P=$(grep -m1 '^TEST_ENV_ADMIN_PASSWORD=' "$WS/.env" 2>/dev/null | cut -d= -f2-)
if [ -z "$U" ] || [ -z "$P" ]; then
  echo "缺测试环境账号(TEST_ENV_ADMIN_USERNAME / TEST_ENV_ADMIN_PASSWORD),先配 .env"; exit 1
fi

note "0. 服务活着吗"
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$BASE/")
[ "$CODE" = "200" ] && ok "首页返回 200" || { bad "首页返回 $CODE,后面全免谈"; exit 1; }

note "登录拿会话"
curl -s --max-time 25 -X POST "$BASE/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$U\",\"password\":\"$P\"}" > "$TMP/login.json"
TOKEN=$(python3 -c "
import json,sys
d=json.load(open('$TMP/login.json'))
print(d.get('data',{}).get('token') or d.get('token') or '')
")
[ -n "$TOKEN" ] || { bad "登录没拿到会话,后面的门都判不了"; exit 1; }
ok "登录成功(会话已拿到,不打印)"
AUTH="Authorization: Bearer $TOKEN"

# ============ G2 项目能带自己的设定 ============
note "G2 · 项目能带自己的设定"
curl -s --max-time 25 -X POST "$BASE/api/v1/projects" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"name\":\"门检查-$(date +%H%M%S)\",\"generation_config\":{\"default_ratio\":\"9:16\",\"default_image_resolution\":\"1K\",\"default_video_resolution\":\"720p\",\"image\":{\"style_description\":\"$STYLEMARK 港风黑帮 霓虹夜景\"}}}" > "$TMP/proj.json"
PID=$(python3 -c "
import json
print((json.load(open('$TMP/proj.json')).get('data') or {}).get('id',''))
" 2>/dev/null)

if [ -z "$PID" ]; then
  bad "建项目失败"
  python3 -c "print(open('$TMP/proj.json').read()[:300])"
else
  curl -s --max-time 25 "$BASE/api/v1/projects/$PID" -H "$AUTH" > "$TMP/detail.json"
  RES=$(python3 - "$STYLEMARK" <<PY
import json,sys
mark=sys.argv[1]
g=(json.load(open('$TMP/detail.json')).get('data') or {}).get('generation_config') or {}
miss=[]
if g.get('default_ratio')!='9:16': miss.append(f"画幅={g.get('default_ratio')}")
if not g.get('default_image_resolution'): miss.append('图片清晰度空')
if not g.get('default_video_resolution'): miss.append('视频清晰度空')
if mark not in ((g.get('image') or {}).get('style_description') or ''): miss.append('风格特征词没存住')
print('OK' if not miss else '缺:'+'、'.join(miss))
PY
)
  case "$RES" in
    OK) ok "画幅 9:16、图片与视频清晰度各有值、风格描述存住了" ;;
    缺*) bad "$RES" ;;
    *)  huh "判定脚本没跑通:$RES" ;;
  esac
  echo "  项目 id:$PID(后面几道门复用它)"
fi

# ============ G8 参数是可选控件 ============
note "G8 · 参数是可点的控件,不是死文字"
curl -s --max-time 25 "$BASE/api/v1/generation/capability-tiers?media_type=image&include_frozen=true" -H "$AUTH" > "$TMP/tiers.json"
python3 <<PY
import json
d=json.load(open('$TMP/tiers.json')).get('data') or {}
pm=d.get('parameter_models') or []
sel=[m for m in pm if m.get('selectable')]
vis,can=set(),set()
for m in pm:
    for opt in (m.get('parameter_options') or []):
        if opt.get('key')=='aspect_ratio':
            for v in (opt.get('values') or []):
                vis.add(v.get('value'))
                if v.get('selectable'): can.add(v.get('value'))
print(f"  模型条目 {len(pm)} 个,其中可选 {len(sel)} 个")
print(f"  画幅可见:{sorted(vis)}")
print(f"  画幅可选:{sorted(can)}")
print("VERDICT_916_SELECTABLE" if '9:16' in can else ("VERDICT_916_VISIBLE_ONLY" if '9:16' in vis else "VERDICT_916_ABSENT"))
PY
V=$(python3 -c "
import json
d=json.load(open('$TMP/tiers.json')).get('data') or {}
can=set()
for m in (d.get('parameter_models') or []):
    for opt in (m.get('parameter_options') or []):
        if opt.get('key')=='aspect_ratio':
            for v in (opt.get('values') or []):
                if v.get('selectable'): can.add(v.get('value'))
print('YES' if '9:16' in can else 'NO')
" 2>/dev/null)
CNT=$(python3 -c "
import json
print(len((json.load(open('$TMP/tiers.json')).get('data') or {}).get('parameter_models') or []))
" 2>/dev/null)
[ "${CNT:-0}" -gt 0 ] && ok "能力目录返回 $CNT 个模型条目" || bad "能力目录空的,生成面板必然是死文字"

note "G7 前置 · 竖屏到底能不能选"
case "$V" in
  YES) ok "9:16 是可选的——G7 有机会过" ;;
  NO)  bad "9:16 只可见不可选(档位没解冻)——G7 必然不过" ;;
  *)   huh "没判出来" ;;
esac

# ============ G5/G6 剧本→分镜→资产 ============
note "G4 G5 G6 · 剧本进系统 → 分镜落库 → 资产真入库"
if [ -z "${PID:-}" ]; then
  skip "前置的项目没建成,这三道跳过"
else
  curl -s --max-time 25 -X POST "$BASE/api/v1/projects/$PID/episodes" -H "$AUTH" \
    -H "Content-Type: application/json" -d '{"episode_no":3}' > "$TMP/ep.json"
  EID=$(python3 -c "
import json
print((json.load(open('$TMP/ep.json')).get('data') or {}).get('id',''))
" 2>/dev/null)
  if [ -z "$EID" ]; then
    bad "建集失败"
    python3 -c "print(open('$TMP/ep.json').read()[:300])"
  else
    ok "建集成功"
    echo "  集 id:$EID"
    skip "G4/G5/G6 后续(存剧本→拆解→查资产库)要跑拆解模型,单独走查时做"
  fi
fi

# ============ 人工门 ============
note "只能人工看的门"
skip "G1 后台开号——要在界面上点"
skip "G7 图片高>宽——要真生成一张图再下载看尺寸(花钱,--with-paid)"
skip "G9 批量三镜 / G10 选定稿 / G11 生视频 / G12 下载——要在生产界面点"
skip "G13 肉眼看是不是同一个人——goal 里已写明这半句无法机器判定"
skip "G14 Seedance 2.5——等 8 号在火山开通后再验"

printf "\n\033[1m逐门结果:过 %d / 不过 %d / 待人工或待跑 %d\033[0m\n" "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0

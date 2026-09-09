#!/bin/bash
# Shortdrama CLI 用户隔离包装
#
# ⚠️ 仅限手动应急使用（MANUAL EMERGENCY ONLY）。
# 本脚本通过「备份/覆盖全局 default.json 再恢复」的方式切换 profile，
# 与每租户独立 HOME（server.py 的 _session_home 方案）冲突，且非并发安全。
# 正常运行请使用 server.py 的 per-HOME 隔离，不要依赖本脚本做多租户隔离。
#
# 用法: shortdrama-for-user.sh <user-id> <shortdrama-cli args...>

USER_ID="${1:-default}"
shift
PROFILE_DIR="${SHORTDRAMA_PROFILE_DIR:-/var/lib/pi-http-wrapper/.config/shortdrama-cli/profiles}"
DEFAULT="${PROFILE_DIR}/default.json"
BACKUP="${PROFILE_DIR}/.default.bak"

# 确定 profile 文件
case "$USER_ID" in
  user-001) SRC="${PROFILE_DIR}/user-001.json" ;;
  user-002) SRC="${PROFILE_DIR}/user-002.json" ;;
  *)        SRC="${PROFILE_DIR}/default.json" ;;
esac

# 如果源不是 default，先备份 default，再复制用户 profile 为 default
if [ "$SRC" != "$DEFAULT" ] && [ -f "$SRC" ]; then
  cp "$DEFAULT" "$BACKUP" 2>/dev/null
  cp "$SRC" "$DEFAULT"
fi

# 执行命令
shortdrama-cli "$@"
RC=$?

# 恢复原 default
if [ -f "$BACKUP" ]; then
  mv "$BACKUP" "$DEFAULT"
fi

exit $RC

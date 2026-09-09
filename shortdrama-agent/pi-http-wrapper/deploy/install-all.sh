#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" != "--apply" ]]; then
  cat <<EOF
Dry run only. To install on the approved Pi host:
  sudo $0 --apply

Installs all 4 systemd services:
  - pi-http-wrapper (8787)
  - admin-service (8001)
  - shortdrama-api (8000)
  - standard-port-proxy (80)

Shared resources are copied from $root/resources/.
Runtime tokens must be injected into /etc/shortdrama/*.env with 0600 permissions.
EOF
  exit 0
fi

# ── common directories ──────────────────────────────────────────────
sudo install -d -m 0750 /opt/shortdrama /var/log/pi-http-wrapper /etc/shortdrama
sudo install -d -m 0750 /opt/shortdrama/pi-http-wrapper/releases /var/lib/pi-http-wrapper

# ── system users ────────────────────────────────────────────────────
for user in piwrapper piadmin piproxy; do
  if ! id "$user" >/dev/null 2>&1; then
    sudo useradd --system --home /var/lib/pi-http-wrapper --shell /usr/sbin/nologin "$user"
  fi
done

sudo chown -R piwrapper:piwrapper /var/lib/pi-http-wrapper /var/log/pi-http-wrapper
# admin-service 数据目录（DATA_ROOT 默认值），属主 piadmin；须在 piadmin 用户创建之后
sudo install -d -o piadmin -g piadmin -m 0750 /var/lib/pi-http-wrapper/data

# ── pi-http-wrapper (core service) ──────────────────────────────────
release_id="$(date -u +%Y%m%dT%H%M%SZ)"
release_root="/opt/shortdrama/pi-http-wrapper/releases/$release_id"
sudo install -d -o piwrapper -g piwrapper -m 0750 "$release_root"
sudo cp -R "$root/." "$release_root/"
sudo chown -R piwrapper:piwrapper "$release_root"
sudo -u piwrapper python3.12 -m venv --system-site-packages "$release_root/.venv"
sudo -u piwrapper "$release_root/.venv/bin/pip" install \
  --disable-pip-version-check --no-deps --no-build-isolation "$release_root"
sudo install -m 0644 "$root/deploy/pi-http-wrapper.service" /etc/systemd/system/pi-http-wrapper.service
if [[ ! -f /etc/shortdrama/pi-http-wrapper.env ]]; then
  sudo install -m 0600 "$root/deploy/pi-http-wrapper.env.example" /etc/shortdrama/pi-http-wrapper.env
  echo "Created placeholder pi-http-wrapper.env. Replace tokens before starting." >&2
fi
sudo ln -sfn "$release_root" /opt/shortdrama/pi-http-wrapper/current

# ── seed managed skills ─────────────────────────────────────────────
seed_skill_root() {
  local source_root="$1" target_root="$2"
  sudo install -d -o piwrapper -g piwrapper -m 0750 "$target_root"
  [[ -d "$source_root" ]] || return 0
  for marker in "$source_root"/*/SKILL.md; do
    [[ -f "$marker" ]] || continue
    local skill_dir="${marker%/SKILL.md}" skill_name="${skill_dir##*/}" target="$target_root/$skill_name"
    if [[ -L "$skill_dir" ]] || [[ -n "$(sudo find "$skill_dir" -type l -print -quit)" ]]; then
      echo "Skipped skill containing symlinks: $skill_dir" >&2; continue
    fi
    if [[ -e "$target" ]]; then
      echo "Preserved existing managed skill: $target" >&2; continue
    fi
    sudo cp -a "$skill_dir" "$target"
    sudo chown -R piwrapper:piwrapper "$target"
  done
}

seed_skill_root /root/.agents/skills /var/lib/pi-http-wrapper/.agents/skills
seed_skill_root /root/.workbuddy/skills /var/lib/pi-http-wrapper/.workbuddy/skills

# ── copy shared resources ───────────────────────────────────────────
SHARED_ROOT="/opt/shortdrama/shared"
sudo install -d -o piadmin -g piadmin -m 0755 "$SHARED_ROOT"

if [[ -d "$root/resources/role-skills" ]]; then
  sudo cp -a "$root/resources/role-skills" "$SHARED_ROOT/role-skills"
  sudo chown -R piadmin:piadmin "$SHARED_ROOT/role-skills"
fi
if [[ -d "$root/resources/shortdrama-cli-skill" ]]; then
  sudo cp -a "$root/resources/shortdrama-cli-skill" "$SHARED_ROOT/shortdrama-cli-skill"
  sudo chown -R piadmin:piadmin "$SHARED_ROOT/shortdrama-cli-skill"
fi
if [[ -d "$root/resources/extensions" ]]; then
  sudo cp -a "$root/resources/extensions" "$SHARED_ROOT/extensions"
  sudo chown -R piadmin:piadmin "$SHARED_ROOT/extensions"
fi
if [[ -d "$root/resources/shortdrama-delta" ]]; then
  sudo cp -a "$root/resources/shortdrama-delta" "$SHARED_ROOT/shortdrama-delta"
  sudo chown -R piadmin:piadmin "$SHARED_ROOT/shortdrama-delta"
fi
if [[ -d "$root/resources/user-instances" ]]; then
  sudo cp -a "$root/resources/user-instances" "$SHARED_ROOT/user-instances"
  sudo chown -R piadmin:piadmin "$SHARED_ROOT/user-instances"
fi
if [[ -d "$root/resources/demo" ]]; then
  sudo cp -a "$root/resources/demo" "$SHARED_ROOT/demo"
  sudo chown -R piadmin:piadmin "$SHARED_ROOT/demo"
fi
if [[ -f "$root/resources/shortdrama-for-user.sh" ]]; then
  sudo cp -a "$root/resources/shortdrama-for-user.sh" "$SHARED_ROOT/shortdrama-for-user.sh"
  sudo chmod 0755 "$SHARED_ROOT/shortdrama-for-user.sh"
fi

# ── admin-service (8001) ────────────────────────────────────────────
ADMIN_SRC="$root/services/admin-service"
ADMIN_ROOT="/opt/shortdrama/admin-service"
sudo install -d -o piadmin -g piadmin -m 0750 "$ADMIN_ROOT"
sudo cp -a "$ADMIN_SRC"/* "$ADMIN_ROOT/"
sudo chown -R piadmin:piadmin "$ADMIN_ROOT"
sudo install -m 0644 "$root/deploy/admin-service.service" /etc/systemd/system/admin-service.service
if [[ ! -f /etc/shortdrama/admin-service.env ]]; then
  sudo install -m 0600 /dev/null /etc/shortdrama/admin-service.env
  echo "Created empty admin-service.env. Fill in tokens before starting." >&2
fi
# Admin-service runs off 8001 so it never collides with shortdrama-api (8000).
# Only inject the pin if the file doesn't already set it; never clobber user tokens.
if ! grep -qE '^PI_MULTI_PORT=' /etc/shortdrama/admin-service.env; then
  echo 'PI_MULTI_PORT=8001' | sudo tee -a /etc/shortdrama/admin-service.env >/dev/null
fi

# ── shortdrama-api (8000) ───────────────────────────────────────────
API_SRC="$root/services/shortdrama_api"
API_ROOT="/opt/shortdrama/shortdrama_api"
sudo install -d -o piadmin -g piadmin -m 0750 "$API_ROOT"
sudo cp -a "$API_SRC"/* "$API_ROOT/"
sudo chown -R piadmin:piadmin "$API_ROOT"
sudo install -m 0644 "$root/deploy/shortdrama-api.service" /etc/systemd/system/shortdrama-api.service
if [[ ! -f /etc/shortdrama/shortdrama-api.env ]]; then
  sudo install -m 0600 /dev/null /etc/shortdrama/shortdrama-api.env
  echo "Created empty shortdrama-api.env. Fill in tokens before starting." >&2
fi
# shortdrama-api 端口固定 8000（proxy /api→8000 契约）；HTTP_API_KEY 启动时强制非空。
if ! grep -qE '^API_PORT=' /etc/shortdrama/shortdrama-api.env; then
  echo 'API_PORT=8000' | sudo tee -a /etc/shortdrama/shortdrama-api.env >/dev/null
fi
# 关键：config.py 会在 HTTP_API_KEY 为空时拒绝启动；缺真实值直接报错退出，不落占位符（防漏改带上线）。
if ! grep -qE '^HTTP_API_KEY=' /etc/shortdrama/shortdrama-api.env; then
  echo "ERROR: /etc/shortdrama/shortdrama-api.env 缺少 HTTP_API_KEY。请先写入真实密钥（sudo sed -i '1i HTTP_API_KEY=<真实密钥>' ...），再重跑本脚本。" >&2
  exit 1
fi

# ── standard-port-proxy (80) ────────────────────────────────────────
PROXY_SRC="$root/services/standard-port-proxy"
PROXY_ROOT="/opt/shortdrama/standard-port-proxy"
sudo install -d -o piproxy -g piproxy -m 0750 "$PROXY_ROOT"
sudo cp -a "$PROXY_SRC"/* "$PROXY_ROOT/"
sudo chown -R piproxy:piproxy "$PROXY_ROOT"
sudo install -m 0644 "$root/deploy/standard-port-proxy.service" /etc/systemd/system/standard-port-proxy.service

# ── enable all services ─────────────────────────────────────────────
sudo systemctl daemon-reload
sudo systemctl enable pi-http-wrapper.service admin-service.service shortdrama-api.service standard-port-proxy.service
echo "Installed release $release_id and enabled all 4 services."
echo "After secret injection: sudo systemctl start pi-http-wrapper admin-service shortdrama-api standard-port-proxy"
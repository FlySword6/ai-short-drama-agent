#!/usr/bin/env bash
# DEPRECATED: use install-all.sh as the single entry point. install-all.sh
# installs every service (including pi-http-wrapper with identical release
# layout); keeping this script risks drift between the two installers.
# Kept for reference only — do not extend it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" != "--apply" ]]; then
  cat <<EOF
Dry run only. To install on the approved Pi host:
  sudo $0 --apply

It will create a versioned release under /opt/shortdrama/pi-http-wrapper,
install the unit file, and enable (but not start) the service. Runtime tokens
must be injected separately into /etc/shortdrama/pi-http-wrapper.env with 0600 permissions.
EOF
  exit 0
fi

release_id="$(date -u +%Y%m%dT%H%M%SZ)"
release_root="/opt/shortdrama/pi-http-wrapper/releases/$release_id"
sudo install -d -m 0750 /opt/shortdrama/pi-http-wrapper/releases /var/lib/pi-http-wrapper /var/log/pi-http-wrapper /etc/shortdrama
if ! id piwrapper >/dev/null 2>&1; then
  sudo useradd --system --home /var/lib/pi-http-wrapper --shell /usr/sbin/nologin piwrapper
fi
sudo chown -R piwrapper:piwrapper /var/lib/pi-http-wrapper /var/log/pi-http-wrapper

seed_skill_root() {
  local source_root="$1"
  local target_root="$2"
  sudo install -d -o piwrapper -g piwrapper -m 0750 "$target_root"
  [[ -d "$source_root" ]] || return 0
  local marker skill_dir skill_name target
  for marker in "$source_root"/*/SKILL.md; do
    [[ -f "$marker" ]] || continue
    skill_dir="${marker%/SKILL.md}"
    skill_name="${skill_dir##*/}"
    target="$target_root/$skill_name"
    if [[ -L "$skill_dir" ]] || [[ -n "$(sudo find "$skill_dir" -type l -print -quit)" ]]; then
      echo "Skipped skill containing symlinks: $skill_dir" >&2
      continue
    fi
    if [[ -e "$target" ]]; then
      echo "Preserved existing managed skill: $target" >&2
      continue
    fi
    sudo cp -a "$skill_dir" "$target"
    sudo chown -R piwrapper:piwrapper "$target"
  done
}

# One-time, non-overwriting migration from the original root-run service. New
# skill releases should be delivered to the managed piwrapper roots directly.
seed_skill_root /root/.agents/skills /var/lib/pi-http-wrapper/.agents/skills
seed_skill_root /root/.workbuddy/skills /var/lib/pi-http-wrapper/.workbuddy/skills

sudo install -d -o piwrapper -g piwrapper -m 0750 "$release_root"
sudo cp -R "$root/." "$release_root/"
sudo chown -R piwrapper:piwrapper "$release_root"
sudo -u piwrapper python3.12 -m venv --system-site-packages "$release_root/.venv"
# The approved host already carries the validated FastAPI/Pi runtime. Avoid a
# deployment-time registry dependency: install only this local package using
# the host's setuptools and shared runtime packages.
sudo -u piwrapper "$release_root/.venv/bin/pip" install \
  --disable-pip-version-check --no-deps --no-build-isolation "$release_root"
sudo install -m 0644 "$root/deploy/pi-http-wrapper.service" /etc/systemd/system/pi-http-wrapper.service
if [[ ! -f /etc/shortdrama/pi-http-wrapper.env ]]; then
  sudo install -m 0600 "$root/deploy/pi-http-wrapper.env.example" /etc/shortdrama/pi-http-wrapper.env
  echo "Created placeholder env file. Replace PI_WRAPPER_BEARER_TOKENS using the approved secret delivery before starting." >&2
fi
sudo systemctl daemon-reload
sudo systemctl enable pi-http-wrapper.service
sudo ln -sfn "$release_root" /opt/shortdrama/pi-http-wrapper/current
echo "Installed release $release_id and enabled the service without starting it."
echo "After secret injection: sudo systemctl start pi-http-wrapper"
echo "Rollback: repoint /opt/shortdrama/pi-http-wrapper/current to the previous release, then restart."

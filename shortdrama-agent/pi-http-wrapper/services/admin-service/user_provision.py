"""
用户自动分配与自举模块。

职责：新用户首次访问时自动创建完整的隔离环境。
- 分配 user_id + 端口
- 创建目录结构（workspace/.pi/.pi-web/config/run-pi.sh）
- 注册 nginx 路由
- 启动 pi-web（sessiond + web-server，纯只读模式）
- 写 meta.json 元信息
- 返回完整的用户信息
"""

import json
import os
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

# 部署面数据根：与 systemd 单元 ReadWritePaths=/var/lib/pi-http-wrapper/data 保持一致
# （原硬编码 /root/data，违反 User=piadmin 非 root 契约）
BASE_DIR = Path(os.environ.get("PI_DATA_ROOT", "/var/lib/pi-http-wrapper/data")) / "agent-a"
SHARED_EXTENSIONS = str(
    Path(os.environ.get("PI_DATA_ROOT", "/var/lib/pi-http-wrapper/data"))
    / "shared/extensions/workspace-guard.ts"
)
NGINX_USERS_DIR = Path(
    os.environ.get("PI_NGINX_USERS_DIR", "/etc/nginx/conf.d/users")
)
SHORTDRAMA_PROFILES_DIR = Path(
    os.environ.get("PI_SHORTDRAMA_PROFILES_DIR", "/var/lib/pi-http-wrapper/.config/shortdrama-cli/profiles")
)
DEFAULT_AUTH = Path(os.environ.get("PI_DEFAULT_AUTH", "/var/lib/pi-http-wrapper/.pi/agent/auth.json"))
PIWEB_BIN = os.environ.get("PI_PIWEB_BIN", "/opt/piweb/npm-prefix/app/node_modules/.bin")
SHORTDRAMA_BIN = os.environ.get(
    "SHORTDRAMA_CLI_BIN", "/var/lib/pi-http-wrapper/.shortdrama/bin"
)

# project_id 会原样内插进 run-pi.sh 再经 bash exec，必须白名单校验，防命令注入
_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def get_next_user_id():
    """扫描已有目录，返回下一个 user_id"""
    existing = sorted([
        d.name for d in BASE_DIR.iterdir()
        if d.is_dir() and d.name.startswith("user-")
    ])
    if not existing:
        return "user-001"
    last_num = int(existing[-1].split("-")[1])
    return f"user-{last_num + 1:03d}"


def _wait_for_port(port, timeout=10):
    """阻塞等待端口开始监听，超时后抛异常。"""
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            result = subprocess.run(
                ["ss", "-tln"], capture_output=True, text=True, timeout=3
            )
            if f":{port}" in result.stdout:
                return True
        except Exception:
            pass
        time.sleep(0.3)
    raise RuntimeError(f"Port {port} did not start listening within {timeout}s")


def get_next_ports():
    """通过 ss 命令实时扫描已占用端口，返回下一组可用端口 (web_port, sessiond_port)。

    不依赖 meta.json（可能有写入延迟），直接查系统端口监听状态。
    """
    # 扫描 85xx（pi-web-server）和 95xx（sessiond）端口
    try:
        result = subprocess.run(
            ["ss", "-tlnpH"], capture_output=True, text=True, timeout=5
        )
        lines = result.stdout.split("\n")
    except Exception:
        lines = []

    web_ports = []
    sessiond_ports = []
    for line in lines:
        # 匹配 127.0.0.1:85xx 或 0.0.0.0:85xx
        for part in line.split():
            if ":85" in part or ":95" in part:
                try:
                    port = int(part.rsplit(":", 1)[-1])
                    if 8501 <= port <= 8599:
                        web_ports.append(port)
                    elif 9501 <= port <= 9599:
                        sessiond_ports.append(port)
                except ValueError:
                    pass

    # 去重
    web_ports = sorted(set(web_ports))
    sessiond_ports = sorted(set(sessiond_ports))

    if not web_ports:
        return 8501, 9501

    max_web = max(web_ports)
    max_sd = max(sessiond_ports) if sessiond_ports else max_web + 999
    next_web = max_web + 1
    next_sd = max(max_sd + 1, max_web + 1000)
    # 边界检查：端口池耗尽后禁止越界分配
    if next_web > 8599 or next_sd > 9599:
        raise RuntimeError(
            f"port pool exhausted: web={next_web} sessiond={next_sd} (limit 8599/9599)"
        )
    return next_web, next_sd


def provision_user(agent_id="agent-a", role="art", project_id=None):
    """创建一个完整的新用户环境，返回元信息字典。
    
    步骤：
    1. 分配 ID 和端口
    2. 创建目录结构
    3. 写配置文件
    4. git init workspace
    5. 注册 nginx 路由
    6. 启动 pi-web（sessiond + web-server）
    7. 写 meta.json
    
    返回 dict 或抛出异常。
    """
    if project_id is not None:
        project_id = project_id.strip()
        if not _PROJECT_ID_RE.match(project_id):
            raise ValueError(f"invalid project_id: {project_id!r}")

    user_id = get_next_user_id()
    web_port, sessiond_port = get_next_ports()
    user_dir = BASE_DIR / user_id

    print(f"[PROVISION] Creating {user_id} (web={web_port}, sessiond={sessiond_port})")

    # ── 1. 创建目录结构 ──
    (user_dir / "workspace").mkdir(parents=True, exist_ok=True)
    (user_dir / "outputs").mkdir(exist_ok=True)
    (user_dir / ".pi" / "agent" / "sessions").mkdir(parents=True, exist_ok=True)
    (user_dir / ".pi-web" / "uploads").mkdir(parents=True, exist_ok=True)
    (user_dir / "logs").mkdir(exist_ok=True)

    # ── 2. 复制 auth.json（继承 API Key）──
    if DEFAULT_AUTH.exists():
        shutil.copy2(DEFAULT_AUTH, user_dir / ".pi" / "agent" / "auth.json")
        os.chmod(user_dir / ".pi" / "agent" / "auth.json", 0o600)

    # ── 3. 写 settings.json（含 workspace-guard 扩展）──
    settings = {
        "extensions": [SHARED_EXTENSIONS]
    }
    (user_dir / ".pi" / "agent" / "settings.json").write_text(
        json.dumps(settings, indent=2))

    # ── 4. 写 run-pi.sh（注入隔离环境变量 + 角色 + PATH 优先级）──
    # PATH 顺序：用户 bin/（wrapper 优先） → shortdrama bin → 系统 PATH
    run_script = f"""#!/bin/bash
export PI_USER_ID="{user_id}"
export SHORTDRAMA_PROFILE="$PI_USER_ID"
export PI_AGENT_ID="{agent_id}"
export PI_ROLE="{role}"
export PI_PROJECT_ID="{project_id or ''}"
export PI_WORKSPACE_DIR="{user_dir}/workspace"
export PI_CODING_AGENT_DIR="{user_dir}/.pi/agent"
export HOME="{user_dir}"
export PATH="{user_dir}/bin:{SHORTDRAMA_BIN}:$PATH"
cd "$PI_WORKSPACE_DIR"
exec pi "$@"
"""
    run_path = user_dir / "run-pi.sh"
    run_path.write_text(run_script)
    os.chmod(run_path, 0o755)

    # ── 5. 写 config.json（pi-web 纯只读模式）──
    config = {
        "host": "127.0.0.1",
        "port": web_port,
        "sessionDir": str(user_dir / ".pi" / "agent" / "sessions"),
        "spawnSessions": False,
        "allowExternalPaths": False,
        "pathAccess": {
            "allowedPaths": [str(user_dir / "workspace")]
        }
    }
    (user_dir / "config.json").write_text(json.dumps(config, indent=2))

    # ── 6. git init workspace ──
    try:
        subprocess.run(["git", "init"], cwd=user_dir / "workspace",
                       capture_output=True, check=True)
        readme = user_dir / "workspace" / "README.md"
        readme.write_text(f"# {user_id} workspace\n\n"
                         f"Auto-provisioned at {datetime.now().isoformat()}\n")
        subprocess.run(["git", "add", "."], cwd=user_dir / "workspace",
                       capture_output=True, check=True)
        subprocess.run(["git", "commit", "-m", "auto-provision init"],
                       cwd=user_dir / "workspace", capture_output=True)
    except Exception as e:
        print(f"[PROVISION] git init warning: {e}")

    # ── 7. shortdrama profile ──
    SHORTDRAMA_PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    # 尝试从已有用户复制
    src_profile = None
    for candidate in [SHORTDRAMA_PROFILES_DIR / "user-001.json",
                      SHORTDRAMA_PROFILES_DIR / "default.json"]:
        if candidate.exists():
            src_profile = candidate
            break
    if src_profile:
        shutil.copy2(src_profile, SHORTDRAMA_PROFILES_DIR / f"{user_id}.json")
        print(f"[PROVISION] shortdrama profile copied from {src_profile.name}")

    # ── 8. 注册 nginx 路由 ──
    NGINX_USERS_DIR.mkdir(parents=True, exist_ok=True)
    
    # PWA static files 不需要认证
    nginx_conf = f"""# Auto-provisioned route for {user_id} (web={web_port}, sessiond={sessiond_port})

# PWA static files - no auth required
location ~ ^/{user_id}/(manifest\\.webmanifest|pwa-icon-.*\\.png)$ {{
    auth_basic off;
    rewrite ^/{user_id}/(.*)$ /$1 break;
    proxy_pass http://127.0.0.1:{web_port};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Authorization "";
    proxy_set_header Cookie $http_cookie;
}}

# Redirect bare path to trailing slash
location = /{user_id} {{
    return 301 /{user_id}/;
}}

# Main tenant route
location /{user_id}/ {{
    auth_basic "PI WEB restricted access";
    auth_basic_user_file /etc/nginx/.htpasswd.pi;
    rewrite ^/{user_id}/(.*)$ /$1 break;
    proxy_pass http://127.0.0.1:{web_port};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Authorization "";
    proxy_set_header Cookie $http_cookie;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $s53_piweb_connection_upgrade;
    proxy_read_timeout 3600s;
}}
"""
    (NGINX_USERS_DIR / f"{user_id}.conf").write_text(nginx_conf)
    print(f"[PROVISION] nginx config written to {NGINX_USERS_DIR / f'{user_id}.conf'}")

    # ── 9. nginx reload ──
    result = subprocess.run(["nginx", "-s", "reload"], capture_output=True)
    if result.returncode != 0:
        print(f"[PROVISION] nginx reload WARNING: {result.stderr.decode()[:200]}")
    else:
        print(f"[PROVISION] nginx reload OK, route /{user_id}/ -> :{web_port}")

    # ── 10. 启动 pi-web-sessiond（等待端口就绪）──
    sessiond_env = os.environ.copy()
    sessiond_env.update({
        "PI_WEB_CONFIG": str(user_dir / "config.json"),
        "PI_WEB_DATA_DIR": str(user_dir / ".pi-web"),
        "PI_WEB_AGENT_DIR": str(user_dir / ".pi" / "agent"),
        "PI_WEB_SESSIOND_HOST": "127.0.0.1",
        "PI_WEB_SESSIOND_PORT": str(sessiond_port),
        # 角色身份注入：pi 子进程继承 sessiond 环境，必须在此带上角色变量，
        # 否则 pi-web 会话里 workspace-guard 读到 unknown（角色未知、工作区错位）。
        "PI_USER_ID": user_id,
        "PI_AGENT_ID": agent_id,
        "PI_ROLE": role,
        "PI_PROJECT_ID": project_id or "",
        "PI_WORKSPACE_DIR": str(user_dir / "workspace"),
        "HOME": str(user_dir),
        "PATH": f"{user_dir}/bin:{SHORTDRAMA_BIN}:$PATH",
    })
    sessiond_bin = f"{PIWEB_BIN}/pi-web-sessiond"
    sessiond_log = open(user_dir / ".pi-web" / "sessiond.log", "w")
    subprocess.Popen(
        ["node", sessiond_bin],
        env=sessiond_env,
        stdout=sessiond_log,
        stderr=subprocess.STDOUT
    )
    # 等待端口实际监听
    _wait_for_port(sessiond_port, timeout=8)
    print(f"[PROVISION] sessiond listening on :{sessiond_port}")

    # ── 11. 启动 pi-web-server（等待端口就绪）──
    webserver_env = os.environ.copy()
    webserver_env.update({
        "PI_WEB_CONFIG": str(user_dir / "config.json"),
        "PI_WEB_DATA_DIR": str(user_dir / ".pi-web"),
        "PI_WEB_HOST": "127.0.0.1",
        "PI_WEB_PORT": str(web_port),
        "PI_WEB_SESSIOND_URL": f"http://127.0.0.1:{sessiond_port}",
        # 角色隔离：继承给 web-server（虽然 web-server 不直接 spawn pi，但保持一致性）
        "PI_ROLE": role,
        "PI_PROJECT_ID": project_id or "",
        "PI_USER_ID": user_id,
        "PI_WORKSPACE_DIR": str(user_dir / "workspace"),
        "HOME": str(user_dir),
    })
    webserver_bin = f"{PIWEB_BIN}/pi-web-server"
    webserver_log = open(user_dir / ".pi-web" / "web.log", "w")
    subprocess.Popen(
        ["node", webserver_bin],
        env=webserver_env,
        stdout=webserver_log,
        stderr=subprocess.STDOUT
    )
    _wait_for_port(web_port, timeout=8)
    print(f"[PROVISION] pi-web-server listening on :{web_port}")

    # ── 12. 注册项目到 pi-web（否则 UI 显示空列表）──
    try:
        import urllib.request
        project_data = json.dumps({
            "name": user_id,
            "path": str(user_dir / "workspace")
        }).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{web_port}/api/projects",
            data=project_data,
            headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=10)
        print(f"[PROVISION] project registered in pi-web: {user_id}")
    except Exception as e:
        print(f"[PROVISION] project registration warning: {e}")

    # ── 13. 角色隔离：复制 skill 文件和包装脚本 ──
    SKILLS_BASE = Path(os.environ.get("PI_DATA_ROOT", "/var/lib/pi-http-wrapper/data")) / "shared/skills"
    role_dir = SKILLS_BASE / role
    GLOBAL_SKILL = Path(
        os.environ.get("PI_AGENTS_SKILLS", "/var/lib/pi-http-wrapper/.agents/skills")
    ) / "shortdrama-cli"
    if not role_dir.exists():
        print(f"[PROVISION] Warning: role dir {role_dir} not found, skipping role setup")
    else:
        # 复制 skill：先完整复制全局 shortdrama-cli skill（含 commands/ references/ examples/ agents/），
        # 再用角色 SKILL.md 覆盖。pi 按 skill 名称 "shortdrama-cli" 匹配，必须放对路径。
        user_skills = user_dir / ".agents" / "skills" / "shortdrama-cli"
        if GLOBAL_SKILL.exists():
            shutil.copytree(GLOBAL_SKILL, user_skills, dirs_exist_ok=True)
            print(f"[PROVISION] global shortdrama-cli skill copied")
        else:
            user_skills.mkdir(parents=True, exist_ok=True)

        skill_src = role_dir / "SKILL.md"
        if skill_src.exists():
            shutil.copy2(skill_src, user_skills / "SKILL.md")
            print(f"[PROVISION] skill SKILL.md overwritten with role={role}")

        # 复制包装脚本到用户 bin/
        user_bin = user_dir / "bin"
        user_bin.mkdir(exist_ok=True)
        wrapper_src = role_dir / "bin" / "shortdrama-cli"
        if wrapper_src.exists():
            shutil.copy2(wrapper_src, user_bin / "shortdrama-cli")
            os.chmod(user_bin / "shortdrama-cli", 0o755)
            print(f"[PROVISION] wrapper script copied to {user_bin}/shortdrama-cli")

    # ── 14. 确保 shortdrama-cli auth session 已登录（共享）──
    import subprocess as sp_auth
    auth_check = sp_auth.run(
        ["shortdrama-cli", "auth", "status"],
        capture_output=True, text=True, timeout=10
    )
    out_lower = auth_check.stdout.lower()
    if "logged in" in out_lower or "login" in out_lower or "succeeded" in out_lower or "ok" in out_lower:
        print("[PROVISION] auth session OK (shared across all users)")
    else:
        print("[PROVISION] Warning: shortdrama-cli auth not logged in")
        print("[PROVISION] Run: shortdrama-cli auth login before starting PI")

    # ── 15. 写 meta.json ──
    meta = {
        "user_id": user_id,
        "agent_id": agent_id,
        "role": role,
        "project_id": project_id,
        "web_port": web_port,
        "sessiond_port": sessiond_port,
        "workspace": str(user_dir / "workspace"),
        "outputs": str(user_dir / "outputs"),
        "tenant_dir": str(user_dir),
        "access_url": f"/{user_id}/",
        "created_at": datetime.now().isoformat(),
        "status": "provisioned"
    }
    (user_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    return meta


def list_all_users():
    """列出所有已创建的用户（从 meta.json 读取）"""
    users = []
    if not BASE_DIR.exists():
        return users
    for user_dir in sorted(BASE_DIR.iterdir()):
        if not user_dir.is_dir() or not user_dir.name.startswith("user-"):
            continue
        meta_path = user_dir / "meta.json"
        if meta_path.exists():
            try:
                users.append(json.loads(meta_path.read_text()))
            except Exception:
                users.append({"user_id": user_dir.name, "tenant_dir": str(user_dir)})
        else:
            users.append({"user_id": user_dir.name, "tenant_dir": str(user_dir)})
    return users


def delete_user(user_id):
    """删除用户：停止进程、清理 nginx 路由、profile、目录。返回 (success, message)。"""
    user_dir = BASE_DIR / user_id
    if not user_dir.exists():
        return False, f"User {user_id} not found"

    # 0. 读取端口号，停止 pi-web 进程
    config_path = user_dir / "config.json"
    if config_path.exists():
        try:
            config = json.loads(config_path.read_text())
            web_port = config.get("port")
            if web_port:
                # 杀掉 pi-web-server
                result = subprocess.run(
                    ["fuser", "-k", f"{web_port}/tcp"],
                    capture_output=True
                )
                print(f"[DELETE] killed pi-web-server on :{web_port}: {result.stdout.decode().strip()}")
        except Exception as e:
            print(f"[DELETE] stop web-server warning: {e}")

    meta_path = user_dir / "meta.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
            sd_port = meta.get("sessiond_port")
            if sd_port:
                result = subprocess.run(
                    ["fuser", "-k", f"{sd_port}/tcp"],
                    capture_output=True
                )
                print(f"[DELETE] killed sessiond on :{sd_port}: {result.stdout.decode().strip()}")
        except Exception as e:
            print(f"[DELETE] stop sessiond warning: {e}")

    # 1. 删除 nginx 路由配置
    nginx_conf = NGINX_USERS_DIR / f"{user_id}.conf"
    if nginx_conf.exists():
        nginx_conf.unlink()
        subprocess.run(["nginx", "-s", "reload"], capture_output=True)
        print(f"[DELETE] nginx route removed: {nginx_conf}")

    # 2. 删除 shortdrama profile
    profile = SHORTDRAMA_PROFILES_DIR / f"{user_id}.json"
    if profile.exists():
        profile.unlink()
        print(f"[DELETE] shortdrama profile removed: {profile}")

    # 3. 删除用户目录
    shutil.rmtree(user_dir)
    print(f"[DELETE] user directory removed: {user_dir}")

    return True, f"User {user_id} deleted"

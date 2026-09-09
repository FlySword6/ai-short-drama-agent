"""admin-service 对 shortdrama-cli 的 argv 回归测试。

固定 CLI（fe3019b）中 ``--env`` 是根 callback 选项（cli/app.py），只能出现在
子命令之前；wrapper 不得把 ``--env`` 拼到子命令之后（否则
``shortdrama-cli doctor --env dev --json`` 报 ``No such option: --env``）。
环境选择靠子进程继承的 ``SHORTDRAMA_ENV`` 环境变量完成。
"""
import subprocess
from unittest.mock import patch

import pytest


def _srv(monkeypatch, tmp_path, **envs):
    """加载 server 模块（带必需环境变量）。SHORTDRAMA_ENV 是模块级读取，须在导入前注入。"""
    import importlib.util
    import sys
    from pathlib import Path

    monkeypatch.setenv("PI_SYNC_TOKEN", "t")
    monkeypatch.setenv("PI_DATA_ROOT", str(tmp_path))
    for key, value in envs.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    admin_dir = str(Path(__file__).resolve().parents[1] / "services" / "admin-service")
    monkeypatch.syspath_prepend(admin_dir)
    spec = importlib.util.spec_from_file_location(
        "admin_srv_cli", str(Path(admin_dir) / "server.py")
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["admin_srv_cli"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_run_cli_never_appends_root_env_option_after_subcommand(monkeypatch, tmp_path):
    """配置 SHORTDRAMA_ENV 时，argv 里不得出现 --env；环境经进程环境继承。"""
    srv = _srv(monkeypatch, tmp_path, SHORTDRAMA_ENV="dev")

    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["env"] = kwargs["env"]
        return subprocess.CompletedProcess(cmd, 0, stdout="{}", stderr="")

    with patch.object(srv.subprocess, "run", side_effect=fake_run):
        srv._run_cli("tenant-a", ["auth", "status"])

    argv = captured["cmd"]
    assert "--env" not in argv  # 根 callback 选项放到子命令后会直接被 CLI 拒绝
    # 子命令与 --json 的相对顺序固定：[cli, auth, status, --json]
    assert argv == [srv.SHORTDRAMA_CLI, "auth", "status", "--json"]
    # 环境选择改由子进程环境继承（CLI 优先级 --env > SHORTDRAMA_ENV > sticky > prod）
    assert captured["env"]["SHORTDRAMA_ENV"] == "dev"
    assert captured["env"]["HOME"].endswith("tenant-a")


def test_run_cli_argv_stable_without_env(monkeypatch, tmp_path):
    """未配置 SHORTDRAMA_ENV 时 argv 保持 [cli, *args, --json]，不注入多余 flag。"""
    srv = _srv(monkeypatch, tmp_path, SHORTDRAMA_ENV=None)

    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout="{}", stderr="")

    with patch.object(srv.subprocess, "run", side_effect=fake_run):
        srv._run_cli("tenant-a", ["doctor"])

    assert captured["cmd"] == [srv.SHORTDRAMA_CLI, "doctor", "--json"]

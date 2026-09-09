import urllib.error
import urllib.request
from unittest.mock import patch

import pytest


def _srv(monkeypatch):
    """加载 server 模块（带必需环境变量）。"""
    import importlib.util
    import sys
    from pathlib import Path

    monkeypatch.setenv("PI_SYNC_TOKEN", "t")
    admin_dir = str(Path(__file__).resolve().parents[1] / "services" / "admin-service")
    monkeypatch.syspath_prepend(admin_dir)
    spec = importlib.util.spec_from_file_location(
        "admin_srv", str(Path(admin_dir) / "server.py")
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["admin_srv"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_download_opener_refuses_redirects(monkeypatch):
    srv = _srv(monkeypatch)
    # opener 级：302 一律 HTTPError，绝不跟随 Location
    class R(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    no_redir = urllib.request.build_opener(R)
    # 自定义拒绝重定向 handler 已替换默认 HTTPRedirectHandler
    assert any(isinstance(h, R) for h in no_redir.handlers)
    # _NoRedirect.redirect_request 返回 None = 拒绝
    handler = srv._NoRedirect()
    assert (
        handler.redirect_request(None, None, 302, "Found", {"Location": "http://evil"}, "http://evil")
        is None
    )


def test_download_task_outputs_skips_non_whitelisted(monkeypatch, tmp_path):
    # DATA_ROOT 在模块加载时从 env 读取，须在 _srv 之前指向临时目录，
    # 避免真实 mkdir 默认 /var/lib/pi-http-wrapper（非 root / CI 无写权限）。
    monkeypatch.setenv("PI_DATA_ROOT", str(tmp_path))
    srv = _srv(monkeypatch)
    event = {
        "type": "tool_result",
        "content": '{"url": "https://evil.example.com/x.jpg"}',
        "_session_key": "agent-a/u1",
    }
    with patch.object(srv.urllib.request, "urlopen") as up:
        srv._download_task_outputs(event)
    up.assert_not_called()  # 白名单为空 → 任何主机都被拒

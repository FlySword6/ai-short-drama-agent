#!/usr/bin/env python3
import http.client
import http.server
import os
import socketserver
import urllib.parse

# IP 白名单：默认仅本地回环，额外来源通过 PROXY_ALLOWED_IPS（逗号分隔）显式注入。
_DEFAULT_ALLOWED = {"127.0.0.1", "::1"}
ALLOWED = _DEFAULT_ALLOWED | {
    ip.strip() for ip in os.environ.get("PROXY_ALLOWED_IPS", "").split(",") if ip.strip()
}
DROP = {"connection", "keep-alive", "transfer-encoding", "content-length", "upgrade"}

# 短剧 API 后端地址：用于派生响应体替换对，与 shortdrama-api 真实端口保持一致。
# 默认 http://127.0.0.1:8000（对应 config.py 的 PORT=8000）。
_API_BACKEND = os.environ.get("PROXY_API_BACKEND", "http://127.0.0.1:8000")
_API_BACKEND_VARIANTS = (_API_BACKEND, _API_BACKEND.replace("127.0.0.1", "localhost"))

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def run_proxy(self):
        client_ip = self.client_address[0]
        if client_ip not in ALLOWED:
            data = ("Forbidden client=" + client_ip).encode()
            self.send_response(403)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True
            return

        if self.path == "/__proxy_health":
            data = b"ok"
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        parsed = urllib.parse.urlsplit(self.path)
        api = parsed.path == "/api" or parsed.path.startswith("/api/")
        pi_agent = parsed.path == "/pi" or parsed.path.startswith("/pi/")
        if pi_agent:
            port = 8080
            path = parsed.path[3:]  # strip /pi prefix
        elif api:
            port = 8000
            path = parsed.path[4:]  # strip /api prefix
        else:
            port = 5500
            path = parsed.path
        
        path = path or "/"
        if parsed.query:
            path = path + "?" + parsed.query

        size = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(size) if size else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in DROP and k.lower() != "host"}
        headers["Host"] = "127.0.0.1:" + str(port)
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
        try:
            conn.request(self.command, path, body, headers)
            res = conn.getresponse()
            data = res.read()
            ctype = res.getheader("Content-Type", "")
            if not api and ("text/" in ctype or "javascript" in ctype or "json" in ctype):
                for old in (_API_BACKEND.encode(), _API_BACKEND_VARIANTS[1].encode()):
                    data = data.replace(old, b"/api")
            self.send_response(res.status)
            for key, value in res.getheaders():
                if key.lower() not in DROP:
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
        except Exception as exc:
            data = ("Bad Gateway: " + str(exc)).encode()
            self.send_response(502)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        finally:
            conn.close()
            self.close_connection = True

    do_GET = run_proxy
    do_HEAD = run_proxy
    do_POST = run_proxy
    do_PUT = run_proxy
    do_PATCH = run_proxy
    do_DELETE = run_proxy
    do_OPTIONS = run_proxy

Server(("0.0.0.0", 80), Handler).serve_forever()

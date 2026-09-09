# Pi HTTP Wrapper

短剧平台的 Pi runtime HTTP 适配器。原始实现已只读收编到 `upstream/original/`；当前适配层
把主仓提供的系统提示词、工具 schema、工具结果和 allowlist skills 接入 Pi 0.80.7 RPC。

关键边界：

- 主仓 PostgreSQL 是对话历史真源，wrapper 一轮结束后销毁 `--no-session` 进程；
- 主流程工具由 wrapper 通过 commit 固定的 `shortdrama-cli` HTTP client 直连 Main；
  后端地址只来自 CLI 内置的受信端点清单（`server_api/endpoints`），wrapper 不复制清单；
  其他外部工具仍暂停 Pi、返回稳定 `toolCallId`、等待对应 `toolResult`；
- wrapper 只导入 CLI 的 `server_api.client`、`api.errors` 与受信端点解析，不导入 Typer 命令层；
- Main 凭据来源由签发路由固化；`X-Shortdrama-Client` 不作为 Agent 身份真源；
- sync 返回 `completed|requires_tool`；SSE 只发稳定事件，不透传 Pi 内部事件；
- 用量或成本未知时明确返回 `null`，不会伪装为 0；
- 多 Bearer token、独立内部回调 token、无明文 token 审计；禁止 `.api_key`；
- skill 只来自 `~/.agents/skills` 和 `~/.workbuddy/skills` 两个 allowlist 根目录；
- systemd 以非 root 用户运行，部署脚本默认 dry-run。

完整协议见 `../docs/contracts/v0.1.1/pi-http-wrapper-takeover.md`。

## 本地检查

```bash
cd pi-http-wrapper
python3.12 -m venv .venv
.venv/bin/pip install -e '.[test]'
.venv/bin/python -m unittest discover -s tests -v
```

这些测试不会调用模型、远程系统或付费能力。

## 本地启动

先通过环境或受管 secret 注入：

```bash
export PI_WRAPPER_BEARER_TOKENS='token-a,token-b'
export PI_WRAPPER_INTERNAL_TOKEN='different-local-callback-token'
export SHORTDRAMA_ENV='dev'   # 受信环境名：prod/test/dev，不接受 URL
export SHORTDRAMA_AGENT_TOKEN='injected-agent-credential'
pi-http-wrapper
```

默认监听 `127.0.0.1:8787`。跨主机部署只允许在受控私网配置监听地址。
`SHORTDRAMA_ENV` 与 `SHORTDRAMA_AGENT_TOKEN` 必须同时配置；环境名只接受
shortdrama-cli 受信清单中的 `prod`/`test`/`dev`，未知环境或 URL 会在启动时
直接失败。旧的 `SHORTDRAMA_API_BASE`（任意 URL）已移除，配置它会在启动时报错。
token 值只从环境或受管 secret 注入，不能写入仓库。每个新凭据先调用
`shortdrama_capabilities`。

## systemd

```bash
./deploy/install-systemd.sh            # 只显示计划
sudo ./deploy/install-systemd.sh --apply
```

`--apply` 只安装并 enable，不自动启动。先由 KMS/受管 secret 写入
`/etc/shortdrama/pi-http-wrapper.env`，再人工启动。回滚说明在协议文档中。

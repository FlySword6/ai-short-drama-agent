# Issue #3 回执：pi-http-wrapper shortdrama-cli commit pin 升级

状态：`tests_passed_pending_operator_commit`

日期：2026-08-19（R3 续作；以受控提交 `0468d86019b78841d4af7a7ca9d2764ba4803615`
为续作基线，被取消任务不予恢复）

Issue：https://github.com/col-shortdrama/zhongwen-shortdrama-agent/issues/3

基线：`0468d86019b78841d4af7a7ca9d2764ba4803615`（分支
`devbox/issue-3-cli-pin-r3`，即 R2 「Cli pin r2 (#3)」合入后的状态）

## 变更内容

- `pi-http-wrapper/pyproject.toml`
  - `shortdrama-cli` git pin：`0746878712c167c8f57aa8ff2e37adc35f9037ed` →
    `fe3019b1c5e1431b4b9fb6fe327e569ad2aba6fb`（开工时 CLI `main` HEAD，
    2026-08-18T20:24:13+08 提交，「Project inventory (#16) (#68)」）。
- `pi-http-wrapper/src/pi_http_wrapper/main_chain.py`：`CLI_CLIENT_COMMIT` 同步升至新 SHA。
- `pi-http-wrapper/tests/test_main_chain.py`：pin 断言同步升至新 SHA。
- `pi-http-wrapper/uv.lock`：就地再生成（`uv lock`），`shortdrama-cli` 条目 rev
  由 `0746878…` 变为 `fe3019b1c5e1431b4b9fb6fe327e569ad2aba6fb`，其余 35 个包
  版本与约束均未变（锁文件已在 R2 入库并由 `pi-http-wrapper/.gitignore` 的
  `!uv.lock` 显式保留）。

未复制 CLI 源码；wrapper 仍只通过包依赖消费 `shortdrama_cli` 接口层。

## 验证

- 干净任务 worktree（应用本次改动后）：
  - `uv sync --frozen --extra test` → exit 0（自锁文件重建 `.venv`，从新 pin
    构建安装 `shortdrama-cli`）。
  - `python3 -m pytest pi-http-wrapper/tests/ -q` → **39 passed, 0 skipped, exit 0**
    （仅 1 条与本改动无关的 starlette/httpx 弃用 warning）。
- 拆包后导入闭包（`pi_http_wrapper.app` 加载后的 `sys.modules`）：
  `shortdrama_cli`、`api`、`api.client`、`api.errors`、`api.tls`、`i18n`、
  `server_api`、`server_api.client` —— 无 `shortdrama_cli.cli` /
  `shortdrama_cli.main`（Typer 命令层），即「只用接口层」成立。
- 拆包出处：`shortdrama_cli-0.3.1.dist-info/direct_url.json` 的 `commit_id`
  等于 `fe3019b1c5e1431b4b9fb6fe327e569ad2aba6fb`，与新 pin 一致。

## 环境说明（known risks 见报告）

- devbox 无 GitHub 拉取凭据（`gh` 未登录、无跨仓 token），安装/锁定通过本机
  root 维护的只读镜像 `/srv/agent-data/repos/zhongwen-shortdrama-cli`
  （worker 级 `url.insteadOf` 重写；锁定前已核验该镜像 `origin/main` 即
  `fe3019b1c5e1431b4b9fb6fe327e569ad2aba6fb`）。CI
  （`.github/workflows/pr-tests.yml`）走 `CLI_REPO_READ_TOKEN`，不受影响。

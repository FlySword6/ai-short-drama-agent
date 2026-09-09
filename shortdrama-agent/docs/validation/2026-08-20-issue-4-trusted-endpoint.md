# Issue #4 回执：pi-http-wrapper 后端地址改为 shortdrama-cli 受信环境名

状态：`tests_passed_pending_operator_commit`

日期：2026-08-20

Issue：https://github.com/col-shortdrama/zhongwen-shortdrama-agent/issues/4

基线：`2798fad6fcbb37823e3ec452d8d64e161a40badc`（分支 `dev`，已含 Issue #3 的
CLI pin `fe3019b1c5e1431b4b9fb6fe327e569ad2aba6fb`）

以 Issue 最新评论为事实口径：旧「缺 `/v1` 静默失败」在当前 pin 下已不可复现
（`BusinessServerClient` 在站点根后固定拼接 `/api/v1`），未为其制造假红；
本回执只处理真实缺口——wrapper 曾接受任意 `SHORTDRAMA_API_BASE` URL。

## 变更内容

- `pi-http-wrapper/src/pi_http_wrapper/trusted_endpoint.py`（新增）
  - 直接复用 `shortdrama_cli.server_api.endpoints` 的 `TRUSTED_ENDPOINTS` /
    `resolve_endpoint` / `DEFAULT_ENVIRONMENT`（成员判定完全委托 CLI 真源，
    wrapper 内不复制清单、不硬编码任何后端 URL）。
  - 未知环境名与 URL 形输入 fail closed，报中文可操作错误（指向
    `SHORTDRAMA_ENV` 与受信环境名，不复述 CLI 的 `auth login` 登录提示）。
  - 明文 HTTP 警告使用 CLI `endpoint.plaintext_warning` 文案，每进程每环境
    只向 stderr 发一次（CLI Typer 层的逐次警告路径 wrapper 从不经过，故不重复）。
- `pi-http-wrapper/src/pi_http_wrapper/config.py`
  - 外部配置由 `SHORTDRAMA_API_BASE`（任意 URL）改为 `SHORTDRAMA_ENV`
    （prod/test/dev，与 CLI 当前口径一致）；启动时经 `resolve_trusted_environment`
    校验，未知环境/URL 直接抛 `ConfigurationError`。
  - 残留 `SHORTDRAMA_API_BASE` 一律启动报错，不留兼容双轨。
- `pi-http-wrapper/src/pi_http_wrapper/main_chain.py`
  - `MainChainAdapter.from_credentials(api_base, …)` 删除，改为
    `for_environment(environment, agent_token)`；`build_main_chain_adapter`
    同步改为环境名入参。adapter 的 CLI 导入仍只有 `server_api.client` 与
    `api.errors`（受信端点解析放在 `trusted_endpoint` 模块），
    `scripts/validate_agent_resources.py` 对 adapter 的导入约束不变。
- `pi-http-wrapper/src/pi_http_wrapper/app.py`：装配改用
  `settings.main_environment` / `settings.main_agent_token`。
- `pi-http-wrapper/tools/run-main-chain-read-e2e.py`：目标改由
  `SHORTDRAMA_ENV`（缺省 `dev`）经受信清单解析；报告字段新增 `environment`，
  `target` 改为解析结果而非外部输入。
- `pi-http-wrapper/services/admin-service/server.py`：`--api-base "$SHORTDRAMA_API_BASE"`
  注入改为 `--env "$SHORTDRAMA_ENV"`（pin 后的 CLI 只接受环境名）；
  残留 `SHORTDRAMA_API_BASE` 或 URL 形 `SHORTDRAMA_ENV` 启动即失败。
- `pi-http-wrapper/deploy/pi-http-wrapper.env.example`、`pi-http-wrapper/README.md`：
  配置示例与说明改为 `SHORTDRAMA_ENV` + `SHORTDRAMA_AGENT_TOKEN`。
- `pi-http-wrapper/resources/shortdrama-cli-skill/`（SKILL.md、commands/、
  examples/、references/capability-matrix.md）：删除全部
  `--api-base "$SHORTDRAMA_API_BASE"` 参数（pin 后的 CLI 无此 flag），
  地址说明改为受信端点清单 + `--env`/`SHORTDRAMA_ENV` 口径。
- `pi-http-wrapper/tests/test_trusted_endpoint.py`（新增）：覆盖
  受信环境解析、未知/URL 拒绝、明文警告只发一次、`SHORTDRAMA_API_BASE`
  旧路径拒绝、环境名与 token 配对、adapter 只接受环境名。

## 验证

- 干净任务 worktree（应用本次改动后）：
  - `cd pi-http-wrapper && uv sync --frozen --extra test &&
    uv run --frozen --extra test python -m pytest tests/ -q` →
    **58 passed, 0 skipped, exit 0**（基线 39 passed；新增 19 个用例；
    仅 1 条与本改动无关的 starlette/httpx 弃用 warning）。
- 启动 fail-closed 冒烟（`create_app()` 直接构造）：
  - `SHORTDRAMA_ENV=staging` → `ConfigurationError: 未知环境：staging。…`；
  - `SHORTDRAMA_ENV=http://10.0.0.1:8000` → `ConfigurationError: SHORTDRAMA_ENV 不接受 URL…`；
  - `SHORTDRAMA_API_BASE=…` → `ConfigurationError: SHORTDRAMA_API_BASE 已不再支持…`；
  - `SHORTDRAMA_ENV=dev`（配 token）→ 应用创建成功，stderr 仅一次
    CLI 文案明文 HTTP 警告。
- 端点真源唯一性：`trusted_endpoint.TRUSTED_ENDPOINTS is
  shortdrama_cli.server_api.endpoints.TRUSTED_ENDPOINTS`（同一对象，非拷贝）；
  wrapper 源码无任何硬编码后端 URL。

## 环境说明（known risks 见报告）

- `scripts/validate_agent_resources.py` 在未改动基线上即以
  「pyproject must pin shortdrama-cli to the approved commit」失败
  （脚本内置 `98d217c…` 与基线 pin `fe3019b…` 漂移）；该脚本位于本任务
  允许修改路径之外，未触碰。本回执以脚本内的 AST 约束函数对改动后的
  adapter 做了等价校验：CLI 导入恰为 `server_api.client` + `api.errors`、
  无 Typer 命令层、工具注册表与期望集合一致。

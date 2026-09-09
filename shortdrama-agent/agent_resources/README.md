# V0.3.0 Agent Pi 资源包

这是短剧 Agent 免费主流程的离线可验证资源包。生产调用只允许 Main `/api/v1`；本目录不含生产业务事实或密钥。运行 `python3 scripts/validate_agent_resources.py` 与 `python3 scripts/check_no_second_runtime.py` 验证资源合同和旧研究运行时的显式 opt-in 门禁。

运行时使用 commit 固定在 `98d217c0ad08bd3728a4a67082908c3523f5b83c` 的
`shortdrama-cli` 包，只导入 `shortdrama_cli.server_api.client` 与
`shortdrama_cli.api.errors`。Pi 工具层不导入 Typer 命令层，也不保存第二份
HTTP client。

免费主流程包括：

- Agent 凭据注入与 capabilities 预检；
- 项目、集、场、镜头只读导航；
- 剧本粘贴、拆解与恢复候选；
- 资产检索、个人域候选登记、拉入项目备料。

确认转正、审核、设主版本和付费提交仍由人类显式操作。名称只有一个精确匹配时
才会解析；零匹配或同名都要求调用方提供明确 ID。Main 未返回的 receipt 字段保持
`unknown`。

研究代码仍保留，但启动 AgentKit、A2A 或 Uvicorn 前必须设置：

```bash
export SHORTDRAMA_RESEARCH_RUNTIME=DEV
export SHORTDRAMA_RESEARCH_OPT_IN=1
```

这不是生产入口，也不能代替 Main 的权限、费用和 receipt 执行。

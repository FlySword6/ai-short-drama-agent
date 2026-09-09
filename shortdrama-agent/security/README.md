# Agent 仓库 Security Action

本目录是 **Agent 仓库自己的独立 CI Security Action**。CLI 仓库另有自己的
workflow、扫描器、baseline 和发布门禁；两套 Action 共享安全原则，但不跨仓运行
同一份脚本。

这是 Agent 仓库第一批可执行安全门禁，不是生产授权系统本身。它在 PR、受保护分支
和定时任务中阻止仓库风险继续增加；身份、项目权限、Quote/Confirm/Submit、额度与
云调用授权仍必须由平台后端实现。

## 检查组成

- `repository_guard.py`：扫描 Git 受跟踪文件，检查秘密、真实运行配置、Agent 直连 Ark/TOS、动态鉴权 URL、自动批准、旧 A2A/test-agent 暴露、危险 Python 模式、依赖声明、Docker 基础镜像和 GitHub Actions。常见私钥/证书文件名即使不是普通文本后缀，也会按高风险文件处理。生产目录和 `test-agent` 中只有明确位于 `tests/` 目录的 Python 测试会跳过生产代码规则，不能通过把业务文件命名为 `test_*.py` 绕过。
- `dependency_audit.py`：递归发现所有 `requirements*.txt` / `requirements*.lock`、
  PEP 621 `pyproject.toml` 和当前仓库使用的 `uv.lock`。它按实际审计输入去重，对
  `pyproject.toml` 的核心及可选依赖生成临时 requirements，对 `uv.lock` 审计精确
  锁定的 registry 包，并为每组运行固定版本 `pip-audit`、生成 CycloneDX JSON。
  单组默认最多等待 180 秒，超时会明确失败，CI 将报告保留 14 天供复核。
- `dependency-inventory.json`：每次依赖审计生成的无依赖原文清单，记录发现的文件、
  类型、数量、内容摘要、审计分组和阻断原因。动态依赖、非 PEP 621 布局、不能安全
  转换的本地/VCS lock 来源，以及尚未支持的 Poetry/PDM/Pipfile/PEP 751 lock 会
  fail closed；不会临时下载导出器，也不会因为别处已有 `requirements.txt` 而跳过
  pyproject-only 或嵌套服务。

  **跨仓依赖例外**：`pyproject.toml` 中形如 `name @ git+https://…@<完整 40 位
  commit SHA>` 的依赖（以及 `uv.lock` 中 `?rev=<40 位 SHA>` 的 git 源）是可复
  现、可审计的跨仓引用：登记进 inventory（`vcs_pinned`），不送 pip-audit，也
  不算违规；未钉完整 SHA 的 VCS/URL/file 来源仍然 fail closed。
- `legacy-baseline.json`：只记录本次落地前已经存在的架构/依赖债务。秘密、真实 `agentkit.yaml`、私钥、远程依赖和危险工作流永远不能进入 baseline。
- `tests/`：只使用合成数据，不访问网络、不加载云凭据。

扫描器只输出规则、文件、行号和来源，不输出匹配内容，避免扫描日志再次泄露秘密。
候选文本必须可读取、是无 NUL 的 UTF-8，且单文件不超过 2 MiB；当前快照或 Git
历史中不满足这些条件的候选文本会触发不可豁免错误，不会因为解码失败或体积过大
被静默跳过。

GitHub Actions 检查同时覆盖 block/flow 两种 `uses` 写法、每一个 checkout 步骤自身
的 `with.persist-credentials: false`、PR 的点号/方括号 Secret 引用，以及 workflow
write 权限。Docker `FROM` 必须使用完整 64 位 sha256 digest；已固定的前置构建阶段
别名和 `scratch` 除外。

## 当前 baseline 与生产边界

`legacy-baseline.json` 当前候选稿只登记 **40 项**落地前已经存在的供应链迁移债务：
28 项未锁定依赖、5 项缺少锁文件和 7 项未固定 Docker 基础镜像。它的负责人是
`agent-repository-maintainers`，到期日为 2026-09-30。该文件尚未暂存/提交，也不
代表安全负责人已经批准；正式采用前必须逐项复核。

云凭据、直连 Ark/TOS、自动批准、任意 Hub、旧 A2A/test harness、动态 URL 请求和
敏感日志等生产边界风险都已改为不可豁免。当前已先关闭两个 test-agent 入口的通配
CORS、调试路由和默认公网绑定 6 项风险，但仍有 **72 项生产边界风险**及 2 项已跟踪
运行配置风险不可豁免。因此当前快照的 Guard 会报告 74 项 active finding 并返回失败。
这是正确的 P0 收口状态：门禁不会因为把问题写进 baseline 而错误放行。

未来普通仓库 Action 变绿，只表示：

- 没有新增或改变这些精确指纹之外的同类风险；
- 没有新增秘密、真实运行配置、私钥、远程依赖或危险 workflow 等不可豁免问题；
- baseline 本身仍有效，且没有已经修复却未删除的过期条目。

它不表示 40 项供应链债务已经修复，也不表示 Agent 可以生产部署。生产阻断类别不在
baseline 中，必须逐项整改；实际部署入口还必须接入对这些规则零豁免的 strict deploy
gate。在 72 项生产边界风险及已跟踪运行配置风险清零之前，真实 Agent 生产部署、真实
付费 Provider 以及 Ark/TOS 调用必须保持关闭。即使未来普通 PR Action 通过，也不能
把它当作运行时授权或生产放行证明。

## GitHub 正式启用前置条件

本地存在 workflow 和扫描器文件不等于门禁已经启用。仓库负责人还必须在 GitHub
完成以下外部配置：

1. 明确指定真实存在的安全团队或安全负责人，对
   `.github/workflows/security.yml`、`security/repository_guard.py`、
   `security/dependency_audit.py`、`security/legacy-baseline.json` 和
   `security/tests/` 拥有必需审批权。
2. 通过 CODEOWNERS、Ruleset 或组织批准的等价机制，保证仓库作者不能在同一个
   未经安全评审的 PR 中同时修改门禁、放宽 baseline 并合入业务代码。Action 会从
   PR base commit 提取受信 baseline，并通过 `--baseline-base` 机械拒绝新增、替换
   条目或重置其负责人与期限；只能删除旧条目。首次安装时 base commit 尚无
   baseline，属于唯一 bootstrap 情况，必须由安全负责人完整评审后才能合入。
3. 保护 `main`、`dev` 和实际部署入口使用的分支、Tag 或 workflow，并把适用的
   repository policy、依赖审计、SAST 和变更历史秘密扫描设为 required checks；
   禁止未经批准绕过。
4. 如果以后新增部署 workflow，必须让它依赖零豁免的生产门禁，不能只依赖允许
   legacy baseline 的普通 PR Action。

当前设计不知道组织中真实的 GitHub team slug，因此不会猜测并生成一个可能无效的
CODEOWNERS 条目。团队身份、required check 绑定和绕过权限必须由仓库/组织管理员
配置并提供生效证据。

## 本地运行

在 Agent 仓库根目录运行：

```powershell
python -m unittest discover -s security/tests -v
python security/repository_guard.py --root . --baseline security/legacy-baseline.json
```

第二条命令对当前未解决、不可豁免问题返回非零退出码。这是门禁的预期行为。

本地命令读取的是“受 Git 跟踪文件在当前工作目录中的内容”，不是暂存区快照，也不会检查尚未纳入 Git 的普通业务文件；提交前仍应先确认 `git status`。GitHub Action 在检出的提交快照上运行，因此 PR 门禁检查的是准备进入仓库的版本。

安装固定版本的审计工具后，可运行依赖漏洞检查：

```powershell
python -m pip install pip-audit==2.10.1
python security/dependency_audit.py --root . --report-dir .security-reports
```

`.security-reports` 只用于本地临时结果，不应提交。
依赖审计需要事先安装 workflow 固定的 `pip-audit==2.10.1`；清单构建和单元测试仅
使用 Python 标准库，不联网。若出现 `lockfile_exporter_not_supported` 等清单错误，
必须先选择并评审确定的导出/解析方案，不能猜测依赖或静默跳过该项目。

定时/手工全历史秘密检查：

```powershell
python security/repository_guard.py --root . --history
```

PR 和受保护分支推送还会检查本次变更引入的 Git 历史范围；定时/手工任务扫描全部可达历史。历史扫描只报告规则、文件与提交来源，不输出匹配值。

## Baseline 迁移规则

Baseline 的目的只是让 CI 在供应链遗留改造期间阻止“新增或修改后的同类风险”，不是宣布旧代码安全：

1. 仅未锁定依赖、缺少锁文件和未固定 Docker 基础镜像这类供应链迁移债务可登记。每条记录绑定 `rule_id + path + 规范化证据` 的指纹；文件强制填写统一适用的负责角色、创建日、到期日、暂留原因和移除计划，且有效期最多 90 天。
2. 遗留代码删除或整文件内容变化后，CI 会报 `BASELINE_STALE`；同一个 PR 必须删除相应旧记录。PR 的当前 baseline 必须是 base commit baseline 的原样子集，不能用新指纹替换旧指纹，也不能重置元数据延长期限。
3. `--write-baseline --baseline-owner <负责角色> --baseline-expiry YYYY-MM-DD` 只供首次建档或安全负责人明确批准的迁移使用；到期 baseline 会直接失败。命令不会写入任何匹配文本，也不能隐藏不可豁免规则。
4. 禁止为了让 CI 变绿而把真实凭据路径、秘密规则或整个目录加入忽略列表。

新增架构例外必须经过安全负责人评审，并说明移除日期。凭据事故、当前真实运行配置和 Git 历史发现必须修复，不能走例外。

门禁规则升级后，如果既有整文件条目因加入内容摘要而同时出现新 finding 和
`BASELINE_STALE`，这是预期的安全迁移信号。安全负责人必须核对实际文件后建立新的
初始快照或直接整改；自动生成的候选只能帮助核对，不能作为批准证据。本次本地候选
仍需在暂存前完成这项评审。

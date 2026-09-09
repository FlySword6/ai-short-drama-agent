# CLI Security Gate

这是一条仓库与发布安全门禁：它检查提交、依赖、工作流和发布制品。CLI 的后端目的地、
环境选择和会话隔离已由 [ADR-0001](../docs/adr/0001-trusted-endpoint-catalogue.md) 定义并
落地；本门禁负责防止这些运行时边界被重新放宽。

## 当前能阻止什么

- 新提交或新 PR 引入的 AK/SK、Token、私钥、硬编码秘密和敏感凭据文件；
- 重新引入密码或 Token 命令行参数，以及 `--api-base`、`--api-url` 等任意后端地址覆盖；
- 绕过受信端点清单的环境变量、直接数据库或云 Provider 依赖、未批准的明文 HTTP 地址；
- 未脱敏输出、明文凭据或会话存储，以及危险的 Skill 指令；
- 未固定到完整提交 SHA 的 GitHub Action、危险 workflow 权限、持久化 checkout 凭据和
  fail-open 写法；
- 依赖漏洞、高置信度 Python SAST 问题，以及未压缩发布目录中的秘密或敏感文件；
- 未经全仓严格扫描、可达历史秘密扫描、依赖审计和 SAST 的 Release。

## 为什么 PR 先使用“改动文件”扫描

仓库仍可能有待整改的旧发现。它们不能被加入 baseline，也不能被声明为已修复；但如果
第一批门禁立即对全部旧文件阻断，门禁本身无法落地。

因此过渡期内，`.github/workflows/security.yml` 的 `Repository policy` 只扫描相对目标
提交新增或修改的文件：旧文件本身不会让该 PR 失败，但任何人改动这些文件时带入或保留的
危险模式都会失败。`security-baseline.json` 保持为空，不能用豁免覆盖生产阻断。Release
始终运行全仓 `repository --strict`，旧风险仍会阻止发布。

## 本地命令

```sh
# 扫描当前全部工作树（用于整改和 Release）
uv run python scripts/security_action.py repository --root . --strict

# 扫描一个 PR/提交范围改动过的文件（普通 PR 门禁）
uv run python scripts/security_action.py repository --root . --changed-since BASE_SHA..HEAD_SHA

# 扫描本次历史范围；不打印匹配值
uv run python scripts/security_action.py repository --root . --history-range BASE_SHA..HEAD_SHA

# 发布目录零豁免扫描
uv run python scripts/security_action.py artifacts dist/app/shortdrama-cli

# 扫描器自身测试
make security-test
```

## 自动执行的位置

- `.github/workflows/security.yml`：PR/push 执行改动文件门禁、完整测试、Ubuntu/macOS
  扫描器测试、依赖漏洞审计/SBOM、SAST 和本次提交范围的历史密钥扫描；定时或手工触发
  可达全历史秘密扫描。
- `.github/workflows/release.yml`：`stage` 创建 draft Release 后，`security-gate` 执行
  全仓严格扫描、可达全历史秘密扫描、依赖审计和 SAST；build job 在 smoke 后扫描未压缩
  app 目录。`publish` 同时依赖既有 `release-gate` 和 `security-gate`。

工作流默认只读仓库；门禁新增的外部 Action 固定到 40 位 commit SHA，checkout 不保留 Git
凭据。`stage` 与 `publish` 都持有 `contents: write`：前者用于产物暂存；后者仅在
`release-gate` 与 `security-gate` 双门禁通过后运行并发布。

## baseline 与历史扫描

`.security/security-baseline.json` 当前是空基线。秘密、私钥、敏感文件、制品发现和所有生产
阻断规则永远不能进入 baseline。将来确有非生产供应链迁移债务时，每一项都必须有负责人、
原因、移除计划和不超过 90 天的到期日。

已知的历史密钥候选必须由具备权限的维护方脱敏核验、必要时轮换/撤销并安排历史清理；不能
通过 baseline 或忽略路径让全历史扫描变绿。

## 门禁不代替的平台控制

本 Action 不代替平台后端的身份、项目权限、报价确认、额度、Gateway、TOS 私有访问或云
出口控制。真实 Ark/TOS 与付费生成仍须由平台的凭据、权限和确认链路控制。

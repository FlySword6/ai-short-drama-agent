# ADR 0002：v0.3.0 发布快照与 `main` 的提交处置

状态：已形成处置结论，等待 PR #70 独立复核与合并

关联工作项：[Issue #31](https://github.com/col-shortdrama/zhongwen-shortdrama-cli/issues/31)

交付 PR：[PR #70](https://github.com/col-shortdrama/zhongwen-shortdrama-cli/pull/70)

## 背景与核验方法

Issue #31 记录了 `v0.3.0` 发布快照与 `main` 分叉的问题。以本次接手时的远端
`main` 锚点 `fe3019b1c5e1431b4b9fb6fe327e569ad2aba6fb` 为基线，执行：

```bash
git log --right-only --reverse --format='%H %s' origin/main...v0.3.0^{}
git cherry origin/main v0.3.0^{}
```

确认 `v0.3.0^{}` 一侧仍有四个 patch 未按原提交进入 `main`。这不意味着应直接
cherry-pick：发布后主干的命令面、受信端点、Skill 和 CI 已继续演进，必须逐项判断
其意图是否仍有效，并以当前合同为准适配。

## 逐项处置

### 1. `cf400a9bdd4c08a9a600654adf2b1d584616db5c`

主题：清理八个退役 Makefile target，并增加工具链契约。

结论：**回流，但按当前主干适配，不直接 cherry-pick。**

- PR #70 的初始锚点 `ae8180cbbff4bfd985581dd7fcabcbd8c3b9e87f` 已移除相同的
  六个退役变量和八个退役 target，并用 `tests/test_makefile_contract.py` 固定现役
  `test`、`security-test` 与发行构建入口。
- 原提交附带的 `doctor API_BASE=...` 会重新开放任意 API URL，与现役受信端点清单
  冲突；旧 `ci.yml`/`actionlint` 入口也已被当前 PR Tests 和 CLI Security 工作流取代，
  因此不回放这些历史实现。
- 当前 Makefile 的 CA bundle 和安全测试入口晚于 v0.3.0，必须保留，不能用历史文件覆盖。

### 2. `8e777e77e3457db4129cb5131bec0e7299d1e442`

主题：修复 Release 表达式，并建立日常 CI。

结论：**意图已由主干后继提交回流，不再 cherry-pick。**

- `c524979` 已把 Release 的 job 级非法 `env` 引用改为可解析表达式。
- `ae7ae44` 已建立 PR Tests；`e2b4630` 与 `af9a14e` 又补上 push/PR 安全、完整测试、
  依赖审计和 SAST。现役工作流覆盖面大于历史 `.github/workflows/ci.yml`。
- 直接恢复旧 `ci.yml` 会重复执行完整测试，并重新引入已废弃的 Python 矩阵和未固定的
  Action 引用，因此没有回流价值。

### 3. `6ac4c9926b374b90c8b984a68747b39e2f56854e`

主题：稳定彩色输出测试，并把 Python 下限改为 3.11。

结论：**分项适配回流。**

- 彩色输出问题已由主干提交 `baf348e`、`624ff77` 在断言层处理；当前 CI 持续通过，
  不再复制历史的全局环境变量 fixture。
- Python 下限仍是有效缺口：`AGENTS.md` 明确要求 Python 3.11+，现役 E2E 脚本直接
  导入 Python 3.11 才提供的 `datetime.UTC`，但 `pyproject.toml` 和 `uv.lock` 仍声明
  `>=3.10`。PR #70 将两者统一为 `>=3.11`。
- 历史提交携带的旧版 `uv.lock` 和已删除的 `ci.yml` 不回放；只同步现役锁文件的
  Python 合同头，并由当前 `uv lock --check --offline` 校验依赖图一致性。

### 4. `988bd34573a3594d356c695104e3b963b5dcf869`

主题：Skill 元数据、轮询策略、原子脚本和幂等下载。

结论：**不回流。**

- 主干已转为受信环境选择，禁止通过 `SHORTDRAMA_API_BASE` 或 `--api-base` 注入任意
  URL；历史 frontmatter 和脚本仍暴露这条旧路径。
- 历史 `poll_status.py` 调用 `queue status --task-id`，现役冻结命令要求
  `--generation-id`；原子脚本不是当前命令合同的可靠入口。
- 主干后继提交 `184d04c`、`d1a327e`、`8ca8940`、`86a8445`、`3575ca9` 已把受信端点、
  参考控制包、抽卡工作台、资产版本和镜头/集状态写入现役 Skill 与领域文档。
- 付费分步、禁止编造和人工裁决等仍有效规则已经存在于当前 `SKILL.md`；恢复旧脚本只会
  复制规则并引入失效参数。

## 最终关系

`v0.3.0` 保持为不可变历史发布快照；`main` 不整体合并该发版分支，而是通过 Issue #31
逐项吸收仍有效的意图：两项由后继提交完成，一项由 PR #70 适配补齐，一项因违反现役
合同明确不回流。

## 未跨越的门禁

- 本报告和 PR #70 的新提交仍需要独立验证者针对不可变 head SHA 复核。
- 本报告不构成 APPROVE、合并授权、发布授权或 Issue #31 关闭依据。
- 合并后应从远端读回 `main`，再由有权限的维护者更新正式 Project/Issue 状态。

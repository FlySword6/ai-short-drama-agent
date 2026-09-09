# legacy-merge-etl — 合流一期 ETL

把旧 common 库(they侧 NestJS/TypeORM)的存量数据按 `docs/contracts/common-to-v020-mapping.md`
§2–§5 迁入本仓 v0.2.0 目标表。**本包只提供工具与账簿;真实迁移窗口由 Fable 获批后执行。**

## 安全姿态(默认值即安全)

- **dry-run 默认**:`plan` 只写运行账/闭包账(`legacy_import_runs` / `legacy_import_closures`,
  mode='dry_run'),不写任何业务表、不写 crosswalk。`apply` 才写业务表。
- **绝不连云库**:未加 `--allow-remote` 时,源与目标连接串都必须是本机/本地 Compose
  (localhost / 127.0.0.1 / ::1 / db / postgres),否则直接拒绝。`--allow-remote` 是 Fable
  在获批窗口内读云库 common 的通道;目标库默认仍只许本机(演练打在本地副本)。
  唯一的例外是 R30 批准的 dev/test 环境导入:再显式加 `--allow-remote-target`
  (或 `LEGACY_ETL_ALLOW_REMOTE_TARGET=1`),双开关齐备才允许写非本机目标,
  plan/apply 与 rollback 同口径。
- **红线字段代码层隔离**:抽取列白名单见 `lib/redlines.mts`;任何抽取 SQL 执行前过
  `assertExtractionSafe`,命中密码 hash、会话 token、provider 原始响应、PII 超集列或
  红线表(凭据/生成历史/asset_media 等)即抛错。口令一律写不可解析哨兵
  `legacy-import:reset-required:v1`(过不了 scrypt 校验,用户必须走重置流程)。
- **人工确认门**:users/projects 只许 `manual_confirmed`——没有 `--decisions` 文件里的
  人工决定,一律进"候选",不自动合并、不自动新发。
- **带病不导**:asset_entities 支持 `--asset-quarantine` 人工指定隔离名单
  (`{"assets": {"<sourcePk>": {"reason": "...", "decidedBy": "..."}}}`)——归属抽查等
  人工审核发现带病行(如图片归属错配)时显式隔离,留 crosswalk 账与闭包账(needs_human),
  不自动修、不静默放过;引用它的 ref 连带隔离(守恒)。

## 用法

```bash
# 1. 计划(dry-run,默认姿态)
tsx scripts/legacy-merge-etl/cli.mts plan \
  --source-url postgresql://postgres:postgres@localhost:5432/legacy_common \
  --target-url postgresql://postgres:postgres@localhost:5432/shortdrama \
  --decisions decisions.json --started-by fable

# 2. 应用(获批窗口内;--import-owner 必需)
tsx scripts/legacy-merge-etl/cli.mts apply \
  --source-url ... --target-url ... --import-owner <uuid> \
  --decisions decisions.json --started-by fable

# 3. 全局核对(三桶报告 + 契约 §4 核对查询)
tsx scripts/legacy-merge-etl/cli.mts verify --target-url ... --run <runId>

# 4. 闭包粒度回滚(按 target_ids_json 反查删除,同事务删 crosswalk 行)
tsx scripts/legacy-merge-etl/cli.mts rollback --target-url ... --run <runId> --closure project:<sourcePk>
```

连接串也可走环境变量 `LEGACY_ETL_SOURCE_URL` / `LEGACY_ETL_TARGET_URL`;
`LEGACY_ETL_ALLOW_REMOTE=1` 等价于 `--allow-remote`,
`LEGACY_ETL_ALLOW_REMOTE_TARGET=1` 等价于 `--allow-remote-target`。

常用开关:`--domains user,project,asset,pricing_rule`(默认全部)、`--with-prompts`
(分镜提示词,默认关,契约 §2.7 决策待 DC)、`--compose-director-prompt`、
`--auto-create-episodes`、`--freeze-at`(取价冻结时刻,默认当前)。

## 人工决定文件(decisions.json)

users/projects 身份不自动合并。每个要迁入的源行必须有一条人工决定:

```json
{
  "users": {
    "<source users.id>": { "decision": "new", "decidedBy": "fable", "usernameOverride": "可选改名" }
  },
  "projects": {
    "<source projects.id>": { "decision": "new", "decidedBy": "fable", "nameOverride": "可选改名" }
  }
}
```

没有决定的行 → 闭包账记"候选"(candidate),apply 也不动它。

## 迁移单位与回滚

迁移单位是**实体闭包**而不是表:

- `user:<id>` — 用户行 + crosswalk;
- `project:<id>` — 项目行 + grants→成员 + refs + 被引用资产实体
  (+ 可选分镜/提示词),单事务同生共死。owner 成员行由目标库
  `sync_project_owner_membership` 触发器(016)随项目行自动写入,ETL 不手工重复插入;
- `asset:<id>` — 未被任何 active ref 引用的孤儿资产实体;
- `pricing_rule:<id>` — 单行取价规则(幂等键:provider/model/media_kind/billing_unit/effective_from)。

每个闭包的全部目标行 id 记在 `legacy_import_closures.target_ids_json`——这是回滚的唯一
依据。`rollback` 按 FK 安全顺序反查删除并同事务删 crosswalk 行,闭包状态转 `rolled_back`。
**跨闭包依赖注意**:项目闭包引用用户闭包迁入的用户;回滚用户前必须先回滚依赖它的项目
闭包,否则 FK 拒绝(回滚事务整体失败,无半态)。

## 三桶验收(verify)

- `identical` — 硬校验全过且无 quarantine/conflict/降级;
- `needs_human` — 硬校验全过但有 quarantine/conflict/降级项(逐条人工处置);
- `failed` — 守恒/孤儿/哨兵/价格复核任一硬校验不过。

守恒公式(契约 §4.D):每个闭包内 源行数 = new + matched + conflict + quarantined + 规则性跳过。
`verify` 另跑契约 §4 的全局核对 SQL(哨兵 100%、成员/引用/镜头无孤儿、每项目恰一个 owner、
价格复核 unit_price_fen = round(legacy 价 × 100)、账目隔离 R4、账本分离 R7)。

## 幂等

重跑安全:crosswalk 四元组(source_system, source_schema, source_table, source_pk)唯一,
已迁行直接跳过并复用 target_id;pricing 用 `WHERE NOT EXISTS` 业务键防重。dry-run 不产生
crosswalk,可与 apply 计划对账。

## 已知边界(施工前必读)

- 抽取列以 they 侧**实体定义**为准;`common-schema-v1.sql` 手工 DDL 与实体有出入
  (如 `projects.owner_team_id` 仅实体侧有)。若 live 库缺白名单列,plan 阶段直接报错——
  这是故意的 fail-fast,施工前用真实 live 跑一次 plan 即知。
- `asset_media` 暂缓(契约 §2.9,施工阻塞,待 live 画像 + DC 决策)。
- 分镜提示词默认不迁;`--with-prompts` 需 DC 批准后才开。
- fixed_fee≠0 的取价行一律隔离转人工(我方模型无"每调用平费")。

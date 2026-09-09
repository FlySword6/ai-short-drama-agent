# 演示数据集(金路径播种)

S22 产出的最小可用演示数据,S21 一键起本地环境时调用。

## 内容

| 对象 | 数量 | 说明 |
|---|---|---|
| users | 1 | `demo.admin`(role=admin,可登录) |
| projects | 1 | 「演示项目·金路径样例」(甜宠,active) |
| project_members | 1 | demo.admin 为 owner(016 触发器也会兜底) |
| episodes | 1 | 第 1 集 |
| scenes | 2 | 日·内·咖啡厅 / 夜·外·天台 |
| shots | 4 | 两条咖啡厅 + 两条天台,带剧本与图/视频提示词 |

够走通「登录 → 项目 → 集 → 分镜」金路径;不播资产、不播计费、不播任何真实业务数据。

## 用法

```bash
# 一键(S21 路径):读取 .env / POSTGRES_* 配置
npx tsx seed/demo-data.mts

# 显式指定
npx tsx seed/demo-data.mts --database-url postgresql://user:pass@127.0.0.1:5432/shortdrama --schema app
```

库是空的也没关系:脚本会先按 `migrations/extensions.json` 预装声明的扩展,
再幂等跑完 `migrations/`,最后播种。

## 纪律

- **幂等**:全部固定 UUID + `ON CONFLICT DO NOTHING`;重复跑新插 0 行、总数不变。
- **无真实凭据**:演示口令 `demo-only-password` 是公开占位值,只用于本地;
  可用 `--password` 或测试注入覆盖。**本数据集不含任何从云库导出的数据。**
- **只连本机**:主机白名单 `127.0.0.1 / localhost / ::1 / db / postgres`,其余一律拒绝。

## 给 S21 的接口

- 入口就是上面的命令;退出码 0 = 数据就绪,非 0 = 失败(信息在 stderr)。
- 输出最后一行是演示账号,可直接透传给用户。
- 真库验证:`SEED_DEMO_TEST_DATABASE_URL=postgresql://… npx tsx --test tests/seed-demo-data-db.test.ts`。

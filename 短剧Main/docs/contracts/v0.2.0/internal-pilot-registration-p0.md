# 内部同事注册与生成额度闸门合同（Issue #26 / P0）

状态：2026-08-04 冻结，供内部同事自助注册试点。本文是
`self-registration-and-account-credits.md` 的增量覆盖；未覆盖的计价、账本、权限和
邮件 fail-closed 不变量继续沿用。

## 1. 固定规则

- 自注册只接受邮箱、密码、六位邮箱验证码和固定邀请码 `COLTECH`；邀请码按
  `trim + uppercase` 归一化，因此大小写和首尾空格不影响核验。
- 不填邀请码返回 `422 invite_code_required`；非 `COLTECH`、停用、过期或用尽均返回
  `422 invite_code_invalid`。公开错误文案不回显共享码；两种情况都不创建用户、
  不消费验证码、不创建积分账户。
- 每个成功注册的试点用户初始获得 **50,000 积分**，每日额度为
  **50,000 积分**。`1 积分 = 1 分`，日界线仍为 `Asia/Shanghai`。
- 固定码由迁移 `049_ops_p0_internal_pilot.sql` 幂等播种，只保存 SHA-256 哈希和
  遮罩前缀，不保存完整明文。迁移重跑不重置 `used_count`，也不恢复管理员已经设置的
  停用状态、过期时间或使用次数上限。固定码是平台签发，`issued_by_user_id` 可为空；
  数据库约束保证其他邀请码必须记录签发人。
- 注册、验证码消费、邀请码核销、用户创建、账户创建、积分赠送和摘要读取在一个
  PostgreSQL 事务中完成；任何一步失败都不能留下半注册用户。
- 邮件发送方式不在本单扩展：仅本地/开发环境且
  `AUTH_EMAIL_DELIVERY_MODE=dev_log` 时可请求验证码；HTTP 响应不回传验证码。
  生产模式继续以 `503 email_delivery_unavailable` 失败关闭。

## 2. API 合同

所有成功响应保持 `{ "ok": true, "data": ... }`，公开 JSON 字段使用
`snake_case`；保护接口要求 `Authorization: Bearer <TOKEN>`。

| 方法与路径 | 权限 | 请求与稳定结果 |
| --- | --- | --- |
| `POST /api/v1/auth/email-verification-codes` | 公开 | `{email}`；开发模式返回 202、`email`、`expires_at`、`delivery: "dev_log"`，验证码只进受控服务日志。 |
| `POST /api/v1/auth/register` | 公开 | `{email,password,verification_code,invitation_code:"COLTECH",display_name?}`；201 返回 `user`、`account_credit`、`registration_grant`。`account_credit.balance_points=50000`、`daily_limit_points=50000`，`registration_grant.source="invitation"`、`granted_points=50000`。 |
| `POST /api/v1/auth/login` | 公开 | `{email,password}`；200 返回 `token`、`expires_at`、`user`。遗留 Day-0 账号仍可用 `username` 登录。 |
| `GET /api/v1/account-credits/me` | 登录 | 返回 `user_id`、`balance_points`、`daily_limit_points`、`used_today_points`、`remaining_today_points`、`day_date`、`point_to_fen:1`。 |
| `GET /api/v1/admin/users` | admin | 保持原排序和审计，加性返回每个用户的 `email`、`email_verified_at` 与 `account_credit` 摘要；遗留用户无账户时 `account_credit:null`。不得返回密码哈希。 |
| `POST /api/v1/admin/users/:id/account-credits/adjust` | admin | `{amount_points,reason}`；正数增加、负数扣减，0 和扣成负余额均拒绝；返回 `adjustment`，同事务写积分台账与管理审计。 |
| `POST /api/v1/generations/estimate` | 登录且有试点额度 | 简单无项目价格浏览不受闸门影响；带项目的完整估价或 retry 会生成可追溯报价，但不创建任务、不调用供应商。 |
| 生成报价、确认、单项提交、批量确认/提交、retry 的既有 API | 登录且有试点额度 | HTTP、CLI、Agent 共用仓储闸门；新报价或新的付费状态转换前必须有积分账户、正余额和当日正剩余额度。 |

管理员列表中的 `account_credit` 与本人积分接口同口径：

```json
{
  "user_id": "uuid",
  "balance_points": 50000,
  "daily_limit_points": 50000,
  "used_today_points": 0,
  "remaining_today_points": 50000,
  "day_date": "2026-08-04",
  "point_to_fen": 1
}
```

## 3. 生成额度闸门

部署开关为 `GENERATION_PILOT_CREDIT_GATE_ENABLED`，默认 `true`。

- `true`：生产工厂把同一个数据库账户检查注入生成仓储。它覆盖新建单项/重试报价、
  确认报价、创建单项任务、创建/提交批量授权和创建重试任务，不能由 CLI 或 Agent
  绕过。
- `false`：跳过本试点的“账户存在且有正额度”预检；只用于明确退出试点策略。
  原有身份、项目权限、价格、预算、付费总开关和 PostgreSQL 精确扣款保护不受影响。
- 开关只接受明确布尔值；拼写或其他非法值必须使服务启动配置解析失败，不能静默按
  `false` 运行。
- 新状态检查与写入在同一 PostgreSQL 事务内，并以账户行 `FOR UPDATE` 和管理员调账、
  生成扣款串行；不能在检查通过后由并发调账制造无额度的新状态。
- 所有生成事务统一按“报价行 → 账户行 → 价格 advisory lock”取锁；无报价的新估价按
  “账户行 → 价格 lock”取锁，避免并发估价、提交、重试和批量提交形成反序死锁。
- 已有持久化结果的幂等重放先返回原结果，不因余额后来变化而伪装成新失败。
- 本闸门只决定是否允许准备或创建新的付费状态，不计算价格也不扣款。报价消费时，
  迁移 `034_s57_account_registration.sql` 的数据库触发器仍按报价成本原子校验
  “余额足够且本日剩余额度足够”并执行唯一扣款。

稳定错误如下：

| HTTP / code | 含义 |
| --- | --- |
| `422 invite_code_required` | 内部试点邀请码未填写。 |
| `422 invite_code_invalid` | 邀请码不正确或暂不可核销；向管理员确认后重试。 |
| `422 account_credit_insufficient` | 账户余额不为正，联系管理员调账。 |
| `422 account_credit_daily_limit_exceeded` | 当日剩余额度不为正，次日再试或联系管理员。 |
| `503 account_credit_unavailable` | 登录用户没有可读取的积分账户，失败关闭。 |

## 4. 本单真实验证判据

本地/开发 PostgreSQL 必须走通：

1. 请求验证码，从受控开发日志读取验证码；
2. 使用唯一测试邮箱和 `COLTECH` 注册；
3. 用邮箱和密码登录；
4. 本人积分摘要为余额 50,000、日额度 50,000、当日已用 0；
5. 管理员列表可按邮箱识别该用户并看到同一积分摘要；管理员正、负调账均有台账与审计；
6. 创建最小项目/集/镜头后，对当前最低成本的有效生成档执行完整估价，得到真实数据库
   报价和确定的 `estimated_cost_fen`；
7. 到此停止：不确认、不提交生成；数据库中无新增生成请求、无积分扣款、无供应商调用。

同一一次性数据库还要用独立测试状态验证：049 重跑保持管理员停用/次数/过期设置，
非固定邀请码不能缺签发人，以及同账户 `estimate/submit`、`estimate/retry`、
`batch/submit` 并发不出现 PostgreSQL `40P01 deadlock_detected`。这些并发夹具不属于
上面的业务验收账号，也不调用生成供应商。

静态文件存在或 mock 测试不能替代上述真 PostgreSQL 全流程走通。
专用一次性 PostgreSQL 14 门禁命令为 `npm run test:ops-p0-db`；未获得真 PG 的通过结果时，
不得把跳过记录写成验收通过。PR 的 `verify-ops-p0-postgres` CI 车道必须执行同一命令；
CI 中 Docker 不可用会直接失败，不能静默跳过。

## 5. 边界

- 只改后端、数据库和合同；不实现或验收注册/管理前端。
- 不接真实邮件/短信，不采购，不加入手机号注册、SSO、支付充值或批量运营。
- 只在本地/dev 验证；不修改 test/prod，不部署，不调用真实生成供应商，不触发付费。
- 不改变现有动态邀请码管理 API，但内部自注册入口在本试点期只承认 `COLTECH`。
- 本单不发布 tag；交付物是 issue #26 分支、PR、测试证据和根目录外置回执。

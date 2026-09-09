# 自注册、邀请码与账户积分合同（v0.2.0 / S57）

> **Issue #26 内部试点现行合同（2026-08-04）**：
> [internal-pilot-registration-p0.md](./internal-pilot-registration-p0.md) 冻结固定邀请码、
> 初始积分、全生成链额度闸和真实验收判据。本文已同步为相同行为；其余积分换算、
> 原子注册、账本、精确扣款和邮件 fail-closed 不变量继续有效。

本合同冻结 S57 的可执行边界。迁移 `034_s57_account_registration.sql`、`auth` 和
`account-credits` 模块必须遵守；不以旧的 `AUTH_REGISTRATION_*` 开关或邀请码名单
限制注册。

## 1. 不可变定值与账务真源

- **1 积分 = 1 分 = ¥0.01**；不得另建汇率、二次计价或把积分换算成另一套价格。
- 内部试点自注册必须核销固定邀请码 `COLTECH`，成功后赠送 **50,000** 积分，
  日额度为 **50,000** 积分（¥500）。余额或当日剩余额度为 0 时，新的生成报价、
  确认和提交必须拒绝；简单价格浏览和非付费查询不受影响。
- 动态邀请码管理 API 和既有 `developer` / `invited` 档位继续保留，但 P0 公开
  自注册入口不接受动态码。已发出的动态邀请码保存发放时快照，之后改档不得回写它。
  表驱动的无码策略只服务遗留账户默认建账，不构成当前自注册入口。
- 三处成本必须同源：`generation_quotes.estimated_cost_fen` 是每一张已消费报价的唯一价格；
  消费时账户台账 `generation_debit.points_delta` 直接取该报价的相同分值（负数）。
  对一个生成请求，`generation_requests.charged_points` 和 `cost_entries.charged_points`
  都等于该请求全部已消费报价之和，也等于该请求所有账户扣减的绝对值之和。
  不允许业务层重复扣款或重新计算报价。
- 日额度按 `Asia/Shanghai` 自然日累计；余额、当日额度和台账写入与报价消费在同一
  PostgreSQL 事务内成功或回滚。每个已消费报价至多一笔扣款。

## 2. 身份与发放规则

邮箱是一期唯一的公开自注册身份：有效邮箱、密码（不少于环境配置的最小长度）、六位
验证码和固定 `invitation_code` 必填；显示名可传。注册、验证码消费、邀请码核销、账户
创建和赠送在一个事务内完成。邀请码行加锁并递增使用次数，不能因并发注册超发。

验证码只保存哈希；新验证码会使该邮箱未消费的旧验证码失效。验证码过期、错误次数达到
上限、邀请码失效/停用/过期/用尽时，注册不创建用户。

邮件一期只允许 `NODE_ENV != production` 且 `AUTH_EMAIL_DELIVERY_MODE=dev_log`：
验证码仅写服务端开发日志，HTTP 响应绝不返回验证码。生产环境，或 delivery mode
不是 `dev_log`，请求验证码必须以 `503 email_delivery_unavailable` 失败关闭；在批准的
邮件供应商接入前，不得把生产模式伪装为可注册。

手机号注册**只做调研，不实现接口、表、短信发送或真实验证**。后续提案须由 Fable
报 DC 决定，至少明确企业实名/主体与签名模板资质、消息组和最小 IAM 权限、按实际控制台
报价的预算、发送回执与风控/限流方案。官方资料：[生产短信前置条件](https://www.volcengine.com/docs/6361/1263654)、
[模板与签名](https://www.volcengine.com/docs/6361/170338)、
[计费说明](https://www.volcengine.com/docs/6391/68713?lang=zh)、
[风控与限流](https://www.volcengine.com/docs/6361/1339305?lang=zh)。这些链接用于开通与
费用/资质复核，不构成已获授权的采购或接入。

## 3. HTTP API（agent-first）

所有路径前缀为 `/api/v1`，JSON 使用现有 `{ data }` 成功包装；受保护接口使用
`Authorization: Bearer <TOKEN>`。管理员接口必须是数据库角色 `admin`，且每个管理
写操作写入 `admin_operation_actions` 审计。

| 方法与路径 | 权限 | 请求要点 / 结果 |
| --- | --- | --- |
| `POST /auth/email-verification-codes` | 公开 | `{email}`；202 返回邮箱、过期时间和 `delivery: dev_log`，验证码只在开发日志。 |
| `POST /auth/register` | 公开 | `{email,password,verification_code,invitation_code:"COLTECH",display_name?}`；201 加性返回 `user`、`account_credit` 与 `registration_grant`。缺码或其他码均不创建用户。 |
| `POST /auth/login` | 公开 | `{email|username,password}`；返回 token、过期时间和用户。 |
| `GET /auth/me`、`POST /auth/logout` | 登录 | 返回当前用户；或撤销当前会话。 |
| `GET /account-credits/me` | 登录 | 返回余额、日额度、当日已用/剩余、`day_date`、`point_to_fen: 1`。 |
| `GET/POST/PATCH/DELETE /admin/invite-tiers[/:tier_id]` | admin | 列表；创建 `{code,name,grant_points,daily_limit_points}`；更新名称、赠送、日额、active；删除为停用。 |
| `GET/POST/PATCH/DELETE /admin/invite-codes[/:code_id]` | admin | 创建 `{tier_id,max_redemptions?,expires_at?}`；**仅创建响应一次返回明文码**；列表仅返回遮罩前缀。更新次数、过期时间、active；删除为撤销。 |
| `GET/PATCH /admin/account-credit-policies/self-registration` | admin | 读或改 `{daily_limit_points}`；只影响之后创建的账户。 |
| `POST /admin/users/:id/account-credits/adjust` | admin | `{amount_points,reason}`；不得使余额为负，写积分台账与审计。 |

完整付费估价（`POST /generations/estimate` 且带 `project_id` 或 `action: retry`）是最早的
账户护栏；生成仓储还在报价确认、单项/批量提交和 retry 等新状态转换前复用同一检查。
检查与状态写入处于同一事务并锁定账户行，与管理员调账和数据库扣款串行。真正扣款仍以
报价变为 `consumed` 时的数据库触发器为准。

注册响应的 `account_credit` 与 `GET /account-credits/me` 使用同一个账户摘要读取逻辑，
并在注册事务提交前读取；账户 trigger 或摘要异常会使整次注册回滚，不能出现用户已创建但
额度未知的半成功。`registration_grant` 只解释本次注册来源
`self_registration | invitation` 与 `granted_points`，不替代积分台账。老消费者继续只读
`data.user`，不受加性字段影响。客户端仍不得提交 `role`、余额、赠送或日额度字段。

## 4. 稳定错误码与用户动作

| HTTP / code | 人话含义与动作 |
| --- | --- |
| `503 email_delivery_unavailable` | 邮箱验证码通道未配置；联系管理员开通，不能绕过验证。 |
| `422 email_verification_invalid` / `email_verification_expired` / `email_verification_attempts_exhausted` | 先重新获取验证码、填写正确验证码或在次数耗尽后重取。 |
| `409 email_exists` | 邮箱已注册，改为登录。 |
| `422 invite_code_required` | 内部试点邀请码未填写；向管理员确认邀请码后重试。 |
| `422 invite_code_invalid` | 码不正确、停用、过期或已用尽；向管理员确认后重试，不能去掉邀请码继续注册。 |
| `422 account_credit_insufficient` | 余额不足；联系管理员调账后再生成，已注册账号不能重复核销邀请码补余额。 |
| `422 account_credit_daily_limit_exceeded` | 今日额度用完；次日再试或联系管理员调整。 |
| `503 account_credit_unavailable` | 账户积分尚未就绪；稍后重试，不得继续提交付费生成。 |
| `409 account_credit_quote_invalid` / `account_credit_duplicate_generation_attempt` | 报价异常需重新估价；或该生成已提交，无需再次扣费。 |
| `403` | 非管理员不能管理邀请码、策略或调账。 |

## 5. 人与 Agent 的 curl 流程

以下命令是 API 优先的最小流程；占位符不是密钥，严禁把真实 token、验证码或邀请码提交到
仓库、日志回执或聊天记录。

```bash
BASE_URL='https://<environment-host>'
curl -sS -X POST "$BASE_URL/api/v1/auth/email-verification-codes" \
  -H 'content-type: application/json' \
  --data '{"email":"agent-demo@example.invalid"}'
# 仅开发环境：由受控服务日志取得 VERIFICATION_CODE，不会出现在此响应中。
curl -sS -X POST "$BASE_URL/api/v1/auth/register" \
  -H 'content-type: application/json' \
  --data '{"email":"agent-demo@example.invalid","password":"<local-test-password>","verification_code":"<VERIFICATION_CODE>","invitation_code":"<INTERNAL_PILOT_INVITE_CODE>"}'
curl -sS -X POST "$BASE_URL/api/v1/auth/login" \
  -H 'content-type: application/json' \
  --data '{"email":"agent-demo@example.invalid","password":"<local-test-password>"}'
curl -sS "$BASE_URL/api/v1/account-credits/me" \
  -H 'Authorization: Bearer <USER_TOKEN>'
```

管理员先登录取得自己的 token，再按此创建档位和邀请码；邀请码明文只在创建响应中安全交接。

```bash
curl -sS -X POST "$BASE_URL/api/v1/admin/invite-tiers" \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'content-type: application/json' \
  --data '{"code":"partner","name":"合作测试","grant_points":50000,"daily_limit_points":50000}'
curl -sS -X POST "$BASE_URL/api/v1/admin/invite-codes" \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'content-type: application/json' \
  --data '{"tier_id":"<TIER_UUID>","max_redemptions":1}'
```

生产环境执行第一条会得到 `email_delivery_unavailable`，这是预期的 fail-closed 行为，
不是可通过 curl 修复的问题。

## 6. 当前并发与批量边界

- 同一邀请码的注册核销通过行锁和使用次数约束串行化；同一报价的重复消费由唯一索引和
  生成尝试检查阻止重复扣款。
- 账户行与当天使用行在消费事务中锁定；余额不足、单笔超过日额度或累计超额均回滚报价
  消费，因此不会生成无资金覆盖的付费任务。
- 本期没有自注册/邀请码的批量导入、批量发码、批量充值或手机号批量验证 API；管理员可
  逐条调账和逐条发码。前端低代码可视化只是这些 API 的调用方，不拥有另一套规则。
- 现有生成批量能力不改变“每个已消费报价分别、原子地校验并扣款”的规则；S57 未定义
  多报价作为一个原子账户批次的预留、部分成功策略或批量重试协议。

## 7. 非目标

- 不接外部邮件发送商、不发真实邮件或短信、不采购/开通火山短信；手机号仅保留上述调研。
- 不做团队、分组、项目角色、充值支付、退款、积分兑换、营销裂变或邀请码批量运营。
- 不重写生成计价或供应商调用；`src/modules/generation/` 只增加统一的账户额度授权闸，
  账户系统仍以已确认报价绑定归属和精确扣款。
- 不提供前端页面或 OpenAPI 生成器；本表和 curl 是本包的接口合同，后续界面必须服从它。

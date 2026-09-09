# v0.2.3 RBAC / 注册默认额度 API 形状稿 v1

- 状态：Fable 2026-08-02 批准，零修改；实现按本稿收口
- 日期：2026-08-02
- 实现基线：`dev@702a622a`
- 依赖真源：迁移 `016_operations_foundation.sql`、`034_s57_account_registration.sql`
- 既有合同：`docs/contracts/v0.2.0/self-registration-and-account-credits.md`

## 结论

不新增用户、角色、额度或积分表，也不新增另一条注册接口。现有实现已经具备正确的数据
地基：

- 平台角色真源是 `users.role`，闭集为 `admin | operator | member`；
- 自注册固定创建 `member`，客户端不能提交角色；
- 项目内 `owner | editor | viewer` 是项目授权，不是平台角色；
- 注册、验证码消费、邀请码核销、账户创建和赠送在同一 PostgreSQL 事务中完成；
- 无码注册赠送 0 积分，日额度取 `self_registration` 当前策略；
- 邀请码使用发放快照覆盖赠送积分和日额度；
- 余额、日额度和真实扣费继续使用现有账户与积分台账，不造第二套 quota。

本包只建议给现有注册成功响应增加一块只读结果，使前端在注册完成当下就能明确展示
「角色、余额、日额度和本次赠送」。老消费者只读 `data.user`，不会被破坏。

## API 形状

### 1. 获取验证码

保持现状：

```http
POST /api/v1/auth/email-verification-codes
```

```json
{
  "email": "user@example.com"
}
```

开发环境成功：

```json
{
  "ok": true,
  "data": {
    "email": "user@example.com",
    "expires_at": "2026-08-02T08:00:00.000Z",
    "delivery": "dev_log"
  }
}
```

生产邮件供应商未接入时继续 fail-closed：

```json
{
  "ok": false,
  "error": {
    "code": "email_delivery_unavailable",
    "message": "邮箱验证码通道尚未配置，请联系管理员开通后再注册",
    "retryable": false,
    "details": null
  }
}
```

验证码不进入 HTTP 响应。

### 2. 邮箱注册

路径和请求保持现状，严格 schema 不增加 `role`、`grant_points` 或
`daily_limit_points` 等客户端可写字段：

```http
POST /api/v1/auth/register
```

```json
{
  "email": "user@example.com",
  "password": "<password>",
  "verification_code": "123456",
  "display_name": "新用户",
  "invitation_code": "<optional>"
}
```

建议批准的加性响应：

```json
{
  "ok": true,
  "data": {
    "user": {
      "id": "uuid",
      "username": "opaque-login-id",
      "display_name": "新用户",
      "role": "member"
    },
    "account_credit": {
      "user_id": "uuid",
      "balance_points": 0,
      "daily_limit_points": 50000,
      "used_today_points": 0,
      "remaining_today_points": 50000,
      "day_date": "2026-08-02",
      "point_to_fen": 1
    },
    "registration_grant": {
      "source": "self_registration",
      "granted_points": 0
    }
  }
}
```

使用有效邀请码时，形状不变，仅事实值变化：

```json
{
  "account_credit": {
    "user_id": "uuid",
    "balance_points": 50000,
    "daily_limit_points": 50000,
    "used_today_points": 0,
    "remaining_today_points": 50000,
    "day_date": "2026-08-02",
    "point_to_fen": 1
  },
  "registration_grant": {
    "source": "invitation",
    "granted_points": 50000
  }
}
```

`registration_grant` 只解释本次注册发生了什么，不是新的积分台账；金额仍来自邀请码
核销快照和 `user_credit_ledger_entries`。

### 3. 登录后读取账户积分

保持现有端点和口径：

```http
GET /api/v1/account-credits/me
Authorization: Bearer <TOKEN>
```

响应中的 `account_credit` 字段与注册响应同源。注册响应是当时快照，登录后页面以本端点
的最新值为准。

## 角色基线

| 平台角色 | 自注册获得 | 基线能力 |
| --- | --- | --- |
| `member` | 是，唯一默认角色 | 浏览、参与获授权项目；付费生成仍受项目权限、余额和日额度约束 |
| `operator` | 否 | 可读全局成本；不能管理用户、邀请码、策略或调账 |
| `admin` | 否 | 管理用户、邀请码、注册策略和积分调账；写操作必须留管理员审计 |

任何项目 `owner/editor/viewer` 权限都不改变平台角色。自注册用户也不会因为使用高额度
邀请码而升级角色。

## 默认额度策略

1. 无码注册：`balance_points=0`，日额度读取注册事务当时的
   `account_credit_policies.self_registration`；
2. 有效邀请码：余额增加邀请码快照的 `grant_points`，日额度采用邀请码快照；
3. 日额度不是赠送余额。余额为 0 时，即使日额度还有 50,000，付费估价仍返回
   `account_credit_insufficient`；
4. 后续管理员修改策略或邀请码档位，不回写已注册账户；
5. 付费生成继续在完整 estimate 阶段做早期护栏，在报价消费事务中做最终原子扣款。

## 实现边界

- 无迁移：继续使用 016、034 既有表、约束、trigger 和审计；
- repository 注册事务需把本次 grant 来源和数值随用户一起返回；
- service 使用同一个账户摘要 repository 生成 `account_credit`，不能在 HTTP 层重算；
- 注册成功但账户摘要缺失视为事务/部署异常，不返回“注册成功但额度未知”的半成功；
- 继续使用冻结信封 `{ok:true,data:{...}}` 与
  `{ok:false,error:{code,message,retryable,details}}`；
- 生产真实邮箱注册仍依赖批准的邮件发送通道，本包不伪装可用、不接短信。

## 批复后验收

1. 无码注册：角色 `member`、赠送 0、余额 0、日额度取策略；
2. 邀请码注册：角色仍是 `member`，赠送与日额度等于邀请码快照；
3. 请求中夹带角色、余额或额度字段返回 400，数据库无用户；
4. 注册响应与随后 `GET /account-credits/me` 的初始账户事实一致；
5. 策略后改不回写旧账户；
6. 非 admin 调邀请码、策略、调账接口返回 403；
7. 五个注册步骤仍是单事务，并发邀请码不超发；
8. 无新增数据表或第二套额度计算。

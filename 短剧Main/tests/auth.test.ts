import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../src/db/client.js";
import type { AuthRepository } from "../src/modules/auth/repository.js";
import {
  AuthService,
  assertRegistrationAllowed,
  hashPassword,
  hashSessionToken,
  normalizeEmail,
  normalizeUsername,
  usernameForEmail,
  verifyPassword,
} from "../src/modules/auth/service.js";
import { AppError, NotFoundError } from "../src/shared/errors.js";

test("password hashes can be verified without storing the plaintext", async () => {
  const encoded = await hashPassword("correct horse battery staple");
  assert.match(encoded, /^scrypt\$/);
  assert.equal(encoded.includes("correct horse battery staple"), false);
  assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(await verifyPassword("wrong password", encoded), false);
});

test("session tokens use deterministic SHA-256 hashes", () => {
  const first = hashSessionToken("secret-token");
  assert.equal(first, hashSessionToken("secret-token"));
  assert.equal(first.length, 64);
  assert.notEqual(first, "secret-token");
});

test("usernames are normalized before persistence", () => {
  assert.equal(normalizeUsername("  Alice.Team  "), "alice.team");
});

test("内部试点注册只接受固定邀请码 COLTECH，旧环境名单不再决定资格", () => {
  assert.doesNotThrow(() => assertRegistrationAllowed(" coltech ", { enabled: false, inviteCodes: [] }));
  assert.throws(
    () => assertRegistrationAllowed(undefined, { enabled: true, inviteCodes: ["legacy"] }),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 422
      && error.code === "invite_code_required"
      && error.message === "注册没成：公司内部试点需要邀请码，请向管理员确认后再试。",
  );
  assert.throws(
    () => assertRegistrationAllowed("legacy", { enabled: true, inviteCodes: ["legacy"] }),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 422
      && error.code === "invite_code_invalid"
      && error.message === "注册没成：邀请码不正确或暂不可用，请向管理员确认后再试。",
  );
});

test("email login identity is normalized while the legacy username stays opaque", () => {
  assert.equal(normalizeEmail("  Alice.Team@Example.COM "), "alice.team@example.com");
  assert.match(usernameForEmail("alice.team@example.com"), /^u-[a-f0-9]{20}$/);
  assert.throws(
    () => normalizeEmail("not-an-email"),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "invalid_request"
      && error.message === "提交邮箱没成：邮箱格式不对，请检查后再试。",
  );
});

test("注册事务缺少账户摘要时整体失败为可重试错误，不返回半成功", async () => {
  const repository = {
    registerVerifiedEmail: async () => {
      throw new NotFoundError("账户积分信息尚未就绪");
    },
  } as unknown as AuthRepository;
  const service = new AuthService({} as Database, repository);
  await assert.rejects(
    service.register({
      email: "credit-missing@example.test",
      password: "long-enough-test-password",
      verificationCode: "123456",
      invitationCode: "COLTECH",
    }),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 503
      && error.code === "account_credit_unavailable"
      && error.retryable
      && error.message === "注册没成：积分账户暂未准备好，请稍后重试。",
  );
});

test("注册拒绝按业务原因映射文案，不公开仓储原始消息", async (context) => {
  const cases = [
    ["email_verification_invalid", "注册没成：验证码不正确或尚未获取，请检查后重新获取。"],
    ["email_verification_expired", "注册没成：验证码已过期，请重新获取后再试。"],
    ["email_verification_attempts_exhausted", "注册没成：验证码尝试次数已用完，请重新获取后再试。"],
    ["invite_code_invalid", "注册没成：邀请码不正确或暂不可用，请向管理员确认后再试。"],
  ] as const;

  for (const [code, message] of cases) {
    await context.test(code, async () => {
      const repository = {
        registerVerifiedEmail: async () => ({
          kind: "rejected" as const,
          failure: { code, message: "Ark returned invalid_type for invitation_code" },
        }),
      } as unknown as AuthRepository;
      const service = new AuthService({} as Database, repository);

      await assert.rejects(
        service.register({
          email: "registration-rejected@example.test",
          password: "long-enough-test-password",
          verificationCode: "123456",
          invitationCode: "COLTECH",
        }),
        (error: unknown) => error instanceof AppError
          && error.statusCode === 422
          && error.code === code
          && error.message === message
          && !/Ark|invalid_type|invitation_code/.test(error.message),
      );
    });
  }
});

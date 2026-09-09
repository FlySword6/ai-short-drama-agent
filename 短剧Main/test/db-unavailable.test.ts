/* 库层故障分层:连接/认证/库缺失类故障从 internal_error 分出 db_unavailable
   (retryable=true),用户文案保持不变、不泄露内部细节,区别只在 code 与服务端
   日志;业务错误(如 401 凭据错误)不受分层影响。全部走整应用 createApp。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { createApp } from "../src/app.js";
import type { Database } from "../src/db/client.js";
import { errorBody } from "../src/shared/errors.js";

test("errorBody:连接/认证/库缺失类故障归类 db_unavailable,其余保持 internal_error", () => {
  for (const code of ["ECONNREFUSED", "ETIMEDOUT", "08006", "57P01", "53300", "28P01", "28000", "3D000", "3F000"]) {
    const body = errorBody(Object.assign(new Error("boom"), { code }));
    assert.equal(body.code, "db_unavailable", `${code} 应归类 db_unavailable`);
    assert.equal(body.retryable, true);
    assert.equal(body.message, "服务暂时不可用，请稍后重试");
    assert.equal(body.details, null);
  }
  // 唯一约束、数据异常等是业务/数据问题,不是「库不可用」。
  for (const code of ["23505", "22P02"]) {
    const body = errorBody(Object.assign(new Error("boom"), { code }));
    assert.equal(body.code, "internal_error", `${code} 不应归类 db_unavailable`);
  }
  assert.equal(errorBody(new Error("boom")).code, "internal_error");
});

function appWithDatabase(db: Database) {
  return createApp({
    logger: false,
    startGenerationWorker: false,
    databaseHandle: { db, pool: {} as unknown as Pool },
  });
}

const loginPayload = { username: "someone", password: "whatever-password" };

test("POST /auth/login 库故障返回 500 db_unavailable,不泄露主机名与用户名", async () => {
  const leakedHost = "db.internal.example.com";
  const leakedUser = "shortdrama_app";
  const db = {
    select: () => {
      throw Object.assign(
        new Error(`connect ECONNREFUSED ${leakedHost}:5432 user=${leakedUser}`),
        { code: "ECONNREFUSED" },
      );
    },
  } as unknown as Database;
  const app = await appWithDatabase(db);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: loginPayload });
  assert.equal(res.statusCode, 500);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "db_unavailable");
  assert.equal(body.error.retryable, true);
  // 用户文案与 internal_error 保持一致,区分只在 code,不泄露任何内部细节。
  assert.equal(body.error.message, "服务暂时不可用，请稍后重试");
  assert.equal(body.error.details, null);
  assert.ok(!res.body.includes(leakedHost), "响应体泄露了数据库主机名");
  assert.ok(!res.body.includes(leakedUser), "响应体泄露了数据库用户名");
  await app.close();
});

test("对照:库正常但凭据错误仍是 401 业务错误,不受分层改动影响", async () => {
  // drizzle 查询链:select().from().where().limit() → 空结果 = 用户不存在。
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Database;
  const app = await appWithDatabase(db);
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: loginPayload });
  assert.equal(res.statusCode, 401);
  const body = res.json();
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.error.message, "登录没成：账号或密码不正确，请检查后再试。");
  assert.equal(body.error.retryable, false);
  await app.close();
});

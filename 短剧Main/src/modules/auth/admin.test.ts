import assert from "node:assert/strict";
import test from "node:test";
import { requireAdministrator, requireGlobalCostReader } from "./admin.js";

const user = {
  id: "user-1",
  username: "price.admin",
  displayName: "费用管理员",
  role: "admin" as const,
};

test("only the database-backed admin role can change global settings", () => {
  assert.doesNotThrow(() => requireAdministrator(user));
  assert.doesNotThrow(() => requireAdministrator(user, []));
  assert.throws(
    () => requireAdministrator({ ...user, role: "operator" }),
    (error: unknown) => hasError(error, "forbidden", 403),
  );
  assert.throws(
    () => requireAdministrator({ ...user, role: "member" }),
    (error: unknown) => hasError(error, "forbidden", 403),
  );
});

test("operator 可以读取全局成本但不能改全局设置", () => {
  const operator = { ...user, role: "operator" as const };
  assert.doesNotThrow(() => requireGlobalCostReader(operator));
  assert.throws(
    () => requireAdministrator(operator),
    (error: unknown) => hasError(error, "forbidden", 403),
  );
  assert.throws(
    () => requireGlobalCostReader({ ...user, role: "member" }),
    (error: unknown) => hasError(error, "forbidden", 403),
  );
});

function hasError(error: unknown, code: string, statusCode: number): boolean {
  return error instanceof Error
    && "code" in error
    && "statusCode" in error
    && error.code === code
    && error.statusCode === statusCode;
}

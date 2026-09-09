import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import { UnauthorizedError } from "../../shared/errors.js";
import { AuthRepository } from "./repository.js";
import { AuthService, hashPassword } from "./service.js";

const userId = "11111111-1111-4111-8111-111111111111";

test("登录创建会话前把刚验证过的密码哈希交给存储层重新核验", async () => {
  const passwordHash = await hashPassword("correct-password");
  let expectedHash: string | undefined;
  const repository = {
    findUserByUsername: async () => ({
      id: userId,
      username: "artist",
      displayName: "美术同事",
      passwordHash,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    createHumanSession: async (input: { expectedPasswordHash: string; source: string }) => {
      expectedHash = input.expectedPasswordHash;
      assert.equal(input.source, "web");
      return "session-id";
    },
  } as unknown as AuthRepository;
  const service = new AuthService({} as Database, repository);

  const result = await service.login({ username: "artist", password: "correct-password" });
  assert.equal(expectedHash, passwordHash);
  assert.equal(result.user.id, userId);
});

test("管理员在登录验证后改密或禁用时，不再签发竞态会话", async () => {
  const passwordHash = await hashPassword("correct-password");
  const repository = {
    findUserByUsername: async () => ({
      id: userId,
      username: "artist",
      displayName: "美术同事",
      passwordHash,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    createHumanSession: async () => undefined,
  } as unknown as AuthRepository;
  const service = new AuthService({} as Database, repository);

  await assert.rejects(
    service.login({ username: "artist", password: "correct-password" }),
    (error: unknown) => error instanceof UnauthorizedError,
  );
});

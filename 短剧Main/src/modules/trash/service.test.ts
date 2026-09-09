import assert from "node:assert/strict";
import test from "node:test";
import { TrashService, type TrashItem, type TrashRepository } from "./service.js";

function item(): TrashItem {
  return { id: "asset-1", kind: "asset", ownerUserId: "user-a", name: "角色资产", deletedAt: new Date() };
}

function repository(overrides: Partial<TrashRepository> = {}) {
  const calls: string[] = [];
  const base: TrashRepository = {
    list: async () => [item()],
    get: async () => item(),
    restore: async () => { calls.push("restore"); return item(); },
    preparePermanentDeletion: async () => { calls.push("prepare"); return { blockers: [] }; },
    checkPermanentDeletion: async () => ({ blockers: [] }),
    deleteExternalObjects: async () => { calls.push("external"); },
    hardDelete: async () => { calls.push("hard"); },
    ...overrides,
  };
  return { repository: base, calls };
}

test("只有所有者可以恢复", async () => {
  const fake = repository();
  const service = new TrashService(fake.repository);
  await assert.rejects(service.restore({ actorId: "user-b", kind: "asset", id: "asset-1" }), /无权/);
  await service.restore({ actorId: "user-a", kind: "asset", id: "asset-1" });
  assert.deepEqual(fake.calls, ["restore"]);
});

test("业务引用存在时拒绝永久删除", async () => {
  const fake = repository({
    preparePermanentDeletion: async () => ({ blockers: ["仍被项目引用"] }),
  });
  const service = new TrashService(fake.repository);
  await assert.rejects(service.permanentlyDelete({ actorId: "user-a", kind: "asset", id: "asset-1" }), /仍被项目引用/);
  assert.deepEqual(fake.calls, []);
});

test("先准备可重放数据库清理计划，再删外部对象和数据库记录", async () => {
  const fake = repository();
  const service = new TrashService(fake.repository);
  await service.permanentlyDelete({ actorId: "user-a", kind: "asset", id: "asset-1" });
  assert.deepEqual(fake.calls, ["prepare", "external", "hard"]);
});

test("外部删除失败时保留已准备的可重放数据库状态", async () => {
  const fake = repository({
    deleteExternalObjects: async () => { fake.calls.push("external"); throw new Error("TOS 删除失败"); },
  });
  const service = new TrashService(fake.repository);
  await assert.rejects(service.permanentlyDelete({ actorId: "user-a", kind: "asset", id: "asset-1" }), /TOS 删除失败/);
  assert.deepEqual(fake.calls, ["prepare", "external"]);
});

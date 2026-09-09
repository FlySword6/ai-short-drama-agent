import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../db/client.js";
import type { AssetEntityData } from "../domain/assets/types.js";
import { AssetEntityRepository } from "./assetEntityRepository.js";

test("个人资产仓储写口强制免审，通用资产保留审核状态", async () => {
  const personal = await saveWithCapture({
    ownerUserId: "11111111-1111-4111-8111-111111111111",
    visibility: "personal",
    assetKind: "character",
    name: "个人角色",
    status: "pending_review",
    approved: null,
  });
  assert.equal(personal.visibility, "personal");
  assert.equal(personal.status, "approved");
  assert.equal(personal.approved, true);

  const commonAsset = await saveWithCapture({
    ownerUserId: null,
    visibility: "common",
    assetKind: "character",
    name: "通用角色",
    status: "pending_review",
    approved: null,
  });
  assert.equal(commonAsset.visibility, "common");
  assert.equal(commonAsset.status, "pending_review");
  assert.equal(commonAsset.approved, null);
});

async function saveWithCapture(asset: AssetEntityData): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        captured = values;
        return {
          returning: async () => [{ id: "22222222-2222-4222-8222-222222222222", ...values }],
        };
      },
    }),
  } as unknown as Database;

  await new AssetEntityRepository(db).save(asset);
  assert.ok(captured);
  return captured;
}

test("重新入库不覆盖通用资产的审核事实，个人资产仍恒为免审", async () => {
  // 通用资产：审核状态与通过标记必须指回目标行本身（SQL 片段），
  // 不能把调用方算出来的默认值写回去——那会把刚提交的审核决定打回。
  const commonAsset = await updateWithCapture({
    ownerUserId: null,
    visibility: "common",
    assetKind: "character",
    name: "通用角色",
    status: "pending_review",
    approved: null,
  });
  assert.ok(isSqlFragment(commonAsset.status), "通用资产的 status 必须指回目标行，不能是调用方传入的值");
  assert.ok(isSqlFragment(commonAsset.approved), "通用资产的 approved 必须指回目标行");

  // 个人资产不参与审核状态机（041 迁移），仍写死免审，不受上面那层保护影响。
  const personal = await updateWithCapture({
    ownerUserId: "11111111-1111-4111-8111-111111111111",
    visibility: "personal",
    assetKind: "character",
    name: "个人角色",
    status: "pending_review",
    approved: null,
  });
  assert.equal(personal.status, "approved");
  assert.equal(personal.approved, true);
});

test("重新入库不擦掉人后加的分类，也不复活已删资产", async () => {
  // 老的命令行/入库调用方不发这些字段，重新入库不能把人后来加的分类擦掉；
  // 删除标记与使用次数同理，必须保留库内现值。
  const captured = await updateWithCapture({
    ownerUserId: null,
    visibility: "common",
    assetKind: "character",
    name: "通用角色",
    status: "pending_review",
    approved: null,
  });
  assert.ok(isSqlFragment(captured.role), "没传 role 时必须保留库内现值");
  assert.ok(isSqlFragment(captured.usageMode), "没传 usageMode 时必须保留库内现值");
  assert.ok(isSqlFragment(captured.deletedAt), "删除标记必须保留库内现值，不能被入库复活");
  assert.ok(isSqlFragment(captured.deletedByUserId), "删除人必须保留库内现值");
  assert.ok(isSqlFragment(captured.useCount), "使用次数必须保留库内现值");

  // 显式传值仍然生效——这层保护只针对"没传"的情况。
  const explicit = await updateWithCapture({
    ownerUserId: null,
    visibility: "common",
    assetKind: "character",
    name: "通用角色",
    status: "pending_review",
    approved: null,
    role: "character_identity",
  });
  assert.equal(explicit.role, "character_identity");
});

/** 走 UPDATE 分支：假 db 的查询返回一条既有行，捕获 set() 收到的值。 */
async function updateWithCapture(asset: AssetEntityData): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const existingRow = {
    id: "33333333-3333-4333-8333-333333333333",
    role: "lead",
    usageMode: "reference",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    useCount: 7,
    deletedAt: null,
    deletedByUserId: null,
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [existingRow],
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        captured = values;
        return {
          where: () => ({
            returning: async () => [{ ...existingRow, ...values }],
          }),
        };
      },
    }),
  } as unknown as Database;

  await new AssetEntityRepository(db).save(asset);
  assert.ok(captured);
  return captured;
}

/** drizzle 的 sql`` 片段不是普通标量；用它区分"指回目标行"和"写入字面值"。 */
function isSqlFragment(value: unknown): boolean {
  return typeof value === "object" && value !== null && !(value instanceof Date);
}

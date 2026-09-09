import assert from "node:assert/strict";
import test from "node:test";
import { canChangeAssetReviewState, canDecideAsset, canDecideProjectReview } from "./repository.js";
import type { ProjectAccess } from "../project-access/types.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const strangerId = "44444444-4444-4444-8444-444444444444";

/** 个人资产免审，不进入项目审核状态机。 */
const ownPersonalAsset = { visibility: "personal", ownerUserId: actorId };
const ownCommonAsset = { visibility: "common", ownerUserId: actorId };
const strangerCommonAsset = { visibility: "common", ownerUserId: strangerId };
/** 平台库里没有个人所有者的通用资产。 */
const unownedCommonAsset = { visibility: "common", ownerUserId: null };

test("项目内审核决定只允许 owner/admin 或当前项目成员中的指定审核人", () => {
  assert.equal(canDecideAsset(access("member", "owner"), actorId, null, ownPersonalAsset), false);
  assert.equal(canDecideAsset(access("member", "editor"), actorId, null, ownPersonalAsset), false);
  assert.equal(canDecideAsset(access("member", "viewer"), actorId, actorId, ownPersonalAsset), false);
  assert.equal(canDecideAsset(access("member", "viewer"), actorId, "other-user", ownPersonalAsset), false);
  assert.equal(canDecideAsset(access("admin", null), actorId, null, ownPersonalAsset), false);
  assert.equal(canDecideAsset(access("operator", "viewer"), actorId, actorId, ownPersonalAsset), false);
});

test("通用库资产：自建项目的 owner 不能批准别人的待审素材", () => {
  // 攻击链(DC V-19)：任意注册用户新建项目并自动成为 owner，把通用库里
  // pending_review 的素材引用进来，再自己批准 —— 而 asset_entities.status
  // 是全平台单列，一批就等于在全平台放行未过审素材进入付费生成。
  assert.equal(canDecideAsset(access("member", "owner"), actorId, null, strangerCommonAsset), false);
  // 把自己写进本项目的审核人也拿不到全平台授权。
  assert.equal(canDecideAsset(access("member", "viewer"), actorId, actorId, strangerCommonAsset), false);
  assert.equal(canDecideAsset(access("member", "editor"), actorId, actorId, strangerCommonAsset), false);
  // 无主的平台库资产 fail-closed，只剩平台 admin。
  assert.equal(canDecideAsset(access("member", "owner"), actorId, null, unownedCommonAsset), false);
  assert.equal(canDecideAsset(access("admin", null), actorId, null, unownedCommonAsset), true);
});

test("通用库资产的审核权只认平台 admin，资产所有者也不能自审", () => {
  assert.equal(canDecideAsset(access("admin", null), actorId, null, strangerCommonAsset), true);
  assert.equal(canDecideAsset(access("member", "owner"), actorId, null, ownCommonAsset), false);
  assert.equal(canDecideAsset(access("operator", "owner"), actorId, null, ownCommonAsset), false);
  assert.equal(canDecideAsset(access("member", "viewer"), actorId, null, ownCommonAsset), false);
});

test("提审与批准是同一次全平台写入，共用同一道守卫", () => {
  // 反向同样要拦：否则可以把别人已过审的通用素材打回 pending_review，
  // 全平台的付费生成随之被卡住。
  assert.equal(canChangeAssetReviewState(access("member", "owner"), actorId, strangerCommonAsset), false);
  assert.equal(canChangeAssetReviewState(access("member", "owner"), actorId, unownedCommonAsset), false);
  assert.equal(canChangeAssetReviewState(access("member", "owner"), actorId, ownCommonAsset), false);
  assert.equal(canChangeAssetReviewState(access("admin", null), actorId, strangerCommonAsset), true);
  assert.equal(canChangeAssetReviewState(access("member", "owner"), actorId, ownPersonalAsset), false);
});

test("生成产物只属于一个项目，审核仍按项目矩阵判定", () => {
  assert.equal(canDecideProjectReview(access("member", "owner"), actorId, null), true);
  assert.equal(canDecideProjectReview(access("member", "editor"), actorId, null), false);
  assert.equal(canDecideProjectReview(access("member", "viewer"), actorId, actorId), true);
  assert.equal(canDecideProjectReview(access("admin", null), actorId, null), true);
  assert.equal(canDecideProjectReview(access("operator", "viewer"), actorId, actorId), false);
});

function access(
  platformRole: ProjectAccess["platformRole"],
  membershipRole: ProjectAccess["membershipRole"],
): ProjectAccess {
  return {
    projectId,
    actorId,
    platformRole,
    membershipRole,
    isPlatformObserver: platformRole === "admin" || platformRole === "operator",
  };
}

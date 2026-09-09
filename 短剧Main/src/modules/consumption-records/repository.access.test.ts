import assert from "node:assert/strict";
import test from "node:test";
import {
  COST_READABLE_MEMBER_ROLES,
  isCostReadableMemberRole,
} from "./repository.js";

test("成本账本只将 owner/editor 当作普通成员的可见范围", () => {
  assert.deepEqual(COST_READABLE_MEMBER_ROLES, ["owner", "editor"]);
  assert.equal(isCostReadableMemberRole("owner"), true);
  assert.equal(isCostReadableMemberRole("editor"), true);
  assert.equal(isCostReadableMemberRole("viewer"), false);
  assert.equal(isCostReadableMemberRole(null), false);
  assert.equal(isCostReadableMemberRole(undefined), false);
});

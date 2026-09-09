import assert from "node:assert/strict";
import test from "node:test";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { ProjectAccessService, canPerformProjectAction, resolveProjectAccess } from "./service.js";
import type { ProjectAccessRecord } from "./types.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const otherUserId = "33333333-3333-4333-8333-333333333333";

test("项目 owner 在迁移补成员行前仍保留完整访问，成员表是正常来源", () => {
  const legacyOwner = resolveProjectAccess(
    { id: actorId, role: "member" },
    record({ ownerUserId: actorId, membershipRole: null }),
  );
  assert.ok(legacyOwner);
  assert.equal(legacyOwner.membershipRole, "owner");
  assert.equal(canPerformProjectAction(legacyOwner, "create"), true);
  assert.equal(canPerformProjectAction(legacyOwner, "manage_members"), true);
  assert.equal(canPerformProjectAction(legacyOwner, "delete"), true);

  const memberOwner = resolveProjectAccess(
    { id: actorId, role: "member" },
    record({ ownerUserId: otherUserId, membershipRole: "owner" }),
  );
  assert.ok(memberOwner);
  assert.equal(memberOwner.membershipRole, "owner");
  assert.equal(canPerformProjectAction(memberOwner, "manage_review_policy"), true);
});

test("editor 和 viewer 严格按项目动作矩阵工作", () => {
  const editor = mustResolve({ id: actorId }, record({ membershipRole: "editor" }));
  assert.equal(canPerformProjectAction(editor, "read"), true);
  assert.equal(canPerformProjectAction(editor, "create"), true);
  assert.equal(canPerformProjectAction(editor, "view_costs"), true);
  assert.equal(canPerformProjectAction(editor, "manage_members"), false);
  assert.equal(canPerformProjectAction(editor, "manage_review_policy"), false);
  assert.equal(canPerformProjectAction(editor, "delete"), false);

  const viewer = mustResolve({ id: actorId }, record({ membershipRole: "viewer" }));
  assert.equal(canPerformProjectAction(viewer, "read"), true);
  assert.equal(canPerformProjectAction(viewer, "create"), false);
  assert.equal(canPerformProjectAction(viewer, "view_costs"), false);
  assert.equal(canPerformProjectAction(viewer, "manage_members"), false);
});

test("admin 全权限，operator 只可跨项目读取和看成本", () => {
  const admin = mustResolve({ id: actorId, role: "admin" }, record({ ownerUserId: otherUserId }));
  for (const action of ["read", "create", "manage_members", "manage_review_policy", "view_costs", "delete"] as const) {
    assert.equal(canPerformProjectAction(admin, action), true, `admin ${action}`);
  }

  const operator = mustResolve({ id: actorId, role: "operator" }, record({ ownerUserId: otherUserId }));
  assert.equal(operator.isPlatformObserver, true);
  assert.equal(canPerformProjectAction(operator, "read"), true);
  assert.equal(canPerformProjectAction(operator, "view_costs"), true);
  assert.equal(canPerformProjectAction(operator, "create"), false);
  assert.equal(canPerformProjectAction(operator, "manage_members"), false);
  assert.equal(canPerformProjectAction(operator, "delete"), false);
});

test("不存在项目和非成员一律变成相同的 404，不泄露项目存在性", async () => {
  const service = new ProjectAccessService({
    findAccessRecord: async (_actorId, requestedProjectId) => (
      requestedProjectId === projectId ? record({ ownerUserId: otherUserId }) : null
    ),
  });

  await assert.rejects(
    service.requireReadable({ id: actorId, role: "member" }, projectId),
    hasHiddenProjectNotFound,
  );
  await assert.rejects(
    service.requireReadable({ id: actorId, role: "member" }, "44444444-4444-4444-8444-444444444444"),
    hasHiddenProjectNotFound,
  );
});

test("已是成员但动作不允许时返回 403，而不是伪装成项目不存在", async () => {
  const service = new ProjectAccessService({
    findAccessRecord: async () => record({ membershipRole: "viewer" }),
  });

  await assert.rejects(
    service.requireCreative({ id: actorId, role: "member" }, projectId),
    hasProjectActionForbidden,
  );
  await assert.rejects(
    service.requireOwner({ id: actorId, role: "member" }, projectId),
    hasProjectActionForbidden,
  );
});

test("operator 可跨项目读，但写操作返回 403", async () => {
  const service = new ProjectAccessService({
    findAccessRecord: async () => record({ ownerUserId: otherUserId }),
  });
  await service.requireReadable({ id: actorId, role: "operator" }, projectId);
  await assert.rejects(
    service.requireCreative({ id: actorId, role: "operator" }, projectId),
    hasProjectActionForbidden,
  );
});

test("service 查询后用同一服务矩阵做动作判定", async () => {
  const calls: Array<{ actorId: string; projectId: string }> = [];
  const service = new ProjectAccessService({
    findAccessRecord: async (actualActorId, actualProjectId) => {
      calls.push({ actorId: actualActorId, projectId: actualProjectId });
      return record({ membershipRole: "editor" });
    },
  });
  const access = await service.requireCreative({ id: actorId }, projectId);
  assert.equal(access.membershipRole, "editor");
  assert.deepEqual(calls, [{ actorId, projectId }]);
  await assert.rejects(
    service.requireOwner({ id: actorId }, projectId),
    hasProjectActionForbidden,
  );
});

test("批量读取过滤一次查询并在计算计数前摘除隐藏项目", async () => {
  const editorProject = "44444444-4444-4444-8444-444444444444";
  const hiddenProject = "55555555-5555-4555-8555-555555555555";
  const missingProject = "66666666-6666-4666-8666-666666666666";
  const calls: string[][] = [];
  const service = new ProjectAccessService({
    findAccessRecord: async () => {
      throw new Error("批量投影不应退化为逐项目查询");
    },
    findAccessRecords: async (actualActorId, projectIds) => {
      assert.equal(actualActorId, actorId);
      calls.push(projectIds);
      return [
        record({ projectId, ownerUserId: actorId }),
        record({ projectId: editorProject, membershipRole: "editor" }),
        record({ projectId: hiddenProject, membershipRole: null }),
      ];
    },
  });
  const visible = await service.filterReadableProjectIds(
    { id: actorId, role: "member" },
    [projectId, editorProject, hiddenProject, missingProject, editorProject],
  );
  assert.deepEqual([...visible].sort(), [editorProject, projectId].sort());
  assert.deepEqual(calls, [[projectId, editorProject, hiddenProject, missingProject]]);
});

function record(overrides: Partial<ProjectAccessRecord> = {}): ProjectAccessRecord {
  return {
    projectId,
    ownerUserId: otherUserId,
    membershipRole: null,
    ...overrides,
  };
}

function mustResolve(
  actor: { id: string; role?: "admin" | "operator" | "member" },
  accessRecord: ProjectAccessRecord,
) {
  const access = resolveProjectAccess(actor, accessRecord);
  assert.ok(access);
  return access;
}

function hasHiddenProjectNotFound(error: unknown): boolean {
  return error instanceof NotFoundError
    && error.statusCode === 404
    && error.message === "项目不存在或你没有访问权限";
}

function hasProjectActionForbidden(error: unknown): boolean {
  return error instanceof ForbiddenError
    && error.statusCode === 403
    && error.message === "你没有在该项目中执行此操作的权限";
}

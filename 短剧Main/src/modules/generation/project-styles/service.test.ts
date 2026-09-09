import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestError } from "../../../shared/errors.js";
import { PROJECT_STYLE_CONTENT_MAX, PROJECT_STYLE_NAME_MAX } from "./types.js";
import type { ProjectStyle, ProjectStyleInput } from "./types.js";
import { ProjectStyleService } from "./service.js";
import type { ProjectStyleStore } from "./service.js";

const now = new Date("2026-08-13T00:00:00.000Z");
const projectId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const styleId = "44444444-4444-4444-8444-444444444444";
const fixture: ProjectStyle = {
  id: styleId,
  projectId,
  mediaKind: "image",
  name: "港风霓虹",
  content: "港风霓虹，暖色调，胶片颗粒，电影级质感",
  isDefault: false,
  createdByUserId: actorId,
  deletedByUserId: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

function store(overrides: Partial<ProjectStyleStore> = {}): ProjectStyleStore {
  return {
    listForActor: async () => [fixture],
    createForActor: async () => fixture,
    updateForActor: async () => fixture,
    softDeleteForActor: async () => undefined,
    setDefaultForActor: async () => ({ ...fixture, isDefault: true }),
    unsetDefaultForActor: async () => ({ ...fixture, isDefault: false }),
    ...overrides,
  };
}

const input: ProjectStyleInput = {
  mediaKind: "image",
  name: "港风霓虹",
  content: "港风霓虹，暖色调，胶片颗粒，电影级质感",
};

test("风格库服务写入前做 trim 归一化，并完整透传项目与创建人", async () => {
  const calls: Array<{ actorId: string; projectId: string; input: ProjectStyleInput }> = [];
  const service = new ProjectStyleService(store({
    createForActor: async (id, pid, normalized) => {
      calls.push({ actorId: id, projectId: pid, input: normalized });
      return { ...fixture, ...normalized };
    },
  }));
  const result = await service.create(actorId, projectId, {
    ...input,
    name: "  港风霓虹  ",
    content: "  港风霓虹，暖色调，胶片颗粒，电影级质感  ",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.actorId, actorId);
  assert.equal(calls[0]?.projectId, projectId);
  assert.deepEqual(calls[0]?.input, input, "写入仓库的必须是 trim 后的干净值");
  assert.equal(result.content, "港风霓虹，暖色调，胶片颗粒，电影级质感");
});

test("风格库服务拒绝空名/超长名/空内容/超长内容，不落地仓库", async () => {
  const calls: unknown[] = [];
  const service = new ProjectStyleService(store({
    createForActor: async () => {
      calls.push("should-not-be-called");
      return fixture;
    },
  }));
  const tooLongContent = `content-${"x".repeat(PROJECT_STYLE_CONTENT_MAX)}`;
  const tooLongName = `name-${"y".repeat(PROJECT_STYLE_NAME_MAX)}`;
  const badCases = [
    { label: "空名", input: { ...input, name: "   " } },
    { label: "超长名", input: { ...input, name: tooLongName } },
    { label: "空内容", input: { ...input, content: "" } },
    { label: "超长内容", input: { ...input, content: tooLongContent } },
  ];
  for (const item of badCases) {
    await assert.rejects(
      service.create(actorId, projectId, item.input),
      (error: unknown) => error instanceof BadRequestError,
      item.label,
    );
  }
  assert.deepEqual(calls, [], "校验失败不得触碰仓库");
});

test("风格库服务更新同样做 trim 归一化；设默认与软删仅委托仓库，不引入额外语义", async () => {
  const calls: unknown[] = [];
  const service = new ProjectStyleService(store({
    updateForActor: async (id, pid, sid, normalized) => {
      calls.push({ method: "update", id, pid, sid, normalized });
      return { ...fixture, ...normalized };
    },
    setDefaultForActor: async (id, pid, sid) => {
      calls.push({ method: "setDefault", id, pid, sid });
      return { ...fixture, isDefault: true };
    },
    unsetDefaultForActor: async (id, pid, sid) => {
      calls.push({ method: "unsetDefault", id, pid, sid });
      return { ...fixture, isDefault: false };
    },
    softDeleteForActor: async (id, pid, sid) => {
      calls.push({ method: "softDelete", id, pid, sid });
      return undefined;
    },
  }));

  const updated = await service.update(actorId, projectId, styleId, {
    ...input,
    name: " 改名 ",
    content: " 新内容 ",
  });
  assert.deepEqual(calls, [{
    method: "update",
    id: actorId,
    pid: projectId,
    sid: styleId,
    normalized: { mediaKind: "image", name: "改名", content: "新内容" },
  }]);
  assert.equal(updated.name, "改名");

  calls.length = 0;
  const defaulted = await service.setDefault(actorId, projectId, styleId);
  assert.equal(defaulted.isDefault, true);
  assert.deepEqual(calls, [{ method: "setDefault", id: actorId, pid: projectId, sid: styleId }]);

  // D1（2026-08-17 修订）：取消默认 = 独立委托方法，服务层不引入额外语义。
  calls.length = 0;
  const undefaulted = await service.unsetDefault(actorId, projectId, styleId);
  assert.equal(undefaulted.isDefault, false);
  assert.deepEqual(calls, [{ method: "unsetDefault", id: actorId, pid: projectId, sid: styleId }]);

  calls.length = 0;
  await service.softDelete(actorId, projectId, styleId);
  assert.deepEqual(calls, [{ method: "softDelete", id: actorId, pid: projectId, sid: styleId }]);
});

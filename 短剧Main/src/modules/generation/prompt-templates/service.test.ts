import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestError } from "../../../shared/errors.js";
import { PROMPT_TEMPLATE_CONTENT_MAX, PROMPT_TEMPLATE_NAME_MAX } from "./types.js";
import type { PromptTemplate, PromptTemplateInput } from "./types.js";
import { PromptTemplateService } from "./service.js";
import type { PromptTemplateStore } from "./service.js";

const now = new Date("2026-08-13T00:00:00.000Z");
const projectId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const templateId = "44444444-4444-4444-8444-444444444444";
const fixture: PromptTemplate = {
  id: templateId,
  projectId,
  mediaKind: "image",
  name: "写实电影质感",
  content: "写实电影质感，自然光，浅景深",
  createdByUserId: actorId,
  deletedByUserId: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

function store(overrides: Partial<PromptTemplateStore> = {}): PromptTemplateStore {
  return {
    listForActor: async () => [fixture],
    getForActor: async () => fixture,
    createForActor: async () => fixture,
    updateForActor: async () => fixture,
    softDeleteForActor: async () => undefined,
    ...overrides,
  };
}

const input: PromptTemplateInput = {
  mediaKind: "image",
  name: "写实电影质感",
  content: "写实电影质感，自然光，浅景深",
};

test("模板库服务写入前做 trim 归一化，并完整透传项目与创建人", async () => {
  const calls: Array<{ actorId: string; projectId: string; input: PromptTemplateInput }> = [];
  const service = new PromptTemplateService(store({
    createForActor: async (id, pid, normalized) => {
      calls.push({ actorId: id, projectId: pid, input: normalized });
      return { ...fixture, ...normalized };
    },
  }));
  const result = await service.create(actorId, projectId, {
    ...input,
    name: "  写实电影质感  ",
    content: "  写实电影质感，自然光，浅景深  ",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.actorId, actorId);
  assert.equal(calls[0]?.projectId, projectId);
  assert.deepEqual(calls[0]?.input, input, "写入仓库的必须是 trim 后的干净值");
  assert.equal(result.content, "写实电影质感，自然光，浅景深");
});

test("模板库服务拒绝空名/超长名/空内容/超长内容，不落地仓库", async () => {
  const calls: unknown[] = [];
  const service = new PromptTemplateService(store({
    createForActor: async () => {
      calls.push("should-not-be-called");
      return fixture;
    },
  }));
  const tooLongContent = `content-${"x".repeat(PROMPT_TEMPLATE_CONTENT_MAX)}`;
  const tooLongName = `name-${"y".repeat(PROMPT_TEMPLATE_NAME_MAX)}`;
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
  assert.equal(calls.length, 0, "非法输入不得触碰仓库");
});

test("模板库服务更新同样做 trim 归一化，软删仅委托不引入删除语义", async () => {
  const updated: Array<{ templateId: string; input: PromptTemplateInput }> = [];
  const service = new PromptTemplateService(store({
    updateForActor: async (_id, _pid, tid, normalized) => {
      updated.push({ templateId: tid, input: normalized });
      return { ...fixture, ...normalized };
    },
    softDeleteForActor: async (id, pid, tid, authorizedProjectId) => {
      assert.equal(id, actorId);
      assert.equal(pid, projectId);
      assert.equal(tid, templateId);
      assert.equal(authorizedProjectId, "authz-project");
    },
  }));
  await service.update(actorId, projectId, templateId, { ...input, name: " 新名字 " }, "authz-project");
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.templateId, templateId);
  assert.equal(updated[0]?.input.name, "新名字");
  await service.softDelete(actorId, projectId, templateId, "authz-project");
});

import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestError } from "../../shared/errors.js";
import { ReferenceTestService, type ReferenceDefaultStore, type ReferenceTestStore } from "./service.js";
import type { ReferenceTest, ReferenceTestResult } from "./types.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const testId = "44444444-4444-4444-8444-444444444444";
const resultId = "55555555-5555-4555-8555-555555555555";

const referenceTest: ReferenceTest = {
  id: testId,
  projectId,
  name: "宫门夜外光线测试",
  mediaKind: "video",
  mode: "material_to_prompt",
  modelKey: "seedance-2-5",
  prompt: "女主从宫门阴影处走出",
  parameters: { duration_seconds: 5 },
  referenceMediaIds: [],
  createdByUserId: actorId,
  version: 1,
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
};

const result: ReferenceTestResult = {
  id: resultId,
  referenceTestId: testId,
  generationRequestId: "66666666-6666-4666-8666-666666666666",
  mediaResultId: "77777777-7777-4777-8777-777777777777",
  mediaKind: "video",
  mode: "material_to_prompt",
  modelKey: "seedance-2-5",
  parameters: { duration_seconds: 5 },
  createdByUserId: actorId,
  createdAt: "2026-07-21T00:01:00.000Z",
};

function store(overrides: Partial<ReferenceTestStore> = {}): ReferenceTestStore {
  return {
    assertProjectOwner: async () => undefined,
    create: async () => referenceTest,
    get: async () => referenceTest,
    list: async () => ({ items: [referenceTest], page: 1, pageSize: 20, hasNext: false }),
    update: async () => referenceTest,
    remove: async () => undefined,
    attachResult: async () => result,
    listResults: async () => ({ items: [{ ...result, referenceTestName: referenceTest.name, mediaResult: null }], page: 1, pageSize: 20, hasNext: false }),
    listProjectResults: async () => ({ items: [{ ...result, referenceTestName: referenceTest.name, mediaResult: null }], page: 1, pageSize: 20, hasNext: false }),
    getResultForDefault: async () => result,
    ...overrides,
  };
}

test("测试结果设为默认只写 generation-defaults，不创建任务或调用供应商", async () => {
  const calls: unknown[] = [];
  const defaults: ReferenceDefaultStore = {
    put: async (actor, project, input) => {
      calls.push({ actor, project, input });
      return { id: "default-id" } as never;
    },
  };
  const service = new ReferenceTestService(store(), defaults);

  await service.setResultAsDefault(actorId, projectId, testId, resultId, 2);

  assert.deepEqual(calls, [{
    actor: actorId,
    project: projectId,
    input: {
      mediaKind: "video",
      mode: "material_to_prompt",
      modelKey: "seedance-2-5",
      parameters: { duration_seconds: 5 },
      sourceGenerationRequestId: result.generationRequestId,
      expectedVersion: 2,
    },
  }]);
});

test("参考测试复用默认策略参数安全限制，拒绝密钥", async () => {
  const service = new ReferenceTestService(store(), { put: async () => ({}) as never });
  await assert.rejects(
    service.create(actorId, projectId, { ...referenceTest, parameters: { api_key: "forbidden" } }),
    (error: unknown) => error instanceof BadRequestError,
  );
});

test("参考素材不能重复，且不隐式创建结果或任务", async () => {
  let creates = 0;
  const service = new ReferenceTestService(store({
    create: async () => {
      creates += 1;
      return referenceTest;
    },
  }), { put: async () => ({}) as never });
  await assert.rejects(
    service.create(actorId, projectId, {
      ...referenceTest,
      referenceMediaIds: ["88888888-8888-4888-8888-888888888888", "88888888-8888-4888-8888-888888888888"],
    }),
    (error: unknown) => error instanceof BadRequestError,
  );
  assert.equal(creates, 0);
});

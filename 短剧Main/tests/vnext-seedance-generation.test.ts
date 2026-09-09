/**
 * vNext generation service unit tests.
 *
 * All provider, storage, and DB calls are replaced with deterministic fakes.
 * Zero real provider calls; zero paid execution.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { VnextGenerationService } from "../src/modules/vnext/generation/service.js";
import { VnextProviderRequestError } from "../src/modules/vnext/generation/errors.js";
import type { VnextGenerationStore } from "../src/modules/vnext/generation/repository.js";
import type { VnextRecoverableAttemptContext } from "../src/modules/vnext/generation/types.js";
import { Seedance25Provider } from "../src/modules/vnext/providers/seedance/seedance25Provider.js";

// ─── Fake primitives ──────────────────────────────────────────────────────────

const projectId = "aaaa0000-0000-4000-8000-000000000001";
const actorId   = "bbbb0000-0000-4000-8000-000000000002";
const intentId  = "cccc0000-0000-4000-8000-000000000003";
const taskId    = "dddd0000-0000-4000-8000-000000000004";
const attemptId = "eeee0000-0000-4000-8000-000000000005";
const controlPackageId = "ffff0000-0000-4000-8000-000000000006";
const referenceVersionId = "11110000-0000-4000-8000-000000000007";
const controlReferences = [{
  referenceId: "22220000-0000-4000-8000-000000000008",
  referenceVersionId,
  label: "角色参考",
  reason: "保持角色一致",
  position: 0,
  capabilitySnapshot: { version: "caps-1", capturedAt: "2026-08-16T00:00:00.000Z", capabilities: ["image-reference"] },
}];

const fakeIntent = {
  id: intentId,
  projectId,
  actorId,
  controlPackageId,
  controlPackageVersion: 1,
  references: controlReferences,
  finalPrompt: "雨夜巷口，人物回望",
  model: "ep-seedance25",
  parameters: { ratio: "9:16", resolution: "720p", durationSeconds: 4 },
  noBgm: true,
  estimatedCostFen: 100,
};

const fakeTask = {
  id: taskId,
  projectId,
  actorId,
  intentId,
  clientIdempotencyKey: "key-1",
  controlPackageId,
  controlPackageVersion: 1,
  references: controlReferences,
  provider: "seedance_2_5",
  model: "ep-seedance25",
  prompt: "雨夜巷口",
  noBgm: true,
  parameters: { ratio: "9:16", resolution: "720p", durationSeconds: 4, generateAudio: true },
  estimatedCostFen: 100,
  status: "created" as const,
  createdAt: "2026-08-16T00:00:00.000Z",
};

function makeAttempt(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: attemptId,
    taskId,
    attemptNo: 1,
    status,
    providerTaskId: null,
    providerRawStatus: null,
    providerResult: null,
    tosMedia: [],
    leaseOwner: "worker-1",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    errorCode: null,
    errorMessage: null,
    actualCostFen: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

// ─── Fake store ───────────────────────────────────────────────────────────────

class RecordingStore implements Partial<VnextGenerationStore> {
  calls: Array<{ method: string; args: unknown[] }> = [];
  private taskStatus: string;
  private attemptStatus: string;

  constructor(taskStatus = "created", attemptStatus = "created") {
    this.taskStatus = taskStatus;
    this.attemptStatus = attemptStatus;
  }

  record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  async createTask(input: Record<string, unknown>) {
    this.record("createTask", input);
    return { task: { ...fakeTask, ...input }, created: true };
  }
  async getTaskView(tid: string, pid: string) {
    this.record("getTaskView", tid, pid);
    return {
      task: { ...fakeTask, status: this.taskStatus as typeof fakeTask.status },
      latestAttempt: {
        id: attemptId,
        attemptNo: 1,
        status: this.attemptStatus as ReturnType<typeof makeAttempt>["status"],
        providerTaskId: null,
        tosMedia: [],
        errorCode: null,
        errorMessage: null,
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-16T00:00:00.000Z",
      },
    };
  }
  async getRecoverableContext(aid: string): Promise<VnextRecoverableAttemptContext> {
    this.record("getRecoverableContext", aid);
    return {
      task: fakeTask,
      attempt: makeAttempt(this.attemptStatus) as ReturnType<typeof makeAttempt>,
    };
  }
  async markSubmitting(aid: string, leaseOwner?: string) { this.record("markSubmitting", aid, leaseOwner); }
  async markProviderQueued(aid: string, ptid: string, rs: string) { this.record("markProviderQueued", aid, ptid, rs); }
  async markProviderProgress(aid: string, rs: string) { this.record("markProviderProgress", aid, rs); }
  async markProviderSucceeded(aid: string, result: unknown) { this.record("markProviderSucceeded", aid, result); }
  async markCopyingToTos(aid: string) { this.record("markCopyingToTos", aid); }
  async recordTosMedia(aid: string, item: unknown) { this.record("recordTosMedia", aid, item); }
  async markSucceeded(aid: string) { this.record("markSucceeded", aid); }
  async markFailed(input: unknown) { this.record("markFailed", input); }
  async markUnknownOutcome(aid: string, reason: string) { this.record("markUnknownOutcome", aid, reason); }
  async recordPollFailure(aid: string, reason: string) { this.record("recordPollFailure", aid, reason); }
  async claimNextAttempt() { return null; }
  async renewLease() { return true; }
  async releaseLease() { /* no-op */ }
}

function fakeProvider(overrides: {
  apiKey?: string;
  endpointModel?: string;
  submitResult?: ReturnType<typeof Promise.resolve<{ providerTaskId: string; rawStatus: string }>>;
  submitError?: Error;
  queryResult?: unknown;
  queryError?: Error;
}) {
  let submitCalled = false;
  let queryCalled = false;

  return new Seedance25Provider({
    apiKey: overrides.apiKey ?? "test-key",
    endpointModel: overrides.endpointModel ?? "ep-seedance25",
    baseUrl: "https://fake.ark/api/v3",
    timeoutMs: 5_000,
    fetchImpl: async (_url: unknown, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(init?.body as string ?? "{}") as Record<string, unknown>;
      const isQuery = (init as RequestInit | undefined)?.method === "GET";
      if (isQuery) {
        if (overrides.queryError) return Promise.reject(overrides.queryError);
        return new Response(JSON.stringify(overrides.queryResult ?? { status: "running" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (overrides.submitError) return Promise.reject(overrides.submitError);
      return new Response(JSON.stringify(overrides.submitResult ?? { id: "task-p1", status: "queued" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    },
  });
}

const access = {
  async assertRead() {},
  async assertWrite() {},
};

const intents = {
  async findById(intentId_: string, projectId_: string) {
    if (intentId_ === intentId && projectId_ === projectId) return fakeIntent;
    return null;
  },
};

const storage = {
  async downloadBytes(_url: string) {
    return { content: Buffer.from("fake-video"), contentType: "video/mp4", extension: "mp4" };
  },
  async uploadBytes(input: { content: Buffer; storagePath: string; contentType: string }) {
    return { bucket: "fake-bucket", storagePath: input.storagePath, storageUrl: `https://tos/${input.storagePath}` };
  },
};
const referenceResolver = {
  async resolve(_projectId: string, references: typeof controlReferences) {
    assert.deepEqual(references, controlReferences);
    return [{ referenceVersionId, kind: "image" as const, url: "https://reference.example/character.png" }];
  },
};

// ─── confirmIntent ────────────────────────────────────────────────────────────

test("confirmIntent: creates a task when capability is configured", async () => {
  const store = new RecordingStore();
  const service = new VnextGenerationService({
    store: store as unknown as VnextGenerationStore,
    intents,
    access,
    provider: fakeProvider({}),
    storage,
    referenceResolver,
  });
  await service.confirmIntent(actorId, projectId, intentId, "idem-key-1");
  const create = store.calls.find((c) => c.method === "createTask");
  assert.ok(create, "createTask should have been called");
  const input = create.args[0] as Record<string, unknown>;
  assert.equal(input["provider"], "seedance_2_5");
  assert.equal(input["noBgm"], true);
  assert.deepEqual(input["references"], controlReferences);
});

test("confirmIntent: fails closed when apiKey is absent", async () => {
  const store = new RecordingStore();
  const service = new VnextGenerationService({
    store: store as unknown as VnextGenerationStore,
    intents,
    access,
    provider: fakeProvider({ apiKey: "" }),
    storage,
    referenceResolver,
  });
  await assert.rejects(
    () => service.confirmIntent(actorId, projectId, intentId, "idem-key-2"),
    (err: unknown) => err instanceof Error && err.message.includes("ARK_API_KEY"),
  );
  // Must not have called createTask.
  assert.ok(!store.calls.some((c) => c.method === "createTask"));
});

test("confirmIntent: fails closed when endpointModel is absent", async () => {
  const store = new RecordingStore();
  const service = new VnextGenerationService({
    store: store as unknown as VnextGenerationStore,
    intents,
    access,
    provider: fakeProvider({ endpointModel: "" }),
    storage,
    referenceResolver,
  });
  await assert.rejects(
    () => service.confirmIntent(actorId, projectId, intentId, "idem-key-3"),
    (err: unknown) => err instanceof Error && err.message.includes("ARK_VIDEO_MODEL_2_5"),
  );
  assert.ok(!store.calls.some((c) => c.method === "createTask"));
});

test("confirmIntent: fails when intent belongs to different actor", async () => {
  const store = new RecordingStore();
  const wrongIntents = {
    async findById() {
      return { ...fakeIntent, actorId: "other-actor-uuid" };
    },
  };
  const service = new VnextGenerationService({
    store: store as unknown as VnextGenerationStore,
    intents: wrongIntents,
    access,
    provider: fakeProvider({}),
    storage,
    referenceResolver,
  });
  await assert.rejects(
    () => service.confirmIntent(actorId, projectId, intentId, "idem-key-4"),
    (err: unknown) => err instanceof Error && err.message.includes("权限"),
  );
});

// ─── runRecoverableAttempt: submit phase ──────────────────────────────────────

test("runRecoverableAttempt[created]: marks submitting then provider_queued on success", async () => {
  const store = new RecordingStore("running", "created");
  // Override getRecoverableContext so the second call (after pollAttempt after markProviderQueued)
  // returns a terminal attempt and does not recurse.
  let ctxCalls = 0;
  store.getRecoverableContext = async (aid: string) => {
    ctxCalls++;
    const status = ctxCalls === 1 ? "created" : "provider_queued";
    return {
      task: fakeTask,
      attempt: makeAttempt(status, ctxCalls > 1 ? { providerTaskId: "task-xyz" } : {}),
    };
  };
  const service = new VnextGenerationService({
    store: store as unknown as VnextGenerationStore,
    intents,
    access,
    provider: fakeProvider({ queryResult: { id: "task-xyz", status: "running" } }),
    storage,
    referenceResolver,
  });
  await service.runRecoverableAttempt(attemptId, undefined, "worker-1");
  const submitCall = store.calls.find((call) => call.method === "markProviderQueued");
  assert.ok(submitCall, "provider submission must complete after resolving persisted references");
  assert.ok(store.calls.some((c) => c.method === "markSubmitting"));
  assert.ok(store.calls.some((c) => c.method === "markProviderQueued"));
});

test("runRecoverableAttempt[submitting]: becomes unknown_outcome (no auto-resubmit)", async () => {
  const store = new RecordingStore("running", "submitting");
  const service = new VnextGenerationService({
    store: store as unknown as VnextGenerationStore,
    intents,
    access,
    provider: fakeProvider({}),
    storage,
    referenceResolver,
  });
  await service.runRecoverableAttempt(attemptId, undefined, "worker-1");
  assert.ok(store.calls.some((c) => c.method === "markUnknownOutcome"));
  assert.ok(!store.calls.some((c) => c.method === "markSubmitting"));
});

test("runRecoverableAttempt[created]: 429 error marks attempt failed (not unknown)", async () => {
  const store = new RecordingStore("running", "created");
  const rateLimitFetch = async (_url: unknown, _init?: RequestInit): Promise<Response> => {
    return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429, headers: { "Content-Type": "application/json" },
    });
  };
  const rateLimitProvider = new (Seedance25Provider as unknown as new (opts: Record<string, unknown>) => Seedance25Provider)({
    apiKey: "test-key",
    endpointModel: "ep-seedance25",
    baseUrl: "https://fake.ark/api/v3",
    timeoutMs: 5_000,
    fetchImpl: rateLimitFetch,
  });

  const service = new VnextGenerationService({
    store: store as unknown as VnextGenerationStore,
    intents,
    access,
    provider: rateLimitProvider,
    storage,
    referenceResolver,
  });
  await service.runRecoverableAttempt(attemptId, undefined, "worker-1");
  const failCall = store.calls.find((c) => c.method === "markFailed");
  assert.ok(failCall, "markFailed should be called for 429");
  const input = failCall.args[0] as Record<string, unknown>;
  assert.equal(input["errorCode"], "RATE_LIMITED");
  assert.ok(!store.calls.some((c) => c.method === "markUnknownOutcome"), "unknown_outcome must not be called for 429");
});
test("runRecoverableAttempt[created]: local contract violation marks attempt failed", async () => {
  const store = new RecordingStore("running", "created");

  let fetchCalled = false;
  const contractProvider = new (Seedance25Provider as unknown as new (opts: Record<string, unknown>) => Seedance25Provider)({
    apiKey: "test-key",
    endpointModel: "ep-seedance25",
    baseUrl: "https://fake.ark/api/v3",
    timeoutMs: 5_000,
    fetchImpl: async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ id: "must-not-submit" }), { status: 200 });
    },
  });
  store.getRecoverableContext = async () => ({
    task: {
      ...fakeTask,
      parameters: { ratio: "9:16", resolution: "720p", durationSeconds: 4, generateAudio: true },
    },
    attempt: makeAttempt("created"),
  });
  const service = new VnextGenerationService({
    store: store as unknown as VnextGenerationStore,
    intents,
    access,
    provider: contractProvider,
    storage,
    referenceResolver: {
      async resolve() {
        return [{ referenceVersionId, kind: "video" as const, url: "https://reference.example/origin.mp4", durationSeconds: 4 }];
      },
    },
  });
  await service.runRecoverableAttempt(attemptId, undefined, "worker-1");
  const failCall = store.calls.find((call) => call.method === "markFailed");
  assert.ok(failCall, "contract violation must be deterministically failed");
  const input = failCall.args[0] as Record<string, unknown>;
  assert.equal(input["errorCode"], "SEEDANCE25_LOCKED_TASK_PARAMETERS_INVALID");
  assert.ok(!store.calls.some((call) => call.method === "markUnknownOutcome"));
  assert.equal(fetchCalled, false, "local contract violation must not submit a paid request");
});

test("runRecoverableAttempt[provider_queued]: poll progress updates status", async () => {
  const store = new RecordingStore("running", "provider_queued");
  // Override getRecoverableContext to return a queued attempt with a providerTaskId.
  store.getRecoverableContext = async () => ({
    task: fakeTask,
    attempt: makeAttempt("provider_queued", { providerTaskId: "task-p1" }),
  });
  const service = new VnextGenerationService({
    store: store as unknown as VnextGenerationStore,
    intents,
    access,
    provider: fakeProvider({ queryResult: { id: "task-p1", status: "running" } }),
    storage,
    referenceResolver,
  });
  await service.runRecoverableAttempt(attemptId, undefined, "worker-1");
  assert.ok(store.calls.some((c) => c.method === "markProviderProgress"));
});

test("runRecoverableAttempt: terminal attempts return without any writes", async () => {
  for (const terminalStatus of ["succeeded", "failed", "unknown_outcome"]) {
    const store = new RecordingStore("succeeded", terminalStatus);
    const service = new VnextGenerationService({
      store: store as unknown as VnextGenerationStore,
      intents,
      access,
      provider: fakeProvider({}),
      storage,
      referenceResolver,
    });
    await service.runRecoverableAttempt(attemptId, undefined, "worker-1");
    const writes = store.calls.filter((c) => !["getRecoverableContext"].includes(c.method));
    assert.equal(writes.length, 0, `Status ${terminalStatus} should produce no writes; got: ${writes.map((c) => c.method).join(", ")}`);
  }
});

// ─── No-BGM applied correctly ─────────────────────────────────────────────────

test("confirmIntent: no-BGM audio constraint is injected into the task prompt", async () => {
  const store = new RecordingStore();
  const service = new VnextGenerationService({
    store: store as unknown as VnextGenerationStore,
    intents,
    access,
    provider: fakeProvider({}),
    storage,
    referenceResolver,
  });
  await service.confirmIntent(actorId, projectId, intentId, "idem-key-bgm");
  const create = store.calls.find((c) => c.method === "createTask");
  const prompt = (create?.args[0] as Record<string, unknown>)?.["prompt"] as string;
  assert.ok(prompt?.includes("背景音乐"), "Prompt should contain the no-BGM audio constraint");
  assert.ok(prompt?.includes("雨夜巷口"), "Prompt should retain the original content");
});

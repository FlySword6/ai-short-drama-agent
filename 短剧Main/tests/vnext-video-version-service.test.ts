/**
 * vNext video version service unit tests.
 *
 * All DB stores are deterministic in-memory fakes. Zero provider calls;
 * zero paid execution — the paid path stays behind the existing
 * generation-tasks confirmation, which is out of scope here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ConflictError, ForbiddenError } from "../src/shared/errors.js";
import type { ControlPackage, ControlPackageDraft } from "../src/modules/vnext/control-packages/types.js";
import type { PendingGenerationIntent } from "../src/modules/vnext/generation-intents/types.js";
import type { VnextGenerationTaskView } from "../src/modules/vnext/generation/types.js";
import { VnextVideoVersionService } from "../src/modules/vnext/video-versions/service.js";
import type {
  CreateVnextVideoChangeDraftInput,
  CreateVnextVideoVersionInput,
} from "../src/modules/vnext/video-versions/repository.js";
import type { VnextVideoChangeDraft, VnextVideoChangeDraftInput, VnextVideoVersion } from "../src/modules/vnext/video-versions/types.js";

const projectId = "aaaa0000-0000-4000-8000-000000000001";
const actorId = "bbbb0000-0000-4000-8000-000000000002";
const taskId = "dddd0000-0000-4000-8000-000000000004";
const attemptId = "eeee0000-0000-4000-8000-000000000005";
const controlPackageId = "ffff0000-0000-4000-8000-000000000006";

const tosItem = {
  providerResultKey: "0:https://cdn.example.com/video.mp4",
  storageBucket: "bucket",
  objectKey: "vnext/generation/t/a/0.mp4",
  storageUrl: "https://tos.example.com/vnext/generation/t/a/0.mp4",
  mimeType: "video/mp4",
  sha256: "a".repeat(64),
  durationSeconds: 4,
  copiedAt: "2026-08-17T00:00:00.000Z",
};

function makeTaskView(overrides: { taskStatus?: string; attemptStatus?: string; tosMedia?: typeof tosItem[]; intentId?: string } = {}): VnextGenerationTaskView {
  return {
    task: {
      id: taskId,
      projectId,
      actorId,
      intentId: overrides.intentId ?? "cccc0000-0000-4000-8000-000000000003",
      clientIdempotencyKey: "task-key",
      controlPackageId,
      controlPackageVersion: 1,
      references: [],
      provider: "seedance_2_5",
      model: "ep-seedance25",
      prompt: "雨夜巷口，人物回望",
      noBgm: true,
      parameters: { ratio: "9:16", durationSeconds: 4 },
      estimatedCostFen: 100,
      status: (overrides.taskStatus ?? "succeeded") as VnextGenerationTaskView["task"]["status"],
      createdAt: "2026-08-16T00:00:00.000Z",
    },
    latestAttempt: {
      id: attemptId,
      attemptNo: 1,
      status: (overrides.attemptStatus ?? "succeeded") as NonNullable<VnextGenerationTaskView["latestAttempt"]>["status"],
      providerTaskId: "prov-1",
      tosMedia: overrides.tosMedia ?? [tosItem],
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:01:00.000Z",
    },
  };
}

function makeIntent(id: string, packageVersion = 1): PendingGenerationIntent {
  return {
    id,
    projectId,
    actorId,
    clientIdempotencyKey: "draft-key",
    controlPackageId,
    controlPackageVersion: packageVersion,
    references: [],
    finalPrompt: "雨夜巷口，人物回望",
    model: "ep-seedance25",
    parameters: { ratio: "9:16" },
    noBgm: true,
    estimatedCostFen: 100,
    status: "pending_confirmation",
    createdAt: "2026-08-16T00:00:00.000Z",
  };
}

class FakeVersions {
  readonly rows: VnextVideoVersion[] = [];
  createCalls = 0;
  async listByProject(): Promise<VnextVideoVersion[]> { return this.rows; }
  async findById(versionId: string): Promise<VnextVideoVersion | null> {
    return this.rows.find((row) => row.id === versionId) ?? null;
  }
  async create(input: CreateVnextVideoVersionInput): Promise<{ version: VnextVideoVersion; created: boolean }> {
    this.createCalls += 1;
    const prior = this.rows.find((row) => row.sourceAttemptId === input.sourceAttemptId);
    if (prior) return { version: prior, created: false };
    const origin = input.originVersionId ? this.rows.find((row) => row.id === input.originVersionId) : null;
    if (input.originVersionId && !origin) throw new Error("origin missing");
    if (origin && this.rows.some((row) => row.originVersionId === origin.id)) {
      throw new ConflictError("该视频段版本已经有后续版本", "video_version_chain_conflict");
    }
    const version: VnextVideoVersion = {
      id: `version-${this.rows.length + 1}`,
      projectId: input.projectId,
      chainId: origin ? origin.chainId : `version-${this.rows.length + 1}`,
      versionNo: origin ? origin.versionNo + 1 : 1,
      changeType: input.changeType,
      originVersionId: input.originVersionId,
      actorId: input.actorId,
      sourceTaskId: input.sourceTaskId,
      sourceAttemptId: input.sourceAttemptId,
      controlPackageId: input.controlPackageId,
      controlPackageVersion: input.controlPackageVersion,
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      parameters: input.parameters,
      tosMedia: input.tosMedia,
      estimatedCostFen: input.estimatedCostFen,
      actualCostFen: input.actualCostFen,
      createdAt: "2026-08-17T00:00:00.000Z",
    };
    this.rows.push(version);
    return { version, created: true };
  }
}

class FakeDrafts {
  readonly rows: VnextVideoChangeDraft[] = [];
  unlinkedIntentId: string | null = null;
  async findByKey(_project: string, _actor: string, key: string): Promise<VnextVideoChangeDraft | null> {
    return this.rows.find((row) => row.clientIdempotencyKey === key) ?? null;
  }
  async findByIntentId(intentId: string): Promise<VnextVideoChangeDraft | null> {
    return this.rows.find((row) => row.intentId === intentId) ?? null;
  }
  async findUnlinkedIntentIdByKey(): Promise<string | null> { return this.unlinkedIntentId; }
  async create(input: CreateVnextVideoChangeDraftInput): Promise<{ draft: VnextVideoChangeDraft; created: boolean }> {
    const prior = this.rows.find((row) => row.clientIdempotencyKey === input.clientIdempotencyKey);
    if (prior) return { draft: prior, created: false };
    const draft: VnextVideoChangeDraft = {
      id: `draft-${this.rows.length + 1}`,
      projectId: input.projectId,
      actorId: input.actorId,
      originVersionId: input.originVersionId,
      changeType: input.changeType,
      intentId: input.intentId,
      clientIdempotencyKey: input.clientIdempotencyKey,
      createdAt: "2026-08-17T00:00:00.000Z",
    };
    this.rows.push(draft);
    return { draft, created: true };
  }
}

class FakePackages {
  calls: ControlPackageDraft[] = [];
  async save(_actor: string, _project: string, draft: ControlPackageDraft): Promise<ControlPackage> {
    this.calls.push(draft);
    return {
      id: controlPackageId,
      projectId,
      version: this.calls.length,
      createdByUserId: actorId,
      createdAt: "2026-08-17T00:00:00.000Z",
      ...draft,
    };
  }
}

class FakeIntents {
  calls: string[] = [];
  intent = makeIntent("intent-1", 2);
  async createPending(_actor: string, _project: string, key: string): Promise<{ intent: PendingGenerationIntent; created: boolean }> {
    this.calls.push(key);
    return { intent: { ...this.intent, clientIdempotencyKey: key }, created: true };
  }
}

class FakePendingIntents {
  readonly byId = new Map<string, PendingGenerationIntent>();
  async findById(intentId: string): Promise<PendingGenerationIntent | null> {
    return this.byId.get(intentId) ?? null;
  }
}

function draftInput(overrides: Partial<VnextVideoChangeDraftInput> = {}): VnextVideoChangeDraftInput {
  return {
    changeType: "modify",
    clientIdempotencyKey: "draft-key",
    references: [{
      referenceId: "11110000-0000-4000-8000-000000000007",
      referenceVersionId: "11110000-0000-4000-8000-000000000007",
      label: "原视频段 v1",
      reason: "修改或续写的来源",
      position: 0,
      capabilitySnapshot: {
        version: "vnext-video-version",
        capturedAt: "2026-08-17T00:00:00.000Z",
        capabilities: ["video-reference"],
      },
    }],
    finalPrompt: "雨夜巷口，人物回望（修改）",
    model: "ep-seedance25",
    parameters: { ratio: "9:16", durationSeconds: 4 },
    noBgm: true,
    modelAvailability: { status: "available", checkedAt: "2026-08-17T00:00:00.000Z" },
    estimatedCostFen: 120,
    ...overrides,
  };
}

function makeService(overrides: {
  versions?: FakeVersions;
  drafts?: FakeDrafts;
  packages?: FakePackages;
  intents?: FakeIntents;
  pendingIntents?: FakePendingIntents;
  lockedTaskParameters?: { lockedTaskParameters(): Record<string, unknown> };
  taskView?: VnextGenerationTaskView | null;
  denyWrite?: boolean;
} = {}) {
  const versions = overrides.versions ?? new FakeVersions();
  const drafts = overrides.drafts ?? new FakeDrafts();
  const packages = overrides.packages ?? new FakePackages();
  const intents = overrides.intents ?? new FakeIntents();
  const pendingIntents = overrides.pendingIntents ?? new FakePendingIntents();
  const taskView = "taskView" in overrides ? overrides.taskView! : makeTaskView();
  const lockedTaskParameters = overrides.lockedTaskParameters ?? {
    lockedTaskParameters: () => ({ ratio: "adaptive", durationSeconds: -1 }),
  };
  const service = new VnextVideoVersionService({
    versions,
    drafts,
    access: {
      async assertRead(): Promise<void> {},
      async assertWrite(): Promise<void> {
        if (overrides.denyWrite) throw new ForbiddenError("没有写权限");
      },
    },
    controlPackages: packages,
    intents,
    pendingIntents,
    generationTasks: {
      async getTaskView(): Promise<VnextGenerationTaskView | null> { return taskView; },
    },
    lockedTaskParameters,
  });
  return { service, versions, drafts, packages, intents, pendingIntents };
}

test("register appends an immutable version 1 from a succeeded task's TOS media", async () => {
  const { service, versions } = makeService();
  const { version, created } = await service.attachSucceededTask(actorId, projectId, taskId);
  assert.equal(created, true);
  assert.equal(version.changeType, "register");
  assert.equal(version.originVersionId, null);
  assert.equal(version.versionNo, 1);
  assert.equal(version.chainId, version.id);
  assert.equal(version.sourceTaskId, taskId);
  assert.equal(version.sourceAttemptId, attemptId);
  assert.equal(version.controlPackageId, controlPackageId);
  assert.equal(version.prompt, "雨夜巷口，人物回望");
  assert.equal(version.model, "ep-seedance25");
  assert.equal(version.provider, "seedance_2_5");
  assert.equal(version.estimatedCostFen, 100);
  assert.equal(version.tosMedia.length, 1);
  assert.equal(version.tosMedia[0]?.storageUrl, tosItem.storageUrl);
  assert.equal(versions.createCalls, 1);

  // Idempotent replay: same attempt replays the same version row.
  const replay = await service.attachSucceededTask(actorId, projectId, taskId);
  assert.equal(replay.created, false);
  assert.equal(replay.version.id, version.id);
  assert.equal(versions.rows.length, 1);
});

test("failed or unfinished tasks never produce version rows", async () => {
  for (const overrides of [
    { taskStatus: "failed", attemptStatus: "failed" },
    { taskStatus: "running", attemptStatus: "provider_running" },
    { taskStatus: "succeeded", attemptStatus: "succeeded", tosMedia: [] as typeof tosItem[] },
  ]) {
    const { service, versions } = makeService({ taskView: makeTaskView(overrides) });
    await assert.rejects(
      service.attachSucceededTask(actorId, projectId, taskId),
      (error: unknown) => (error as { code?: string }).code === "video_version_source_not_succeeded",
    );
    assert.equal(versions.createCalls, 0);
    assert.equal(versions.rows.length, 0);
  }
});

test("change draft snapshots reviewed inputs without any provider call", async () => {
  const versions = new FakeVersions();
  const { service, drafts, packages, intents } = makeService({ versions });
  const root = (await service.attachSucceededTask(actorId, projectId, taskId)).version;

  const result = await service.createChangeDraft(actorId, projectId, root.id, draftInput());
  assert.equal(result.created, true);
  assert.equal(result.draft.originVersionId, root.id);
  assert.equal(result.draft.changeType, "modify");
  assert.equal(result.draft.intentId, "intent-1");
  assert.ok(result.controlPackage);
  assert.equal(result.controlPackage.finalPrompt, "雨夜巷口，人物回望（修改）");
  assert.equal(result.controlPackage.estimatedCostFen, 120);
  assert.deepEqual(result.controlPackage.references, draftInput().references);
  assert.deepEqual(intents.calls, ["draft-key"]);
  assert.equal(packages.calls.length, 1);
  assert.equal(drafts.rows.length, 1);
});

test("change draft overrides caller parameters with locked-task source values", async () => {
  const versions = new FakeVersions();
  let lockedTaskParametersCalls = 0;
  const { service, packages } = makeService({
    versions,
    lockedTaskParameters: {
      lockedTaskParameters: () => {
        lockedTaskParametersCalls += 1;
        return { ratio: "adaptive", durationSeconds: -1 };
      },
    },
  });
  const root = (await service.attachSucceededTask(actorId, projectId, taskId)).version;

  await service.createChangeDraft(actorId, projectId, root.id, draftInput({
    parameters: { ratio: "9:16", durationSeconds: 4, resolution: "720p" },
  }));

  assert.equal(lockedTaskParametersCalls, 1);
  assert.deepEqual(packages.calls[0]?.parameters, {
    ratio: "adaptive",
    durationSeconds: -1,
    resolution: "720p",
  });
});

test("change draft replay does not write another control package", async () => {
  const versions = new FakeVersions();
  const drafts = new FakeDrafts();
  const packages = new FakePackages();
  const pendingIntents = new FakePendingIntents();
  const { service } = makeService({ versions, drafts, packages, pendingIntents });
  const root = (await service.attachSucceededTask(actorId, projectId, taskId)).version;

  const first = await service.createChangeDraft(actorId, projectId, root.id, draftInput());
  pendingIntents.byId.set(first.intent.id, first.intent);
  assert.equal(packages.calls.length, 1);

  const replay = await service.createChangeDraft(actorId, projectId, root.id, draftInput());
  assert.equal(replay.created, false);
  assert.equal(replay.draft.id, first.draft.id);
  assert.equal(replay.intent.id, first.intent.id);
  assert.equal(replay.controlPackage, null);
  assert.equal(packages.calls.length, 1);
  assert.equal(drafts.rows.length, 1);
});

test("change draft recovers a crashed request that already created the intent", async () => {
  const versions = new FakeVersions();
  const drafts = new FakeDrafts();
  const packages = new FakePackages();
  const intents = new FakeIntents();
  const pendingIntents = new FakePendingIntents();
  const crashedIntent = makeIntent("intent-crashed", 2);
  drafts.unlinkedIntentId = crashedIntent.id;
  pendingIntents.byId.set(crashedIntent.id, crashedIntent);
  const { service } = makeService({ versions, drafts, packages, intents, pendingIntents });
  const root = (await service.attachSucceededTask(actorId, projectId, taskId)).version;

  const recovered = await service.createChangeDraft(actorId, projectId, root.id, draftInput({ changeType: "extend" }));
  assert.equal(recovered.created, true);
  assert.equal(recovered.intent.id, crashedIntent.id);
  assert.equal(recovered.draft.intentId, crashedIntent.id);
  assert.equal(recovered.draft.changeType, "extend");
  assert.equal(recovered.controlPackage, null);
  assert.equal(packages.calls.length, 0, "must not write a second control package");
  assert.equal(intents.calls.length, 0, "must not create a second intent");
});

test("change draft requires an existing origin version and write access", async () => {
  const { service } = makeService();
  await assert.rejects(
    service.createChangeDraft(actorId, projectId, "99990000-0000-4000-8000-000000000099", draftInput()),
    /原视频段版本不存在/,
  );
  const denied = makeService({ denyWrite: true });
  await assert.rejects(
    denied.service.createChangeDraft(actorId, projectId, "99990000-0000-4000-8000-000000000099", draftInput()),
    (error: unknown) => error instanceof ForbiddenError,
  );
  await assert.rejects(
    denied.service.attachSucceededTask(actorId, projectId, taskId),
    (error: unknown) => error instanceof ForbiddenError,
  );
});

test("attaching a change task grows the origin chain with the draft's change type", async () => {
  const versions = new FakeVersions();
  const { service, drafts } = makeService({ versions });
  const root = (await service.attachSucceededTask(actorId, projectId, taskId)).version;

  const draftResult = await service.createChangeDraft(actorId, projectId, root.id, draftInput({ changeType: "extend" }));
  assert.ok(drafts.rows[0]);

  // The confirmed change task references the draft's intent; its success
  // appends version 2 on the same chain without touching the origin row.
  const changeTaskView = makeTaskView({ intentId: draftResult.intent.id });
  changeTaskView.task = { ...changeTaskView.task, id: "dddd0000-0000-4000-8000-000000000099" };
  changeTaskView.latestAttempt = { ...changeTaskView.latestAttempt!, id: "eeee0000-0000-4000-8000-000000000099" };
  const growth = makeService({ versions, drafts, taskView: changeTaskView });
  const { version: child, created } = await growth.service.attachSucceededTask(actorId, projectId, changeTaskView.task.id);

  assert.equal(created, true);
  assert.equal(child.changeType, "extend");
  assert.equal(child.originVersionId, root.id);
  assert.equal(child.versionNo, 2);
  assert.equal(child.chainId, root.chainId);
  // Origin row is untouched: still version 1 with its own media and metadata.
  const originAfter = await versions.findById(root.id);
  assert.deepEqual(originAfter, root);
});

test("listVersions returns chains for refresh recovery", async () => {
  const { service } = makeService();
  await service.attachSucceededTask(actorId, projectId, taskId);
  const { items } = await service.listVersions(actorId, projectId);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.tosMedia[0]?.objectKey, tosItem.objectKey);
  assert.equal(items[0]?.estimatedCostFen, 100);
});

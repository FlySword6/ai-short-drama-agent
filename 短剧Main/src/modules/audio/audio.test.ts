import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ConflictError } from "../../shared/errors.js";
import { compileAudioPrompt } from "./prompts.js";
import { registerAudioRoutes } from "./routes.js";
import { AudioVersionService, DisabledAudioExtractionPort, requireTtsModel } from "./service.js";
import type { AudioVersion, AudioVersionRepository } from "./types.js";
import { CachedVoiceCatalog } from "./voiceCatalog.js";

test("六维声音方向与要朗读的台词分离，且保留空维度", () => {
  const compiled = compileAudioPrompt({ voiceReference: "低沉男声", paceAndPauses: "慢速，句末停顿" }, "我不会走的。 ");
  assert.equal(compiled.version, "sound-workshop-v1");
  assert.equal(compiled.dimensions.performanceEmotion, "");
  assert.equal(compiled.dimensions.voiceReference, "低沉男声");
  assert.equal(compiled.prompt, "我不会走的。");
  assert.doesNotMatch(compiled.prompt, /音色基准|语速停顿|补充/);
});

test("音频台词在进入供应商前剥离时间码，但保留自然语言时间", () => {
  const compiled = compileAudioPrompt(
    {},
    "[00:00.000-00:02.500] 第一行\n镜头2 00:02.500-00:04.000 第二行\n晚上 20:30 集合",
  );
  assert.equal(compiled.prompt, "第一行 镜头2 第二行 晚上 20:30 集合");
});

test("声音工坊生成 schema 复用既有付费链，并明确 BGM、时间码和合规默认值", async () => {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: "u", username: "u", displayName: "U" };
  });
  await registerAudioRoutes(app);
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/audio/generation-schema" });
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json().data as Record<string, any>;
    assert.equal(data.schema_version, "sound-workshop-generation-v1");
    assert.equal(data.media_kind, "audio");
    assert.equal(data.submission_flow.estimate, "/api/v1/generations/estimate");
    assert.equal(data.defaults.enable_subtitle, true);
    assert.equal(data.defaults.aigc_metadata_enabled, true);
    assert.equal(data.capabilities.background_music_generation, false);
    assert.equal(data.capabilities.timecodes_in_spoken_prompt, false);
    assert.equal(data.capabilities.paid_submission_requires_explicit_confirmation, true);
    assert.equal(data.limits.text_prompt_max_chars, 3_000);
    assert.equal(data.limits.reference_audio.max_count, 3);
  } finally {
    await app.close();
  }
});

test("音色库缓存、筛选，且不包含付费试听调用", async () => {
  let calls = 0;
  const catalog = new CachedVoiceCatalog({ listVoices: async () => {
    calls += 1;
    return [{ id: "voice-1", displayName: "旁白一", language: "zh", category: "旁白", gender: "female" }];
  } }, 60_000, () => 1);
  assert.equal((await catalog.list({ category: "旁白" })).length, 1);
  assert.equal((await catalog.list({ query: "voice" })).length, 1);
  assert.equal(calls, 1);
});

test("音色路由:有数据返回 200 + voices(含 audition_url),词表空返回 200 + 空数组 + reason", async () => {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => { request.authUser = { id: "u", username: "u", displayName: "U" }; });
  const voices = [
    { id: "zh_female_vv_uranus_bigtts", displayName: "Vivi 2.0", language: "中文", category: "通用场景", gender: "女" },
    { id: "zh_male_sunwukong_uranus_bigtts", displayName: "猴哥 2.0", auditionUrl: "https://tos.example.invalid/voice-auditions/x.mp3" },
  ];
  await registerAudioRoutes(app, { voiceCatalogProvider: { listVoices: async () => voices } });
  try {
    const ok = await app.inject({ method: "GET", url: "/api/v1/audio/voices" });
    assert.equal(ok.statusCode, 200);
    const payload = ok.json() as { data: { voices: Array<Record<string, unknown>>; reason?: string } };
    assert.equal(payload.data.voices.length, 2);
    assert.equal(payload.data.voices[0]!.display_name, "Vivi 2.0");
    assert.equal(payload.data.voices[1]!.audition_url, "https://tos.example.invalid/voice-auditions/x.mp3");
    assert.equal(payload.data.reason, undefined, "有数据时不得带 reason");

    // 筛选无命中:正常空结果,不带 reason(词表本身非空)。
    const filtered = await app.inject({ method: "GET", url: "/api/v1/audio/voices?category=%E4%B8%8D%E5%AD%98%E5%9C%A8" });
    assert.equal(filtered.statusCode, 200);
    const filteredPayload = filtered.json() as { data: { voices: unknown[]; reason?: string } };
    assert.deepEqual(filteredPayload.data.voices, []);
    assert.equal(filteredPayload.data.reason, undefined, "筛选无命中不得带 reason");
  } finally {
    await app.close();
  }
});

test("音色路由:词表为空(种子未播/全部停用)返回 200 + 空数组 + 明确 reason,不是 503", async () => {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => { request.authUser = { id: "u", username: "u", displayName: "U" }; });
  await registerAudioRoutes(app, { voiceCatalogProvider: { listVoices: async () => [] } });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/audio/voices" });
    assert.equal(response.statusCode, 200);
    const payload = response.json() as { data: { voices: unknown[]; reason?: string } };
    assert.deepEqual(payload.data.voices, []);
    assert.match(payload.data.reason ?? "", /词表为空/);
  } finally {
    await app.close();
  }
});

test("未进控制包的候选不能锁定，锁定只能由审核事实仓储放行", async () => {
  const repository = new MemoryAudioRepository();
  const service = new AudioVersionService(repository, () => new Date("2026-07-27T00:00:00.000Z"));
  await service.createCandidate(candidateInput);
  await assert.rejects(() => service.lock(candidateInput.mediaResultId, lockTarget), /请先选中/);
  repository.markSelectedFromControlPackage("selector");
  await assert.rejects(() => service.lock(candidateInput.mediaResultId, lockTarget), /审核/);
  await assert.rejects(() => service.lock(candidateInput.mediaResultId, { ...lockTarget, lockedAssetMediaId: "" }), /关联素材信息不完整/);
  repository.approvedForLock = true;
  const locked = await service.lock(candidateInput.mediaResultId, lockTarget);
  assert.equal(locked.status, "locked");
});

test("候选废弃使用条件更新，已离开 candidate 的版本不能被旧写入覆盖", async () => {
  const repository = new MemoryAudioRepository();
  const service = new AudioVersionService(repository, () => new Date("2026-07-27T00:00:00.000Z"));
  await service.createCandidate({ ...candidateInput, mediaResultId: "media-race" });
  repository.markSelectedFromControlPackage("selector");
  await assert.rejects(() => service.discard("media-race", "discarder"), (error: unknown) => {
    return error instanceof ConflictError
      && (error.code === "audio_version_not_discardable" || error.code === "audio_version_state_conflict");
  });
});

test("未注入 provider 的音色路由和提取端口均 fail-closed", async () => {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => { request.authUser = { id: "u", username: "u", displayName: "U" }; });
  await registerAudioRoutes(app, {
    projectAccessService: allowProjectAccess,
    extractionSourceRepository: { findProjectIdForExtractableVideo: async () => "11111111-1111-4111-8111-111111111111" },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/audio/voices" });
    assert.equal(response.statusCode, 503);
    const extract = await app.inject({
      method: "POST", url: "/api/v1/audio/extract",
      payload: { project_id: "11111111-1111-4111-8111-111111111111", source_media_result_id: "22222222-2222-4222-8222-222222222222" },
    });
    assert.equal(extract.statusCode, 501, extract.body);
    await assert.rejects(
      () => new DisabledAudioExtractionPort().extract(),
      (error: unknown) => error instanceof Error
        && error.message === "提取音轨没成：功能暂未准备好，请联系管理员处理。",
    );
    assert.throws(() => requireTtsModel({}), /OPENSPEECH_TTS_MODEL/);
  } finally {
    await app.close();
  }
});

test("注册音频路由不会在启动阶段抢占数据库", async () => {
  const app = Fastify({ logger: false });
  let databaseCalls = 0;
  await registerAudioRoutes(app, {
    getDatabase: () => {
      databaseCalls += 1;
      throw new Error("route registration must stay lazy");
    },
  });
  try {
    assert.equal(databaseCalls, 0);
  } finally {
    await app.close();
  }
});

test("生命周期路由没有脱离控制包的 select 入口，锁定也不会接收客户端伪造的审核布尔值", async () => {
  const app = Fastify({ logger: false });
  const repository = new MemoryAudioRepository();
  const service = new AudioVersionService(repository, () => new Date("2026-07-27T00:00:00.000Z"));
  await service.createCandidate({ ...candidateInput, mediaResultId: "33333333-3333-4333-8333-333333333333" });
  app.addHook("preHandler", async (request) => { request.authUser = { id: "actor", username: "u", displayName: "U" }; });
  await registerAudioRoutes(app, { lifecycleService: service, projectAccessService: allowProjectAccess });
  try {
    const selected = await app.inject({ method: "POST", url: "/api/v1/audio/versions/33333333-3333-4333-8333-333333333333/select" });
    assert.equal(selected.statusCode, 404, selected.body);
    repository.markSelectedFromControlPackage("actor");
    const lock = await app.inject({
      method: "POST",
      url: "/api/v1/audio/versions/33333333-3333-4333-8333-333333333333/lock",
      payload: {
        asset_entity_id: "44444444-4444-4444-8444-444444444444",
        asset_media_id: "55555555-5555-4555-8555-555555555555",
        project_asset_ref_id: "66666666-6666-4666-8666-666666666666",
        review_accepted: true,
      },
    });
    assert.equal(lock.statusCode, 400, lock.body);
  } finally {
    await app.close();
  }
});

test("提取端点在调用适配器前拒绝跨项目源视频", async () => {
  const app = Fastify({ logger: false });
  let extractionCalls = 0;
  app.addHook("preHandler", async (request) => { request.authUser = { id: "actor", username: "u", displayName: "U" }; });
  await registerAudioRoutes(app, {
    projectAccessService: allowProjectAccess,
    extractionSourceRepository: { findProjectIdForExtractableVideo: async () => "77777777-7777-4777-8777-777777777777" },
    extractionPort: {
      extract: async () => {
        extractionCalls += 1;
        throw new Error("must not be called");
      },
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/audio/extract",
      payload: {
        project_id: "11111111-1111-4111-8111-111111111111",
        source_media_result_id: "22222222-2222-4222-8222-222222222222",
      },
    });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(extractionCalls, 0);
  } finally {
    await app.close();
  }
});

const candidateInput = {
  id: "audio-1", projectId: "project-1", mediaResultId: "media-1", createdByUserId: "creator-1",
  complianceMetadata: { aigc_metadata: { enable: true } },
};
const lockTarget = {
  lockedAssetEntityId: "44444444-4444-4444-8444-444444444444",
  lockedAssetMediaId: "55555555-5555-4555-8555-555555555555",
  projectAssetRefId: "66666666-6666-4666-8666-666666666666",
};

class MemoryAudioRepository implements AudioVersionRepository {
  private value?: AudioVersion;
  approvedForLock = false;
  async createCandidate(input: typeof candidateInput, at: Date): Promise<AudioVersion> {
    this.value = { ...input, status: "candidate", createdAt: at, updatedAt: at };
    return this.value;
  }
  async findByMediaResultId(mediaResultId: string): Promise<AudioVersion | undefined> {
    return this.value?.mediaResultId === mediaResultId ? this.value : undefined;
  }
  async update(version: AudioVersion): Promise<AudioVersion> {
    // Mirror the production WHERE id AND status = 'candidate' transition so
    // the service test exercises the stale-read race rather than overwriting.
    if (!this.value || this.value.id !== version.id || this.value.status !== "candidate") {
      throw new ConflictError("修改音频没成：状态已变化，请刷新后再试。", "audio_version_state_conflict");
    }
    this.value = version;
    return version;
  }
  markSelectedFromControlPackage(actorId: string): void {
    if (!this.value || this.value.status !== "candidate") throw new Error("candidate required");
    const at = new Date("2026-07-27T00:00:00.000Z");
    this.value = {
      ...this.value,
      status: "selected",
      selectedByUserId: actorId,
      selectedAt: at,
      updatedAt: at,
    };
  }
  async lockSelectedAfterApprovedAssetReview(
    version: AudioVersion,
    target: typeof lockTarget,
    at: Date,
  ): Promise<AudioVersion> {
    if (!this.approvedForLock) throw new Error("审核未通过");
    this.value = { ...version, ...target, status: "locked", lockedAt: at, updatedAt: at };
    return this.value;
  }
}

const allowProjectAccess = {
  async requireReadable() { return {}; },
  async requireCreative() { return {}; },
};

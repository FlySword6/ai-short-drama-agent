import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GenerationError, ProviderRequestError } from "../../src/modules/generation/errors.js";
import type { GenerationProvider, GenerationStorage } from "../../src/modules/generation/ports.js";
import {
  assertAigcMetadataEvidence,
  assertAudioProviderMediaIntegrity,
  AudioProviderMediaIntegrityError,
  GenerationService,
  hashGenerationRequest,
  hashLegacyFullGenerationRequest,
  normalizeGenerationInput,
} from "../../src/modules/generation/service.js";
import type { GenerationServiceOptions } from "../../src/modules/generation/service.js";
import type { SubmitGenerationInput } from "../../src/modules/generation/types.js";
import { FakeGenerationRepository } from "./fakes.js";

const scopedUserActor = { userId: "user-1", authorizedProjectId: "project-1" };

describe("GenerationService", () => {
  it("FABLE-007 纯离线闭环经过报价、人工确认、单次 provider、AIGC、TOS 与持久化", async () => {
    const repository = new FakeGenerationRepository();
    let submitCalls = 0;
    let uploadedContent = "";
    const service = createService(
      repository,
      {
        submit: async (request) => {
          submitCalls += 1;
          assert.equal(request.model, "image-01");
          return {
            outcome: "succeeded",
            result: {
              status: "succeeded",
              media: [{
                kind: "image",
                temporaryUrl: "https://provider.example.test/fable007.png",
                providerResultKey: "fable007-image-0",
              }],
            },
          };
        },
        query: async () => { throw new Error("synchronous result must not be queried"); },
      },
      {
        uploadBytes: async ({ content, storagePath }) => {
          uploadedContent = content.toString("utf8");
          return {
            bucket: "generated-media",
            storagePath,
            storageUrl: `https://tos.example.com/${storagePath}`,
          };
        },
      },
      500,
      3,
    );
    const input = {
      ...imageInput("fable007-offline-e2e"),
      model: "image-01",
      parameters: { size: "1K", ratio: "16:9" },
    };

    const quote = await service.quoteSubmission({ userId: "user-1" }, input, "web");
    assert.equal(quote.status, "pending_confirmation");
    const confirmed = await service.confirmQuote(scopedUserActor, quote.id);
    assert.equal(confirmed.status, "confirmed");
    const created = await service.submit(scopedUserActor, input, quote.id, "web");
    const completed = await service.runRecoverableAttempt(created.attemptId);

    assert.equal(submitCalls, 1);
    assert.equal(repository.usedFen, 3);
    assert.match(uploadedContent, /\|aigc:/);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.phase, "complete");
    assert.equal(completed.media.length, 1);
    assert.equal(completed.media[0]?.complianceMetadata?.aigcMetadataEvidence, "platform_applied");
    assert.equal(repository.tosObjectLedger.size, 1);
  });

  it("defaults historical requests to full mode and makes sample mode part of the request identity", () => {
    const full = normalizeGenerationInput(videoInput("mode-full"));
    const sample = normalizeGenerationInput({ ...videoInput("mode-sample"), productionMode: "sample" });
    assert.equal(full.productionMode, "full");
    assert.equal(sample.productionMode, "sample");
    assert.notEqual(hashGenerationRequest(full), hashGenerationRequest(sample));
    assert.notEqual(hashGenerationRequest(full), hashLegacyFullGenerationRequest(full));
    assert.throws(
      () => hashLegacyFullGenerationRequest(sample),
      (error: unknown) => error instanceof GenerationError && error.code === "INVALID_GENERATION_REQUEST",
    );
    assert.throws(
      () => normalizeGenerationInput({ ...imageInput("mode-image"), productionMode: "sample" }),
      (error: unknown) => error instanceof GenerationError && error.code === "INVALID_GENERATION_REQUEST",
    );
  });

  it("marks a disconnected paid POST as SUBMISSION_OUTCOME_UNKNOWN", async () => {
    const repository = new FakeGenerationRepository();
    const service = createService(repository, {
      submit: async () => { throw new Error("socket disconnected"); },
      query: async () => { throw new Error("not used"); },
    });
    const created = await submitWithQuote(service, imageInput("key-1"));
    const result = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(result.status, "failed");
    assert.equal(result.phase, "submitting");
    assert.equal(result.errorCode, "SUBMISSION_OUTCOME_UNKNOWN");
  });

  it("does not resubmit an attempt recovered in submitting phase", async () => {
    const repository = new FakeGenerationRepository();
    let submitCalls = 0;
    const service = createService(repository, {
      submit: async () => {
        submitCalls += 1;
        return { outcome: "accepted", providerTaskId: "must-not-be-created" };
      },
      query: async () => { throw new Error("not used"); },
    });
    const created = await submitWithQuote(service, imageInput("key-1"));
    repository.forcePhase(created.attemptId, "submitting");
    const result = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(submitCalls, 0);
    assert.equal(result.errorCode, "SUBMISSION_OUTCOME_UNKNOWN");
  });

  it("fails closed before the provider when final Seedance provenance recheck fails", async () => {
    const repository = new FakeGenerationRepository();
    repository.markSubmittingError = new GenerationError(
      "control_asset_invalid_usage",
      "Seedance self-produced trust expired before provider submission",
      422,
    );
    let submitCalls = 0;
    const service = createService(repository, {
      submit: async () => {
        submitCalls += 1;
        return { outcome: "accepted", providerTaskId: "must-not-be-created" };
      },
      query: async () => { throw new Error("not used"); },
    });
    const created = await submitWithQuote(service, videoInput("seedance-final-recheck"));
    const result = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(submitCalls, 0);
    assert.equal(result.status, "failed");
    assert.equal(result.phase, "complete");
    assert.equal(result.errorCode, "control_asset_invalid_usage");
  });

  it("does not mark a paid task failed when status query fails", async () => {
    const repository = new FakeGenerationRepository();
    const provider: GenerationProvider = {
      submit: async () => ({ outcome: "accepted", providerTaskId: "task-1" }),
      query: async () => { throw new Error("temporary query outage"); },
    };
    const service = createService(repository, provider);
    const created = await submitWithQuote(service, videoInput("key-1"));
    const submitted = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(submitted.status, "running");
    assert.equal(submitted.phase, "provider_queued");

    const queried = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(queried.status, "running");
    assert.notEqual(queried.phase, "failed");
    assert.equal(repository.pollFailures, 1);
  });

  it("reports success only after provider media has been persisted", async () => {
    const repository = new FakeGenerationRepository();
    const provider: GenerationProvider = {
      submit: async () => ({
        outcome: "succeeded",
        result: {
          status: "succeeded",
          media: [{
            kind: "image",
            temporaryUrl: "https://media.example.com/result.png",
            providerResultKey: "image-0",
            complianceMetadata: {
              aigcMetadataEnabled: true,
              aigcMetadataEvidence: "provider_response",
              providerOriginEvidence: {
                c2paPresentBefore: true,
                c2paPresentAfter: true,
                manifestFingerprint: "client-or-provider-claim-must-not-survive",
              },
            },
          }],
        },
      }),
      query: async () => { throw new Error("not used"); },
    };
    let storageAvailable = false;
    const storage: GenerationStorage = {
      uploadBytes: async ({ storagePath }) => {
        if (!storageAvailable) throw new Error("TOS unavailable");
        return {
          bucket: "generated-media",
          storagePath,
          storageUrl: `https://tos.example.com/${storagePath}`,
        };
      },
    };
    const service = createService(repository, provider, storage);
    const created = await submitWithQuote(service, imageInput("key-1"));
    const notPersisted = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(notPersisted.status, "running");
    assert.equal(notPersisted.phase, "persisting");
    assert.equal(notPersisted.media.length, 0);

    storageAvailable = true;
    const persisted = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(persisted.status, "succeeded");
    assert.equal(persisted.phase, "complete");
    assert.equal(persisted.media.length, 1);
    assert.equal(persisted.media[0]?.storageBucket, "generated-media");
    assert.equal(persisted.media[0]?.mimeType, "image/png");
    assert.match(persisted.media[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(persisted.media[0]?.complianceMetadata?.providerOriginEvidence, undefined);
    assert.equal(
      persisted.media[0]?.storagePath,
      "projects/project-1/assets/request-1/image/attempt-1/0.png",
    );
    const tosLedger = [...repository.tosObjectLedger.values()];
    assert.equal(tosLedger.length, 1);
    assert.equal(tosLedger[0]?.producedAt instanceof Date, true);
    assert.deepEqual({ ...tosLedger[0], producedAt: undefined }, {
      attemptId: created.attemptId,
      providerResultKey: "image-0",
      storageBucket: "generated-media",
      objectKey: "projects/project-1/assets/request-1/image/attempt-1/0.png",
      producedAt: undefined,
      cleanupStatus: "referenced",
    });
    await repository.recordTosObjectUpload(created.attemptId, {
      providerResultKey: "image-0",
      storageBucket: "generated-media",
      objectKey: persisted.media[0]!.storagePath,
      producedAt: new Date(),
    });
    assert.equal(
      repository.tosObjectLedger.get(`generated-media:${persisted.media[0]!.storagePath}`)?.cleanupStatus,
      "referenced",
      "a late receipt must never downgrade a live object to pending cleanup",
    );
  });

  it("fails provider-cost recording open and emits a structured alert", async () => {
    const repository = new FakeGenerationRepository();
    repository.providerCostError = new Error("provider_costs insert failed");
    const warnings: Array<{ value: unknown; message?: string }> = [];
    const service = new GenerationService({
      repository,
      provider: {
        submit: async () => ({
          outcome: "succeeded",
          result: {
            status: "succeeded",
            actualModelId: "doubao-seedream-5-0-pro-260628",
            usage: { generated_images: 1 },
            media: [{
              kind: "image",
              inlineContent: {
                contentBase64: Buffer.from("provider-image").toString("base64"),
                contentType: "image/png",
              },
              providerResultKey: "image-cost-fail-open",
            }],
          },
        }),
        query: async () => { throw new Error("not used"); },
      },
      storage: {
        uploadBytes: async ({ storagePath }) => ({
          bucket: "generated-media",
          storagePath,
          storageUrl: `https://tos.example.test/${storagePath}`,
        }),
      },
      aigcLabeler: platformAppliedLabeler(),
      budgetLimitFen: 50_000,
      costAlertLogger: {
        warn(value, message) {
          warnings.push({ value, message });
        },
      },
    });

    const created = await submitWithQuote(service, imageInput("cost-fail-open"));
    const result = await service.runRecoverableAttempt(created.attemptId);

    assert.equal(result.status, "succeeded", "cost-ledger failure must not block generated media");
    assert.equal(repository.providerCostRecords.length, 1);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0], {
      value: {
        alert_code: "provider_cost_recording_failed",
        requires_attention: true,
        attempt_id: created.attemptId,
        request_id: created.requestId,
        model: "doubao-seedream-5-0-pro-260628",
        media_kind: "image",
        error: "provider_costs insert failed",
      },
      message: "provider cost recording failed open",
    });
  });

  it("scopes TOS object keys to the worker lease so an expired writer cannot overwrite its successor", async () => {
    const runWithLease = async (leaseOwner: string) => {
      const repository = new FakeGenerationRepository();
      let uploadedPath = "";
      const service = createService(
        repository,
        {
          submit: async () => ({
            outcome: "succeeded",
            result: { status: "succeeded", media: [imageProviderMedia("image-0")] },
          }),
          query: async () => { throw new Error("not used"); },
        },
        {
          uploadBytes: async ({ storagePath }) => {
            uploadedPath = storagePath;
            return {
              bucket: "generated-media",
              storagePath,
              storageUrl: `https://tos.example.test/${storagePath}`,
            };
          },
        },
      );
      const created = await submitWithQuote(service, imageInput(`lease-key-${leaseOwner}`));
      const result = await service.runRecoverableAttempt(created.attemptId, undefined, leaseOwner);
      assert.equal(result.status, "succeeded");
      return uploadedPath;
    };

    const firstWorkerPath = await runWithLease("worker-alpha");
    const replayBySameWorker = await runWithLease("worker-alpha");
    const successorWorkerPath = await runWithLease("worker-beta");
    assert.equal(firstWorkerPath, replayBySameWorker, "same worker retry keeps an idempotent object key");
    assert.notEqual(firstWorkerPath, successorWorkerPath, "different lease owners must never share a PutObject key");
    assert.match(firstWorkerPath, /\/attempt-1-[a-f0-9]{16}\/0\.png$/);
    assert.doesNotMatch(firstWorkerPath, /worker-alpha/);
  });

  it("removes a recovered partial batch when its remaining media cannot be AIGC-labeled", async () => {
    const repository = new FakeGenerationRepository();
    let labelCalls = 0;
    let uploadCalls = 0;
    const service = createService(
      repository,
      {
        submit: async () => ({
          outcome: "succeeded",
          result: {
            status: "succeeded",
            media: [
              imageProviderMedia("image-0"),
              imageProviderMedia("image-1"),
            ],
          },
        }),
        query: async () => { throw new Error("not used"); },
      },
      {
        uploadBytes: async ({ storagePath }) => {
          uploadCalls += 1;
          if (uploadCalls === 2) throw new Error("TOS unavailable after the first media result");
          return {
            bucket: "generated-media",
            storagePath,
            storageUrl: `https://tos.example.com/${storagePath}`,
          };
        },
      },
      50_000,
      100,
      {
        apply: async (input) => {
          labelCalls += 1;
          if (labelCalls === 3) throw new Error("AIGC label writer unavailable on recovery");
          return {
            content: input.content,
            complianceMetadata: {
              aigcMetadataEnabled: true,
              aigcMetadataEvidence: "platform_applied",
            },
          };
        },
      },
    );
    const created = await submitWithQuote(service, imageInput("partial-batch-label-failure"));

    const beforeRecovery = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(beforeRecovery.status, "running");
    assert.equal(beforeRecovery.phase, "persisting");
    assert.equal(beforeRecovery.media.length, 1);
    assert.equal(beforeRecovery.media[0]?.providerResultKey, "image-0");

    const failed = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.phase, "complete");
    assert.equal(failed.errorCode, "IMAGE_RESULT_AIGC_LABELING_FAILED");
    assert.deepEqual(failed.media, []);
    const context = await repository.getRecoverableAttempt(created.attemptId);
    assert.deepEqual(context?.media, []);
    const orphaned = [...repository.tosObjectLedger.values()]
      .filter((entry) => entry.cleanupStatus === "pending_cleanup");
    assert.equal(orphaned.length, 1);
    assert.equal(orphaned[0]?.producedAt instanceof Date, true);
    assert.deepEqual({ ...orphaned[0], producedAt: undefined }, {
      attemptId: created.attemptId,
      providerResultKey: "image-0",
      storageBucket: "generated-media",
      objectKey: "projects/project-1/assets/request-1/image/attempt-1/0.png",
      producedAt: undefined,
      cleanupStatus: "pending_cleanup",
    });
    assert.deepEqual(repository.billingFailureFacts, [{
      attemptId: created.attemptId,
      quoteId: "quote-1",
      reservedAmountFen: 100,
      failureCode: "IMAGE_RESULT_AIGC_LABELING_FAILED",
      providerCostStatus: "incurred",
      resolutionStatus: "pending_compensation",
    }]);
  });

  it("removes a partial batch when persistence recovery retries are exhausted", async () => {
    const repository = new FakeGenerationRepository();
    let uploadCalls = 0;
    const service = createService(
      repository,
      {
        submit: async () => ({
          outcome: "succeeded",
          result: {
            status: "succeeded",
            media: [imageProviderMedia("image-0"), imageProviderMedia("image-1")],
          },
        }),
        query: async () => { throw new Error("not used"); },
      },
      {
        uploadBytes: async ({ storagePath }) => {
          uploadCalls += 1;
          if (uploadCalls >= 2) throw new Error("TOS unavailable for the remaining media result");
          return {
            bucket: "generated-media",
            storagePath,
            storageUrl: `https://tos.example.com/${storagePath}`,
          };
        },
      },
    );
    const created = await submitWithQuote(service, imageInput("partial-batch-persistence-exhausted"));

    const retryableFailure = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(retryableFailure.status, "running");
    assert.equal(retryableFailure.phase, "persisting");
    assert.equal(retryableFailure.media.length, 1);

    const exhausted = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(exhausted.status, "failed");
    assert.equal(exhausted.phase, "complete");
    assert.equal(exhausted.errorCode, "PERSISTENCE_RETRY_EXHAUSTED");
    assert.deepEqual(exhausted.media, []);
    assert.deepEqual((await repository.getRecoverableAttempt(created.attemptId))?.media, []);
    const orphaned = [...repository.tosObjectLedger.values()]
      .filter((entry) => entry.cleanupStatus === "pending_cleanup");
    assert.equal(orphaned.length, 1);
    assert.equal(orphaned[0]?.attemptId, created.attemptId);
    assert.equal(orphaned[0]?.providerResultKey, "image-0");
  });

  it("fails an audio result terminally when the three-modal evidence gate is not satisfied", async () => {
    const repository = new FakeGenerationRepository();
    let uploads = 0;
    const provider: GenerationProvider = {
      submit: async () => ({
        outcome: "succeeded",
        result: {
          status: "succeeded",
          media: [{
            kind: "audio",
            temporaryUrl: "https://provider.example.test/result.mp3",
            providerResultKey: "audio-0",
            actualDurationMs: 12_000,
            subtitle: [{ text: "你好", start: 0, end: 1 }],
          }],
        },
      }),
      query: async () => { throw new Error("not used"); },
    };
    const service = createService(
      repository,
      provider,
      {
        uploadBytes: async () => {
          uploads += 1;
          throw new Error("unverified audio must not be uploaded");
        },
      },
      50_000,
      100,
      missingEvidenceLabeler(),
    );
    const created = await submitWithQuote(service, audioInput("audio-missing-evidence"));
    const result = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(result.status, "failed");
    assert.equal(result.phase, "complete");
    assert.equal(result.errorCode, "AUDIO_RESULT_AIGC_EVIDENCE_MISSING");
    assert.equal(repository.persistenceFailures, 0);
    assert.equal(uploads, 0);
    assert.equal(result.media.length, 0);
  });

  it("does not persist media or provider cost when the adapter fails closed for missing original duration", async () => {
    const repository = new FakeGenerationRepository();
    const service = createService(repository, {
      submit: async () => {
        throw new ProviderRequestError(
          "Seed Audio 返回成功但缺少计费原始时长",
          "submit_audio",
          "unknown",
          false,
        );
      },
      query: async () => { throw new Error("not used"); },
    });
    const created = await submitWithQuote(service, audioInput("audio-original-duration-missing"));
    const result = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(result.status, "failed");
    assert.equal(result.media.length, 0);
    assert.equal(repository.providerCostRecords.length, 0);
    assert.deepEqual((await repository.getRecoverableAttempt(created.attemptId))?.media, []);
  });

  it("fails an image result terminally and performs zero uploads when evidence is missing", async () => {
    const repository = new FakeGenerationRepository();
    let uploads = 0;
    const service = createService(
      repository,
      {
        submit: async () => ({
          outcome: "succeeded",
          result: {
            status: "succeeded",
            media: [{
              kind: "image",
              temporaryUrl: "https://provider.example.test/result.png",
              providerResultKey: "image-0",
            }],
          },
        }),
        query: async () => { throw new Error("not used"); },
      },
      {
        uploadBytes: async () => {
          uploads += 1;
          throw new Error("unverified image must not be uploaded");
        },
      },
      50_000,
      100,
      missingEvidenceLabeler(),
    );
    const created = await submitWithQuote(service, imageInput("image-missing-evidence"));
    const result = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "IMAGE_RESULT_AIGC_EVIDENCE_MISSING");
    assert.equal(uploads, 0);
    assert.equal(result.media.length, 0);
  });

  it("fails a video result terminally and performs zero uploads when evidence is missing", async () => {
    const repository = new FakeGenerationRepository();
    let uploads = 0;
    const service = createService(
      repository,
      {
        submit: async () => ({
          outcome: "succeeded",
          result: {
            status: "succeeded",
            media: [{
              kind: "video",
              temporaryUrl: "https://provider.example.test/result.mp4",
              providerResultKey: "video-0",
            }],
          },
        }),
        query: async () => { throw new Error("not used"); },
      },
      {
        uploadBytes: async () => {
          uploads += 1;
          throw new Error("unverified video must not be uploaded");
        },
      },
      50_000,
      100,
      missingEvidenceLabeler(),
    );
    const created = await submitWithQuote(service, videoInput("video-missing-evidence"));
    const result = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "VIDEO_RESULT_AIGC_EVIDENCE_MISSING");
    assert.equal(uploads, 0);
    assert.equal(result.media.length, 0);
  });

  it("accepts only the two adjudicated AIGC evidence values", () => {
    assert.doesNotThrow(() => assertAigcMetadataEvidence("image", {
      aigcMetadataEnabled: true,
      aigcMetadataEvidence: "platform_applied",
    }));
    assert.doesNotThrow(() => assertAigcMetadataEvidence("video", {
      aigcMetadataEnabled: true,
      aigcMetadataEvidence: "provider_response",
    }));
    assert.throws(
      () => assertAigcMetadataEvidence("audio", {
        aigcMetadataEnabled: true,
        aigcMetadataEvidence: "self_asserted",
      }),
      /missing verified AIGC metadata evidence/,
    );
  });

  it("retains an out-of-tolerance audio duration for manual follow-up instead of retrying", async () => {
    const repository = new FakeGenerationRepository();
    const provider: GenerationProvider = {
      submit: async () => ({
        outcome: "succeeded",
        result: {
          status: "succeeded",
          media: [{
            kind: "audio",
            inlineContent: {
              contentBase64: Buffer.from("audio").toString("base64"),
              contentType: "audio/mpeg",
            },
            providerResultKey: "audio-out-of-tolerance",
            actualDurationMs: 13_001,
            subtitle: [{ text: "你好", start: 0, end: 1 }],
            complianceMetadata: {
              aigcMetadataEnabled: true,
              aigcMetadataEvidence: "provider_response",
            },
          }],
        },
      }),
      query: async () => { throw new Error("not used"); },
    };
    const service = createService(repository, provider);
    const created = await submitWithQuote(service, audioInput("audio-out-of-tolerance"));
    const result = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(result.status, "failed");
    assert.equal(result.phase, "complete");
    assert.equal(result.errorCode, "AUDIO_RESULT_DURATION_OUT_OF_TOLERANCE");
    assert.equal(repository.persistenceFailures, 0);
    const context = await repository.getRecoverableAttempt(created.attemptId);
    assert.equal(context?.attempt.providerResult?.media[0]?.actualDurationMs, 13_001);
    assert.equal(context?.attempt.providerResult?.media[0]?.durationDeltaMs, 1_001);
  });

  it("honors provider-reported duration semantics for any Seed Audio deployment alias", () => {
    const request = normalizeGenerationInput({
      ...audioInput("seed-audio-variable-duration"),
      model: "prod-audio-deployment-alias-2026-07",
    });
    const media = {
      kind: "audio" as const,
      providerResultKey: "seed-audio-variable-duration",
      actualDurationMs: 70_000,
      audioDurationPolicy: { source: "provider_reported" as const, maxDurationMs: 120_000 },
      subtitle: [{ text: "你好", start: 0, end: 70 }],
    };
    assert.deepEqual(assertAudioProviderMediaIntegrity(request, media), {
      actualDurationMs: 70_000,
      durationDeltaMs: 58_000,
    });
    assert.throws(
      () => assertAudioProviderMediaIntegrity(request, { ...media, actualDurationMs: 120_001 }),
      (error: unknown) => error instanceof AudioProviderMediaIntegrityError
        && error.code === "AUDIO_RESULT_DURATION_OUT_OF_RANGE",
    );
  });

  it("rejects non-cue, inverted, and out-of-range subtitle timestamps", () => {
    const request = normalizeGenerationInput(audioInput("audio-bad-subtitle"));
    const base = {
      kind: "audio" as const,
      temporaryUrl: "https://provider.example.test/result.mp3",
      providerResultKey: "audio-0",
      actualDurationMs: 12_000,
      complianceMetadata: {
        aigcMetadataEnabled: true,
        aigcMetadataEvidence: "provider_response",
      },
    };
    for (const subtitle of [
      [{ start: 0, end: 1 }],
      [{ text: "你好", start: 2, end: 1 }],
      [{ text: "你好", start: -1, end: 1 }],
      [{ text: "你好", start: 0, end: 13 }],
    ]) {
      assert.throws(
        () => assertAudioProviderMediaIntegrity(request, { ...base, subtitle }),
        /timed subtitle JSON/,
      );
    }
  });

  it("persists complete audio only to TOS and never returns its provider URL", async () => {
    const repository = new FakeGenerationRepository();
    const providerUrl = "https://provider.example.test/temporary/audio-secret.mp3";
    const provider: GenerationProvider = {
      submit: async () => ({
        outcome: "succeeded",
        result: {
          status: "succeeded",
          media: [{
            kind: "audio",
            temporaryUrl: providerUrl,
            providerResultKey: "audio-0",
            actualDurationMs: 12_000,
            subtitle: [{ text: "你好", start: 0, end: 1 }],
            complianceMetadata: {
              aigcMetadataEnabled: true,
              aigcMetadataEvidence: "provider_response",
            },
          }],
        },
      }),
      query: async () => { throw new Error("not used"); },
    };
    let downloadedUrl: string | undefined;
    const service = new GenerationService({
      repository,
      provider,
      storage: {
        uploadBytes: async ({ storagePath }) => ({
          bucket: "generated-media",
          storagePath,
          storageUrl: `https://tos.example.test/${storagePath}`,
        }),
      },
      aigcLabeler: platformAppliedLabeler(),
      budgetLimitFen: 50_000,
      mediaDownloader: async (url) => {
        downloadedUrl = url;
        return {
          content: Buffer.from("audio-bytes"),
          contentType: "audio/mpeg",
          byteLength: 11,
          extension: "mp3",
        };
      },
    });
    const created = await submitWithQuote(service, audioInput("audio-complete"));
    const result = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(result.status, "succeeded");
    assert.equal(downloadedUrl, providerUrl);
    assert.equal(result.media[0]?.storageUrl.startsWith("https://tos.example.test/"), true);
    assert.equal(JSON.stringify(result).includes(providerUrl), false);
  });

  it("persists inline audio bytes without calling the media downloader", async () => {
    const repository = new FakeGenerationRepository();
    const provider: GenerationProvider = {
      submit: async () => ({
        outcome: "succeeded",
        result: {
          status: "succeeded",
          media: [{
            kind: "audio",
            // 同步 TTS 直接返回 base64 音频,没有可供下载的临时 URL。
            inlineContent: {
              contentBase64: Buffer.from("inline-audio-bytes").toString("base64"),
              contentType: "audio/mpeg",
            },
            providerResultKey: "audio-0",
            actualDurationMs: 12_000,
            subtitle: [{ text: "你好", start: 0, end: 1 }],
            complianceMetadata: {
              aigcMetadataEnabled: true,
              aigcMetadataEvidence: "provider_response",
            },
          }],
        },
      }),
      query: async () => { throw new Error("not used"); },
    };
    let downloads = 0;
    const service = new GenerationService({
      repository,
      provider,
      storage: {
        uploadBytes: async ({ storagePath }) => ({
          bucket: "generated-media",
          storagePath,
          storageUrl: `https://tos.example.test/${storagePath}`,
        }),
      },
      aigcLabeler: platformAppliedLabeler(),
      budgetLimitFen: 50_000,
      mediaDownloader: async () => {
        downloads += 1;
        throw new Error("inline media must not be downloaded");
      },
    });
    const created = await submitWithQuote(service, audioInput("audio-inline"));
    const result = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(result.status, "succeeded");
    assert.equal(downloads, 0);
    assert.equal(result.media[0]?.mimeType, "audio/mpeg");
    assert.match(result.media[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(result.media[0]?.storagePath.endsWith(".mp3"), true);
    assert.equal(result.media[0]?.storageUrl.startsWith("https://tos.example.test/"), true);
  });

  it("uses the frozen shot path and stores a last frame as image", async () => {
    const repository = new FakeGenerationRepository();
    const provider: GenerationProvider = {
      submit: async () => ({ outcome: "accepted", providerTaskId: "provider-task-1" }),
      query: async () => ({
        status: "succeeded",
        providerTaskId: "provider-task-1",
        media: [
          {
            kind: "video",
            temporaryUrl: "https://media.example.com/result.mp4",
            providerResultKey: "video-0",
          },
          {
            kind: "last_frame",
            temporaryUrl: "https://media.example.com/last-frame.png",
            providerResultKey: "last-frame-0",
          },
        ],
      }),
    };
    const service = createService(repository, provider);
    const created = await submitWithQuote(
      service,
      { ...videoInput("key-1"), shotId: "shot-9" },
    );
    await service.runRecoverableAttempt(created.attemptId);
    const persisted = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(persisted.status, "succeeded");
    assert.deepEqual(
      persisted.media.map((item) => ({ mediaKind: item.mediaKind, storagePath: item.storagePath })),
      [
        {
          mediaKind: "video",
          storagePath: "projects/project-1/shots/shot-9/video/provider-task-1/0.mp4",
        },
        {
          mediaKind: "image",
          storagePath: "projects/project-1/shots/shot-9/image/provider-task-1/1.png",
        },
      ],
    );
  });

  it("预览档请求把 parameters.preview=true 转录到落库媒体的 preview 标记", async () => {
    const repository = new FakeGenerationRepository();
    const provider: GenerationProvider = {
      submit: async () => ({ outcome: "accepted", providerTaskId: "preview-task-1" }),
      query: async () => ({
        status: "succeeded",
        providerTaskId: "preview-task-1",
        media: [
          {
            kind: "video",
            temporaryUrl: "https://media.example.com/preview.mp4",
            providerResultKey: "video-0",
          },
        ],
      }),
    };
    const service = createService(repository, provider);
    const created = await submitWithQuote(
      service,
      { ...videoInput("preview-key-1"), parameters: { durationSeconds: 4, preview: true } },
    );
    await service.runRecoverableAttempt(created.attemptId);
    const persisted = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(persisted.status, "succeeded");

    const context = await repository.getRecoverableAttempt(created.attemptId);
    assert.equal(context?.request.input.parameters.preview, true);
    assert.equal(context?.media[0]?.preview, true, "saveMediaResult 落行的 metadata.preview 来自 storedMedia.preview");

    // 非预览请求不带该键:落库口径保持空 metadata。
    const formalRepository = new FakeGenerationRepository();
    const formalService = createService(formalRepository, provider);
    const formal = await submitWithQuote(formalService, videoInput("formal-key-1"));
    await formalService.runRecoverableAttempt(formal.attemptId);
    await formalService.runRecoverableAttempt(formal.attemptId);
    const formalContext = await formalRepository.getRecoverableAttempt(formal.attemptId);
    assert.equal(formalContext?.media[0]?.preview, undefined);
  });

  it("labels and verifies every video result before starting the first upload", async () => {
    const repository = new FakeGenerationRepository();
    let labelCalls = 0;
    let uploads = 0;
    const service = createService(
      repository,
      {
        submit: async () => ({
          outcome: "succeeded",
          result: {
            status: "succeeded",
            media: [
              {
                kind: "video",
                temporaryUrl: "https://media.example.com/result.mp4",
                providerResultKey: "video-0",
              },
              {
                kind: "last_frame",
                temporaryUrl: "https://media.example.com/last-frame.png",
                providerResultKey: "last-frame-0",
              },
            ],
          },
        }),
        query: async () => { throw new Error("not used"); },
      },
      {
        uploadBytes: async () => {
          uploads += 1;
          throw new Error("a partial output set must never reach TOS");
        },
      },
      50_000,
      100,
      {
        apply: async (input) => {
          labelCalls += 1;
          if (labelCalls === 2) throw new Error("last-frame metadata write failed");
          return platformAppliedLabeler().apply(input);
        },
      },
    );
    const created = await submitWithQuote(service, videoInput("video-tail-label-fails"));
    const result = await service.runRecoverableAttempt(created.attemptId);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "IMAGE_RESULT_AIGC_LABELING_FAILED");
    assert.equal(labelCalls, 2);
    assert.equal(uploads, 0);
    assert.equal(result.media.length, 0);
  });

  it("returns the existing request for the same idempotency key and rejects changed input", async () => {
    const repository = new FakeGenerationRepository();
    const service = createService(repository, idleProvider());
    const input = imageInput("same-key");
    const quote = await confirmedQuote(service, input);
    const first = await service.submit(scopedUserActor, input, quote.id, "web");
    const duplicate = await service.submit(scopedUserActor, input, quote.id, "web");
    assert.equal(duplicate.requestId, first.requestId);
    assert.equal(duplicate.attemptId, first.attemptId);
    assert.equal(repository.usedFen, 100);

    await assert.rejects(
      async () => {
        const changed = { ...input, prompt: "changed prompt" };
        const changedQuote = await confirmedQuote(service, changed);
        return service.submit(scopedUserActor, changed, changedQuote.id, "web");
      },
      (error: unknown) => error instanceof GenerationError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  });

  it("allows an exact budget reservation and rejects the next paid request", async () => {
    const repository = new FakeGenerationRepository();
    const service = createService(repository, idleProvider(), undefined, 50_000, 50_000);
    const exact = await submitWithQuote(service, imageInput("budget-1"));
    assert.equal(exact.estimatedCostFen, 50_000);
    assert.equal(repository.usedFen, 50_000);
    await assert.rejects(
      () => submitWithQuote(service, imageInput("budget-2")),
      (error: unknown) => error instanceof GenerationError
        && error.code === "GENERATION_BUDGET_EXCEEDED",
    );
  });

  it("authorizes one list, preserves per-item budget guards, and replays the stored result", async () => {
    const repository = new FakeGenerationRepository();
    const service = createService(repository, idleProvider(), undefined, 150);
    const firstQuote = await service.quoteSubmission(
      { userId: "user-1" },
      imageInput("batch-item-1"),
      "web",
    );
    const secondQuote = await service.quoteSubmission(
      { userId: "user-1" },
      imageInput("batch-item-2"),
      "web",
    );
    const batch = {
      projectId: "project-1",
      clientIdempotencyKey: "batch-key-1",
      expectedTotalEstimatedCostFen: 200,
      items: [
        { itemId: "item-1", quoteId: firstQuote.id },
        { itemId: "item-2", quoteId: secondQuote.id },
      ],
    };

    const confirmed = await service.confirmBatch(scopedUserActor, batch, "web");
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.createdCount, 0);
    assert.equal(confirmed.submittedTotalEstimatedCostFen, 0);
    assert.deepEqual(confirmed.items.map((item) => item.status), ["confirmed", "confirmed"]);
    assert.equal(repository.usedFen, 0);

    const first = await service.submitBatchAuthorization(scopedUserActor, confirmed.authorizationId, "web");

    assert.equal(first.status, "partial");
    assert.equal(first.createdCount, 1);
    assert.equal(first.failedCount, 1);
    assert.equal(first.authorizedTotalEstimatedCostFen, 200);
    assert.equal(first.submittedTotalEstimatedCostFen, 100);
    assert.deepEqual(first.items.map((item) => item.status), ["created", "budget_blocked"]);
    assert.equal(repository.usedFen, 100);

    const replay = await service.submitBatchAuthorization(scopedUserActor, confirmed.authorizationId, "web");
    assert.equal(replay.idempotentReplay, true);
    assert.deepEqual(replay.items, first.items);
    assert.equal(repository.usedFen, 100);
  });

  it("creates one paid attempt per idempotent retry", async () => {
    const repository = new FakeGenerationRepository();
    const service = createService(repository, idleProvider());
    const created = await submitWithQuote(service, imageInput("submit-key"));
    const retryQuote = await service.quoteRetry({ userId: "user-1" }, created.requestId, "web");
    await service.confirmQuote(scopedUserActor, retryQuote.id);
    const retried = await service.retry(scopedUserActor, created.requestId, "retry-key", retryQuote.id, "web");
    const duplicateRetry = await service.retry(scopedUserActor, created.requestId, "retry-key", retryQuote.id, "web");
    assert.notEqual(retried.attemptId, created.attemptId);
    assert.equal(duplicateRetry.attemptId, retried.attemptId);
    assert.equal(repository.usedFen, 200);
  });

  it("enforces the frozen image quantity of one", async () => {
    const repository = new FakeGenerationRepository();
    const service = createService(repository, idleProvider());
    await assert.rejects(
      () => submitWithQuote(service, { ...imageInput("key-1"), quantity: 2 }),
      (error: unknown) => error instanceof GenerationError
        && error.code === "INVALID_GENERATION_REQUEST",
    );
  });

  it("normalizes configured image and video capability parameters", () => {
    const image = normalizeGenerationInput({
      ...imageInput("image-contract"),
      parameters: { ratio: "16:9", resolution: "2K", size: "2K" },
    });
    assert.deepEqual(image.parameters, {
      size: "2048x1152",
      ratio: "16:9",
      watermark: false,
      sequentialImageGeneration: "disabled",
    });

    const video = normalizeGenerationInput({
      ...videoInput("video-contract"),
      parameters: {},
      referenceAssetSnapshots: [
        { kind: "image", url: "https://media.example.com/one.png" },
        { kind: "image", url: "https://media.example.com/two.png" },
        { kind: "video", url: "https://media.example.com/camera.mp4" },
      ],
    });
    assert.deepEqual(video.parameters, {
      resolution: "720p",
      ratio: "9:16",
      durationSeconds: 4,
      watermark: false,
      generateAudio: true,
    });
    assert.deepEqual(video.referenceAssetSnapshots.map((item) => item.role), [
      "reference_image",
      "reference_image",
      "reference_video",
    ]);
  });

  it("rejects parameters outside the selected model capability", () => {
    for (const parameters of [
      { ratio: "2:3" },
      { resolution: "4K" },
      { seed: 1 },
      { size: "4K" },
      { watermark: true },
      { sequentialImageGeneration: "auto" as const },
    ]) {
      assert.throws(
        () => normalizeGenerationInput({ ...imageInput("bad-image"), parameters }),
        (error: unknown) => error instanceof GenerationError
          && error.code === "INVALID_GENERATION_REQUEST",
      );
    }
    for (const parameters of [
      { resolution: "1080p" },
      { ratio: "2:3" },
      { durationSeconds: 16 },
      { seed: 1 },
    ]) {
      assert.throws(
        () => normalizeGenerationInput({ ...videoInput("bad-video"), parameters }),
        (error: unknown) => error instanceof GenerationError
          && error.code === "INVALID_GENERATION_REQUEST",
      );
    }
  });

  it("rejects unsupported fixed parameters before creating a confirmable quote", async () => {
    const service = createService(new FakeGenerationRepository(), idleProvider());
    await assert.rejects(
      () => service.quoteSubmission(
        { userId: "user-1" },
        { ...imageInput("bad-image-quote"), parameters: { ratio: "2:3" } },
        "web",
      ),
      (error: unknown) => error instanceof GenerationError
        && error.code === "INVALID_GENERATION_REQUEST",
    );
    await assert.rejects(
      () => service.quoteSubmission(
        { userId: "user-1" },
        { ...videoInput("bad-video-quote"), parameters: { durationSeconds: 16 } },
        "web",
      ),
      (error: unknown) => error instanceof GenerationError
        && error.code === "INVALID_GENERATION_REQUEST",
    );
  });

  it("validates official reference roles and permits all-reference video controls", () => {
    const videoReference = normalizeGenerationInput({
      ...videoInput("input-video"),
      referenceAssetSnapshots: [{
        kind: "video",
        url: "https://media.example.com/reference.mp4",
        role: "reference_video",
      }],
    });
    assert.equal(videoReference.referenceAssetSnapshots[0]?.role, "reference_video");
    assert.throws(
      () => normalizeGenerationInput({
        ...videoInput("too-many-images"),
        referenceAssetSnapshots: Array.from({ length: 10 }, (_, index) => ({
          kind: "image" as const,
          url: `https://media.example.com/${index}.png`,
        })),
      }),
      (error: unknown) => error instanceof GenerationError
        && error.code === "control_asset_invalid_usage"
        && error.statusCode === 422,
    );
    assert.throws(
      () => normalizeGenerationInput({
        ...videoInput("bad-role"),
        referenceAssetSnapshots: [{
          kind: "image",
          url: "https://media.example.com/reference.png",
          role: "reference_video",
        }],
      }),
      (error: unknown) => error instanceof GenerationError
        && error.code === "control_asset_invalid_usage"
        && error.statusCode === 422,
    );
    assert.throws(
      () => normalizeGenerationInput({
        ...videoInput("too-many-audios"),
        referenceAssetSnapshots: [
          { kind: "image", url: "https://media.example.com/reference.png" },
          ...Array.from({ length: 4 }, (_, index) => ({
            kind: "audio" as const,
            url: `https://media.example.com/${index}.mp3`,
          })),
        ],
      }),
      (error: unknown) => error instanceof GenerationError
        && error.code === "control_asset_invalid_usage"
        && error.statusCode === 422,
    );
    assert.throws(
      () => normalizeGenerationInput({
        ...videoInput("audio-alone"),
        referenceAssetSnapshots: [{
          kind: "audio",
          url: "https://media.example.com/reference.mp3",
        }],
      }),
      (error: unknown) => error instanceof GenerationError
        && error.code === "control_asset_invalid_usage"
        && error.statusCode === 422,
    );
    assert.throws(
      () => normalizeGenerationInput({
        ...videoInput("director-model"),
        referenceAssetSnapshots: [{
          kind: "image",
          url: "https://media.example.com/director-rig.glb?signature=test",
          role: "reference_image",
        }],
      }),
      (error: unknown) => error instanceof GenerationError
        && error.code === "control_asset_invalid_usage"
        && error.statusCode === 422
        && error.message.includes("3D 素模"),
    );
  });

  it("requires an explicitly confirmed one-time quote", async () => {
    const repository = new FakeGenerationRepository();
    const service = createService(repository, idleProvider());
    const input = imageInput("quote-confirmation");
    const quote = await service.quoteSubmission({ userId: "user-1" }, input, "web");
    assert.equal(quote.status, "pending_confirmation");
    await assert.rejects(
      () => service.submit(scopedUserActor, input, quote.id, "web"),
      (error: unknown) => error instanceof GenerationError
        && error.code === "GENERATION_QUOTE_UNCONFIRMED",
    );
    await service.confirmQuote(scopedUserActor, quote.id);
    const created = await service.submit(scopedUserActor, input, quote.id, "web");
    const replay = await service.submit(scopedUserActor, { ...input, clientIdempotencyKey: "quote-confirmation-replay" }, quote.id, "web");
    assert.equal(replay.attemptId, created.attemptId);
    assert.equal(repository.usedFen, 100);
  });

  it("does not consume a quote through a different entry source", async () => {
    const repository = new FakeGenerationRepository();
    const service = createService(repository, idleProvider());
    const input = imageInput("source-bound-quote");
    const assistantQuote = await service.quoteSubmission(
      { userId: "user-1" },
      input,
      "assistant",
      "assistant-session-1",
    );
    await service.confirmQuote(scopedUserActor, assistantQuote.id);

    await assert.rejects(
      () => service.submit(scopedUserActor, input, assistantQuote.id, "web"),
      (error: unknown) => error instanceof GenerationError
        && error.code === "GENERATION_QUOTE_SOURCE_MISMATCH",
    );
    assert.equal(repository.usedFen, 0);
  });
});

async function confirmedQuote(service: GenerationService, input: SubmitGenerationInput) {
  const quote = await service.quoteSubmission({ userId: "user-1" }, input, "web");
  return service.confirmQuote(scopedUserActor, quote.id);
}

async function submitWithQuote(service: GenerationService, input: SubmitGenerationInput) {
  const quote = await confirmedQuote(service, input);
  return service.submit(scopedUserActor, input, quote.id, "web");
}

function createService(
  repository: FakeGenerationRepository,
  provider: GenerationProvider,
  storage: GenerationStorage = {
    uploadBytes: async ({ storagePath }) => ({
      bucket: "generated-media",
      storagePath,
      storageUrl: `https://tos.example.com/${storagePath}`,
    }),
  },
  budgetLimitFen = 50_000,
  unitPriceFen = 100,
  aigcLabeler: GenerationServiceOptions["aigcLabeler"] = platformAppliedLabeler(),
): GenerationService {
  repository.unitPriceFen = unitPriceFen;
  return new GenerationService({
    repository,
    provider,
    storage,
    aigcLabeler,
    budgetLimitFen,
    mediaDownloader: async (url) => {
      const isVideo = url.endsWith(".mp4");
      return {
        content: Buffer.from("generated-media"),
        contentType: isVideo ? "video/mp4" : "image/png",
        byteLength: Buffer.byteLength("generated-media"),
        extension: isVideo ? "mp4" : "png",
      };
    },
  });
}

function platformAppliedLabeler(): GenerationServiceOptions["aigcLabeler"] {
  return {
    apply: async (input) => ({
      content: Buffer.concat([input.content, Buffer.from(`|aigc:${input.contentId}`)]),
      complianceMetadata: {
        aigcMetadataEnabled: true,
        aigcMetadataEvidence: "platform_applied",
        contentId: input.contentId,
        contentProducer: "001191110000802044347C00000",
        schemaVersion: "GB45438-2025-Appendix-E",
      },
    }),
  };
}

function missingEvidenceLabeler(): GenerationServiceOptions["aigcLabeler"] {
  return {
    apply: async (input) => ({
      content: input.content,
      complianceMetadata: {
        aigcMetadataEnabled: false,
        aigcMetadataEvidence: "unverified",
      },
    // The intentionally malformed result exercises the runtime fail-closed
    // gate rather than TypeScript's trusted platform-writer contract.
    }) as never,
  };
}

function idleProvider(): GenerationProvider {
  return {
    submit: async () => ({ outcome: "accepted", providerTaskId: "task-1" }),
    query: async () => ({ status: "running", media: [] }),
  };
}

function imageProviderMedia(providerResultKey: string) {
  return {
    kind: "image" as const,
    temporaryUrl: `https://provider.example.test/${providerResultKey}.png`,
    providerResultKey,
    complianceMetadata: {
      aigcMetadataEnabled: true,
      aigcMetadataEvidence: "provider_response" as const,
    },
  };
}

function imageInput(clientIdempotencyKey: string): SubmitGenerationInput {
  return {
    projectId: "project-1",
    mediaKind: "image",
    model: "doubao-seedream-5-0-pro-260628",
    prompt: "test image",
    quantity: 1,
    clientIdempotencyKey,
  };
}

function videoInput(clientIdempotencyKey: string): SubmitGenerationInput {
  return {
    projectId: "project-1",
    mediaKind: "video",
    model: "doubao-seedance-2-0-fast-260128",
    prompt: "test video",
    parameters: { durationSeconds: 4 },
    clientIdempotencyKey,
  };
}

function audioInput(clientIdempotencyKey: string): SubmitGenerationInput {
  return {
    projectId: "project-1",
    mediaKind: "audio",
    model: "configured-seed-audio-id",
    prompt: "你好",
    parameters: { originalDurationSeconds: 12, format: "mp3" },
    referenceAssetSnapshots: [{ kind: "audio", url: "https://media.example.com/reference.mp3" }],
    quantity: 1,
    clientIdempotencyKey,
  };
}

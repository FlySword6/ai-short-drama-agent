#!/usr/bin/env node
/**
 * FABLE-007 real-provider smoke.
 *
 * Safety contract:
 * - one explicitly selected probe per process;
 * - approved dev/test target only, explicit paid confirmation, hard CNY 50 ceiling;
 * - no paid submission retries (video status polling is read-only);
 * - no prompts, provider URLs, credentials or raw provider payloads in output;
 * - every media result is downloaded in memory, platform-labeled and read back.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import sharp from "sharp";
import { settings } from "../src/config/env.js";
import { buildDatabasePoolConfig } from "../src/db/client.js";
import { quoteIdentifier } from "../src/db/migrate.js";
import { downloadMediaBytes, inlineDownloadedMedia } from "../src/modules/generation/mediaDownload.js";
import { ArkChatClient } from "../src/integrations/arkClient.js";
import {
  COMPANY_PROVIDER_NOT_ENABLED_MESSAGE,
  isCompanyProviderAllowed,
  normalizeCompanyProviderAllowlist,
} from "../src/shared/companyProviderPolicy.js";
import {
  AigcMetadataLabeler,
  readAigcImplicitLabel,
} from "../src/modules/generation/aigcLabeler.js";
import { ProviderRequestError } from "../src/modules/generation/errors.js";
import { MiniMaxCompletionProvider } from "../src/modules/ai/minimaxCompletionProvider.js";
import { ArkGenerationProvider } from "../src/modules/generation/provider/arkGenerationProvider.js";
import { MinimaxGenerationProvider } from "../src/modules/generation/provider/minimaxGenerationProvider.js";
import { SeedAudioProvider } from "../src/modules/generation/provider/seedAudioProvider.js";
import type { GenerationProvider } from "../src/modules/generation/ports.js";
import type {
  GenerationMediaKind,
  ProviderGenerationRequest,
  ProviderMediaResult,
  ProviderResultSnapshot,
} from "../src/modules/generation/types.js";
import { assertPromotionDatabaseIdentity } from "./seed-pricing-tiers.mjs";
import {
  assertTierUnfreezeDatabaseTransport,
  assertTierUnfreezeTargetIdentity,
  TIER_UNFREEZE_BATCH_ID,
  TIER_UNFREEZE_TEST_ENV_BATCH_ID,
  type TierUnfreezeTarget,
} from "./tier-unfreeze-target.mjs";

const PROBES = [
  "ark-llm",
  "minimax-llm",
  "ark-image",
  "minimax-image",
  "ark-video",
  "minimax-video",
  "seed-audio",
  "minimax-audio",
] as const;

type Probe = typeof PROBES[number];

const MAX_AUTHORIZED_BUDGET_FEN = 5_000;
const COST_CEILING_FEN: Readonly<Record<Probe, number>> = {
  "ark-llm": 2,
  "minimax-llm": 2,
  "ark-image": 60,
  "minimax-image": 3,
  "ark-video": 100,
  "minimax-video": 200,
  "seed-audio": 9,
  "minimax-audio": 1,
};
const VIDEO_POLL_INTERVAL_MS = 10_000;
const VIDEO_MAX_POLLS = 90;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

/** Stable receipt handles. They intentionally do not disclose provider or model IDs. */
const PROBE_KEYS: Readonly<Record<Probe, string>> = {
  "ark-llm": "fable007-llm-a",
  "minimax-llm": "fable007-llm-b",
  "ark-image": "fable007-image-a",
  "minimax-image": "fable007-image-b",
  "ark-video": "fable007-video-a",
  "minimax-video": "fable007-video-b",
  "seed-audio": "fable007-audio-a",
  "minimax-audio": "fable007-audio-b",
};
const TIER_KEYS: Readonly<Record<Probe, string>> = {
  "ark-llm": "fable007-llm-smoke-v1",
  "minimax-llm": "fable007-llm-smoke-v1",
  "ark-image": "fable007-image-smoke-v1",
  "minimax-image": "fable007-image-smoke-v1",
  "ark-video": "fable007-video-smoke-v1",
  "minimax-video": "fable007-video-smoke-v1",
  "seed-audio": "fable007-audio-smoke-v1",
  "minimax-audio": "fable007-audio-smoke-v1",
};

const RECEIPT_USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "completion_tokens",
  "total_tokens",
  "generated_images",
  "duration_seconds",
  "duration_ms",
  "original_duration_ms",
  "audio_length_ms",
  "usage_characters",
] as const;
type ReceiptUsageKey = typeof RECEIPT_USAGE_KEYS[number];

interface CliOptions {
  probe: Probe;
  target: TierUnfreezeTarget;
  budgetFen: number;
  confirmPaid: true;
  tierId?: string;
  tierLedgerFile?: string;
}

interface ArtifactEvidence {
  mediaKind: GenerationMediaKind;
  contentType: string;
  extension: string;
  widthPx?: number;
  heightPx?: number;
  bytesBeforeLabel: number;
  bytesAfterLabel: number;
  sha256BeforeLabel: string;
  sha256AfterLabel: string;
  platformAigcReadback: true;
  providerOriginPreserved: boolean;
}

interface ProbeSummary {
  ok: true;
  probeKey: string;
  tierKey: string;
  declaredCostCeilingFen: number;
  reservedCostFen: number;
  providerTaskFingerprint?: string;
  usage?: Partial<Record<ReceiptUsageKey, number>>;
  outputLength?: number;
  outputSha256?: string;
  artifact?: ArtifactEvidence;
}

interface TierSmokeSpec {
  probe: "ark-image" | "ark-video";
  model: string;
  costCeilingFen: number;
  parameters: ProviderGenerationRequest["parameters"];
  /** 该档所属解冻批次;缺省归 ark-common-cheapest-v1(dev 首批)。 */
  ledgerBatchId?: string;
}

const TIER_UNFREEZE_SMOKE_SPECS: Readonly<Record<string, TierSmokeSpec>> = {
  "vid-seedance25-ep-916-720p-4s": {
    probe: "ark-video",
    model: "ep-20260807153339-f6bp4",
    costCeilingFen: 650,
    ledgerBatchId: "ark-lite-b2-video-v1",
    parameters: {
      resolution: "720p",
      ratio: "9:16",
      durationSeconds: 4,
      watermark: false,
      generateAudio: false,
    },
  },
  "img-seedream5pro-169-1k-1": {
    probe: "ark-image",
    model: "doubao-seedream-5-0-pro-260628",
    costCeilingFen: 30,
    parameters: {
      size: "1K",
      ratio: "16:9",
      watermark: false,
      sequentialImageGeneration: "disabled",
    },
  },
  "img-seedream5pro-916-1k-1": {
    probe: "ark-image",
    model: "doubao-seedream-5-0-pro-260628",
    costCeilingFen: 30,
    parameters: {
      size: "1K",
      ratio: "9:16",
      watermark: false,
      sequentialImageGeneration: "disabled",
    },
  },
  "vid-seedance20fast-169-480p": {
    probe: "ark-video",
    model: "doubao-seedance-2-0-fast-260128",
    costCeilingFen: 160,
    parameters: {
      resolution: "480p",
      ratio: "16:9",
      durationSeconds: 4,
      watermark: false,
      generateAudio: false,
    },
  },
  "vid-seedance20fast-916-480p": {
    probe: "ark-video",
    model: "doubao-seedance-2-0-fast-260128",
    costCeilingFen: 160,
    parameters: {
      resolution: "480p",
      ratio: "9:16",
      durationSeconds: 4,
      watermark: false,
      generateAudio: false,
    },
  },
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // env.ts loads the caller's local-only .env before this switch.  Running the
  // remaining work from the repository root makes the checked-in ExifTool
  // configuration the AIGC writer's exact source.
  process.chdir(fileURLToPath(new URL("../", import.meta.url)));
  const ledgerBatchId = options.target === "dev"
    ? (options.tierId
      ? TIER_UNFREEZE_SMOKE_SPECS[options.tierId]?.ledgerBatchId ?? TIER_UNFREEZE_BATCH_ID
      : TIER_UNFREEZE_BATCH_ID)
    : TIER_UNFREEZE_TEST_ENV_BATCH_ID;
  const reservationId = options.target === "dev" && options.tierId && options.tierLedgerFile
    ? await reserveTierSmokeLedger(
        options.tierLedgerFile,
        options.tierId,
        requireTierSmokeSpec(options.tierId, options.probe as TierSmokeSpec["probe"]).costCeilingFen,
        ledgerBatchId,
      )
    : undefined;
  const summary = await executeProbe(options);
  if (reservationId && options.tierId && options.tierLedgerFile) {
    await completeTierSmokeLedger(
      options.tierLedgerFile,
      options.tierId,
      reservationId,
      summary,
      ledgerBatchId,
    );
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function executeProbe(options: CliOptions): Promise<ProbeSummary> {
  if (options.target === "dev") {
    assertFable007DeploymentIdentity({
      databaseUrl: settings.databaseUrl,
      expectedSha256: settings.pricingSeedDevDatabaseIdentitySha256,
      appEnvironment: settings.appEnvironment,
    });
  } else {
    assertTestEnvSmokeTarget();
  }
  const budget = new SmokeBudget(options.budgetFen);
  switch (options.probe) {
    case "ark-llm":
      return smokeArkLlm(options.probe, budget);
    case "minimax-llm":
      return smokeMinimaxLlm(options.probe, budget);
    case "ark-image":
      return smokeArkImage(options.probe, budget, options.target, options.tierId);
    case "minimax-image":
      return smokeMinimaxImage(options.probe, budget);
    case "ark-video":
      return smokeArkVideo(options.probe, budget, options.tierId);
    case "minimax-video":
      return smokeMinimaxVideo(options.probe, budget);
    case "seed-audio":
      return smokeSeedAudio(options.probe, budget);
    case "minimax-audio":
      return smokeMinimaxAudio(options.probe, budget);
  }
}

async function smokeArkLlm(probe: Probe, budget: SmokeBudget): Promise<ProbeSummary> {
  const model = requireConfiguredModel(
    settings.arkLlmModels,
    ["doubao-seed-2-0-mini-260428", "doubao-seed-2-0-mini-260215"],
    "ARK_LLM_MODELS",
  );
  const client = new ArkChatClient(
    assertApprovedCredential(
      settings.arkApiKey,
      settings.fable007DevArkCredentialSha256,
      "ARK_API_KEY",
    ),
    model,
    settings.arkBaseUrl,
  );
  budget.reserve(probe);
  const completion = await client.completeTextWithMetadata(
    "只回复 OK",
    "只输出 OK，不要解释。",
    { model, maxTokens: 8, thinking: "disabled" },
  );
  return llmSummary(probe, completion);
}

async function smokeMinimaxLlm(probe: Probe, budget: SmokeBudget): Promise<ProbeSummary> {
  const model = requireConfiguredModel(
    settings.minimaxLlmModels,
    ["MiniMax-M3", "MiniMax-M2.7"],
    "MINIMAX_LLM_MODELS",
  );
  const provider = new MiniMaxCompletionProvider(
    assertApprovedCredential(
      settings.minimaxApiKey,
      settings.fable007DevMinimaxCredentialSha256,
      "MINIMAX_API_KEY",
    ),
    model,
    settings.minimaxBaseUrl,
  );
  budget.reserve(probe);
  const completion = await provider.complete({
    model,
    system: "只输出 OK，不要解释。",
    prompt: "只回复 OK",
    maxTokens: 8,
    thinking: "disabled",
  });
  return llmSummary(probe, completion);
}

async function smokeArkImage(
  probe: Probe,
  budget: SmokeBudget,
  target: TierUnfreezeTarget,
  tierId?: string,
): Promise<ProbeSummary> {
  const spec = tierId ? requireTierSmokeSpec(tierId, "ark-image") : undefined;
  const model = requireConfiguredModel(
    settings.arkImageModel,
    [spec?.model ?? "doubao-seedream-5-0-pro-260628"],
    "ARK_IMAGE_MODEL",
  );
  const provider = new ArkGenerationProvider({
    apiKey: assertApprovedCredential(
      settings.arkApiKey,
      target === "dev"
        ? settings.fable007DevArkCredentialSha256
        : settings.tierUnfreezeTestEnvArkCredentialSha256,
      "ARK_API_KEY",
    ),
    baseUrl: settings.arkBaseUrl,
  });
  const request: ProviderGenerationRequest = {
    mediaKind: "image",
    model,
    prompt: "一只白色陶瓷杯放在纯色桌面，产品摄影，无文字，无人物。",
    parameters: spec?.parameters ?? {
      size: "1K",
      ratio: "16:9",
      watermark: false,
      sequentialImageGeneration: "disabled",
    },
    references: [],
    quantity: 1,
  };
  if (target === "test-env" && tierId && spec) {
    const reservationId = await reserveTestEnvTierSmoke(tierId, spec.costCeilingFen);
    const summary = await mediaSummary(
      probe,
      budget,
      provider,
      request,
      tierId,
      spec.costCeilingFen,
      "9:16",
    );
    await completeTestEnvTierSmoke(tierId, reservationId, summary);
    return summary;
  }
  return mediaSummary(probe, budget, provider, request, tierId, spec?.costCeilingFen);
}

async function smokeMinimaxImage(probe: Probe, budget: SmokeBudget): Promise<ProbeSummary> {
  const model = requireConfiguredModel(
    settings.minimaxImageModels,
    ["image-01"],
    "MINIMAX_IMAGE_MODELS",
  );
  const provider = minimaxMediaProvider();
  return mediaSummary(probe, budget, provider, {
    mediaKind: "image",
    model,
    prompt: "一只白色陶瓷杯放在纯色桌面，产品摄影，无文字，无人物。",
    parameters: {
      size: "1K",
      ratio: "16:9",
      watermark: false,
      sequentialImageGeneration: "disabled",
    },
    references: [],
    quantity: 1,
  });
}

async function smokeArkVideo(
  probe: Probe,
  budget: SmokeBudget,
  tierId?: string,
): Promise<ProbeSummary> {
  const spec = tierId ? requireTierSmokeSpec(tierId, "ark-video") : undefined;
  // 2.5 专用接入点档的模型来自 ARK_VIDEO_MODEL_2_5,其余档来自 ARK_VIDEO_MODEL;
  // 两个都是部署侧显式配置,缺哪个就 fail-closed,绝不回退到别的模型。
  const configuredVideoModels = [settings.arkVideoModel, settings.arkVideoModel25]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(",");
  const model = requireConfiguredModel(
    configuredVideoModels,
    [spec?.model ?? "doubao-seedance-2-0-mini-260615"],
    "ARK_VIDEO_MODEL/ARK_VIDEO_MODEL_2_5",
  );
  const provider = new ArkGenerationProvider({
    apiKey: assertApprovedCredential(
      settings.arkApiKey,
      settings.fable007DevArkCredentialSha256,
      "ARK_API_KEY",
    ),
    baseUrl: settings.arkBaseUrl,
  });
  return mediaSummary(probe, budget, provider, {
    mediaKind: "video",
    model,
    prompt: "固定镜头，一只白色陶瓷杯放在纯色桌面，柔和光线，轻微蒸汽，无文字，无人物。",
    parameters: spec?.parameters ?? {
      resolution: "480p",
      ratio: "16:9",
      durationSeconds: 4,
      watermark: false,
      generateAudio: false,
    },
    references: [],
    quantity: 1,
  }, tierId, spec?.costCeilingFen);
}

async function smokeMinimaxVideo(probe: Probe, budget: SmokeBudget): Promise<ProbeSummary> {
  const model = requireConfiguredModel(
    settings.minimaxVideoModels,
    ["MiniMax-H3"],
    "MINIMAX_VIDEO_MODELS",
  );
  return mediaSummary(probe, budget, minimaxMediaProvider(), {
    mediaKind: "video",
    model,
    prompt: "固定镜头，一只白色陶瓷杯放在纯色桌面，柔和光线，轻微蒸汽，无文字，无人物。",
    parameters: {
      resolution: "768P",
      ratio: "16:9",
      durationSeconds: 4,
      watermark: false,
      generateAudio: false,
    },
    references: [],
    quantity: 1,
  });
}

async function smokeSeedAudio(probe: Probe, budget: SmokeBudget): Promise<ProbeSummary> {
  const model = requireSecret(settings.seedAudioModel, "SEED_AUDIO_MODEL");
  const provider = new SeedAudioProvider({
    apiKey: assertApprovedCredential(
      settings.seedAudioApiKey,
      settings.fable007DevSeedAudioCredentialSha256,
      "SEED_AUDIO_API_KEY",
    ),
    endpoint: requireSecret(settings.seedAudioEndpoint, "SEED_AUDIO_ENDPOINT"),
  });
  return mediaSummary(probe, budget, provider, {
    mediaKind: "audio",
    model,
    prompt: "今天天气很好。",
    parameters: {
      originalDurationSeconds: 3,
      format: "mp3",
      sampleRate: 48_000,
      enableSubtitle: true,
      aigcMetadataEnabled: true,
      aigcWatermarkEnabled: false,
    },
    references: [],
    quantity: 1,
  });
}

async function smokeMinimaxAudio(probe: Probe, budget: SmokeBudget): Promise<ProbeSummary> {
  const model = requireConfiguredModel(
    settings.minimaxAudioModels,
    ["speech-2.8-turbo"],
    "MINIMAX_AUDIO_MODELS",
  );
  return mediaSummary(probe, budget, minimaxMediaProvider(), {
    mediaKind: "audio",
    model,
    prompt: "今天天气很好。",
    parameters: {
      originalDurationSeconds: 3,
      format: "mp3",
      sampleRate: 32_000,
      enableSubtitle: true,
      aigcMetadataEnabled: true,
      aigcWatermarkEnabled: false,
    },
    references: [],
    quantity: 1,
  });
}

function minimaxMediaProvider(): MinimaxGenerationProvider {
  return new MinimaxGenerationProvider({
    apiKey: assertApprovedCredential(
      settings.minimaxApiKey,
      settings.fable007DevMinimaxCredentialSha256,
      "MINIMAX_API_KEY",
    ),
    baseUrl: settings.minimaxBaseUrl,
    defaultSpeakerId: settings.minimaxAudioVoiceId,
  });
}

function llmSummary(
  probe: Probe,
  completion: {
    content: string;
    inputTokens: number | null;
    outputTokens: number | null;
  },
): ProbeSummary {
  if (!completion.content.trim()) throw new Error("LLM_PROBE_EMPTY_OUTPUT");
  return {
    ok: true,
    probeKey: PROBE_KEYS[probe],
    tierKey: TIER_KEYS[probe],
    declaredCostCeilingFen: COST_CEILING_FEN[probe],
    reservedCostFen: COST_CEILING_FEN[probe],
    usage: receiptUsage({
      input_tokens: completion.inputTokens,
      output_tokens: completion.outputTokens,
    }),
    outputLength: completion.content.length,
    outputSha256: sha256(Buffer.from(completion.content, "utf8")),
  };
}

async function mediaSummary(
  probe: Probe,
  budget: SmokeBudget,
  provider: GenerationProvider,
  request: ProviderGenerationRequest,
  tierId?: string,
  costCeilingFen?: number,
  expectedImageRatio?: "9:16",
): Promise<ProbeSummary> {
  // This is the last operation before provider.submit. The fixed approved
  // maximum is charged against the in-process cumulative ceiling first.
  const reservedCostFen = costCeilingFen ?? COST_CEILING_FEN[probe];
  budget.reserveFen(reservedCostFen);
  let submission;
  try {
    submission = await provider.submit(request);
  } catch (error) {
    throw providerProbeFailure(error, "SUBMIT");
  }
  let result: ProviderResultSnapshot;
  if (submission.outcome === "succeeded") {
    result = submission.result;
  } else {
    result = await pollVideo(provider, request, submission.providerTaskId, probe);
  }
  if (result.status !== "succeeded" || result.media.length !== 1) {
    // 状态插值一律大写:safeFailure 只放行全大写错误码,小写会被脱敏成无名失败。
    throw new Error(`MEDIA_PROBE_INVALID_RESULT_${result.status.toUpperCase()}_${result.media.length}`);
  }
  const artifact = await verifyPlatformAigc(
    probe,
    request.mediaKind,
    result.media[0]!,
    expectedImageRatio,
  );
  const providerTaskFingerprint = sha256(Buffer.from(
    submission.providerTaskId
      ?? result.media[0]!.temporaryUrl
      ?? artifact.sha256BeforeLabel,
    "utf8",
  )).slice(0, 16);
  return {
    ok: true,
    probeKey: PROBE_KEYS[probe],
    tierKey: tierId ?? TIER_KEYS[probe],
    declaredCostCeilingFen: reservedCostFen,
    reservedCostFen,
    providerTaskFingerprint,
    ...(result.usage ? { usage: receiptUsage(result.usage) } : {}),
    artifact,
  };
}

async function pollVideo(
  provider: GenerationProvider,
  request: ProviderGenerationRequest,
  taskId: string,
  probe: Probe,
): Promise<ProviderResultSnapshot> {
  for (let poll = 1; poll <= VIDEO_MAX_POLLS; poll += 1) {
    await delay(VIDEO_POLL_INTERVAL_MS);
    let result: ProviderResultSnapshot;
    try {
      result = await provider.query(taskId, {
        model: request.model,
        mediaKind: request.mediaKind,
      });
    } catch (error) {
      throw providerProbeFailure(error, "QUERY");
    }
    process.stderr.write(`probe=${PROBE_KEYS[probe]} poll=${poll} status=${result.status}\n`);
    if (result.status === "succeeded") return result;
    if (result.status === "failed") {
      throw new Error(`VIDEO_PROBE_FAILED_${safeToken(result.errorCode ?? result.rawStatus ?? "UNKNOWN")}`);
    }
  }
  throw new Error("VIDEO_PROBE_POLL_TIMEOUT");
}

async function verifyPlatformAigc(
  probe: Probe,
  mediaKind: GenerationMediaKind,
  media: ProviderMediaResult,
  expectedImageRatio?: "9:16",
): Promise<ArtifactEvidence> {
  let materialized: { content: Buffer; contentType: string };
  try {
    materialized = await materializeMedia(media);
  } catch {
    throw new Error("MEDIA_PROBE_ARTIFACT_DOWNLOAD_FAILED");
  }
  const detected = detectMedia(materialized.content, materialized.contentType, mediaKind);
  const imageDimensions = mediaKind === "image" && expectedImageRatio
    ? await readImageDimensions(materialized.content)
    : undefined;
  if (expectedImageRatio && imageDimensions) {
    assertImageAspectRatio(imageDimensions.widthPx, imageDimensions.heightPx, expectedImageRatio);
  }
  const contentId = `fable007-${probe}-${randomUUID()}`;
  let labeled: Awaited<ReturnType<AigcMetadataLabeler["apply"]>>;
  try {
    labeled = await new AigcMetadataLabeler().apply({
      content: materialized.content,
      contentType: detected.contentType,
      extension: detected.extension,
      mediaKind,
      contentId,
    });
  } catch {
    throw new Error("AIGC_PLATFORM_LABEL_FAILED");
  }
  let readback: Awaited<ReturnType<typeof readAigcImplicitLabel>>;
  try {
    readback = await readAigcImplicitLabel(labeled.content, mediaKind, detected.extension);
  } catch {
    throw new Error("AIGC_PLATFORM_READBACK_FAILED");
  }
  if (readback.ProduceID !== contentId
    || labeled.complianceMetadata.aigcMetadataEvidence !== "platform_applied") {
    throw new Error("AIGC_PLATFORM_READBACK_MISMATCH");
  }
  return {
    mediaKind,
    contentType: detected.contentType,
    extension: detected.extension,
    ...imageDimensions,
    bytesBeforeLabel: materialized.content.length,
    bytesAfterLabel: labeled.content.length,
    sha256BeforeLabel: sha256(materialized.content),
    sha256AfterLabel: sha256(labeled.content),
    platformAigcReadback: true,
    providerOriginPreserved: Boolean(labeled.complianceMetadata.providerOriginEvidence),
  };
}

async function readImageDimensions(
  content: Buffer,
): Promise<{ widthPx: number; heightPx: number }> {
  let metadata;
  try {
    metadata = await sharp(content).metadata();
  } catch {
    throw new Error("MEDIA_PROBE_IMAGE_DIMENSIONS_INVALID");
  }
  if (!metadata.width || !metadata.height) {
    throw new Error("MEDIA_PROBE_IMAGE_DIMENSIONS_MISSING");
  }
  return { widthPx: metadata.width, heightPx: metadata.height };
}

export function assertImageAspectRatio(
  widthPx: number,
  heightPx: number,
  expected: "9:16",
): void {
  if (!Number.isSafeInteger(widthPx)
    || !Number.isSafeInteger(heightPx)
    || widthPx <= 0
    || heightPx <= 0) {
    throw new Error("MEDIA_PROBE_IMAGE_DIMENSIONS_INVALID");
  }
  if (heightPx <= widthPx || Math.abs((widthPx / heightPx) - (9 / 16)) > 0.02) {
    throw new Error(`MEDIA_PROBE_IMAGE_RATIO_MISMATCH_${expected}`);
  }
}

async function materializeMedia(
  media: ProviderMediaResult,
): Promise<{ content: Buffer; contentType: string }> {
  if (media.inlineContent) {
    const downloaded = inlineDownloadedMedia(media.inlineContent);
    assertArtifactSize(downloaded.byteLength);
    return { content: downloaded.content, contentType: downloaded.contentType };
  }
  if (!media.temporaryUrl) throw new Error("MEDIA_PROBE_MISSING_CONTENT");
  const downloaded = await downloadMediaBytes(media.temporaryUrl, {
    maxBytes: MAX_ARTIFACT_BYTES,
    timeoutMs: 120_000,
  });
  assertArtifactSize(downloaded.byteLength);
  return {
    content: downloaded.content,
    contentType: downloaded.contentType,
  };
}

function detectMedia(
  content: Buffer,
  suppliedContentType: string,
  mediaKind: GenerationMediaKind,
): { contentType: string; extension: string } {
  if (content.length >= 8 && content.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) {
    if (mediaKind !== "image") throw new Error("MEDIA_PROBE_KIND_MISMATCH");
    return { contentType: "image/png", extension: "png" };
  }
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    if (mediaKind !== "image") throw new Error("MEDIA_PROBE_KIND_MISMATCH");
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (content.length >= 12 && content.subarray(4, 8).toString("ascii") === "ftyp") {
    if (mediaKind !== "video") throw new Error("MEDIA_PROBE_KIND_MISMATCH");
    return { contentType: "video/mp4", extension: "mp4" };
  }
  const isMp3 = content.subarray(0, 3).toString("ascii") === "ID3"
    || (content.length >= 2 && content[0] === 0xff && (content[1]! & 0xe0) === 0xe0);
  if (isMp3) {
    if (mediaKind !== "audio") throw new Error("MEDIA_PROBE_KIND_MISMATCH");
    return { contentType: "audio/mpeg", extension: "mp3" };
  }
  throw new Error(`MEDIA_PROBE_UNSUPPORTED_TYPE_${safeToken(suppliedContentType)}`);
}

export function parseArgs(
  args: readonly string[],
  companyProviderAllowlist: readonly string[] = settings.companyProviderAllowlist,
): CliOptions {
  let probe: Probe | undefined;
  let target: string | undefined;
  let budgetFen: number | undefined;
  let confirmPaid = false;
  let tierId: string | undefined;
  let tierLedgerFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--probe") {
      const value = args[index + 1];
      if (!value || !PROBES.includes(value as Probe)) {
        throw new Error(`--probe 仅支持 ${PROBES.join(" / ")}`);
      }
      probe = value as Probe;
      index += 1;
    } else if (arg === "--target") {
      target = args[index + 1];
      index += 1;
    } else if (arg === "--budget-fen") {
      budgetFen = Number(args[index + 1]);
      index += 1;
    } else if (arg === "--confirm-paid") {
      confirmPaid = true;
    } else if (arg === "--tier-id") {
      tierId = args[index + 1];
      index += 1;
    } else if (arg === "--tier-ledger-file") {
      tierLedgerFile = args[index + 1];
      index += 1;
    } else {
      throw new Error(`未知参数 ${arg}`);
    }
  }
  if (!probe) throw new Error("缺少 --probe");
  const tierSpec = tierId ? TIER_UNFREEZE_SMOKE_SPECS[tierId] : undefined;
  if (tierId && (!tierSpec || tierSpec.probe !== probe)) {
    throw new Error("拒绝执行:--tier-id 不在该 Ark 探针的已审核解冻批次");
  }
  if (!tierId && tierLedgerFile) {
    throw new Error("拒绝执行:--tier-ledger-file 只能与 --tier-id 同时使用");
  }
  if (!isCompanyProviderAllowed(
    probe.startsWith("minimax-") ? "minimax" : "ark",
    normalizeCompanyProviderAllowlist(companyProviderAllowlist),
  )) {
    throw new Error(COMPANY_PROVIDER_NOT_ENABLED_MESSAGE);
  }
  if (target !== "dev" && target !== "test-env") {
    throw new Error("拒绝执行:FABLE-007 真实调用只允许 --target dev 或 test-env");
  }
  if (target === "test-env"
    && (probe !== "ark-image" || tierId !== "img-seedream5pro-916-1k-1")) {
    throw new Error("拒绝执行:test-env 付费探针只允许已审核的 9:16 最低价图片档");
  }
  if (target === "dev" && tierId && (!tierLedgerFile || !path.isAbsolute(tierLedgerFile))) {
    throw new Error("拒绝执行:dev 档位付费探针必须提供绝对路径 --tier-ledger-file");
  }
  if (target === "test-env" && tierLedgerFile) {
    throw new Error("拒绝执行:test-env 付费防重只允许使用测试库持久账本");
  }
  if (!confirmPaid) throw new Error("拒绝执行:必须显式声明 --confirm-paid");
  const requiredBudgetFen = tierSpec?.costCeilingFen ?? COST_CEILING_FEN[probe];
  if (!Number.isSafeInteger(budgetFen) || (budgetFen ?? 0) < requiredBudgetFen) {
    throw new Error(`拒绝执行:--budget-fen 必须覆盖该探针 ${requiredBudgetFen} 分的上限`);
  }
  if (budgetFen! > MAX_AUTHORIZED_BUDGET_FEN) {
    throw new Error(`拒绝执行:预算不能超过 ${MAX_AUTHORIZED_BUDGET_FEN} 分`);
  }
  return {
    probe,
    target,
    budgetFen: budgetFen!,
    confirmPaid: true,
    ...(tierId ? { tierId } : {}),
    ...(tierLedgerFile ? { tierLedgerFile } : {}),
  };
}

/**
 * Uses the same independently provisioned database identity gate as the
 * FABLE-007 dev-tier promotion. `--target dev` is merely intent; it cannot
 * identify a deployment or database on its own.
 */
export function assertFable007DeploymentIdentity(configured: {
  databaseUrl?: string;
  expectedSha256?: string;
  appEnvironment: string;
}): void {
  assertPromotionDatabaseIdentity({
    promoteSgoal04P2: false,
    promoteFable007: true,
  }, configured);
}

export class SmokeBudget {
  private consumedFen = 0;

  constructor(private readonly approvedFen: number) {}

  reserve(probe: Probe): void {
    this.reserveFen(COST_CEILING_FEN[probe]);
  }

  reserveFen(costFen: number): void {
    if (!Number.isSafeInteger(costFen) || costFen <= 0) {
      throw new Error("SMOKE_BUDGET_INVALID_RESERVATION");
    }
    const next = this.consumedFen + costFen;
    if (!Number.isSafeInteger(next) || next > this.approvedFen) {
      throw new Error("SMOKE_BUDGET_EXCEEDED");
    }
    this.consumedFen = next;
  }

  get reservedFen(): number {
    return this.consumedFen;
  }
}

interface TierSmokeLedgerEntry {
  tierId: string;
  reservationId: string;
  reservedFen: number;
  reservedAt: string;
  status: "reserved" | "completed";
  completedAt?: string;
  providerTaskFingerprint?: string;
  artifactSha256?: string;
  artifactWidthPx?: number;
  artifactHeightPx?: number;
}

interface TierSmokeLedger {
  batchId: string;
  maxCumulativeFen: number;
  entries: TierSmokeLedgerEntry[];
}

function assertTestEnvSmokeTarget(): void {
  assertTierUnfreezeDatabaseTransport({
    target: "test-env",
    sslMode: settings.postgresSslMode,
    rootCertPath: settings.postgresSslRootCert,
  });
  assertTierUnfreezeTargetIdentity({
    target: "test-env",
    databaseUrl: settings.databaseUrl,
    schema: settings.postgresSchema,
    expectedSha256: settings.tierUnfreezeTestEnvTargetIdentitySha256,
    appEnvironment: settings.appEnvironment,
  });
}

async function withTestEnvSmokePool<T>(
  operation: (pool: Pool, qualifiedTable: string) => Promise<T>,
): Promise<T> {
  const databaseUrl = settings.databaseUrl;
  if (!databaseUrl) throw new Error("TIER_SMOKE_DATABASE_NOT_CONFIGURED");
  const pool = new Pool(buildDatabasePoolConfig(databaseUrl));
  const qualifiedTable = `${quoteIdentifier(settings.postgresSchema)}.tier_smoke_reservations`;
  try {
    return await operation(pool, qualifiedTable);
  } finally {
    await pool.end();
  }
}

export async function reserveTestEnvTierSmoke(
  tierId: string,
  reservedFen: number,
): Promise<string> {
  return withTestEnvSmokePool((pool) => reserveTestEnvTierSmokeInPool(
    pool,
    settings.postgresSchema,
    tierId,
    reservedFen,
  ));
}

export async function reserveTestEnvTierSmokeInPool(
  pool: Pool,
  schema: string,
  tierId: string,
  reservedFen: number,
): Promise<string> {
  if (tierId !== "img-seedream5pro-916-1k-1"
    || !Number.isSafeInteger(reservedFen)
    || reservedFen !== 30) {
    throw new Error("TIER_SMOKE_TEST_ENV_RESERVATION_NOT_APPROVED");
  }
  const reservationId = randomUUID();
  const table = `${quoteIdentifier(schema)}.tier_smoke_reservations`;
  const result = await pool.query<{ reservation_id: string }>(
    `INSERT INTO ${table} (
       reservation_id, batch_id, tier_id, target, reserved_fen, status, reserved_at
     ) VALUES ($1, $2, $3, 'test-env', $4, 'reserved', now())
     ON CONFLICT (batch_id, tier_id) DO NOTHING
     RETURNING reservation_id`,
    [reservationId, TIER_UNFREEZE_TEST_ENV_BATCH_ID, tierId, reservedFen],
  );
  if (result.rowCount !== 1) {
    throw new Error("TIER_SMOKE_ALREADY_RESERVED_OR_COMPLETED");
  }
  return reservationId;
}

export async function completeTestEnvTierSmoke(
  tierId: string,
  reservationId: string,
  summary: ProbeSummary,
): Promise<void> {
  const providerTaskFingerprint = summary.providerTaskFingerprint;
  const artifactSha256 = summary.artifact?.sha256AfterLabel;
  const artifactWidthPx = summary.artifact?.widthPx;
  const artifactHeightPx = summary.artifact?.heightPx;
  if (!providerTaskFingerprint || !/^[0-9a-f]{16,64}$/u.test(providerTaskFingerprint)) {
    throw new Error("TIER_SMOKE_LEDGER_TASK_FINGERPRINT_MISSING");
  }
  if (!artifactSha256 || !/^[0-9a-f]{64}$/u.test(artifactSha256)) {
    throw new Error("TIER_SMOKE_LEDGER_ARTIFACT_SHA_MISSING");
  }
  assertImageAspectRatio(artifactWidthPx ?? 0, artifactHeightPx ?? 0, "9:16");
  await withTestEnvSmokePool(async (pool, table) => {
    const result = await pool.query(
      `UPDATE ${table}
       SET status = 'completed',
           completed_at = now(),
           provider_task_fingerprint = $4,
           artifact_sha256 = $5,
           artifact_width_px = $6,
           artifact_height_px = $7
       WHERE batch_id = $1
         AND tier_id = $2
         AND reservation_id = $3
         AND status = 'reserved'
       RETURNING reservation_id`,
      [
        TIER_UNFREEZE_TEST_ENV_BATCH_ID,
        tierId,
        reservationId,
        providerTaskFingerprint,
        artifactSha256,
        artifactWidthPx,
        artifactHeightPx,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("TIER_SMOKE_LEDGER_RESERVATION_MISMATCH");
    }
  });
}

/**
 * A reservation is persisted before provider.submit. A failed or interrupted
 * call deliberately leaves the tier reserved, so rerunning cannot silently
 * create a second paid request. Manual review is required to release it.
 */
export async function reserveTierSmokeLedger(
  file: string,
  tierId: string,
  reservedFen: number,
  batchId: TierSmokeLedger["batchId"] = TIER_UNFREEZE_BATCH_ID,
): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error("TIER_SMOKE_LEDGER_PATH_MUST_BE_ABSOLUTE");
  if (!Number.isSafeInteger(reservedFen) || reservedFen <= 0) {
    throw new Error("TIER_SMOKE_LEDGER_INVALID_RESERVATION");
  }
  return withTierSmokeLedger(file, batchId, (ledger) => {
    if (ledger.entries.some((entry) => entry.tierId === tierId)) {
      throw new Error("TIER_SMOKE_ALREADY_RESERVED_OR_COMPLETED");
    }
    const cumulative = ledger.entries.reduce((total, entry) => total + entry.reservedFen, 0);
    if (cumulative + reservedFen > MAX_AUTHORIZED_BUDGET_FEN) {
      throw new Error("TIER_SMOKE_CUMULATIVE_BUDGET_EXCEEDED");
    }
    const reservationId = randomUUID();
    ledger.entries.push({
      tierId,
      reservationId,
      reservedFen,
      reservedAt: new Date().toISOString(),
      status: "reserved",
    });
    return reservationId;
  });
}

export async function completeTierSmokeLedger(
  file: string,
  tierId: string,
  reservationId: string,
  summary: ProbeSummary,
  batchId: TierSmokeLedger["batchId"] = TIER_UNFREEZE_BATCH_ID,
): Promise<void> {
  const providerTaskFingerprint = summary.providerTaskFingerprint;
  const artifactSha256 = summary.artifact?.sha256AfterLabel;
  const artifactWidthPx = summary.artifact?.widthPx;
  const artifactHeightPx = summary.artifact?.heightPx;
  if (!providerTaskFingerprint || !/^[0-9a-f]{16,64}$/u.test(providerTaskFingerprint)) {
    throw new Error("TIER_SMOKE_LEDGER_TASK_FINGERPRINT_MISSING");
  }
  if (!artifactSha256 || !/^[0-9a-f]{64}$/u.test(artifactSha256)) {
    throw new Error("TIER_SMOKE_LEDGER_ARTIFACT_SHA_MISSING");
  }
  await withTierSmokeLedger(file, batchId, (ledger) => {
    const entry = ledger.entries.find((candidate) => (
      candidate.tierId === tierId && candidate.reservationId === reservationId
    ));
    if (!entry || entry.status !== "reserved") {
      throw new Error("TIER_SMOKE_LEDGER_RESERVATION_MISMATCH");
    }
    if (ledger.entries.some((candidate) => (
      candidate !== entry
      && (candidate.providerTaskFingerprint === providerTaskFingerprint
        || candidate.artifactSha256 === artifactSha256)
    ))) {
      throw new Error("TIER_SMOKE_LEDGER_DUPLICATE_EVIDENCE");
    }
    entry.status = "completed";
    entry.completedAt = new Date().toISOString();
    entry.providerTaskFingerprint = providerTaskFingerprint;
    entry.artifactSha256 = artifactSha256;
    if (artifactWidthPx !== undefined) entry.artifactWidthPx = artifactWidthPx;
    if (artifactHeightPx !== undefined) entry.artifactHeightPx = artifactHeightPx;
  });
}

async function withTierSmokeLedger<T>(
  file: string,
  batchId: TierSmokeLedger["batchId"],
  update: (ledger: TierSmokeLedger) => T,
): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockFile = `${file}.lock`;
  let lock;
  try {
    lock = await open(lockFile, "wx", 0o600);
  } catch {
    throw new Error("TIER_SMOKE_LEDGER_LOCKED");
  }
  try {
    const ledger = await readTierSmokeLedger(file, batchId);
    const result = update(ledger);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
    return result;
  } finally {
    await lock.close();
    await unlink(lockFile).catch(() => undefined);
  }
}

async function readTierSmokeLedger(
  file: string,
  batchId: TierSmokeLedger["batchId"],
): Promise<TierSmokeLedger> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        batchId,
        maxCumulativeFen: MAX_AUTHORIZED_BUDGET_FEN,
        entries: [],
      };
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("TIER_SMOKE_LEDGER_INVALID_JSON");
  }
  if (!isRecord(value)
    || value.batchId !== batchId
    || value.maxCumulativeFen !== MAX_AUTHORIZED_BUDGET_FEN
    || !Array.isArray(value.entries)) {
    throw new Error("TIER_SMOKE_LEDGER_INVALID_SHAPE");
  }
  const entries = value.entries.map((entry): TierSmokeLedgerEntry => {
    if (!isRecord(entry)
      || typeof entry.tierId !== "string"
      || typeof entry.reservationId !== "string"
      || !Number.isSafeInteger(entry.reservedFen)
      || typeof entry.reservedAt !== "string"
      || (entry.status !== "reserved" && entry.status !== "completed")) {
      throw new Error("TIER_SMOKE_LEDGER_INVALID_ENTRY");
    }
    return entry as unknown as TierSmokeLedgerEntry;
  });
  if (new Set(entries.map((entry) => entry.tierId)).size !== entries.length) {
    throw new Error("TIER_SMOKE_LEDGER_DUPLICATE_TIER");
  }
  return {
    batchId,
    maxCumulativeFen: MAX_AUTHORIZED_BUDGET_FEN,
    entries,
  };
}

function requireTierSmokeSpec(
  tierId: string,
  probe: TierSmokeSpec["probe"],
): TierSmokeSpec {
  const spec = TIER_UNFREEZE_SMOKE_SPECS[tierId];
  if (!spec || spec.probe !== probe) throw new Error("TIER_SMOKE_SPEC_NOT_APPROVED");
  return spec;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function receiptUsage(usage: Record<string, unknown>): Partial<Record<ReceiptUsageKey, number>> {
  const result: Partial<Record<ReceiptUsageKey, number>> = {};
  for (const key of RECEIPT_USAGE_KEYS) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}

function requireConfiguredModel(
  configured: string | undefined,
  preferred: readonly string[],
  key: string,
): string {
  const values = [...new Set((configured ?? "").split(",").map((value) => value.trim()).filter(Boolean))];
  for (const model of preferred) {
    if (values.includes(model)) return model;
  }
  // A paid smoke must never fall back to an arbitrary configured model:
  // its hard-coded cost ceiling is valid only for the reviewed cheap models.
  throw new Error(`${key}_REVIEWED_CHEAP_MODEL_NOT_CONFIGURED`);
}

function requireSecret(value: string | undefined, key: string): string {
  if (!value?.trim()) throw new Error(`${key}_NOT_CONFIGURED`);
  return value.trim();
}

/** Refuses an accidental prod/unknown credential even inside a dev shell. */
export function assertApprovedCredential(
  value: string | undefined,
  expectedSha256: string | undefined,
  key: string,
): string {
  const secret = requireSecret(value, key);
  if (!expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(`${key}_DEV_SMOKE_FINGERPRINT_NOT_CONFIGURED`);
  }
  const actual = Buffer.from(sha256(Buffer.from(secret, "utf8")), "hex");
  const expected = Buffer.from(expectedSha256, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(`${key}_NOT_APPROVED_FOR_DEV_SMOKE`);
  }
  return secret;
}

function assertArtifactSize(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("MEDIA_PROBE_EMPTY_ARTIFACT");
  if (bytes > MAX_ARTIFACT_BYTES) throw new Error("MEDIA_PROBE_ARTIFACT_TOO_LARGE");
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "UNKNOWN";
}

function providerProbeFailure(error: unknown, stage: "SUBMIT" | "QUERY"): Error {
  if (!(error instanceof ProviderRequestError)) {
    return new Error(
      stage === "SUBMIT"
        ? "MEDIA_PROBE_SUBMIT_INTERNAL_FAILURE"
        : "MEDIA_PROBE_QUERY_INTERNAL_FAILURE",
    );
  }
  if (error.outcome === "rejected") {
    return new Error(
      stage === "SUBMIT"
        ? "MEDIA_PROBE_SUBMIT_REJECTED"
        : "MEDIA_PROBE_QUERY_REJECTED",
    );
  }
  if (error.outcome === "unknown") {
    return new Error(
      stage === "SUBMIT"
        ? "MEDIA_PROBE_SUBMIT_OUTCOME_UNKNOWN"
        : "MEDIA_PROBE_QUERY_OUTCOME_UNKNOWN",
    );
  }
  return new Error(
    stage === "SUBMIT"
      ? "MEDIA_PROBE_SUBMIT_FAILED"
      : "MEDIA_PROBE_QUERY_FAILED",
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFailure(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return { name: "FABLE007_SMOKE_FAILED" };
  const { message } = error instanceof Error ? error : { message: undefined };
  return {
    name: "FABLE007_SMOKE_FAILED",
    ...(
      message
      && /^(?:FABLE007|SMOKE|AIGC|MEDIA|LLM|VIDEO)_[A-Z0-9_]+$/.test(message)
        ? { code: safeToken(message) }
        : {}
    ),
  };
}

const isDirectRun = process.argv[1]?.endsWith("fable007-provider-smoke.mts")
  || process.argv[1]?.endsWith("fable007-provider-smoke");
if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeFailure(error) })}\n`);
    process.exitCode = 1;
  });
}

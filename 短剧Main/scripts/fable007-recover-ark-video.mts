#!/usr/bin/env node
/**
 * Read-only recovery for the single recent Ark video used by FABLE-007.
 *
 * The paid submission is never repeated. This script lists already-succeeded
 * Ark tasks inside a narrow time window, requires one exact cheap-tier match,
 * then retries only the temporary artifact download and platform AIGC label.
 * It never prints a task ID, provider URL, prompt, credential or raw response.
 */
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { settings } from "../src/config/env.js";
import {
  AigcMetadataLabeler,
  readAigcImplicitLabel,
} from "../src/modules/generation/aigcLabeler.js";
import { downloadMediaBytes } from "../src/modules/generation/mediaDownload.js";
import {
  assertApprovedCredential,
  assertFable007DeploymentIdentity,
} from "./fable007-provider-smoke.mjs";

interface RecoveryOptions {
  target: "dev";
  afterUnix: number;
  taskFingerprint?: string;
}

interface ArkTaskCandidate {
  id: string;
  temporaryUrl: string;
}

interface CandidateDiagnostics {
  listed: number;
  succeeded: number;
  afterWindow: number;
  expectedModel: number;
  expectedModelAfterWindow: number;
  cheapTierShapeAfterWindow: number;
  withVideoUrl: number;
  uniqueCandidateIds: number;
  candidateEvidence: Array<{
    taskFingerprint: string;
    createdAt: number;
    updatedAt: number;
    completionTokens: number;
  }>;
}

class CandidateCountError extends Error {
  constructor(
    count: number,
    readonly diagnostics: CandidateDiagnostics,
  ) {
    super(`ARK_RECOVERY_CANDIDATE_COUNT_${Math.min(count, 99)}`);
  }
}

const MAX_LOOKBACK_SECONDS = 4 * 60 * 60;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

async function main(): Promise<void> {
  const options = parseRecoveryArgs(process.argv.slice(2));
  assertFable007DeploymentIdentity({
    databaseUrl: settings.databaseUrl,
    expectedSha256: settings.pricingSeedDevDatabaseIdentitySha256,
    appEnvironment: settings.appEnvironment,
  });
  const apiKey = assertApprovedCredential(
    settings.arkApiKey,
    settings.fable007DevArkCredentialSha256,
    "ARK_API_KEY",
  );
  const model = reviewedArkVideoModel(settings.arkVideoModel);
  const baseUrl = approvedArkBaseUrl(settings.arkBaseUrl);
  const scan = await listCandidates({ apiKey, baseUrl, model, afterUnix: options.afterUnix });
  const selected = options.taskFingerprint
    ? scan.candidates.filter((candidate) => sha256(candidate.id).startsWith(options.taskFingerprint!))
    : scan.candidates;
  if (selected.length !== 1) {
    throw new CandidateCountError(selected.length, scan.diagnostics);
  }

  // env.ts must load the caller's local-only root .env first. ExifTool then
  // resolves against the checked-in worktree configuration.
  process.chdir(fileURLToPath(new URL("../", import.meta.url)));
  const candidate = selected[0]!;
  let downloaded: Awaited<ReturnType<typeof downloadMediaBytes>>;
  try {
    downloaded = await downloadMediaBytes(candidate.temporaryUrl, {
      maxBytes: MAX_ARTIFACT_BYTES,
      timeoutMs: 120_000,
    });
  } catch (error) {
    throw new Error(classifyDownloadFailure(error));
  }
  if (
    downloaded.content.length < 12
    || downloaded.content.subarray(4, 8).toString("ascii") !== "ftyp"
  ) {
    throw new Error("ARK_RECOVERY_NOT_MP4");
  }

  const contentId = `fable007-ark-video-recovery-${randomUUID()}`;
  let labeled: Awaited<ReturnType<AigcMetadataLabeler["apply"]>>;
  try {
    labeled = await new AigcMetadataLabeler().apply({
      content: downloaded.content,
      contentType: "video/mp4",
      extension: "mp4",
      mediaKind: "video",
      contentId,
    });
  } catch {
    throw new Error("ARK_RECOVERY_AIGC_LABEL_FAILED");
  }
  let readback: Awaited<ReturnType<typeof readAigcImplicitLabel>>;
  try {
    readback = await readAigcImplicitLabel(labeled.content, "video", "mp4");
  } catch {
    throw new Error("ARK_RECOVERY_AIGC_READBACK_FAILED");
  }
  if (
    readback.ProduceID !== contentId
    || labeled.complianceMetadata.aigcMetadataEvidence !== "platform_applied"
  ) {
    throw new Error("ARK_RECOVERY_AIGC_READBACK_MISMATCH");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    taskFingerprint: sha256(candidate.id).slice(0, 16),
    artifact: {
      mediaKind: "video",
      contentType: "video/mp4",
      extension: "mp4",
      bytesBeforeLabel: downloaded.content.length,
      bytesAfterLabel: labeled.content.length,
      sha256BeforeLabel: sha256(downloaded.content),
      sha256AfterLabel: sha256(labeled.content),
      platformAigcReadback: true,
      providerOriginPreserved: Boolean(labeled.complianceMetadata.providerOriginEvidence),
    },
  })}\n`);
}

export function parseRecoveryArgs(args: readonly string[], nowUnix = Math.floor(Date.now() / 1_000)): RecoveryOptions {
  let target: string | undefined;
  let afterUnix: number | undefined;
  let taskFingerprint: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--target") {
      target = args[index + 1];
      index += 1;
    } else if (key === "--after-unix") {
      afterUnix = Number(args[index + 1]);
      index += 1;
    } else if (key === "--task-fingerprint") {
      taskFingerprint = args[index + 1]?.trim().toLowerCase();
      index += 1;
    } else {
      throw new Error("ARK_RECOVERY_ARGUMENT_INVALID");
    }
  }
  if (target !== "dev") throw new Error("ARK_RECOVERY_TARGET_MUST_BE_DEV");
  if (!Number.isSafeInteger(afterUnix) || afterUnix! <= 0 || afterUnix! > nowUnix) {
    throw new Error("ARK_RECOVERY_AFTER_UNIX_INVALID");
  }
  if (nowUnix - afterUnix! > MAX_LOOKBACK_SECONDS) {
    throw new Error("ARK_RECOVERY_LOOKBACK_TOO_WIDE");
  }
  if (taskFingerprint !== undefined && !/^[0-9a-f]{16}$/.test(taskFingerprint)) {
    throw new Error("ARK_RECOVERY_TASK_FINGERPRINT_INVALID");
  }
  return {
    target: "dev",
    afterUnix: afterUnix!,
    ...(taskFingerprint ? { taskFingerprint } : {}),
  };
}

export function classifyDownloadFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const status = message.match(/HTTP (\d{3})/)?.[1];
  if (status) return `ARK_RECOVERY_DOWNLOAD_HTTP_${status}`;
  if (/must use HTTPS|is invalid/i.test(message)) return "ARK_RECOVERY_DOWNLOAD_URL_INVALID";
  if (/credentials|standard HTTPS port/i.test(message)) return "ARK_RECOVERY_DOWNLOAD_URL_POLICY_REJECTED";
  if (/private|reserved host/i.test(message)) return "ARK_RECOVERY_DOWNLOAD_SSRF_POLICY_REJECTED";
  if (/could not be resolved/i.test(message)) return "ARK_RECOVERY_DOWNLOAD_DNS_FAILED";
  if (/connection failed/i.test(message)) return "ARK_RECOVERY_DOWNLOAD_CONNECT_FAILED";
  if (/cancelled/i.test(message)) return "ARK_RECOVERY_DOWNLOAD_TIMEOUT_OR_CANCELLED";
  if (/redirect/i.test(message)) return "ARK_RECOVERY_DOWNLOAD_REDIRECT_POLICY_FAILED";
  if (/byte limit/i.test(message)) return "ARK_RECOVERY_DOWNLOAD_SIZE_LIMIT";
  if (/content type/i.test(message)) return "ARK_RECOVERY_DOWNLOAD_CONTENT_TYPE_REJECTED";
  return "ARK_RECOVERY_DOWNLOAD_UNKNOWN";
}

async function listCandidates(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  afterUnix: number;
}): Promise<{ candidates: ArkTaskCandidate[]; diagnostics: CandidateDiagnostics }> {
  const url = new URL(`${input.baseUrl}/contents/generations/tasks`);
  url.searchParams.set("page_num", "1");
  url.searchParams.set("page_size", "100");
  url.searchParams.set("filter.status", "succeeded");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`ARK_RECOVERY_LIST_HTTP_${response.status}`);
    const payload: unknown = await response.json().catch(() => undefined);
    if (!isRecord(payload) || !Array.isArray(payload.items)) {
      throw new Error("ARK_RECOVERY_LIST_INVALID");
    }
    const diagnostics: CandidateDiagnostics = {
      listed: Math.min(payload.items.length, 999),
      succeeded: 0,
      afterWindow: 0,
      expectedModel: 0,
      expectedModelAfterWindow: 0,
      cheapTierShapeAfterWindow: 0,
      withVideoUrl: 0,
      uniqueCandidateIds: 0,
      candidateEvidence: [],
    };
    const candidates = payload.items.flatMap((item) => {
      if (!isRecord(item) || item.status !== "succeeded") return [];
      diagnostics.succeeded += 1;
      const afterWindow = integerValue(item.created_at) >= input.afterUnix;
      if (afterWindow) diagnostics.afterWindow += 1;
      if (item.model === input.model) {
        diagnostics.expectedModel += 1;
        if (afterWindow) diagnostics.expectedModelAfterWindow += 1;
      }
      if (
        !afterWindow
        || item.model !== input.model
        || String(item.resolution ?? "").toLowerCase() !== "480p"
        || item.ratio !== "16:9"
        || integerValue(item.duration) !== 4
        || item.generate_audio === true
      ) return [];
      diagnostics.cheapTierShapeAfterWindow += 1;
      const content = isRecord(item.content) ? item.content : {};
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const temporaryUrl = typeof content.video_url === "string" ? content.video_url.trim() : "";
      if (!id || !temporaryUrl) return [];
      diagnostics.withVideoUrl += 1;
      return [{ id, temporaryUrl }];
    });
    const uniqueCandidates = [...new Map(
      candidates.map((candidate) => [candidate.id, candidate] as const),
    ).values()];
    diagnostics.uniqueCandidateIds = uniqueCandidates.length;
    diagnostics.candidateEvidence = payload.items.flatMap((item) => {
      if (!isRecord(item)) return [];
      const id = typeof item.id === "string" ? item.id.trim() : "";
      if (!id || !uniqueCandidates.some((candidate) => candidate.id === id)) return [];
      const usage = isRecord(item.usage) ? item.usage : {};
      return [{
        taskFingerprint: sha256(id).slice(0, 16),
        createdAt: integerValue(item.created_at),
        updatedAt: integerValue(item.updated_at),
        completionTokens: integerValue(usage.completion_tokens),
      }];
    });
    return { candidates: uniqueCandidates, diagnostics };
  } catch (error) {
    if (error instanceof Error && /^ARK_RECOVERY_[A-Z0-9_]+$/.test(error.message)) throw error;
    throw new Error("ARK_RECOVERY_LIST_FAILED");
  } finally {
    clearTimeout(timeoutId);
  }
}

function approvedArkBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.hostname !== "ark.cn-beijing.volces.com"
    || url.pathname.replace(/\/+$/, "") !== "/api/v3"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("ARK_RECOVERY_BASE_URL_NOT_APPROVED");
  }
  return url.toString().replace(/\/+$/, "");
}

function reviewedArkVideoModel(value: string | undefined): string {
  const configured = new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  const reviewed = "doubao-seedance-2-0-mini-260615";
  if (!configured.has(reviewed)) throw new Error("ARK_VIDEO_MODEL_REVIEWED_CHEAP_MODEL_NOT_CONFIGURED");
  return reviewed;
}

function integerValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeFailure(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : "";
  return {
    name: "FABLE007_ARK_RECOVERY_FAILED",
    ...(/^ARK_RECOVERY_[A-Z0-9_]+$/.test(message) ? { code: message } : {}),
    ...(error instanceof CandidateCountError ? { diagnostics: error.diagnostics } : {}),
  };
}

const isDirectRun = process.argv[1]?.endsWith("fable007-recover-ark-video.mts")
  || process.argv[1]?.endsWith("fable007-recover-ark-video");
if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeFailure(error) })}\n`);
    process.exitCode = 1;
  });
}

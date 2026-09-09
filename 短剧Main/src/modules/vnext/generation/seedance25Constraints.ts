/**
 * Seedance 2.5 submit-contract constraints.
 *
 * Source: zhongwen-shortdrama-context/docs/research/2026-08-10-seedance25-reference-limits.md (verified).
 */

export const SEEDANCE25_SUPPORTED_RESOLUTIONS = ["480p", "720p"] as const;
export const SEEDANCE25_DURATION_MIN_SECONDS = 4;
export const SEEDANCE25_DURATION_MAX_SECONDS = 30;
export const SEEDANCE25_LOCKED_DURATION_SECONDS = -1;
export const SEEDANCE25_LOCKED_RATIO = "adaptive";
export const SEEDANCE25_REFERENCE_LIMITS = {
  total: 50,
  image: 30,
  video: 10,
  audio: 10,
  mediaDurationMinSeconds: 2,
  mediaDurationMaxSeconds: 30,
  mediaDurationTotalSeconds: 30,
} as const;
export const SEEDANCE25_CONTENT_ROLES = [
  "reference_image",
  "reference_video",
  "reference_audio",
  "first_frame",
  "last_frame",
] as const;

export type Seedance25ContentRole = typeof SEEDANCE25_CONTENT_ROLES[number];
export type Seedance25ReferenceKind = "image" | "video" | "audio";

export interface Seedance25Reference {
  kind: Seedance25ReferenceKind;
  url: string;
  role?: Seedance25ContentRole;
  /** Required for video and audio references so their API limits are enforceable before submission. */
  durationSeconds?: number;
}

export interface Seedance25SubmitContractInput {
  ratio: string;
  resolution: string;
  durationSeconds: number;
  references: readonly Seedance25Reference[];
}

export class Seedance25ContractViolationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "Seedance25ContractViolationError";
  }
}

const CONTENT_ROLE_BY_VALUE: Record<Seedance25ContentRole, true> = {
  reference_image: true,
  reference_video: true,
  reference_audio: true,
  first_frame: true,
  last_frame: true,
};
const SUPPORTED_RESOLUTION_BY_VALUE: Record<typeof SEEDANCE25_SUPPORTED_RESOLUTIONS[number], true> = {
  "480p": true,
  "720p": true,
};

export function resolveSeedance25ReferenceRole(reference: Seedance25Reference): Seedance25ContentRole {
  return reference.role ?? `reference_${reference.kind}` as Seedance25ContentRole;
}

export function validateSeedance25SubmitContract(input: Seedance25SubmitContractInput): void {
  if (!SUPPORTED_RESOLUTION_BY_VALUE[input.resolution as keyof typeof SUPPORTED_RESOLUTION_BY_VALUE]) {
    fail("SEEDANCE25_RESOLUTION_UNSUPPORTED", "Seedance 2.5 仅支持 480p 或 720p 分辨率");
  }
  if (!isValidGenerationDuration(input.durationSeconds)) {
    fail("SEEDANCE25_DURATION_INVALID", "Seedance 2.5 时长必须为 4 到 30 秒，或锁定任务的 -1");
  }

  const counts: Record<Seedance25ReferenceKind, number> = { image: 0, video: 0, audio: 0 };
  const mediaDurations: Record<"video" | "audio", number> = { video: 0, audio: 0 };
  for (const reference of input.references) {
    counts[reference.kind] += 1;
    const role = resolveSeedance25ReferenceRole(reference);
    if (!CONTENT_ROLE_BY_VALUE[role]) {
      fail("SEEDANCE25_REFERENCE_ROLE_INVALID", `Seedance 2.5 不支持参考 role：${String(role)}`);
    }
    if (reference.kind === "video" || reference.kind === "audio") {
      const duration = reference.durationSeconds;
      if (!isValidReferenceDuration(duration)) {
        fail("SEEDANCE25_REFERENCE_DURATION_INVALID", `Seedance 2.5 ${reference.kind === "video" ? "视频" : "音频"}参考时长必须为 2 到 30 秒`);
      }
      mediaDurations[reference.kind] += duration;
    }
  }

  if (input.references.length > SEEDANCE25_REFERENCE_LIMITS.total
    || counts.image > SEEDANCE25_REFERENCE_LIMITS.image
    || counts.video > SEEDANCE25_REFERENCE_LIMITS.video
    || counts.audio > SEEDANCE25_REFERENCE_LIMITS.audio) {
    fail("SEEDANCE25_REFERENCE_COUNT_EXCEEDED", "Seedance 2.5 参考最多 50 个：图 30、视频 10、音频 10");
  }
  for (const kind of ["video", "audio"] as const) {
    if (mediaDurations[kind] > SEEDANCE25_REFERENCE_LIMITS.mediaDurationTotalSeconds) {
      fail("SEEDANCE25_REFERENCE_DURATION_TOTAL_EXCEEDED", `Seedance 2.5 ${kind === "video" ? "视频" : "音频"}参考总时长不得超过 30 秒`);
    }
  }

  if (hasSeedance25LockedReference(input.references)
    && (input.ratio !== SEEDANCE25_LOCKED_RATIO || input.durationSeconds !== SEEDANCE25_LOCKED_DURATION_SECONDS)) {
    fail("SEEDANCE25_LOCKED_TASK_PARAMETERS_INVALID", "Seedance 2.5 锁定任务必须使用 ratio=adaptive 且 duration=-1");
  }
}

export function hasSeedance25LockedReference(references: readonly Seedance25Reference[]): boolean {
  return references.some((reference) => {
    const role = resolveSeedance25ReferenceRole(reference);
    return role === "reference_video" || role === "first_frame" || role === "last_frame";
  });
}

function isValidGenerationDuration(duration: number): boolean {
  return duration === SEEDANCE25_LOCKED_DURATION_SECONDS
    || (Number.isInteger(duration)
      && duration >= SEEDANCE25_DURATION_MIN_SECONDS
      && duration <= SEEDANCE25_DURATION_MAX_SECONDS);
}

function isValidReferenceDuration(duration: number | undefined): duration is number {
  return duration !== undefined
    && Number.isInteger(duration)
    && duration >= SEEDANCE25_REFERENCE_LIMITS.mediaDurationMinSeconds
    && duration <= SEEDANCE25_REFERENCE_LIMITS.mediaDurationMaxSeconds;
}

function fail(code: string, message: string): never {
  throw new Seedance25ContractViolationError(code, message);
}

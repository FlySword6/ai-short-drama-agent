import { createHash } from "node:crypto";
import { settings } from "../config/env.js";
import { TosStorage } from "../integrations/tosStorage.js";
import type { SnapshotATosVerificationPort } from "../modules/vnext/imports/service.js";
import { AppError, BadRequestError } from "../shared/errors.js";

const MAX_SNAPSHOT_MEDIA_BYTES = 20 * 1024 * 1024;

export interface SnapshotATosVerificationDependencies {
  storage?: TosStorage;
  /** Deployment override; defaults to the configured TOS public base URL. */
  publicBaseUrl?: string;
}

/**
 * Controlled TOS verification for Snapshot A imports. The caller-provided URL
 * must point inside the configured TOS public origin; the object bytes are
 * read through the shared public `TosStorage` abstraction and hashed, so the
 * persisted identity is the authoritative TOS object + SHA-256 instead of the
 * caller's claim. Non-TOS URLs and hash mismatches fail closed with 400; a
 * missing TOS origin fails closed with 503 before any persistence happens.
 */
export function createSnapshotATosVerification(
  dependencies: SnapshotATosVerificationDependencies = {},
): SnapshotATosVerificationPort {
  const storage = dependencies.storage ?? new TosStorage();
  return {
    async verify(input) {
      const baseUrl = dependencies.publicBaseUrl ?? settings.tosPublicBaseUrl;
      if (!baseUrl) {
        throw new AppError(503, "snapshot_tos_verification_unavailable", "TOS 公共访问地址未配置，未执行任何校验");
      }
      const url = parseMediaUrl(input.mediaUrl);
      const base = new URL(baseUrl);
      const basePath = base.pathname.replace(/\/+$/u, "");
      if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`)) {
        throw new BadRequestError("素材地址必须属于受信的 TOS 存储空间");
      }
      const storagePath = decodeURIComponent(url.pathname.slice(basePath.length).replace(/^\/+/u, ""));
      if (!storagePath) throw new BadRequestError("素材地址缺少 TOS 对象路径");
      const bytes = await storage.readObjectBytes(storagePath, { maxBytes: MAX_SNAPSHOT_MEDIA_BYTES });
      const mediaSha256 = createHash("sha256").update(bytes).digest("hex");
      if (mediaSha256 !== input.mediaSha256.toLowerCase()) {
        throw new BadRequestError("TOS 对象哈希与快照登记的 SHA-256 不一致");
      }
      return { mediaUrl: url.toString(), mediaSha256 };
    },
  };
}

function parseMediaUrl(mediaUrl: string): URL {
  try {
    const url = new URL(mediaUrl);
    if (url.protocol !== "https:") throw new Error();
    return url;
  } catch {
    throw new BadRequestError("素材地址必须是 HTTPS URL");
  }
}

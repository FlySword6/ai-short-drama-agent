import type { Database } from "../../../db/client.js";
import { AppError, BadRequestError, ConflictError } from "../../../shared/errors.js";
import { SnapshotAImportRepository } from "./repository.js";
import { transportFailure } from "./failures.js";
export type SnapshotAssetKind = "character" | "scene" | "prop";
export type SnapshotMediaKind = "image" | "video" | "audio";
export type SnapshotRegistrationStatus = "not_required" | "pending" | "active" | "processing" | "failed" | "unknown";

export interface SnapshotAImportInput {
  sourceSystem: string;
  sourceId: string;
  name: string;
  assetKind: SnapshotAssetKind;
  mediaKind: SnapshotMediaKind;
  mediaUrl: string;
  mediaSha256: string;
  snapshotAt: string;
  snapshotVersion: string;
}

/** Public, controlled TOS seam. Implementations reject non-TOS URLs. */
export interface SnapshotATosVerificationPort {
  verify(input: { mediaUrl: string; mediaSha256: string }): Promise<{ mediaUrl: string; mediaSha256: string }>;
}

/** Controlled registration/readback result. */
export interface SnapshotRegistrationReadback {
  registrationId: string | null;
  status: Extract<SnapshotRegistrationStatus, "active" | "processing" | "failed" | "unknown">;
  failureCode?: string | null;
  failureReason?: string | null;
  readback: Record<string, unknown> | null;
}

/** Public seam onto the existing Volc private-asset registration backend. */
export interface SnapshotARegistrationPort {
  register(input: { assetId: string; mediaUrl: string; mediaSha256: string; name: string }): Promise<SnapshotRegistrationReadback>;
  readback(input: { registrationId: string; name: string }): Promise<SnapshotRegistrationReadback>;
  readbackByName(input: { assetId: string; name: string }): Promise<SnapshotRegistrationReadback>;
}

export interface SnapshotAssetView {
  id: string;
  libraryName: string;
  sourceSystem: string;
  sourceId: string;
  name: string;
  assetKind: SnapshotAssetKind;
  mediaKind: SnapshotMediaKind;
  mediaUrl: string;
  mediaSha256: string;
  snapshotAt: Date;
  snapshotVersion: string;
  reviewStatus: "approved" | "pending_review" | "rejected";
  registrationStatus: SnapshotRegistrationStatus;
  registrationId: string | null;
  registrationFailureCode: string | null;
  registrationFailureReason: string | null;
  registrationReadback: Record<string, unknown> | null;
  updatedAt: Date;
}

const UNIQUE_VIOLATION = "23505";
const STALE_PENDING_MS = 5 * 60_000;
const ALLOWED_ASSET_KINDS: Record<SnapshotAssetKind, true> = { character: true, scene: true, prop: true };
const ALLOWED_MEDIA_KINDS: Record<SnapshotMediaKind, true> = { image: true, video: true, audio: true };

/**
 * PostgreSQL source truth for Snapshot A. Source approvals bind every immutable
 * media fact; the repository serializes persistence and provider-action claims.
 */
export class SnapshotAImportService {
  private readonly repository: SnapshotAImportRepository;

  constructor(
    db: Database,
    private readonly registration?: SnapshotARegistrationPort,
    private readonly tos?: SnapshotATosVerificationPort,
  ) {
    this.repository = new SnapshotAImportRepository(db);
  }

  async import(input: SnapshotAImportInput): Promise<{ asset: SnapshotAssetView; outcome: "created" | "replayed" }> {
    validate(input);
    const replayed = await this.repository.findBySource(input.sourceSystem, input.sourceId);
    if (replayed) {
      assertImmutableFacts(replayed, input);
      return { asset: requiresRegistrationSettlement(replayed) ? await this.settleRegistration(replayed) : replayed, outcome: "replayed" };
    }
    const verified = await this.verifyApprovedTosSource(input);
    try {
      const result = await this.repository.createAsset(verified);
      if (result.outcome === "replayed") {
        assertImmutableFacts(result.asset, verified);
        return result;
      }
      return { asset: await this.settleRegistration(result.asset), outcome: "created" };
    } catch (error) {
      if (pgCode(error) !== UNIQUE_VIOLATION) throw error;
      const concurrentReplay = await this.repository.findBySource(verified.sourceSystem, verified.sourceId);
      if (!concurrentReplay) throw error;
      assertImmutableFacts(concurrentReplay, verified);
      return { asset: concurrentReplay, outcome: "replayed" };
    }
  }

  async list(): Promise<SnapshotAssetView[]> {
    return this.repository.list();
  }

  /**
   * A remote ID is authoritative evidence that CreateAsset was attempted.
   * Every recovery of such a row claims and invokes readback only; only rows
   * without an ID and a deterministic failed outcome may submit again.
   */
  async retry(assetId: string): Promise<SnapshotAssetView> {
    if (!this.registration) throw new AppError(503, "snapshot_registration_unavailable", "火山素材注册尚未开启，未发送任何请求");
    const asset = await this.requireAsset(assetId);
    if (asset.mediaKind !== "image") throw new BadRequestError("当前火山私域素材注册只支持图片素材");
    if (asset.registrationStatus === "active") return asset;

    if (asset.registrationId) {
      if (asset.registrationStatus === "pending" && Date.now() - asset.updatedAt.getTime() < STALE_PENDING_MS) return asset;
      const claimed = await this.repository.claimRegistration(asset.id, asset.registrationStatus);
      return claimed ? this.readback(asset) : this.requireAsset(asset.id);
    }

    if (asset.registrationStatus === "unknown") {
      const reconciled = await this.reconcileUnknownRegistration(asset);
      if (reconciled.claimed && reconciled.asset.registrationId) return reconciled.asset;
      throw new ConflictError("上次登记结果不明确且缺少远端素材 ID，需要人工复核", "snapshot_registration_unknown");
    }
    if (asset.registrationStatus === "pending") {
      if (Date.now() - asset.updatedAt.getTime() < STALE_PENDING_MS) return asset;
      return this.repository.persistRegistration(asset.id, transportFailure(null), "register");
    }
    if (asset.registrationStatus === "not_required") return asset.mediaKind === "image" ? this.settleRegistration(asset) : asset;
    const claimed = await this.repository.claimRegistration(asset.id, "failed");
    return claimed ? this.register(asset) : this.requireAsset(asset.id);
  }

  private async settleRegistration(asset: SnapshotAssetView): Promise<SnapshotAssetView> {
    if (asset.mediaKind !== "image") return asset;
    if (!this.registration) {
      await this.repository.setRegistrationUnavailable(asset.id);
      return this.requireAsset(asset.id);
    }
    const claimed = await this.repository.claimRegistration(asset.id, "not_required");
    return claimed ? this.register(asset) : this.requireAsset(asset.id);
  }

  private async register(asset: SnapshotAssetView): Promise<SnapshotAssetView> {
    let response: SnapshotRegistrationReadback;
    try {
      response = await this.registration!.register({ assetId: asset.id, mediaUrl: asset.mediaUrl, mediaSha256: asset.mediaSha256, name: asset.name });
    } catch {
      response = transportFailure(null);
    }
    return this.repository.persistRegistration(asset.id, response, "register");
  }

  private async readback(asset: SnapshotAssetView): Promise<SnapshotAssetView> {
    let response: SnapshotRegistrationReadback;
    try {
      response = await this.registration!.readback({ registrationId: asset.registrationId!, name: asset.name });
    } catch {
      response = transportFailure(asset.registrationId);
    }
    return this.repository.persistRegistration(asset.id, preserveRemoteId(asset, response), "readback");
  }
  private async reconcileUnknownRegistration(asset: SnapshotAssetView): Promise<{ asset: SnapshotAssetView; claimed: boolean }> {
    return this.repository.reconcileUnknownRegistration(asset.id, async () => {
      const response = await this.registration!.readbackByName({ assetId: asset.id, name: asset.name });
      return response.registrationId ? { ...response, registrationId: response.registrationId } : response;
    });
  }

  private async verifyApprovedTosSource(input: SnapshotAImportInput): Promise<SnapshotAImportInput> {
    if (!await this.repository.approvedFactsMatch(input)) {
      throw new BadRequestError("来源未在受信批准的非真人快照清单中，或素材事实与批准记录不一致");
    }
    if (!this.tos) throw new AppError(503, "snapshot_tos_verification_unavailable", "快照素材 TOS 校验尚未配置");
    try {
      const verified = await this.tos.verify({ mediaUrl: input.mediaUrl, mediaSha256: input.mediaSha256 });
      const result = { ...input, mediaUrl: verified.mediaUrl, mediaSha256: verified.mediaSha256 };
      if (!await this.repository.approvedFactsMatch(result)) {
        throw new BadRequestError("TOS 实测素材事实与批准记录不一致");
      }
      await this.repository.recordVerification(result, "verified");
      return result;
    } catch (error) {
      await this.repository.recordVerification(input, "failed", "TOS_VERIFICATION_FAILED", error instanceof Error ? error.message : "TOS 校验失败");
      if (error instanceof AppError || error instanceof BadRequestError) throw error;
      throw new AppError(503, "snapshot_tos_verification_failed", "快照素材 TOS 校验暂时失败，可重试", true);
    }
  }

  private async requireAsset(assetId: string): Promise<SnapshotAssetView> {
    const asset = await this.repository.find(assetId);
    if (!asset) throw new BadRequestError("快照素材不存在");
    return asset;
  }
}

function assertImmutableFacts(asset: SnapshotAssetView, input: SnapshotAImportInput): void {
  const inputSnapshotAt = new Date(input.snapshotAt).getTime();
  if (asset.mediaSha256 !== input.mediaSha256.toLowerCase() || asset.assetKind !== input.assetKind || asset.mediaKind !== input.mediaKind || asset.name !== input.name || asset.snapshotVersion !== input.snapshotVersion || Number.isNaN(inputSnapshotAt) || asset.snapshotAt.getTime() !== inputSnapshotAt) {
    throw new ConflictError("同一旧系统来源的不可变素材事实发生冲突", "snapshot_source_mapping_conflict");
  }
}


function preserveRemoteId(asset: SnapshotAssetView, response: SnapshotRegistrationReadback): SnapshotRegistrationReadback {
  if (!asset.registrationId || response.registrationId) return response;
  return { ...response, registrationId: asset.registrationId, status: "unknown" };
}

function pgCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function validate(input: SnapshotAImportInput): void {
  if (!input.sourceSystem || !input.sourceId || !input.name || !input.snapshotVersion) throw new BadRequestError("快照来源、名称和版本不能为空");
  if (!ALLOWED_ASSET_KINDS[input.assetKind] || !ALLOWED_MEDIA_KINDS[input.mediaKind]) throw new BadRequestError("素材类型不在 Snapshot A 允许范围内");
  if (!/^[a-f0-9]{64}$/i.test(input.mediaSha256)) throw new BadRequestError("mediaSha256 必须是 SHA-256 十六进制摘要");
  if (Number.isNaN(new Date(input.snapshotAt).getTime())) throw new BadRequestError("snapshotAt 必须是有效时间");
}
function requiresRegistrationSettlement(asset: SnapshotAssetView): boolean {
  return asset.mediaKind === "image" && !["active", "failed"].includes(asset.registrationStatus);
}

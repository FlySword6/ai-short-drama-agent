import type { Database } from "../../../db/client.js";
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableEntityError } from "../../../shared/errors.js";
import { VnextProjectRepository } from "../repository.js";
import { ControlPackageRepository, type ControlPackageStore } from "./repository.js";
import type { ControlPackage, ControlPackageDraft, ControlPackageReference, ControlPackageWorkbench, ModelAvailability } from "./types.js";

export interface ControlPackageProjectAccess {
  assertRead(actorId: string, projectId: string): Promise<void>;
  assertWrite(actorId: string, projectId: string): Promise<void>;
}

export class ControlPackageService {
  constructor(
    private readonly packages: ControlPackageStore,
    private readonly access: ControlPackageProjectAccess,
  ) {}

  static fromDatabase(database: Database): ControlPackageService {
    return new ControlPackageService(new ControlPackageRepository(database), createControlPackageProjectAccess(database));
  }

  async workbench(actorId: string, projectId: string): Promise<ControlPackageWorkbench> {
    await this.access.assertRead(actorId, projectId);
    return { controlPackage: await this.packages.latest(projectId) };
  }

  async save(actorId: string, projectId: string, draft: ControlPackageDraft): Promise<ControlPackage> {
    await this.access.assertWrite(actorId, projectId);
    const normalized = normalizeDraft(draft);
    return this.packages.write({ projectId, actorId, ...normalized });
  }
}

export function createControlPackageProjectAccess(database: Database): ControlPackageProjectAccess {
  const projects = new VnextProjectRepository(database);
  return {
    async assertRead(actorId, projectId) {
      if (!await projects.findMemberRole(projectId, actorId)) throw new NotFoundError("vNext 项目不存在或你没有访问权限");
    },
    async assertWrite(actorId, projectId) {
      const role = await projects.findMemberRole(projectId, actorId);
      if (!role) throw new NotFoundError("vNext 项目不存在或你没有访问权限");
      if (role === "viewer") throw new ForbiddenError("你没有在这个 vNext 项目中修改生成控制包的权限");
    },
  };
}

export function normalizeDraft(draft: ControlPackageDraft): ControlPackageDraft {
  const prompt = draft.finalPrompt.trim();
  const model = draft.model.trim();
  if (!prompt) throw new UnprocessableEntityError("最终提示词不能为空");
  if (!model) throw new UnprocessableEntityError("必须选择模型");
  if (!Number.isSafeInteger(draft.estimatedCostFen) || draft.estimatedCostFen < 0) {
    throw new UnprocessableEntityError("预计费用必须是非负整数分");
  }
  const seenVersionIds = new Set<string>();
  const references = draft.references.map((reference, position) => normalizeReference(reference, position, seenVersionIds));
  return {
    references,
    finalPrompt: prompt,
    model,
    parameters: { ...draft.parameters, no_bgm: draft.noBgm },
    noBgm: draft.noBgm,
    modelAvailability: normalizeAvailability(draft.modelAvailability),
    estimatedCostFen: draft.estimatedCostFen,
  };
}

function normalizeReference(reference: ControlPackageReference, position: number, seenVersionIds: Set<string>): ControlPackageReference {
  const referenceVersionId = reference.referenceVersionId.trim();
  if (!referenceVersionId) throw new UnprocessableEntityError("每个参考都必须锁定到不可变版本");
  if (seenVersionIds.has(referenceVersionId)) throw new ConflictError("同一不可变参考版本不能重复加入控制包", "duplicate_reference_version");
  seenVersionIds.add(referenceVersionId);
  const reason = reference.reason.trim();
  if (!reason) throw new UnprocessableEntityError("每个参考都必须说明采用原因");
  const capabilitySnapshot = reference.capabilitySnapshot;
  if (!capabilitySnapshot.version.trim() || !capabilitySnapshot.capturedAt || !capabilitySnapshot.capabilities.length) {
    throw new UnprocessableEntityError("每个参考都必须带完整能力快照");
  }
  return { ...reference, referenceVersionId, reason, position, capabilitySnapshot: {
    version: capabilitySnapshot.version.trim(), capturedAt: capabilitySnapshot.capturedAt,
    capabilities: [...capabilitySnapshot.capabilities],
  } };
}

function normalizeAvailability(availability: ModelAvailability): ModelAvailability {
  return { status: availability.status, checkedAt: availability.checkedAt, ...(availability.reason ? { reason: availability.reason.trim() } : {}) };
}

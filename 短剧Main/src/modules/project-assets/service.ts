import type { Database } from "../../db/client.js";
import { redactAssetStorageMetadata } from "../assets/mediaDisplay.js";
import {
  ProjectAssetRepository,
  type AddProjectAssetReferenceInput,
  type ProjectAssetReferenceRow,
} from "./repository.js";

export class ProjectAssetService {
  private readonly repository: ProjectAssetRepository;

  constructor(db: Database, repository = new ProjectAssetRepository(db)) {
    this.repository = repository;
  }

  async list(actorId: string, projectId: string, authorizedProjectId?: string) {
    return (await this.repository.list(actorId, projectId, authorizedProjectId)).map(toProjectAssetReference);
  }

  async addReference(
    actorId: string,
    projectId: string,
    input: AddProjectAssetReferenceInput,
    authorizedProjectId?: string,
  ) {
    return toProjectAssetReference(await this.repository.add(actorId, projectId, input, authorizedProjectId));
  }

  async removeReference(
    actorId: string,
    projectId: string,
    referenceId: string,
    authorizedProjectId?: string,
  ): Promise<void> {
    await this.repository.remove(actorId, projectId, referenceId, authorizedProjectId);
  }
}

function toProjectAssetReference(row: ProjectAssetReferenceRow) {
  return {
    id: row.id,
    project_id: row.projectId,
    asset_entity_id: row.assetEntityId,
    asset_variant_id: row.assetVariantId,
    asset_media_id: row.assetMediaId,
    version_snapshot: redactAssetStorageMetadata(row.versionSnapshot),
    created_by_user_id: row.createdByUserId,
    created_at: row.createdAt.toISOString(),
  };
}

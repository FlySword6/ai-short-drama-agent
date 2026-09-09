import type { ProjectAccessActor } from "../project-access/types.js";

export type ScenePrepItemStatus = "pending" | "committed";
export type ScenePrepCommitMode = "scene" | "shots" | "all_shots";

export interface ScenePrepItem {
  id: string;
  sceneId: string;
  lane: string;
  assetEntityId: string;
  assetVariantId: string | null;
  assetMediaId: string | null;
  assetName: string;
  thumbnailUrl: string | null;
  status: ScenePrepItemStatus;
  projectAssetRefId: string | null;
  createdByUserId: string;
  committedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  committedAt: Date | null;
}

export interface PullScenePrepItemInput {
  lane: string;
  assetEntityId: string;
  assetVariantId?: string | null;
  assetMediaId?: string | null;
  clientIdempotencyKey: string;
}

export interface CommitScenePrepInput {
  clientIdempotencyKey: string;
  itemIds?: string[];
  shotIds?: string[];
  allShots?: boolean;
}

export interface ScenePrepCommitResult {
  commitId: string;
  sceneId: string;
  projectId: string;
  mode: ScenePrepCommitMode;
  itemIds: string[];
  projectAssetRefIds: string[];
  shotIds: string[];
  controlPackageRefIds: string[];
  controlPackageRefCount: number;
  idempotentReplay: boolean;
  committedAt: Date;
}

export interface ScenePrepStore {
  list(actor: ProjectAccessActor, sceneId: string): Promise<ScenePrepItem[]>;
  pull(actor: ProjectAccessActor, sceneId: string, input: PullScenePrepItemInput): Promise<ScenePrepItem>;
  remove(actor: ProjectAccessActor, sceneId: string, itemId: string): Promise<void>;
  commit(actor: ProjectAccessActor, sceneId: string, input: CommitScenePrepInput): Promise<ScenePrepCommitResult>;
}

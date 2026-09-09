import type { Database } from "../../../db/client.js";
import { NotFoundError } from "../../../shared/errors.js";
import {
  createDirectorProjectAccess,
  toDirectorActor,
  type DirectorActor,
  type DirectorProjectAccessPort,
} from "../projectAccess.js";
import {
  createPgDirectorDb,
  PgDirectorSceneRepository,
  type DirectorSceneRecord,
  type DirectorSceneVersionRecord,
  type SaveSceneVersionResult,
} from "./repository.js";

/** scene 服务依赖注入口：单测给假 repository，生产给 pg 实现。 */
export interface DirectorSceneRepositoryPort {
  getScene(projectId: string): Promise<DirectorSceneRecord | null>;
  listVersions(sceneId: string): Promise<DirectorSceneVersionRecord[]>;
  saveVersion(input: {
    projectId: string;
    actorId: string;
    expectedVersion: number;
    snapshot: Record<string, unknown>;
    sourceAction: string;
    status?: "draft" | "saved";
  }): Promise<SaveSceneVersionResult>;
}

export interface DirectorSceneServiceDependencies {
  repository?: DirectorSceneRepositoryPort;
  projectAccess?: DirectorProjectAccessPort;
}

export class DirectorSceneService {
  private readonly repository: DirectorSceneRepositoryPort;
  private readonly projectAccess: DirectorProjectAccessPort;

  constructor(db: Database, dependencies: DirectorSceneServiceDependencies = {}) {
    this.repository = dependencies.repository ?? new PgDirectorSceneRepository(createPgDirectorDb(db));
    this.projectAccess = dependencies.projectAccess ?? createDirectorProjectAccess(db);
  }

  async get(actorInput: DirectorActor, projectId: string): Promise<DirectorSceneRecord> {
    await this.projectAccess.require(toDirectorActor(actorInput), projectId, "read");
    const scene = await this.repository.getScene(projectId);
    if (!scene) throw new NotFoundError("导演场景不存在");
    return scene;
  }

  async save(
    actorInput: DirectorActor,
    projectId: string,
    input: {
      sceneVersion: number;
      snapshot: Record<string, unknown>;
      sourceAction?: string;
      status?: "draft" | "saved";
    },
  ): Promise<SaveSceneVersionResult> {
    const actor = toDirectorActor(actorInput);
    await this.projectAccess.require(actor, projectId, "create");
    // A normal scene save is creative work and editors may do it. Removing a
    // persisted object/camera is different: it is destructive and therefore
    // has to pass the shared owner/admin delete permission as well. The later
    // repository write still uses its optimistic version check, so a stale
    // snapshot cannot turn this comparison into a lost update.
    const current = await this.repository.getScene(projectId);
    if (current && removesPersistedSceneEntry(current.snapshot, input.snapshot)) {
      await this.projectAccess.require(actor, projectId, "delete");
    }
    return this.repository.saveVersion({
      projectId,
      actorId: actor.id,
      expectedVersion: input.sceneVersion,
      snapshot: input.snapshot,
      sourceAction: input.sourceAction ?? "manual_save",
      ...(input.status ? { status: input.status } : {}),
    });
  }

  async listVersions(actorInput: DirectorActor, projectId: string): Promise<{
    scene: DirectorSceneRecord;
    versions: DirectorSceneVersionRecord[];
  }> {
    const scene = await this.get(actorInput, projectId);
    const versions = await this.repository.listVersions(scene.id);
    return { scene, versions };
  }
}

function removesPersistedSceneEntry(
  currentSnapshot: Record<string, unknown> | null,
  nextSnapshot: Record<string, unknown>,
): boolean {
  if (!currentSnapshot) return false;
  return ["objects", "cameras"].some((collection) => {
    const currentIds = sceneEntryIds(currentSnapshot[collection]);
    if (currentIds.size === 0) return false;
    const nextIds = sceneEntryIds(nextSnapshot[collection]);
    return [...currentIds].some((id) => !nextIds.has(id));
  });
}

function sceneEntryIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string") return [];
    return [(entry as { id: string }).id];
  }));
}

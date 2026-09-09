import type { Database } from "../../db/client.js";
import { ScenePrepRepository } from "./repository.js";
import type {
  CommitScenePrepInput,
  PullScenePrepItemInput,
  ScenePrepStore,
} from "./types.js";
import type { ProjectAccessActor } from "../project-access/types.js";

export class ScenePrepService {
  private readonly store: ScenePrepStore;

  constructor(db: Database, store: ScenePrepStore = new ScenePrepRepository(db)) {
    this.store = store;
  }

  list(actor: ProjectAccessActor, sceneId: string) {
    return this.store.list(actor, sceneId);
  }

  pull(actor: ProjectAccessActor, sceneId: string, input: PullScenePrepItemInput) {
    return this.store.pull(actor, sceneId, input);
  }

  remove(actor: ProjectAccessActor, sceneId: string, itemId: string) {
    return this.store.remove(actor, sceneId, itemId);
  }

  commit(actor: ProjectAccessActor, sceneId: string, input: CommitScenePrepInput) {
    return this.store.commit(actor, sceneId, input);
  }
}

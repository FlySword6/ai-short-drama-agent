import type { Database } from "../../db/client.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import { CastingTaskRepository } from "./repository.js";
import type {
  CastingTaskStore,
  CreateCastingTaskInput,
  ListCastingTasksFilter,
  UpdateCastingTaskInput,
} from "./types.js";

export class CastingTaskService {
  private readonly store: CastingTaskStore;

  constructor(db: Database, store: CastingTaskStore = new CastingTaskRepository(db)) {
    this.store = store;
  }

  create(actor: ProjectAccessActor, projectId: string, input: CreateCastingTaskInput) {
    return this.store.create(actor, projectId, input);
  }

  list(actor: ProjectAccessActor, projectId: string, filter: ListCastingTasksFilter) {
    return this.store.list(actor, projectId, filter);
  }

  get(actor: ProjectAccessActor, id: string) {
    return this.store.get(actor, id);
  }

  update(actor: ProjectAccessActor, id: string, input: UpdateCastingTaskInput) {
    return this.store.update(actor, id, input);
  }
}

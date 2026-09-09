import type { Database } from "../../db/client.js";
import { ControlPackageRepository } from "./repository.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import type { AddControlPackageRefInput, ControlPackageStore } from "./types.js";

export class ControlPackageService {
  private readonly store: ControlPackageStore;

  constructor(db: Database, store: ControlPackageStore = new ControlPackageRepository(db)) {
    this.store = store;
  }

  get(actor: ProjectAccessActor, shotId: string) {
    return this.store.get(actor, shotId);
  }

  setReady(actor: ProjectAccessActor, shotId: string, ready: boolean) {
    return this.store.setReady(actor, shotId, ready);
  }

  addRef(actor: ProjectAccessActor, shotId: string, input: AddControlPackageRefInput) {
    return this.store.addRef(actor, shotId, input);
  }

  deleteRef(actor: ProjectAccessActor, refId: string) {
    return this.store.deleteRef(actor, refId);
  }
}

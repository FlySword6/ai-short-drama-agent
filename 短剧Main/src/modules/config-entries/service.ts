import { ConflictError, NotFoundError, isPostgresUniqueViolation } from "../../shared/errors.js";
import type {
  ConfigEntriesRepository,
  ConfigEntry,
  ConfigEntryKind,
  CreateConfigEntryInput,
  UpdateConfigEntryInput,
} from "./types.js";

/**
 * Thin config-entry service: reads pass through; writes translate the
 * (kind, entry_key) primary-key race into a human-facing 409 and unknown
 * ids into a 404 instead of leaking raw driver errors.
 */
export class ConfigEntriesService {
  constructor(private readonly repository: ConfigEntriesRepository) {}

  listPublished(kind: ConfigEntryKind): Promise<ConfigEntry[]> {
    return this.repository.listPublishedByKind(kind);
  }

  listAll(kind: ConfigEntryKind): Promise<ConfigEntry[]> {
    return this.repository.listByKind(kind);
  }

  async create(input: CreateConfigEntryInput): Promise<ConfigEntry> {
    try {
      return await this.repository.create(input);
    } catch (error) {
      if (isPostgresUniqueViolation(error)) throw new ConflictError("同一类型下已有同名列");
      throw error;
    }
  }

  async update(id: string, kind: ConfigEntryKind, input: UpdateConfigEntryInput): Promise<ConfigEntry> {
    try {
      const entry = await this.repository.update(id, kind, input);
      if (!entry) throw new NotFoundError("配置项不存在");
      return entry;
    } catch (error) {
      if (isPostgresUniqueViolation(error)) throw new ConflictError("同一类型下已有同名列");
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const removed = await this.repository.remove(id);
    if (!removed) throw new NotFoundError("配置项不存在");
  }
}

export type TrashItemKind = "project" | "episode" | "scene" | "shot" | "asset" | "media";

export interface TrashItem {
  id: string;
  kind: TrashItemKind;
  ownerUserId: string;
  name: string;
  deletedAt: Date;
}

export interface TrashDeletionCheck {
  blockers: string[];
}

export interface TrashPurgeAttemptInput {
  source: "manual" | "retention";
  targetKind: "project" | "asset";
  targetId: string;
  ownerUserId: string | null;
  actorUserId: string | null;
  retentionDays: number | null;
  deletedAtSnapshot: Date | null;
}

export interface TrashRepository {
  list(actorId: string): Promise<TrashItem[]>;
  get(kind: TrashItemKind, id: string): Promise<TrashItem | undefined>;
  restore(kind: TrashItemKind, id: string, actorId: string): Promise<TrashItem>;
  preparePermanentDeletion(
    kind: TrashItemKind,
    id: string,
    actorId: string,
    retention?: { cutoff: Date; expectedDeletedAt: Date; expectedOwnerUserId: string },
  ): Promise<TrashDeletionCheck>;
  checkPermanentDeletion(kind: TrashItemKind, id: string): Promise<TrashDeletionCheck>;
  deleteExternalObjects(kind: TrashItemKind, id: string): Promise<void>;
  hardDelete(kind: TrashItemKind, id: string, attemptId?: string): Promise<void>;
  beginPurgeAttempt?(input: TrashPurgeAttemptInput): Promise<string>;
  completePurgeAttempt?(id: string, input: { status: "blocked" | "failed" | "deleted"; blockers?: string[]; errorCode?: string }): Promise<void>;
}

export class TrashService {
  constructor(private readonly repository: TrashRepository) {}

  list(actorId: string): Promise<TrashItem[]> {
    return this.repository.list(actorId);
  }

  async restore(input: { actorId: string; kind: TrashItemKind; id: string }): Promise<TrashItem> {
    const item = await this.ownedItem(input);
    return this.repository.restore(item.kind, item.id, input.actorId);
  }

  async permanentlyDelete(input: { actorId: string; kind: TrashItemKind; id: string }): Promise<void> {
    const item = await this.ownedItem(input);
    await this.purge({ item, actorId: input.actorId, source: "manual", retentionDays: null });
  }

  async retainPermanentlyDelete(input: { item: TrashItem; retentionDays: number }): Promise<"blocked" | "deleted"> {
    return this.purge({ item: input.item, actorId: null, source: "retention", retentionDays: input.retentionDays });
  }

  private async purge(input: { item: TrashItem; actorId: string | null; source: "manual" | "retention"; retentionDays: number | null }): Promise<"blocked" | "deleted"> {
    const attemptId = await this.repository.beginPurgeAttempt?.({
      source: input.source, targetKind: input.item.kind as "project" | "asset", targetId: input.item.id,
      ownerUserId: input.item.ownerUserId, actorUserId: input.actorId,
      retentionDays: input.retentionDays, deletedAtSnapshot: input.item.deletedAt,
    });
    const retention = input.source === "retention" ? {
      cutoff: new Date(Date.now() - input.retentionDays! * 24 * 60 * 60 * 1000),
      expectedDeletedAt: input.item.deletedAt,
      expectedOwnerUserId: input.item.ownerUserId,
    } : undefined;
    try {
      const check = await this.repository.preparePermanentDeletion(input.item.kind, input.item.id, input.actorId ?? "retention", retention);
      if (check.blockers.length) {
        await this.repository.completePurgeAttempt?.(attemptId ?? "", { status: "blocked", blockers: check.blockers });
        if (input.source === "retention") return "blocked";
        throw new ConflictError(`暂时不能永久删除：${check.blockers.join("；")}`, "trash_item_referenced");
      }
      await this.repository.deleteExternalObjects(input.item.kind, input.item.id);
      // The repository commits deleted alongside the final hard-delete
      // transaction, so a successful audit fact can never outlive its target.
      await this.repository.hardDelete(input.item.kind, input.item.id, attemptId);
      return "deleted";
    } catch (error) {
      if (error instanceof ConflictError && error.code === "trash_item_referenced") {
        const blockers = error.details && typeof error.details === "object" && "blockers" in error.details
          && Array.isArray(error.details.blockers) ? error.details.blockers.filter((value): value is string => typeof value === "string") : [];
        await this.repository.completePurgeAttempt?.(attemptId ?? "", { status: "blocked", blockers });
        if (input.source === "retention") return "blocked";
        throw error;
      }
      await this.repository.completePurgeAttempt?.(attemptId ?? "", { status: "failed", errorCode: safeErrorCode(error) });
      throw error;
    }
  }

  private async ownedItem(input: { actorId: string; kind: TrashItemKind; id: string }): Promise<TrashItem> {
    const item = await this.repository.get(input.kind, input.id);
    if (!item) throw new NotFoundError("回收站项目不存在");
    if (item.ownerUserId !== input.actorId) throw new ForbiddenError("无权操作该回收站项目");
    return item;
  }
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code.slice(0, 128);
  return "purge_failed";
}
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";

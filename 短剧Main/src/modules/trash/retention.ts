import type { Database } from "../../db/client.js";
import { databaseSchema } from "../../db/schema.js";
import { settings } from "../../config/env.js";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { DrizzleTrashRepository } from "./repository.js";
import { TrashService } from "./service.js";

interface WorkerLogger {
  info(value: unknown, message?: string): void;
  warn(value: unknown, message?: string): void;
  error(value: unknown, message?: string): void;
}

export type TrashRetentionRepositoryFactory = (db: Database) => DrizzleTrashRepository;

const INTERVAL_MS = 24 * 60 * 60 * 1000;
const START_DELAY_MS = 5_000;
const BATCH_SIZE = 50;

/** In-process daily retention worker; PostgreSQL is the shared scheduling lock. */
export class TrashRetentionWorker {
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly db: Database,
    private readonly logger: WorkerLogger,
    private readonly retentionDays = settings.trashRetentionDays,
    private readonly repositoryFactory: TrashRetentionRepositoryFactory = (db) => new DrizzleTrashRepository(db),
  ) {}

  start(): void {
    if (this.timer || this.stopping) return;
    this.logger.info({ retention_days: this.retentionDays }, "trash retention worker started");
    const startup = setTimeout(() => this.kick(), START_DELAY_MS);
    startup.unref();
    this.timer = setInterval(() => this.kick(), INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeRun;
    this.logger.info("trash retention worker stopped");
  }

  kick(): void {
    if (this.stopping || this.activeRun) return;
    this.activeRun = this.runOnce().then(() => undefined)
      .catch((error: unknown) => this.logger.error({ error: safeMessage(error) }, "trash retention worker loop failed"))
      .finally(() => { this.activeRun = undefined; });
  }

  async runOnce(now = new Date()): Promise<{ skipped: boolean; processed: number }> {
    // A session-level lock and all three purge phases must share this checked
    // out PostgreSQL connection. A transaction lock would be released before
    // TOS/Milvus cleanup and allow another rolling pod to duplicate the work.
    const pool = (this.db as Database & { $client: Pool }).$client;
    const client = await pool.connect();
    const lock = await client.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtext('trash-retention-worker')) as locked");
    if (!lock.rows[0]?.locked) {
      client.release();
      this.logger.info("trash retention run skipped: advisory lock not acquired");
      return { skipped: true, processed: 0 };
    }
    const repository = this.repositoryFactory(drizzle(client, { schema: databaseSchema }) as Database);
    try {
      const cutoff = new Date(now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000);
      const service = new TrashService(repository);
      let processed = 0;
      let cursor: { deletedAt: Date; id: string; kind: "project" | "asset" } | undefined;
      while (!this.stopping) {
        const candidates = await repository.retentionCandidates(cutoff, cursor, BATCH_SIZE);
        if (!candidates.length) break;
        for (const item of candidates) {
          if (this.stopping) break;
          cursor = { deletedAt: item.deletedAt, id: item.id, kind: item.kind as "project" | "asset" };
          try {
            const outcome = await service.retainPermanentlyDelete({ item, retentionDays: this.retentionDays });
            if (outcome === "blocked") this.logger.warn({ target_kind: item.kind, target_id: item.id, outcome }, "trash retention item blocked");
            processed += 1;
          } catch (error) {
            // An individual external delete is retryable. Its durable audit row
            // records the safe error code; do not let it starve later candidates.
            this.logger.warn({ target_kind: item.kind, target_id: item.id, error: safeMessage(error) }, "trash retention item failed");
          }
        }
        if (candidates.length < BATCH_SIZE) break;
      }
      return { skipped: false, processed };
    } finally {
      await client.query("select pg_advisory_unlock(hashtext('trash-retention-worker'))");
      client.release();
    }
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "unknown_error";
}

import type { Database } from "../../db/client.js";
import { AuthRepository } from "./repository.js";

interface WorkerLogger {
  info(value: unknown, message?: string): void;
  error(value: unknown, message?: string): void;
}

export interface WecomTransactionCleanupRepository {
  deleteTerminalWecomAuthTransactions(cutoff: Date): Promise<number>;
}

const RETENTION_MS = 24 * 60 * 60 * 1_000;
const INTERVAL_MS = 24 * 60 * 60 * 1_000;
const START_DELAY_MS = 5_000;

/** Daily cleanup for the temporary OAuth transaction table only. */
export class WecomTransactionCleanupWorker {
  private timer: NodeJS.Timeout | undefined;
  private startupTimer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;
  private stopping = false;

  constructor(
    db: Database,
    private readonly logger: WorkerLogger,
    private readonly repository: WecomTransactionCleanupRepository = new AuthRepository(db),
  ) {}

  start(): void {
    if (this.timer || this.startupTimer || this.stopping) return;
    this.logger.info("WeCom authentication transaction cleanup worker started");
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      this.kick();
    }, START_DELAY_MS);
    this.startupTimer.unref();
    this.timer = setInterval(() => this.kick(), INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = undefined;
    this.timer = undefined;
    await this.activeRun;
    this.logger.info("WeCom authentication transaction cleanup worker stopped");
  }

  kick(): void {
    if (this.stopping || this.activeRun) return;
    this.activeRun = this.runOnce().then(() => undefined)
      .catch((error: unknown) => this.logger.error({ error: safeMessage(error) }, "WeCom authentication transaction cleanup failed"))
      .finally(() => { this.activeRun = undefined; });
  }

  async runOnce(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_MS);
    const deleted = await this.repository.deleteTerminalWecomAuthTransactions(cutoff);
    this.logger.info({ deleted }, "WeCom authentication transaction cleanup completed");
    return deleted;
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "unknown_error";
}

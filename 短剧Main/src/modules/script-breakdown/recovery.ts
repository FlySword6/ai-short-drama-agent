import type { Database } from "../../db/client.js";
import { DrizzleScriptBreakdownRepository } from "./repository.js";
import type { ScriptBreakdownRepository } from "./types.js";

interface RecoveryLogger {
  info(value: unknown, message?: string): void;
  error(value: unknown, message?: string): void;
}

export const SCRIPT_BREAKDOWN_STALE_AFTER_MS = 5 * 60 * 1_000;
const RECOVERY_POLL_INTERVAL_MS = 60_000;
const RECOVERY_START_DELAY_MS = 5_000;

export type ScriptBreakdownRecoveryRepositoryFactory =
  (db: Database) => Pick<ScriptBreakdownRepository, "reclaimStaleRuns">;

/**
 * 进程内执行器的恢复安全网。AI 单请求有用途级超时(默认 120 秒,阶段②
 * 放宽到 10 分钟,见 AI_PURPOSE_TIMEOUT_OVERRIDES);五分钟无 run 更新可
 * 判定执行进程已失联——阶段②长调用期间执行器每 60 秒用执行令牌 touch
 * 一次 updatedAt(STAGE_HEARTBEAT_INTERVAL_MS),活着就不会进回收窗口。
 * 数据库条件更新负责多实例下的唯一回收。
 */
export class ScriptBreakdownRecoveryWorker {
  private timer: NodeJS.Timeout | undefined;
  private startupTimer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly getDatabase: () => Database,
    private readonly logger: RecoveryLogger,
    private readonly repositoryFactory: ScriptBreakdownRecoveryRepositoryFactory =
      (db) => new DrizzleScriptBreakdownRepository(db),
  ) {}

  start(): void {
    if (this.timer || this.startupTimer || this.stopping) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      this.kick();
    }, RECOVERY_START_DELAY_MS);
    this.startupTimer.unref();
    this.timer = setInterval(() => this.kick(), RECOVERY_POLL_INTERVAL_MS);
    this.timer.unref();
    this.logger.info("script breakdown recovery worker started");
  }

  kick(): void {
    if (this.stopping || this.activeRun) return;
    this.activeRun = this.runOnce().then(() => undefined)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message.slice(0, 256) : "unknown_error";
        this.logger.error({ error: message }, "script breakdown recovery failed");
      })
      .finally(() => {
        this.activeRun = undefined;
      });
  }

  async runOnce(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - SCRIPT_BREAKDOWN_STALE_AFTER_MS);
    const count = await this.repositoryFactory(this.getDatabase()).reclaimStaleRuns({ cutoff, now });
    if (count > 0) {
      this.logger.info({ reclaimed: count }, "script breakdown stale runs reclaimed");
    }
    return count;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = undefined;
    this.timer = undefined;
    await this.activeRun;
    this.logger.info("script breakdown recovery worker stopped");
  }
}

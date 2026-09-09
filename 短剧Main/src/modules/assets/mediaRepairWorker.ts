import type { Database } from "../../db/client.js";
import { AssetMediaRepairService } from "./mediaRepairService.js";

interface WorkerLogger {
  info(value: unknown, message?: string): void;
  warn(value: unknown, message?: string): void;
  error(value: unknown, message?: string): void;
}

export interface AssetMediaRepairKickPort {
  kick(): void;
}

interface AssetMediaRepairWorkerService {
  processNextQueued(): Promise<boolean>;
  requeueInterrupted(): Promise<number>;
  enqueueSelfHealCandidates(limit?: number): Promise<number>;
}

const QUEUE_POLL_INTERVAL_MS = 30_000;
const SELF_HEAL_SCAN_INTERVAL_MS = 15 * 60_000;
const SELF_HEAL_BATCH_SIZE = 20;

export interface AssetMediaRepairWorkerOptions {
  executionEnabled?: () => boolean;
  queuePollIntervalMs?: number;
  selfHealScanIntervalMs?: number;
}

/**
 * One in-process, serial repair worker. PostgreSQL task claims and the active
 * per-asset unique index make rolling replicas safe; memory only provides a
 * wake-up signal and never owns task truth.
 */
export class AssetMediaRepairWorker implements AssetMediaRepairKickPort {
  private readonly executionEnabled: () => boolean;
  private readonly queuePollIntervalMs: number;
  private readonly selfHealScanIntervalMs: number;
  private queueTimer: NodeJS.Timeout | undefined;
  private scanTimer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;
  private stopping = false;
  private kickScheduled = false;
  private pausedLogged = false;

  constructor(
    db: Database,
    private readonly logger: WorkerLogger,
    private readonly service: AssetMediaRepairWorkerService = AssetMediaRepairService.fromDatabase(db),
    options: AssetMediaRepairWorkerOptions = {},
  ) {
    this.executionEnabled = options.executionEnabled ?? (() => false);
    this.queuePollIntervalMs = options.queuePollIntervalMs ?? QUEUE_POLL_INTERVAL_MS;
    this.selfHealScanIntervalMs = options.selfHealScanIntervalMs ?? SELF_HEAL_SCAN_INTERVAL_MS;
  }

  start(): void {
    if (this.queueTimer || this.stopping) return;
    if (!this.isExecutionEnabled()) {
      this.logPaused();
    } else {
      this.logger.info("asset media repair worker started");
      void this.service.requeueInterrupted()
        .then((count) => {
          if (count > 0) {
            this.logger.info({ requeued: count }, "asset media repair worker requeued interrupted tasks");
          }
        })
        .then(() => this.scanAndKick())
        .catch((error: unknown) => this.logger.error(
          { error: safeError(error) },
          "asset media repair startup recovery failed",
        ));
      this.kick();
    }
    this.queueTimer = setInterval(() => this.kick(), this.queuePollIntervalMs);
    this.queueTimer.unref();
    this.scanTimer = setInterval(() => {
      void this.scanAndKick().catch((error: unknown) => this.logger.error(
        { error: safeError(error) },
        "asset media self-heal scan failed",
      ));
    }, this.selfHealScanIntervalMs);
    this.scanTimer.unref();
  }

  kick(): void {
    if (this.activeRun || this.stopping || this.kickScheduled) return;
    if (!this.isExecutionEnabled()) {
      this.logPaused();
      return;
    }
    this.kickScheduled = true;
    setImmediate(() => {
      this.kickScheduled = false;
      if (this.activeRun || this.stopping) return;
      if (!this.isExecutionEnabled()) {
        this.logPaused();
        return;
      }
      this.activeRun = this.drain()
        .catch((error: unknown) => this.logger.error(
          { error: safeError(error) },
          "asset media repair worker loop failed",
        ))
        .finally(() => {
          this.activeRun = undefined;
        });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.queueTimer = undefined;
    this.scanTimer = undefined;
    await this.activeRun;
    this.logger.info("asset media repair worker stopped");
  }

  private async scanAndKick(): Promise<void> {
    if (this.stopping) return;
    if (!this.isExecutionEnabled()) {
      this.logPaused();
      return;
    }
    const enqueued = await this.service.enqueueSelfHealCandidates(SELF_HEAL_BATCH_SIZE);
    if (enqueued > 0) {
      this.logger.info({ enqueued }, "asset media self-heal tasks enqueued");
      this.kick();
    }
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      if (!this.isExecutionEnabled()) {
        this.logPaused();
        return;
      }
      const processed = await this.service.processNextQueued();
      if (!processed) return;
    }
  }

  private isExecutionEnabled(): boolean {
    const enabled = this.executionEnabled();
    if (enabled) this.pausedLogged = false;
    return enabled;
  }

  private logPaused(): void {
    if (this.pausedLogged) return;
    this.pausedLogged = true;
    this.logger.warn({}, "asset media repair worker remains stopped because external execution is disabled or not ready");
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "unknown_error";
}

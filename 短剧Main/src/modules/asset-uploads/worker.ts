import type { AssetUploadTaskService } from "./service.js";

interface WorkerLogger {
  info(value: unknown, message?: string): void;
  warn(value: unknown, message?: string): void;
  error(value: unknown, message?: string): void;
}

/** Route-facing port: a submission wakes the queue without knowing worker internals. */
export interface AssetUploadKickPort {
  kick(): void;
}

export type AssetUploadWorkerService = Pick<
  AssetUploadTaskService,
  "requeueInterrupted" | "processNextQueued"
>;

const SAFETY_POLL_INTERVAL_MS = 30_000;

export interface AssetUploadWorkerOptions {
  executionEnabled?: () => boolean;
  pollIntervalMs?: number;
}

/**
 * In-process serial worker for the upload submission queue. Submissions kick
 * it directly; the slow interval covers missed kicks and resumes a paused
 * worker after execution is re-enabled.
 * Serial by construction — one drain loop, one claim at a time.
 */
export class AssetUploadWorker implements AssetUploadKickPort {
  private readonly executionEnabled: () => boolean;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;
  private stopping = false;
  private kickScheduled = false;
  private pausedLogged = false;

  constructor(
    private readonly service: AssetUploadWorkerService,
    private readonly logger: WorkerLogger,
    options: AssetUploadWorkerOptions = {},
  ) {
    this.executionEnabled = options.executionEnabled ?? (() => false);
    this.pollIntervalMs = options.pollIntervalMs ?? SAFETY_POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.timer || this.stopping) return;
    if (!this.isExecutionEnabled()) {
      this.logPaused();
    } else {
      this.logger.info("asset upload worker started");
      void this.service.requeueInterrupted()
        .then((count) => {
          if (count > 0) this.logger.info({ requeued: count }, "asset upload worker requeued interrupted tasks");
        })
        .catch((error: unknown) => this.logger.error({ error: String(error) }, "asset upload requeue failed"));
      this.kick();
    }
    this.timer = setInterval(() => this.kick(), this.pollIntervalMs);
    this.timer.unref();
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
        .catch((error: unknown) => this.logger.error({ error: String(error) }, "asset upload worker loop failed"))
        .finally(() => {
          this.activeRun = undefined;
        });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeRun;
    this.logger.info("asset upload worker stopped");
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
    this.logger.warn({}, "asset upload worker remains stopped because external execution is disabled or not ready");
  }
}

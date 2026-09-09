import type { VideoIngestService } from "./service.js";

interface WorkerLogger {
  info(value: unknown, message?: string): void;
  error(value: unknown, message?: string): void;
}

export interface VideoIngestKickPort {
  kick(): void;
}

export type VideoIngestWorkerService = Pick<
  VideoIngestService,
  "requeueInterrupted" | "processNextQueued"
>;

const SAFETY_POLL_INTERVAL_MS = 30_000;

export class VideoIngestWorker implements VideoIngestKickPort {
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;
  private stopping = false;
  private kickScheduled = false;

  constructor(
    private readonly service: VideoIngestWorkerService,
    private readonly logger: WorkerLogger,
  ) {}

  start(): void {
    if (this.timer || this.stopping) return;
    this.logger.info("video ingest worker started");
    void this.service.requeueInterrupted()
      .then((count) => {
        if (count > 0) this.logger.info({ requeued: count }, "video ingest worker requeued interrupted tasks");
      })
      .catch((error: unknown) => this.logger.error({ error: String(error) }, "video ingest requeue failed"));
    this.kick();
    this.timer = setInterval(() => this.kick(), SAFETY_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  kick(): void {
    if (this.activeRun || this.stopping || this.kickScheduled) return;
    this.kickScheduled = true;
    setImmediate(() => {
      this.kickScheduled = false;
      if (this.activeRun || this.stopping) return;
      this.activeRun = this.drain()
        .catch((error: unknown) => this.logger.error({ error: String(error) }, "video ingest worker loop failed"))
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
    this.logger.info("video ingest worker stopped");
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const processed = await this.service.processNextQueued();
      if (!processed) return;
    }
  }
}

/**
 * vNext generation worker.
 *
 * Polls for claimable attempts and runs them with a lease heartbeat.
 * Mirrors the production GenerationWorker contract:
 *  - Only starts when execution is explicitly enabled.
 *  - Stops polling immediately if the execution flag is revoked.
 *  - Releases the lease (with retry delay) after unexpected errors.
 *  - Never submits a paid request without first acquiring a fresh lease.
 */

import { safeMessage } from "./serviceUtils.js";
import type { VnextGenerationService } from "./service.js";
import type { VnextGenerationStore } from "./repository.js";

interface WorkerLogger {
  info(value: unknown, message?: string): void;
  warn(value: unknown, message?: string): void;
  error(value: unknown, message?: string): void;
}

export interface VnextGenerationWorkerOptions {
  store: VnextGenerationStore;
  service: Pick<VnextGenerationService, "runRecoverableAttempt">;
  workerId?: string;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  /** When false the worker refuses to start and stops if already running. */
  executionEnabled?: () => boolean;
}

const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS_PER_POLL = 10;

export class VnextGenerationWorker {
  private readonly workerId: string;
  private readonly store: VnextGenerationStore;
  private readonly service: Pick<VnextGenerationService, "runRecoverableAttempt">;
  private readonly leaseSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly executionEnabled: () => boolean;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;
  private stopping = false;
  private abortController = new AbortController();

  constructor(
    private readonly logger: WorkerLogger,
    options: VnextGenerationWorkerOptions,
  ) {
    this.store = options.store;
    this.service = options.service;
    this.workerId = options.workerId ?? `vnext-gen-${Date.now()}`;
    this.leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.executionEnabled = options.executionEnabled ?? (() => false);
  }

  start(): void {
    if (this.timer || this.stopping) return;
    if (!this.executionEnabled()) {
      this.logger.warn({ worker_id: this.workerId }, "vnext generation worker not started: execution disabled");
      return;
    }
    this.logger.info({ worker_id: this.workerId }, "vnext generation worker started");
    this.timer = setInterval(() => this.runSoon(), this.pollIntervalMs);
    this.timer.unref();
    this.runSoon();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.pausePolling();
    this.abortController.abort();
    await this.activeRun;
    this.logger.info({ worker_id: this.workerId }, "vnext generation worker stopped");
  }

  private runSoon(): void {
    if (this.activeRun || this.stopping) return;
    this.activeRun = this.runAvailable()
      .catch((err: unknown) => this.logger.error({ error: safeMessage(err) }, "vnext generation worker loop failed"))
      .finally(() => { this.activeRun = undefined; });
  }

  private async runAvailable(): Promise<void> {
    for (let i = 0; i < MAX_ATTEMPTS_PER_POLL && !this.stopping; i++) {
      if (!this.executionEnabled()) {
        this.pausePolling();
        this.logger.warn({ worker_id: this.workerId }, "vnext generation worker stopped: execution disabled");
        return;
      }
      const attemptId = await this.store.claimNextAttempt(this.workerId, this.leaseSeconds);
      if (!attemptId) return;

      if (!this.executionEnabled()) {
        await this.store.releaseLease(attemptId, this.workerId, this.pollIntervalMs / 1_000);
        this.pausePolling();
        this.logger.warn({ attempt_id: attemptId }, "vnext generation worker released attempt: execution disabled after claim");
        return;
      }

      const attemptAbort = this.createAttemptAbort();
      const heartbeat = this.startHeartbeat(attemptId, () => attemptAbort.abort());
      try {
        await this.service.runRecoverableAttempt(attemptId, attemptAbort.signal, this.workerId);
        if (await heartbeat.stop()) await this.store.releaseLease(attemptId, this.workerId);
      } catch (error) {
        this.logger.error({ attempt_id: attemptId, error: safeMessage(error) }, "vnext generation attempt failed unexpectedly");
        if (await heartbeat.stop()) {
          await this.store.releaseLease(attemptId, this.workerId, this.pollIntervalMs / 1_000);
        }
      } finally {
        attemptAbort.dispose();
      }
    }
  }

  private pausePolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private createAttemptAbort(): { signal: AbortSignal; abort(): void; dispose(): void } {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (this.abortController.signal.aborted) abort();
    else this.abortController.signal.addEventListener("abort", abort, { once: true });
    return {
      signal: controller.signal,
      abort,
      dispose: () => this.abortController.signal.removeEventListener("abort", abort),
    };
  }

  private startHeartbeat(attemptId: string, abortAttempt: () => void): { stop(): Promise<boolean> } {
    const intervalMs = Math.max(250, Math.floor((this.leaseSeconds * 1_000) / 3));
    let stillOwner = true;
    let inFlight: Promise<void> | undefined;
    const renew = (): void => {
      if (!stillOwner || inFlight) return;
      inFlight = this.store.renewLease(attemptId, this.workerId, this.leaseSeconds)
        .then((renewed) => {
          if (renewed) return;
          stillOwner = false;
          abortAttempt();
          this.logger.warn({ attempt_id: attemptId }, "vnext generation attempt lease lost");
        })
        .catch((err: unknown) => {
          stillOwner = false;
          abortAttempt();
          this.logger.warn({ attempt_id: attemptId, error: safeMessage(err) }, "vnext lease heartbeat failed");
        })
        .finally(() => { inFlight = undefined; });
    };
    const timer = setInterval(renew, intervalMs);
    timer.unref();
    return {
      stop: async () => {
        clearInterval(timer);
        await inFlight;
        return stillOwner;
      },
    };
  }
}

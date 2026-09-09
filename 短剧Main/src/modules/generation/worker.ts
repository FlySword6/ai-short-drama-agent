import { randomUUID } from "node:crypto";
import { settings } from "../../config/env.js";
import { safeErrorMessage } from "./errors.js";
import {
  createGenerationRepository,
  createGenerationService,
  generationExecutionEnabled,
} from "./factory.js";
import type { Database } from "../../db/client.js";
import type { GenerationRepository, GenerationWorkerLeaseRepository } from "./ports.js";
import type { GenerationService } from "./service.js";

interface WorkerLogger {
  info(value: unknown, message?: string): void;
  warn(value: unknown, message?: string): void;
  error(value: unknown, message?: string): void;
}

type WorkerDependencies = {
  repository: GenerationRepository & GenerationWorkerLeaseRepository;
  service: Pick<GenerationService, "runRecoverableAttempt">;
  workerId?: string;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  allowPaidGeneration?: boolean;
  /** Test seam; production uses the shared current execution authority. */
  executionEnabled?: () => boolean;
};

export class GenerationWorker {
  private readonly workerId: string;
  private readonly repository: GenerationRepository & GenerationWorkerLeaseRepository;
  private readonly service: Pick<GenerationService, "runRecoverableAttempt">;
  private readonly leaseSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly allowPaidGeneration: boolean;
  private readonly executionEnabled: () => boolean;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;
  private stopping = false;
  private abortController = new AbortController();

  constructor(db: Database, private readonly logger: WorkerLogger, dependencies?: WorkerDependencies) {
    if (dependencies) {
      this.repository = dependencies.repository;
      this.service = dependencies.service;
    } else {
      const productionRepository = createGenerationRepository(db);
      this.repository = productionRepository;
      this.service = createGenerationService(productionRepository, { costAlertLogger: this.logger });
    }
    this.workerId = dependencies?.workerId ?? `generation-${randomUUID()}`;
    this.leaseSeconds = dependencies?.leaseSeconds ?? settings.generationTaskLeaseSeconds;
    this.pollIntervalMs = dependencies?.pollIntervalMs ?? settings.generationWorkerPollIntervalMs;
    this.allowPaidGeneration = dependencies?.allowPaidGeneration ?? settings.allowPaidGeneration;
    this.executionEnabled = dependencies?.executionEnabled ?? (() => generationExecutionEnabled());
  }

  start(): void {
    if (this.timer || this.stopping) return;
    if (!this.executionEnabled()) {
      this.logger.warn(
        { worker_id: this.workerId },
        "generation worker remains stopped because paid execution is disabled or not ready",
      );
      return;
    }
    this.logger.info({ worker_id: this.workerId }, "generation worker started");
    this.timer = setInterval(() => this.runSoon(), this.pollIntervalMs);
    this.timer.unref();
    this.runSoon();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.pausePolling();
    this.abortController.abort();
    await this.activeRun;
    this.logger.info({ worker_id: this.workerId }, "generation worker stopped");
  }

  private runSoon(): void {
    if (this.activeRun || this.stopping) return;
    this.activeRun = this.runAvailable()
      .catch((error: unknown) => this.logger.error({ error: safeErrorMessage(error) }, "generation worker loop failed"))
      .finally(() => { this.activeRun = undefined; });
  }

  private async runAvailable(): Promise<void> {
    for (let processed = 0; processed < 10 && !this.stopping; processed += 1) {
      if (!this.executionEnabled()) {
        this.pausePolling();
        this.logger.warn(
          { worker_id: this.workerId },
          "generation worker stopped polling because paid execution is disabled or not ready",
        );
        return;
      }
      const attemptId = await this.repository.claimNextRecoverableAttempt(
        this.workerId,
        this.leaseSeconds,
        this.allowPaidGeneration,
      );
      if (!attemptId) return;
      if (!this.executionEnabled()) {
        await this.repository.releaseLease(attemptId, this.workerId, this.pollIntervalMs);
        this.pausePolling();
        this.logger.warn(
          { attempt_id: attemptId, worker_id: this.workerId },
          "generation worker released an attempt after paid execution was disabled",
        );
        return;
      }
      const attemptAbort = this.createAttemptAbortController();
      const heartbeat = this.startLeaseHeartbeat(attemptId, () => attemptAbort.abort());
      try {
        await this.service.runRecoverableAttempt(attemptId, attemptAbort.signal, this.workerId);
        if (await heartbeat.stop()) await this.repository.releaseLease(attemptId, this.workerId);
      } catch (error) {
        this.logger.error({ attempt_id: attemptId, error: safeErrorMessage(error) }, "generation attempt failed unexpectedly");
        if (await heartbeat.stop()) {
          await this.repository.releaseLease(attemptId, this.workerId, this.pollIntervalMs);
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

  private createAttemptAbortController(): { signal: AbortSignal; abort(): void; dispose(): void } {
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

  private startLeaseHeartbeat(attemptId: string, abortAttempt: () => void): { stop(): Promise<boolean> } {
    const intervalMs = Math.max(250, Math.floor((this.leaseSeconds * 1_000) / 3));
    let stillOwner = true;
    let inFlight: Promise<void> | undefined;
    const renew = (): void => {
      if (!stillOwner || inFlight) return;
      inFlight = this.repository.renewLease(attemptId, this.workerId, this.leaseSeconds)
        .then((renewed) => {
          if (renewed) return;
          stillOwner = false;
          abortAttempt();
          this.logger.warn({ attempt_id: attemptId, worker_id: this.workerId }, "generation attempt lease lost");
        })
        .catch((error: unknown) => {
          // An uncertain heartbeat is not permission to keep writing a paid
          // attempt. The owner must be re-established by a fresh claim.
          stillOwner = false;
          abortAttempt();
          this.logger.warn({ attempt_id: attemptId, error: safeErrorMessage(error) }, "generation attempt lease heartbeat failed");
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

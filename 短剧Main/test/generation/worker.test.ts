import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../src/db/client.js";
import { GenerationWorker } from "../../src/modules/generation/worker.js";
import { settings } from "../../src/config/env.js";
import { generationExecutionEnabled } from "../../src/modules/generation/factory.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

test("paid execution disabled before startup does not claim historical work or call a provider", async () => {
  let claimCount = 0;
  let providerExecutionCount = 0;
  let leaseReleaseCount = 0;
  const worker = new GenerationWorker({} as Database, logger, {
    repository: {
      claimNextRecoverableAttempt: async () => {
        claimCount += 1;
        return "historical-attempt";
      },
      renewLease: async () => true,
      releaseLease: async () => { leaseReleaseCount += 1; },
    } as never,
    service: {
      runRecoverableAttempt: async () => { providerExecutionCount += 1; },
    },
    allowPaidGeneration: true,
    executionEnabled: () => false,
    pollIntervalMs: 60_000,
  });

  worker.start();
  await worker.stop();

  assert.equal(claimCount, 0);
  assert.equal(providerExecutionCount, 0);
  assert.equal(leaseReleaseCount, 0);
});

test("a worker releases a claimed lease when paid execution is revoked", async () => {
  const leaseReleased = Promise.withResolvers<void>();
  let gateChecks = 0;
  let providerExecutionCount = 0;
  const worker = new GenerationWorker({} as Database, logger, {
    repository: {
      claimNextRecoverableAttempt: async () => "historical-attempt",
      renewLease: async () => true,
      releaseLease: async () => { leaseReleased.resolve(); },
    } as never,
    service: {
      runRecoverableAttempt: async () => { providerExecutionCount += 1; },
    },
    allowPaidGeneration: true,
    executionEnabled: () => {
      gateChecks += 1;
      return gateChecks <= 2;
    },
    pollIntervalMs: 60_000,
  });

  worker.start();
  await leaseReleased.promise;
  await worker.stop();

  assert.equal(providerExecutionCount, 0);
});

test("a worker rechecks the execution gate before the next claim", async () => {
  const firstExecution = Promise.withResolvers<void>();
  let gateChecks = 0;
  let claimCount = 0;
  let providerExecutionCount = 0;
  const worker = new GenerationWorker({} as Database, logger, {
    repository: {
      claimNextRecoverableAttempt: async () => {
        claimCount += 1;
        return `attempt-${claimCount}`;
      },
      renewLease: async () => true,
      releaseLease: async () => {},
    } as never,
    service: {
      runRecoverableAttempt: async () => {
        providerExecutionCount += 1;
        firstExecution.resolve();
      },
    },
    allowPaidGeneration: true,
    executionEnabled: () => {
      gateChecks += 1;
      return gateChecks <= 3;
    },
    pollIntervalMs: 60_000,
  });

  worker.start();
  await firstExecution.promise;
  await worker.stop();

  assert.equal(claimCount, 1);
  assert.equal(providerExecutionCount, 1);
});

test("a worker without an injected execution gate keeps the full readiness check", () => {
  const overrides = settings as unknown as Record<string, unknown>;
  const previous = {
    allowPaidGeneration: overrides.allowPaidGeneration,
    paidGenerationBudgetFen: overrides.paidGenerationBudgetFen,
    paidGenerationReviewThresholdFen: overrides.paidGenerationReviewThresholdFen,
    arkApiKey: overrides.arkApiKey,
    arkImageModel: overrides.arkImageModel,
    tosBucket: overrides.tosBucket,
    tosEndpoint: overrides.tosEndpoint,
    tosAccessKey: overrides.tosAccessKey,
    tosSecretKey: overrides.tosSecretKey,
    tosPublicBaseUrl: overrides.tosPublicBaseUrl,
    companyProviderAllowlist: overrides.companyProviderAllowlist,
  };
  try {
    overrides.allowPaidGeneration = true;
    overrides.paidGenerationBudgetFen = 1_000;
    overrides.paidGenerationReviewThresholdFen = 1_000;
    overrides.arkApiKey = "worker-gate-test-ark-key";
    overrides.arkImageModel = "doubao-seedream-5-0-pro-260628";
    overrides.tosBucket = "worker-gate-test-bucket";
    overrides.tosEndpoint = "https://tos.example.com";
    overrides.tosAccessKey = "worker-gate-test-access-key";
    overrides.tosSecretKey = "worker-gate-test-secret-key";
    overrides.tosPublicBaseUrl = "https://media.example.com";
    overrides.companyProviderAllowlist = ["ark"];
    overrides.aigcLabelingRuntimeReady = () => true;
    const worker = new GenerationWorker({} as Database, logger, {
      repository: {
        claimNextRecoverableAttempt: async () => undefined,
        renewLease: async () => true,
        releaseLease: async () => {},
      } as never,
      service: {
        runRecoverableAttempt: async () => {},
      },
      pollIntervalMs: 60_000,
    });
    // Test seam: the default gate resolves in the constructor only, so the private
    // field is the sole way to assert it is the shared readiness check itself.
    const workerGate = worker as unknown as { executionEnabled: () => boolean };

    assert.equal(generationExecutionEnabled(), true);
    assert.equal(workerGate.executionEnabled(), true);

    overrides.paidGenerationBudgetFen = 0;
    assert.equal(generationExecutionEnabled(), false);
    assert.equal(workerGate.executionEnabled(), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete overrides[key];
      else overrides[key] = value;
    }
    delete overrides.aigcLabelingRuntimeReady;
  }
});

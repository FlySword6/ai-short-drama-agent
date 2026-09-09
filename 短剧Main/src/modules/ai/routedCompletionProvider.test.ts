import assert from "node:assert/strict";
import test from "node:test";
import type { AiCompletionProvider } from "./types.js";
import { RoutedAiCompletionProvider } from "./routedCompletionProvider.js";

function fake(modelLog: string[]): AiCompletionProvider {
  return {
    async complete(input) {
      modelLog.push(input.model ?? "");
      return {
        content: "{}",
        model: input.model ?? "",
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
      };
    },
  };
}

test("routes only exact deployment-bound Ark and MiniMax model IDs", async () => {
  const arkCalls: string[] = [];
  const minimaxCalls: string[] = [];
  const router = new RoutedAiCompletionProvider([
    { providerId: "ark", models: ["ark-model"], adapter: fake(arkCalls) },
    { providerId: "minimax", models: ["MiniMax-M3"], adapter: fake(minimaxCalls) },
  ], { companyProviderAllowlist: ["ark", "minimax"] });

  assert.equal(router.providerForModel("ark-model"), "ark");
  assert.equal(router.providerForModel("MiniMax-M3"), "minimax");
  await router.complete({ model: "MiniMax-M3", system: "s", prompt: "p", maxTokens: 1 });
  assert.deepEqual(arkCalls, []);
  assert.deepEqual(minimaxCalls, ["MiniMax-M3"]);
  assert.throws(
    () => router.complete({ model: "client-supplied-model", system: "s", prompt: "p", maxTokens: 1 }),
    /model route is not configured/,
  );
});

test("rejects an ambiguous model binding at startup", () => {
  assert.throws(() => new RoutedAiCompletionProvider([
    { providerId: "ark", models: ["duplicate"], adapter: fake([]) },
    { providerId: "minimax", models: ["duplicate"], adapter: fake([]) },
  ], { companyProviderAllowlist: ["ark"] }), /configured more than once/);
});

test("R195-5 rejects a non-company LLM provider before the adapter runs", async () => {
  const arkCalls: string[] = [];
  const minimaxCalls: string[] = [];
  const router = new RoutedAiCompletionProvider([
    { providerId: "ark", models: ["ark-model"], adapter: fake(arkCalls) },
    { providerId: "minimax", models: ["MiniMax-M3"], adapter: fake(minimaxCalls) },
  ], { companyProviderAllowlist: ["ark"] });

  assert.throws(
    () => router.complete({
      model: "MiniMax-M3",
      system: "s",
      prompt: "p",
      maxTokens: 1,
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "provider_company_account_not_enabled"
      && error.message === "该供应商未开通公司账户",
  );
  assert.deepEqual(minimaxCalls, []);

  await router.complete({ model: "ark-model", system: "s", prompt: "p", maxTokens: 1 });
  assert.deepEqual(arkCalls, ["ark-model"]);
});

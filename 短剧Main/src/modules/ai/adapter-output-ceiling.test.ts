import assert from "node:assert/strict";
import test from "node:test";
import { ArkChatClient, MAX_ARK_CHAT_MAX_TOKENS, type ArkFetch } from "../../integrations/arkClient.js";
import { ColCompletionProvider, MAX_COL_COMPLETION_MAX_TOKENS } from "./colCompletionProvider.js";

/**
 * 两个适配器自己加的输出硬顶(改造前各是 4096)不能挡住动态值。
 *
 * 这两个 4096 都不是供应商文档里的限制——翻了 config-and-secrets.md 与
 * ai-foundation-gateway.md 都没有出处,git 追到引入它们的那两笔提交也只是
 * 「adapter 加个保险」。而 arkcli 实测 deepseek-v4-flash-ga 的
 * max_completion_token_length 是 384k,远高于 4096。
 *
 * 所以能力判断归网关(它查 model_capabilities 表),适配器只保留一道
 * 结构性上限:防住明显荒谬的值,不参与「这个模型能开多大」的判断。
 */

function chatResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Ark 适配器的结构性上限必须高于改造前的 4096,否则挡住动态值", () => {
  assert.ok(
    MAX_ARK_CHAT_MAX_TOKENS >= 393_216,
    "arkcli 实测 384k 输出的模型存在,适配器上限低于它就会把真实能力挡掉",
  );
});

test("Ark 适配器放行改造前会被拒的大预算", async () => {
  let sentBody: string | undefined;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sentBody = String(init?.body);
    return chatResponse({ choices: [{ message: { content: "内容" } }] });
  }) as unknown as ArkFetch;

  const client = new ArkChatClient("test-key", "configured-model", "https://ark.example.com", fetchImpl);
  await client.completeTextWithMetadata("问题", "系统", { maxTokens: 32_768 });

  assert.equal(JSON.parse(sentBody ?? "{}").max_tokens, 32_768);
});

test("Ark 适配器仍然拒绝形状非法与荒谬的值", async () => {
  const fetchImpl = (async () => chatResponse({
    choices: [{ message: { content: "内容" } }],
  })) as unknown as ArkFetch;
  const client = new ArkChatClient("test-key", "configured-model", "https://ark.example.com", fetchImpl);

  for (const bad of [0, -1, 1.5, MAX_ARK_CHAT_MAX_TOKENS + 1]) {
    await assert.rejects(
      client.completeTextWithMetadata("问题", "系统", { maxTokens: bad }),
      (error: unknown) => error instanceof Error && /max_tokens/.test(error.message),
      `${bad} 应当被适配器拒绝`,
    );
  }
});

test("公司通道适配器的结构性上限同样高于 4096", () => {
  assert.ok(
    MAX_COL_COMPLETION_MAX_TOKENS >= 393_216,
    "公司通道代理的是同一批模型,上限不该比 Ark 更严",
  );
});

test("公司通道适配器放行大预算,仍拒绝形状非法的值", async () => {
  let sentBody: string | undefined;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sentBody = String(init?.body);
    return chatResponse({
      choices: [{ message: { content: "内容" } }],
      model: "col-model",
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
  }) as unknown as typeof fetch;

  const provider = new ColCompletionProvider(
    "test-key",
    "col-model",
    "https://col.example.com/v1",
    fetchImpl,
  );
  await provider.complete({ system: "系统", prompt: "问题", maxTokens: 32_768 });
  assert.equal(JSON.parse(sentBody ?? "{}").max_tokens, 32_768);

  for (const bad of [0, -1, 1.5, MAX_COL_COMPLETION_MAX_TOKENS + 1]) {
    await assert.rejects(
      provider.complete({ system: "系统", prompt: "问题", maxTokens: bad }),
      (error: unknown) => error instanceof Error,
      `${bad} 应当被适配器拒绝`,
    );
  }
});

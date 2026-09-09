/**
 * Dynamic bridge for shortdrama-owned tools.
 *
 * Schemas and per-turn system instructions are supplied by the local Python
 * wrapper through a 0600 context file. Tool execution is delegated back to
 * the wrapper; the extension waits for the product to return the corresponding
 * toolResult before Pi continues its current turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";

type ExternalTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type TurnContext = {
  system?: string | null;
  tools?: ExternalTool[];
  turnNonce?: string;
  conversationId?: string;
};

export default function externalTools(pi: ExtensionAPI) {
  const contextPath = process.env.PI_WRAPPER_CONTEXT_PATH;
  const callbackUrl = process.env.PI_WRAPPER_TOOL_CALLBACK_URL;
  const internalToken = process.env.PI_WRAPPER_INTERNAL_TOKEN;
  const registered = new Map<string, string>();
  let turnContext: TurnContext = {};

  function loadContext(): TurnContext {
    if (!contextPath) throw new Error("PI_WRAPPER_CONTEXT_PATH is required");
    return JSON.parse(fs.readFileSync(contextPath, "utf8")) as TurnContext;
  }

  function schemaKey(tool: ExternalTool): string {
    return JSON.stringify({ description: tool.description || "", inputSchema: tool.inputSchema || {} });
  }

  function register(tool: ExternalTool): void {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(tool.name)) {
      throw new Error(`invalid external tool name: ${tool.name}`);
    }
    const nextKey = schemaKey(tool);
    const previousKey = registered.get(tool.name);
    if (previousKey && previousKey !== nextKey) {
      throw new Error(`external tool schema changed during session: ${tool.name}`);
    }
    if (previousKey) return;
    registered.set(tool.name, nextKey);
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description || tool.name,
      parameters: (tool.inputSchema || { type: "object", properties: {} }) as any,
      async execute(toolCallId, args) {
        const turnNonce = turnContext.turnNonce;
        const conversationId = turnContext.conversationId;
        if (!callbackUrl || !internalToken || !turnNonce || !conversationId) {
          return {
            content: [{ type: "text", text: "External tool bridge is unavailable." }],
            details: { code: "external_tool_bridge_unavailable" },
            isError: true,
          };
        }
        const response = await fetch(callbackUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${internalToken}`,
          },
          body: JSON.stringify({ toolCallId, name: tool.name, arguments: args, turnNonce, conversationId }),
        });
        if (!response.ok) {
          return {
            content: [{ type: "text", text: `External tool bridge failed (${response.status}).` }],
            details: { code: "external_tool_bridge_http_error", status: response.status },
            isError: true,
          };
        }
        const result = (await response.json()) as { content: unknown; isError?: boolean };
        const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
        return {
          content: [{ type: "text", text }],
          details: { delegated: true, toolCallId },
          isError: Boolean(result.isError),
        };
      },
    });
  }

  pi.registerCommand("shortdrama-sync-context", {
    description: "Load the wrapper-supplied system prompt and external tool schemas.",
    handler: async () => {
      turnContext = loadContext();
      for (const tool of turnContext.tools || []) register(tool);
    },
  });

  pi.on("before_agent_start", (event) => {
    if (!turnContext.system) return undefined;
    return { systemPrompt: turnContext.system };
  });
}

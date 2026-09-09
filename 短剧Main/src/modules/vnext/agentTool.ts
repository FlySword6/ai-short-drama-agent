import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantContext } from "../assistant/types.js";
import type { GraphDocument, VnextProjectService } from "./service.js";

/**
 * vNext 画布的 Agent 写入工具(issue #345 复审 P1-6)。
 *
 * 这是挂在真实 Agent 运行时(AssistantContext,见 src/modules/assistant)入口上的
 * 薄 adapter:vnextProjectId 只从真实 Agent Context 取,写入只经与 UI 相同的
 * VnextProjectService.replaceDocument——同一条 GraphDocument revision 链,
 * actorKind 记 agent,页面「Agent 状态」读到的事实与界面写入完全同源。
 * 工具本身不做任何 HTTP 旁路,也不绕过 revision CAS。
 */

const positionParameters = Type.Object(
  { x: Type.Number(), y: Type.Number() },
  { additionalProperties: false },
);

const uuidParameters = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});
const graphDataValueParameters = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

const nodeParameters = Type.Object(
  {
    id: uuidParameters,
    kind: Type.Union([Type.Literal("scene"), Type.Literal("asset"), Type.Literal("task"), Type.Literal("note")]),
    label: Type.String({ minLength: 1, maxLength: 240 }),
    position: positionParameters,
    data: Type.Optional(Type.Record(Type.String(), graphDataValueParameters)),
  },
  { additionalProperties: false },
);

const edgeParameters = Type.Object(
  {
    id: uuidParameters,
    source: uuidParameters,
    target: uuidParameters,
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  },
  { additionalProperties: false },
);

const writeVnextCanvasParameters = Type.Object(
  {
    expected_revision: Type.Integer({ minimum: 0, description: "基于读到的最新 revision 做 CAS;陈旧会被 409 拒绝" }),
    document: Type.Object(
      {
        schema_version: Type.Literal(1),
        nodes: Type.Array(nodeParameters, { maxItems: 1000 }),
        edges: Type.Array(edgeParameters, { maxItems: 2000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const getVnextCanvasParameters = Type.Object({}, { additionalProperties: false });

export const VNEXT_CANVAS_READ_TOOL_NAME = "get_vnext_canvas";
export const VNEXT_CANVAS_TOOL_NAME = "write_vnext_canvas";

export function createVnextCanvasReadTool(
  context: AssistantContext,
  service: VnextProjectService,
): AgentTool<typeof getVnextCanvasParameters, unknown> {
  return {
    name: VNEXT_CANVAS_READ_TOOL_NAME,
    label: "读取 vNext 画布",
    description:
      "读取当前 vNext 项目的最新 GraphDocument、revision 和最近写入事实；写入前必须先调用本工具。",
    parameters: getVnextCanvasParameters,
    execute: async () => {
      if (!context.vnextProjectId) throw new Error("当前没有选择 vNext 项目");
      const current = await service.getDocument(
        { id: context.userId },
        context.vnextProjectId,
      );
      return toolResult({
        project_id: current.projectId,
        revision: current.revision,
        document: toToolDocument(current.document),
        updated_at: current.updatedAt.toISOString(),
        last_write: current.lastWrite
          ? { kind: current.lastWrite.kind, user_id: current.lastWrite.userId, at: current.lastWrite.at.toISOString() }
          : null,
      });
    },
  };
}

export function createVnextCanvasTool(
  context: AssistantContext,
  service: VnextProjectService,
): AgentTool<typeof writeVnextCanvasParameters, unknown> {
  return {
    name: VNEXT_CANVAS_TOOL_NAME,
    label: "写入 vNext 画布",
    description:
      "把 Agent 的画布增量写入当前 vNext 项目:与界面共用同一服务、同一条 revision 链,陈旧 revision 会被拒绝,需要先重读最新画布再重放。",
    parameters: writeVnextCanvasParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      if (!context.vnextProjectId) throw new Error("当前没有选择 vNext 项目");
      const saved = await service.replaceDocument({
        actor: { id: context.userId },
        projectId: context.vnextProjectId,
        expectedRevision: params.expected_revision,
        document: fromToolDocument(params.document),
        actorKind: "agent",
      });
      return toolResult({
        project_id: saved.projectId,
        revision: saved.revision,
        updated_at: saved.updatedAt.toISOString(),
        last_write: saved.lastWrite
          ? { kind: saved.lastWrite.kind, user_id: saved.lastWrite.userId, at: saved.lastWrite.at.toISOString() }
          : null,
      });
    },
  };
}

function toToolDocument(document: GraphDocument): {
  schema_version: 1;
  nodes: GraphDocument["nodes"];
  edges: GraphDocument["edges"];
} {
  return {
    schema_version: 1,
    nodes: document.nodes,
    edges: document.edges,
  };
}

function fromToolDocument(document: {
  schema_version: 1;
  nodes: Array<{
    id: string;
    kind: "scene" | "asset" | "task" | "note";
    label: string;
    position: { x: number; y: number };
    data?: NonNullable<GraphDocument["nodes"][number]["data"]>;
  }>;
  edges: Array<{ id: string; source: string; target: string; label?: string }>;
}): GraphDocument {
  return {
    schemaVersion: 1,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      position: node.position,
      ...(node.data === undefined ? {} : { data: node.data }),
    })),
    edges: document.edges,
  };
}

function toolResult(result: unknown) {
  const safeResult = JSON.parse(JSON.stringify(result ?? null)) as unknown;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(safeResult) }],
    details: safeResult,
  };
}

/**
 * 导演台合同镜像门禁。
 *
 * 前端 src/components/director/contracts.ts 是后端
 * src/modules/director/commands/snapshot.ts + commands.ts 的自包含镜像
 * （前端 workspace 不能 import 后端源码）。本脚本把两边同名 zod schema
 * 序列化为 JSON Schema 逐一比对：形状漂移即失败，把"人工记得同步"
 * 变成门禁强制。用法：npx tsx scripts/check-director-mirror.mts
 */
import { z } from "zod";
import * as backendSnapshot from "../src/modules/director/commands/snapshot.js";
import * as backendCommands from "../src/modules/director/commands.js";
import * as frontendContracts from "../frontend/shortdrama-rag-demo/src/components/director/contracts.js";

const SHARED_SCHEMAS = [
  // snapshot 域
  "vec3Schema", "transformSchema", "transformPatchSchema", "poseSchema",
  "attachedAssetSchema", "sceneObjectSchema", "sceneCameraSchema",
  "aspectRatioSchema", "environmentSchema", "environmentPatchSchema",
  "sceneSnapshotSchema",
  // command 域
  "addObjectCommandSchema", "duplicateObjectCommandSchema", "deleteObjectCommandSchema",
  "selectObjectCommandSchema", "setTransformCommandSchema", "setPoseCommandSchema",
  "addCameraCommandSchema", "setCameraCommandSchema", "setAspectRatioCommandSchema",
  "setEnvironmentCommandSchema", "attachAssetCommandSchema", "saveSceneCommandSchema",
  "captureViewCommandSchema", "undoCommandSchema",
  "directorCommandSchema", "commandInverseSchema",
] as const;

const SHARED_CONSTANTS = ["SCENE_ASPECT_RATIOS", "DEFAULT_SCENE_ENVIRONMENT", "DIRECTOR_COMMAND_TYPES"] as const;

const backend: Record<string, unknown> = { ...backendSnapshot, ...backendCommands };
const frontend: Record<string, unknown> = { ...frontendContracts };

function fingerprint(schema: z.ZodType): string {
  // io: "input" 保证 default/optional 的输入侧形状参与比较。
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  return JSON.stringify(json, Object.keys(flatten(json)).sort());
}

function flatten(value: unknown, prefix = "", acc: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, `${prefix}${k}.`, acc);
  } else {
    acc[prefix] = value;
  }
  return acc;
}

const errors: string[] = [];

for (const name of SHARED_SCHEMAS) {
  const b = backend[name];
  const f = frontend[name];
  if (!b) { errors.push(`后端缺少导出：${name}`); continue; }
  if (!f) { errors.push(`前端镜像缺少导出：${name}`); continue; }
  let bp: string, fp: string;
  try {
    bp = fingerprint(b as z.ZodType);
    fp = fingerprint(f as z.ZodType);
  } catch (error) {
    errors.push(`${name}: 无法序列化比较（${String(error)}）`);
    continue;
  }
  if (bp !== fp) errors.push(`${name}: 前后端 schema 形状不一致 —— 同步 contracts.ts 与 commands*/snapshot.ts`);
}

for (const name of SHARED_CONSTANTS) {
  const b = JSON.stringify(backend[name]);
  const f = JSON.stringify(frontend[name]);
  if (b !== f) errors.push(`${name}: 常量不一致（后端 ${b} / 前端 ${f}）`);
}

if (errors.length > 0) {
  console.error("导演台镜像门禁失败：");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`导演台镜像门禁通过：${SHARED_SCHEMAS.length} 个 schema + ${SHARED_CONSTANTS.length} 个常量一致。`);

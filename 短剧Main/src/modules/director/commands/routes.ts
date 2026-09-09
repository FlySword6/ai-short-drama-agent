import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../../db/client.js";
import { requireCurrentUser } from "../../../http/authenticate.js";
import { parseRequest } from "../../../http/response.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../../shared/errors.js";
import {
  CommandValidationError,
  validateCommandsBodySchema,
} from "../commands.js";
import { sceneSnapshotSchema } from "./snapshot.js";
import { applyCommand, CommandExecutionError } from "./executor.js";
import {
  createDirectorProjectAccess,
  type DirectorProjectAccessPort,
} from "../projectAccess.js";
import {
  createPgDirectorDb,
  PgDirectorSceneRepository,
  type DirectorSceneRecord,
} from "../scene/repository.js";

/**
 * DirectorCommand 批量校验：结构（zod）、项目归属、版本匹配、对象引用存在。
 * 校验基于当前场景快照干跑（纯函数 applyCommand 在克隆上执行），不落库。
 */

const projectParams = z.object({ project_id: z.string().uuid() });

export interface CommandSceneStorePort {
  getScene(projectId: string): Promise<DirectorSceneRecord | null>;
}

export interface CommandRouteDependencies {
  sceneStore?: CommandSceneStorePort;
  projectAccess?: DirectorProjectAccessPort;
}

export async function registerDirectorCommandRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: CommandRouteDependencies = {},
): Promise<void> {
  const sceneStore = () => dependencies.sceneStore
    ?? new PgDirectorSceneRepository(createPgDirectorDb(getDatabase()));
  const projectAccess = () => dependencies.projectAccess
    ?? createDirectorProjectAccess(getDatabase());

  app.post("/api/v1/projects/:project_id/director/commands/validate", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const actor = requireCurrentUser(request);
    const body = parseRequest(validateCommandsBodySchema, request.body);

    // 命令与 URL/body 的一致性（结构层面，先于任何 IO）。
    for (const [index, command] of body.commands.entries()) {
      if (command.projectId !== params.project_id) {
        throw new BadRequestError(`第 ${index + 1} 条操作不属于当前项目，请检查后再试`);
      }
      if (command.sceneId !== body.sceneId || command.sceneVersion !== body.sceneVersion) {
        throw new BadRequestError(`第 ${index + 1} 条操作对应的场景已变更，请刷新后再试`);
      }
    }

    // 命令即使在本端只做 dry-run，仍然是创作工作流的一部分；viewer 不能
    // 借校验接口探测或准备可执行修改。delete_object 是破坏性动作，和保存
    // 快照删除已有对象一样，只能由项目 owner 或平台 admin 发起。
    const action = body.commands.some((command) => command.type === "delete_object")
      ? "delete"
      : "create";
    await projectAccess().require(actor, params.project_id, action);
    const store = sceneStore();
    const scene = await store.getScene(params.project_id);
    if (!scene) throw new NotFoundError("导演场景不存在");
    if (scene.id !== body.sceneId) {
      throw new BadRequestError("所选场景不是当前项目的导演场景，请刷新后再试");
    }
    if (scene.currentVersion !== body.sceneVersion) {
      throw new ConflictError(
        "场景已更新，请刷新后再试",
        "scene_version_conflict",
        { currentVersion: scene.currentVersion },
      );
    }

    // 基于当前快照干跑：任何对象引用错误都汇总返回，不执行任何持久化。
    const parsedSnapshot = sceneSnapshotSchema.safeParse(scene.snapshot ?? {});
    if (!parsedSnapshot.success) {
      throw new ConflictError(
        "场景内容暂时无法校验，请刷新后再试",
        "scene_snapshot_corrupt",
      );
    }
    let working = parsedSnapshot.data;
    const errors: Array<{ index: number; type: string; message: string }> = [];
    for (const [index, command] of body.commands.entries()) {
      try {
        working = applyCommand(working, command).snapshot;
      } catch (error) {
        if (error instanceof CommandExecutionError) {
          errors.push({ index, type: command.type, message: error.message });
          continue;
        }
        throw error;
      }
    }
    if (errors.length) {
      throw new CommandValidationError("导演操作没能完成，请检查场景后再试", errors);
    }

    return {
      ok: true,
      data: {
        valid: true,
        commandCount: body.commands.length,
        sceneId: scene.id,
        sceneVersion: scene.currentVersion,
      },
    };
  });
}

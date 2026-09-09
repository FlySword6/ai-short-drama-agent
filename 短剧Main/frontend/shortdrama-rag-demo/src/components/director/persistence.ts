/**
 * 3D 导演台 · 场景装载/保存编排（乐观锁与 409 分支）
 *
 * 纯逻辑层：不碰 React，依赖 api.ts 的可注入 fetch（tsx --test 直接 mock）。
 * - 加载：GET scene → 404 视为「无已存版本」返回 seed 指示；200 解析快照为 store 切片，
 *   ephemeral 对象跳过并带名单。
 * - 保存：store → persist 快照（blob: 资源打 ephemeral 标记）→ PUT（带 sceneVersion 乐观锁
 *   与 sourceAction 留痕）；409 / scene_version_conflict → conflict 分支，
 *   由 UI 提示用户刷新/加载最新。
 */
import { ApiClientError, getDirectorScene, putDirectorScene } from "./api";
import type { FetchLike } from "./api";
import { fromSceneSnapshot, toSceneSnapshot } from "./snapshot";
import type { SceneStateSlice } from "./store";
import { useDirectorStore } from "./store";

export type LoadDirectorSceneResult =
  | {
      kind: "loaded";
      sceneId: string;
      sceneVersion: number;
      slice: SceneStateSlice;
      skippedEphemeral: string[];
      skippedUnknown: string[];
    }
  | { kind: "seed" }
  | { kind: "error"; message: string };

export async function loadDirectorScene(
  projectId: string,
  fetchImpl?: FetchLike,
): Promise<LoadDirectorSceneResult> {
  try {
    const scene = await getDirectorScene(projectId, fetchImpl);
    const parsed = fromSceneSnapshot(scene.snapshot);
    return {
      kind: "loaded",
      sceneId: scene.id,
      sceneVersion: scene.currentVersion,
      slice: parsed.slice,
      skippedEphemeral: parsed.skippedEphemeral,
      skippedUnknown: parsed.skippedUnknown,
    };
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) return { kind: "seed" };
    return { kind: "error", message: errorMessage(error) };
  }
}

export type SaveDirectorSceneResult =
  | { kind: "saved"; sceneId: string; sceneVersion: number }
  | { kind: "conflict"; currentVersion: number | null }
  | { kind: "error"; message: string };

/**
 * 保存当前 store 场景。sceneVersion 传当前持有版本（首次保存传 0，后端据此 INSERT）；
 * sourceAction 留痕来源动作（manual_save / template:apply:<id> 等），写进版本记录。
 */
export async function saveDirectorSceneState(
  projectId: string,
  input: { sceneVersion: number; sourceAction?: string },
  fetchImpl?: FetchLike,
): Promise<SaveDirectorSceneResult> {
  const snapshot = toSceneSnapshot(useDirectorStore.getState(), { persist: true });
  try {
    const data = await putDirectorScene(
      projectId,
      {
        sceneVersion: input.sceneVersion,
        snapshot,
        ...(input.sourceAction ? { sourceAction: input.sourceAction } : {}),
        status: "saved",
      },
      fetchImpl,
    );
    return { kind: "saved", sceneId: data.id, sceneVersion: data.currentVersion };
  } catch (error) {
    if (error instanceof ApiClientError && (error.status === 409 || error.code === "scene_version_conflict")) {
      const details = error.details as Record<string, unknown> | null;
      const currentVersion =
        details && typeof details["currentVersion"] === "number" ? details["currentVersion"] : null;
      return { kind: "conflict", currentVersion };
    }
    return { kind: "error", message: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return "网络请求失败，请稍后重试";
}

/* ============================================================
   capabilities-state.ts — 权限读取的三态真源（读取中 / 读不到 / 已拿到）

   为什么是判别联合而不是可空值：可空值只能表达两件事，而界面要回答三件——
   还没读到、读不到、读到了。三件挤进一个 null，界面就只能把接口故障说成
   「你没有权限」。判别联合上没有 platformRole 这类字段，想读权限必须先挑
   分支，编译器逼着每个消费点为「读取中」「读不到」各写一句话。

   allow 语义一律由 operations.ts / lite-review.ts 的纯函数决定（镜像后端），
   本文件只管「读没读到」，不参与「准不准」。
   ============================================================ */
import { useCallback, useEffect, useState } from "react";
import { CAPABILITIES_REFRESH_EVENT, api } from "./api";
import { DEMO_CAPABILITIES, withOwnedProject, type Capabilities, type PlatformRoleForCopy } from "./operations";

export type CapabilitiesState =
  | { status: "loading" }
  | { status: "unavailable"; reload: () => void }
  | { status: "ready"; capabilities: Capabilities };

/** 四值闸门 = 界面必须画的四种东西：占位 / 「没读到·重试」/ 出动作 / 出拒绝文案。 */
export type CapabilityGate = "loading" | "unavailable" | "allowed" | "denied";

export function capabilityGate(state: CapabilitiesState, allow: (capabilities: Capabilities) => boolean): CapabilityGate {
  switch (state.status) {
    case "loading": return "loading";
    case "unavailable": return "unavailable";
    case "ready": return allow(state.capabilities) ? "allowed" : "denied";
  }
}

/**
 * 只给「按角色分叉的文案」用（比如状态条该说去全局设置开启还是去找管理员）。
 * 返回 unknown 而不是 null：null 会被下游当成假值、一路滑进非管理员话术，
 * 于是网关挂掉时管理员被告知「请联系管理员」——「没读到」又一次被说成「你不是管理员」。
 * 凡是决定按钮出不出、页面进不进的地方，一律用 capabilityGate，不许用这个。
 */
export function platformRoleForCopy(state: CapabilitiesState): PlatformRoleForCopy {
  return state.status === "ready" ? state.capabilities.platformRole : "unknown";
}

/** 读不到时的重拉入口；另外两态没有可重拉的东西，返回 null 让调用方不必写分支。 */
export function capabilityReload(state: CapabilitiesState): (() => void) | null {
  return state.status === "unavailable" ? state.reload : null;
}

/**
 * 壳层唯一的能力状态源：拉取、失败落态、重拉、以及建项目后的本地并入。
 * demo 恒为已拿到；登出回读取中（回不到「读不到」——没在读的东西谈不上读失败）。
 *
 * sessionKey = 「这份权限是哪一次登录会话读到的」，null 表示没人登录。
 * 绑「有没有人登录」是不够的：401 原地重登可以换成另一个账号，这个布尔一路是 true，
 * 权限就不重拉——B 顶着 A 的权限。所以由壳层给出会话身份，换人或重登都要换。
 */
export function useCapabilitiesState({ demoMode, sessionKey }: { demoMode: boolean; sessionKey: string | null }): CapabilitiesState {
  const [state, setState] = useState<CapabilitiesState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  /* 手上这份权限属于哪一次会话；会话一换它当场作废，退回读取中重读。
     作废必须发生在这一帧——连这一帧都不能把上一个人的权限交出去，
     等 effect 就晚了：那时候界面已经按前一个人的身份画完了。 */
  const [loadedSession, setLoadedSession] = useState(sessionKey);
  const staleSession = loadedSession !== sessionKey;
  if (staleSession) {
    setLoadedSession(sessionKey);
    setState({ status: "loading" });
  }

  useEffect(() => {
    if (demoMode) { setState({ status: "ready", capabilities: DEMO_CAPABILITIES }); return; }
    if (!sessionKey) { setState({ status: "loading" }); return; }
    let active = true;
    /* 同一次会话里的重拉（建项目后那次）不把界面打回读取中，也不因失败而退回读不到——
       手上那份仍然是真的；只有还没拿到过的重拉才有资格改变界面。
       换会话不走这里：上面已经把它作废成读取中了。 */
    setState((current) => current.status === "ready" ? current : { status: "loading" });
    void api.meCapabilities()
      .then((capabilities) => { if (active) setState({ status: "ready", capabilities }); })
      .catch(() => {
        if (active) setState((current) => current.status === "ready" ? current : { status: "unavailable", reload });
      });
    return () => { active = false; };
  }, [demoMode, sessionKey, attempt, reload]);

  useEffect(() => {
    if (demoMode) return;
    const onRefresh = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (projectId) {
        setState((current) => current.status === "ready"
          ? { status: "ready", capabilities: withOwnedProject(current.capabilities, projectId) }
          : current);
      }
      reload();
    };
    window.addEventListener(CAPABILITIES_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(CAPABILITIES_REFRESH_EVENT, onRefresh);
  }, [demoMode, reload]);

  return staleSession ? { status: "loading" } : state;
}

/* ============================================================
   lite-registration.ts — Lite seedance 素材登记共享状态机（S5 抽取）

   状态机原样抽自 lite-shots-page.tsx 行内登记链（POST 登记 → registering/processing
   轮询 → active → ready），供 Lite 两分镜/素材页共用。2026-08-10 #186 全能参考口径：
   生视频的一切素材都以「参考」身份进请求——登记提升实体缺省 usage_mode=reference，
   active 即「可引用」，本 hook 不发任何用途 PATCH（旧锚定方案的用途标记阶段已随
   废案删除）。

   登记是火山控制面调用，不是付费生成任务。触发模型（2026-08-19 裁定）：唯一自动触发 =
   媒体成为主变体（设主图/主音频翻转或 is_primary=true 上传，后端翻转提交后后台任务
   fire-and-forget），本 hook 不做任何自动登记；它只负责状态轮询/恢复与失败重试——
   startRegistration 仍是用户明示点击的登记/重试入口（failed 重试 = 完整重走本链）。
   键缺省 = media_results.id（登记提升产物）；详情页传 endpoints 切换为 asset_media_id 键
   （主变体自动登记的 probe）。
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, api, type SeedanceRegistration, type SeedanceRegistrationStatus } from "../../api";
import { humanErrorMessage } from "../batch-generate-drawer";

/** 登记轮询节奏：固定 10s（登记入库是分钟级，不套指数退避）。 */
const REGISTRATION_POLL_MS = 10_000;
/** 单阶段看守上限：registering 超 10 分钟（与服务端 isSubmissionStale 同口径）/
    processing 超 30 分钟视为卡死，转 failed 给人工重试出口，不留永远的「入库中」。 */
const REGISTRATION_REGISTERING_CAP_MS = 10 * 60 * 1000;
const REGISTRATION_PROCESSING_CAP_MS = 30 * 60 * 1000;

/**
 * 行内登记阶段（服务端 status 的页面侧归一，映射见 phaseFromRegistrationStatus）：
 * - registering：POST 登记在飞，或恢复时见到服务端 pending/submitting（本地提交窗口，GET 轮询）；
 * - processing：远端入库中（refresh 轮询）；
 * - ready：登记完成（active 即「可引用」，提升实体缺省 usage_mode=reference）；
 * - failed：任一步失败（含服务端 failed/unknown/unavailable），「重试登记」= 重新走完整链，
 *   服务端自行决定复用/刷新/重开（幂等，不重复建行）。
 */
export type LiteRegistrationPhase = "registering" | "processing" | "ready" | "failed";

export interface LiteRegistrationState {
  phase: LiteRegistrationPhase;
  /** 服务端登记视图（ready 时必有；其 asset_media_id 才是生成 references 认的 media_id）。 */
  registration: SeedanceRegistration | null;
  /** failed 的人话原因（latest_error.message 或本地异常），其余阶段为 null。 */
  error: string | null;
  /** 进入现阶段的时间戳；配合看守上限识别卡死。 */
  phaseSince: number;
}

/** 服务端登记状态 → 行内阶段；active 不归这里（调用方 active 即 ready），返回 null。 */
function phaseFromRegistrationStatus(status: SeedanceRegistrationStatus): "registering" | "processing" | "failed" | null {
  if (status === "pending" || status === "submitting") return "registering";
  if (status === "processing") return "processing";
  if (status === "active") return null;
  /* failed=远端明确失败；unknown=提交结果不明、unavailable=授权/核验过期——三者都收敛到
     failed 阶段给人工出口：再点「重试登记」由服务端决定下一步（claimCreate 的语义分叉），前端不自作主张。 */
  return "failed";
}

/** 登记视图的人话错误（latest_error 已由后端脱敏，直接可读）。 */
function registrationErrorMessage(registration: SeedanceRegistration): string {
  return registration.latest_error?.message || "素材登记未完成，请重试";
}

/** 登记端点三件套；键语义由调用方定（缺省 media_results.id，详情页 asset_media_id）。 */
export interface LiteRegistrationEndpoints {
  /** 查现状；未登记返回 null（404 归一）。 */
  get: (key: string) => Promise<SeedanceRegistration | null>;
  /** 拉一次远端 GetAsset 刷新（仅 processing 有意义，见 api.ts refreshSeedanceRegistration）。 */
  refresh: (key: string) => Promise<SeedanceRegistration>;
  /** 登记/重试（服务端幂等复用既有行）。 */
  register: (key: string) => Promise<SeedanceRegistration>;
}

/** 缺省端点：media_results.id 键（分镜页/素材页登记提升产物）。 */
const mediaResultKeyedEndpoints: LiteRegistrationEndpoints = {
  get: (key) => api.getSeedanceRegistration(key),
  refresh: (key) => api.refreshSeedanceRegistration(key),
  register: (key) => api.registerSeedanceAsset(key),
};

export interface UseLiteRegistrationsOptions {
  demoMode: boolean;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
  /** 覆盖端点（详情页 asset_media_id 键用）；缺省 media_results.id。 */
  endpoints?: LiteRegistrationEndpoints;
}

export interface LiteRegistrations {
  /** 键 = media_results.id（候选图/候选产物 id）或 asset_media_id（详情页主变体）。 */
  registrations: Record<string, LiteRegistrationState>;
  /** 「登记素材」点击 = 一次完整链：POST 登记 →（远端入库中转轮询接管）→ active 即 ready。
      同一键同时在飞最多一个登记动作；failed 重试 = 完整重走本链（服务端幂等）。 */
  startRegistration: (key: string) => Promise<void>;
  /** 挂载/列表刷新恢复：对还没有登记记录的键各 GET 一次还原状态（404=未登记，保持无记录；
      processing 由轮询接管；active 即 ready）。同键只查一次，幂等可反复调。 */
  probeRegistrations: (keys: readonly string[]) => void;
  /** 重新 probe 指定键（先清 probedRef）：主变体自动登记的后台任务建行晚于 probe 时兜底重查。 */
  reprobeRegistrations: (keys: readonly string[]) => void;
}

export function useLiteRegistrations({ demoMode, notify, endpoints }: UseLiteRegistrationsOptions): LiteRegistrations {
  const [registrations, setRegistrations] = useState<Record<string, LiteRegistrationState>>({});
  const [pollKick, setPollKick] = useState(0);
  const registrationsRef = useRef(registrations);
  useEffect(() => { registrationsRef.current = registrations; }, [registrations]);
  /* 端点经 ref 取最新（详情页按 assetEntityId 换引用，不进轮询依赖放大布防）。 */
  const endpointsRef = useRef(endpoints ?? mediaResultKeyedEndpoints);
  useEffect(() => { endpointsRef.current = endpoints ?? mediaResultKeyedEndpoints; }, [endpoints]);
  /** 本地链在飞的键（登记/单次恢复调用在飞）；轮询跳过，防并发重入。 */
  const inflightRef = useRef<Set<string>>(new Set());
  /** 恢复已查过的键：媒体刷新会重建列表数据，靠它防止对同一产物重复 GET。 */
  const probedRef = useRef<Set<string>>(new Set());
  /** 卸载后不再写状态（恢复/登记的异步回调可能在卸载后返回）。 */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  /* notify 由页面渲染域传入（app 壳每渲染可能换新引用），经 ref 取最新，不进依赖。 */
  const notifyRef = useRef(notify);
  useEffect(() => { notifyRef.current = notify; }, [notify]);

  const patchRegistration = useCallback((key: string, next: LiteRegistrationState | null): void => {
    setRegistrations((previous) => {
      const copy = { ...previous };
      if (next === null) delete copy[key];
      else copy[key] = next;
      return copy;
    });
  }, []);

  /** register/refresh/get 拿到登记视图后的统一分路：active 直接 ready（提升实体缺省
      usage_mode=reference，全能参考口径下可引用，无需任何用途 PATCH），其余按状态落阶段。
      调用方须已把键挂进 inflightRef（本函数不管锁）。 */
  const settleRegistration = useCallback(async (key: string, registration: SeedanceRegistration): Promise<void> => {
    if (registration.status === "active") {
      patchRegistration(key, { phase: "ready", registration, error: null, phaseSince: Date.now() });
      return;
    }
    const phase = phaseFromRegistrationStatus(registration.status);
    patchRegistration(key, {
      phase: phase ?? "failed",
      registration,
      error: phase === "failed" ? registrationErrorMessage(registration) : null,
      phaseSince: Date.now(),
    });
  }, [patchRegistration]);

  /* 轮询 effect 经 ref 调最新 settle（双保险不进依赖放大布防）。 */
  const settleRegistrationRef = useRef(settleRegistration);
  useEffect(() => { settleRegistrationRef.current = settleRegistration; }, [settleRegistration]);

  /* ---------- 登记轮询：每 10s 对 processing 调 refresh、registering 调 GET（无 remote_asset_id
     时 refresh 必 400，故按阶段分路）；标签页隐藏暂停 + 恢复即查；本地链在飞的键跳过。 ---------- */
  useEffect(() => {
    if (demoMode) return;
    let active = true;
    let timer = 0;
    const hasWork = (): boolean => Object.values(registrationsRef.current).some(
      (state) => state.phase === "processing" || state.phase === "registering",
    );
    const schedule = (ms: number): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void tick(), ms);
    };
    const tick = async (): Promise<void> => {
      if (!active) return;
      /* 标签页隐藏不发请求（document.hidden 暂停），visibilitychange 恢复即查。 */
      if (document.hidden) {
        schedule(REGISTRATION_POLL_MS);
        return;
      }
      const now = Date.now();
      for (const [key, state] of Object.entries(registrationsRef.current)) {
        if (!active) return;
        if (inflightRef.current.has(key)) continue;
        if (state.phase !== "processing" && state.phase !== "registering") continue;
        /* 卡死看守：单阶段超上限转 failed，留人工重试出口（重试对服务端是幂等复用语义）。 */
        const cap = state.phase === "processing" ? REGISTRATION_PROCESSING_CAP_MS : REGISTRATION_REGISTERING_CAP_MS;
        if (now - state.phaseSince > cap) {
          patchRegistration(key, { phase: "failed", registration: state.registration, error: "素材登记长时间未完成，请重试登记", phaseSince: now });
          continue;
        }
        inflightRef.current.add(key);
        try {
          const registration = state.phase === "processing"
            ? await endpointsRef.current.refresh(key)
            : await endpointsRef.current.get(key);
          if (!active) return;
          if (registration === null) {
            /* GET 404：登记行已不存在（防御分支，正常不会发生）→ 回到未登记。 */
            patchRegistration(key, null);
            continue;
          }
          await settleRegistrationRef.current(key, registration);
        } catch (reason) {
          if (!active) return;
          if (reason instanceof ApiClientError && reason.status === 404) {
            patchRegistration(key, null);
          } else if (reason instanceof ApiClientError && reason.status === 403) {
            patchRegistration(key, { phase: "failed", registration: state.registration, error: "没有权限查看该素材登记", phaseSince: now });
          }
          /* 其余异常（网络/5xx）：保持现阶段下轮再试——服务端 refresh 失败会自行把登记
             收敛到 unknown（recordRefreshFailure），前端终会落到 failed 给人工出口。 */
        } finally {
          inflightRef.current.delete(key);
        }
      }
      if (active && hasWork()) schedule(REGISTRATION_POLL_MS);
    };
    const onVisibility = (): void => {
      if (!document.hidden && hasWork()) schedule(0);
    };
    if (hasWork()) schedule(0);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // kick：登记动作/恢复写入新状态后重新布防；回调经 ref/稳定 useCallback 取最新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, pollKick, patchRegistration]);

  const startRegistration = useCallback(async (key: string): Promise<void> => {
    if (demoMode) {
      notifyRef.current("离线演示不会发起素材登记", "info");
      return;
    }
    if (inflightRef.current.has(key)) return;
    const current = registrationsRef.current[key];
    if (current && current.phase !== "failed") return;
    inflightRef.current.add(key);
    patchRegistration(key, { phase: "registering", registration: current?.registration ?? null, error: null, phaseSince: Date.now() });
    try {
      const registration = await endpointsRef.current.register(key);
      if (!aliveRef.current) return;
      await settleRegistrationRef.current(key, registration);
    } catch (reason) {
      if (!aliveRef.current) return;
      patchRegistration(key, { phase: "failed", registration: null, error: humanErrorMessage(reason, "登记失败，请重试"), phaseSince: Date.now() });
    } finally {
      inflightRef.current.delete(key);
      if (aliveRef.current) setPollKick((value) => value + 1);
    }
  }, [demoMode, patchRegistration]);

  const probeRegistrations = useCallback((keys: readonly string[]): void => {
    if (demoMode) return;
    for (const key of keys) {
      if (!key) continue;
      if (probedRef.current.has(key) || inflightRef.current.has(key)) continue;
      if (registrationsRef.current[key]) continue;
      probedRef.current.add(key);
      inflightRef.current.add(key);
      void (async () => {
        try {
          const registration = await endpointsRef.current.get(key);
          if (!aliveRef.current || !registration) return;
          await settleRegistrationRef.current(key, registration);
          if (aliveRef.current) setPollKick((value) => value + 1);
        } catch {
          /* 恢复失败不阻断页面：该产物保持「未登记」，用户可手动点登记素材（服务端幂等复用）。 */
        } finally {
          inflightRef.current.delete(key);
        }
      })();
    }
  }, [demoMode]);

  const reprobeRegistrations = useCallback((keys: readonly string[]): void => {
    for (const key of keys) {
      if (key) probedRef.current.delete(key);
    }
    probeRegistrations(keys);
  }, [probeRegistrations]);

  return { registrations, startRegistration, probeRegistrations, reprobeRegistrations };
}

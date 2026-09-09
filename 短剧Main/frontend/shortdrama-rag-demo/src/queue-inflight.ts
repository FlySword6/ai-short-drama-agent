/* ============================================================
   queue-inflight.ts — 生产队列在途计数(已换源,批次二规矩 3)

   换源后:生成在途=GET /generations/in-flight(冻结信封/status 单轴/等待最久优先,
   sol 端点已在 dev)+上传活跃任务(GET /asset-upload-tasks, queued/processing)。
   旧「localStorage recovery 前缀枚举」退役为说明行(队列页提示回本机续跑用);
   调用方(AppRail 队列 chip / QueuePage)不动,只换这里。
   ============================================================ */
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { GenerationInFlight } from "./types";

/** 与 generation-task-recovery 的 KEY_PREFIX 同值(那边未导出,这里同名复用;改名两边一起改)。 */
const RECOVERY_KEY_PREFIX = "shortdrama_v01_generation_request";

/** 本机未完成的生成提交记录数(只数键不读值;队列页说明行用,不再计入在途总数)。 */
export function countLocalInflight(storage: Pick<Storage, "length" | "key">): number {
  let count = 0;
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && key.startsWith(RECOVERY_KEY_PREFIX)) count += 1;
  }
  return count;
}

/** 上传活跃任务数(queued/processing;终态服务端不回)。 */
export async function countUploadInflight(): Promise<number> {
  const list = await api.assetUploadTasks();
  return list.items.filter((task) => task.status === "queued" || task.status === "processing").length;
}

export interface InFlightCount {
  state: "loading" | "ready" | "error";
  /** ready 时为在途总数(生成 in-flight total + 上传活跃);error 时不显示数字(rail chip 静默降级为纯图标)。 */
  count: number | null;
  retry: () => void;
}

/** rail 队列 chip 与队列页共用的在途计数;demo 固定 2(与原型「生产中 2」同口径)。 */
export function useInFlightCount(demoMode: boolean): InFlightCount {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [count, setCount] = useState<number | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const generations = await api.generationsInFlight({ pageSize: 1 });
      const uploads = await countUploadInflight();
      setCount(generations.total + uploads);
      setState("ready");
    } catch {
      setCount(null);
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (demoMode) {
      setCount(2);
      setState("ready");
      return;
    }
    void load();
  }, [demoMode, load]);

  return { state, count, retry: () => void load() };
}

export interface InFlightList {
  state: "loading" | "ready" | "error";
  items: GenerationInFlight[];
  retry: () => void;
}

/** 队列页的生成在途列表(等待最久优先=服务端序;一页 50 覆盖在途规模,不做翻页)。 */
export function useInFlightGenerations(demoMode: boolean): InFlightList {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [items, setItems] = useState<GenerationInFlight[]>([]);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const result = await api.generationsInFlight({ pageSize: 50 });
      setItems(result.items);
      setState("ready");
    } catch {
      setItems([]);
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (demoMode) {
      setItems([]);
      setState("ready");
      return;
    }
    void load();
  }, [demoMode, load]);

  return { state, items, retry: () => void load() };
}

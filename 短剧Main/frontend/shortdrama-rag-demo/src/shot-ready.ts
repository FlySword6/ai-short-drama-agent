/* ============================================================
   shot-ready.ts — 粗剪素材「标记就绪」（S2b-4 · 纯逻辑 + 本地存储适配）

   Dario 拍板口径：
   - 「就绪」是导演/美术的人工判断，不是机器门禁；
   - 生成按钮不被硬校验锁死，缺项只做提示；
   - 「标记就绪」= 人工一次点击，记谁在什么时候标的，可撤销；
   - 控制通道=人工标记就绪后出现「生成本粗剪素材」；
     「生成本集」= 对本集所有人工标记就绪的粗剪素材依序执行。

   降级明示：后端字段（ready_marked_by/at）Sol 未供，当前存 localStorage
   （换浏览器/清缓存会丢），合同 API 就位后整体换源，UI 不改动。
   ============================================================ */

export interface ReadyMark {
  /** 标记人（用户名/展示名）。 */
  by: string;
  /** 标记时间（ISO 字符串）。 */
  at: string;
}

const STORAGE_PREFIX = "shortdrama_shot_ready_v1:";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function parseMark(raw: string | null): ReadyMark | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReadyMark>;
    if (typeof parsed?.by === "string" && parsed.by && typeof parsed?.at === "string" && parsed.at) {
      return { by: parsed.by, at: parsed.at };
    }
  } catch {
    /* 脏数据视为未标记 */
  }
  return null;
}

export function loadReadyMark(storage: StorageLike, shotId: string): ReadyMark | null {
  return parseMark(storage.getItem(`${STORAGE_PREFIX}${shotId}`));
}

/** 批量读取（剧集页徽章用）；未标记的键不出现。 */
export function loadReadyMarks(storage: StorageLike, shotIds: readonly string[]): Record<string, ReadyMark> {
  const marks: Record<string, ReadyMark> = {};
  for (const shotId of shotIds) {
    const mark = loadReadyMark(storage, shotId);
    if (mark) marks[shotId] = mark;
  }
  return marks;
}

/** 标记/撤销（mark=null 即撤销）。 */
export function saveReadyMark(storage: StorageLike, shotId: string, mark: ReadyMark | null): void {
  try {
    if (mark) storage.setItem(`${STORAGE_PREFIX}${shotId}`, JSON.stringify(mark));
    else storage.removeItem(`${STORAGE_PREFIX}${shotId}`);
  } catch {
    /* 存储不可用时就绪标记仅本次会话可见 */
  }
}

/** 标记摘要：「Alice · 07-22 18:03」。 */
export function formatReadyMark(mark: ReadyMark): string {
  const date = new Date(mark.at);
  const pad = (value: number) => String(value).padStart(2, "0");
  const when = Number.isNaN(date.getTime())
    ? mark.at
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${mark.by} · ${when}`;
}

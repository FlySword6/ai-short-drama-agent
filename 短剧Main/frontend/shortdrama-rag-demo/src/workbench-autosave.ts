/* ============================================================
   workbench-autosave.ts — 工作台文字描述/提示词自动保存判定（纯逻辑）

   S16 条 1 根因：后端 updateShotSchema 的 nullableText 一律 `.trim()`
   （production/routes.ts:16——服务端契约=文本不保留首尾空白），
   前端此前按原样字符串比较 dirty。文本带尾随换行时：
   保存 → 服务端存 trim 值 → 回包 ≠ 本地 → 永远 dirty → 1.2s 后再存
   → 无限循环（实测 18s 内 12 次相同 PATCH，「已保存」频闪）。

   修复口径：
   - dirty 判定与服务端契约对齐——trim 语义比较（首尾空白差异不算
     未保存变更：服务端本来也不会存它）；
   - 只有 trim 后内容真实不同才触发保存；保存动作真实发生才提示；
   - 「已保存」提示由组件 effect 在 ~2.4s 后淡出（见 workbench-page）。
   ============================================================ */

/** 与服务端 nullableText(trim)对齐的文本归一：null/undefined→""，再 trim。 */
export function normalizePromptText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export interface PromptTrio {
  script: string;
  image: string;
  video: string;
}

/**
 * 自动保存 dirty 判定（trim 语义）：任一组 trim 后不同才算有未保存变更。
 * 本地 "abc\n" vs 服务端 "abc" → false（不算 dirty，保存循环断）。
 */
export function autosaveDirty(local: PromptTrio, server: PromptTrio): boolean {
  return (
    normalizePromptText(local.script) !== normalizePromptText(server.script) ||
    normalizePromptText(local.image) !== normalizePromptText(server.image) ||
    normalizePromptText(local.video) !== normalizePromptText(server.video)
  );
}

/** 从分镜实体取服务端基线三件套。 */
export function serverPromptTrio(shot: { script_text?: string | null; image_prompt?: string | null; video_prompt?: string | null }): PromptTrio {
  return {
    script: shot.script_text ?? "",
    image: shot.image_prompt ?? "",
    video: shot.video_prompt ?? "",
  };
}

/** 「已保存」提示淡出时长（出现一次后自动消失，不常驻不闪烁）。 */
export const SAVED_FADE_MS = 2400;

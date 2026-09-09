/* ============================================================
   local-drafts.ts — 长文本本地草稿（F01「401 不丢用户的东西」配套）

   场景:粘贴整集剧本这类长输入,即使有了原地重登小窗,刷新/误关/崩溃仍会丢字。
   口径:写跟随输入(每次变更即写,文本量级小无所谓防抖);保存成功由调用方显式清除;
   读取失败/存储损坏一律回 null,不影响主流程。
   ============================================================ */

export function readLocalDraft(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocalDraft(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch { /* 隐私模式等写入失败不挡输入 */ }
}

export function clearLocalDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch { /* 忽略 */ }
}

/** 剧本粘贴草稿的键位（按项目+集隔离,切集不串）。 */
export function scriptDraftKey(projectId: string, episodeId: string | null): string {
  return `shortdrama:draft:script:${projectId}:${episodeId ?? "none"}`;
}

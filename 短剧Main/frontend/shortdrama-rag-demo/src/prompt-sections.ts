/* ============================================================
   prompt-sections.ts — 提示词两段式（GP-12 / 剧本步 6 口径）

   剧本步 6：提示词 = 自动段（只读，含场景/角色/镜头上下文）+ 补充段（手输）。
   分界真源：现有预填生成逻辑（workbench-page 的 buildImagePrompt/buildVideoPrompt/
   applyPresetPrompt）产出的整段预填 = 系统部分，即自动段；用户手输 = 补充段。
   提交拼接 = 自动段 + 换行 + 补充段（任一侧为空即另一侧原文），与旧单框
   「预填文本即提交文本」的注入语义一致——不改提交 payload 结构，只改呈现与可编辑边界。

   已存文本（shot.image_prompt/video_prompt，旧单框时代写入）的分界：
   与当前系统候选（同函数同参数重算的预填）前缀比对——
   命中则前缀为自动段、余下为补充段；对不上则无法回溯哪部分是用户改的，
   如实整段作自动段 + 空白补充段（不猜、不硬切）。
   ============================================================ */

/** 两段式提示词：auto=系统预填（只读）；supplement=用户手输（可编辑）。 */
export interface PromptSections {
  auto: string;
  supplement: string;
}

/**
 * 提交/持久化拼接：自动段在下、补充段追加其后。
 * - 自动段空 → 补充段原文（用户全手输，与旧单框手输口径一致）；
 * - 补充段空 → 自动段原文（预填未动，与旧单框未编辑口径一致）；
 * - 两段都有 → 自动段去尾随空白 + 一个换行 + 补充段原文。
 */
export function splicePromptSections(auto: string, supplement: string): string {
  if (!auto.trim()) return supplement;
  if (!supplement.trim()) return auto;
  return `${auto.replace(/\s+$/, "")}\n${supplement}`;
}

/**
 * 已存提示词 → 两段。systemCandidate = 用当前分镜/参考重算的系统预填
 * （buildImagePrompt/buildVideoPrompt 等同源函数产出）。
 * - 空已存 → 两段皆空（干净起点，预填在开抽屉/点优化时生成）；
 * - 已存 == 候选，或已存 = 候选 + 换行 + 追加 → 候选为自动段，追加为补充段；
 * - 其余（旧单框里改过半截、候选因参考未载齐对不上）→ 整段作自动段 + 空白补充段。
 */
export function splitSavedPromptSections(saved: string, systemCandidate: string): PromptSections {
  if (!saved.trim()) return { auto: "", supplement: "" };
  if (systemCandidate.trim()) {
    if (saved === systemCandidate) return { auto: systemCandidate, supplement: "" };
    if (saved.startsWith(systemCandidate)) {
      const rest = saved.slice(systemCandidate.length);
      if (rest.startsWith("\n")) return { auto: systemCandidate, supplement: rest.replace(/^\n+/, "") };
    }
  }
  return { auto: saved, supplement: "" };
}

import type { GenerationMediaKind, ProjectStyle } from "./types";

/** 风格内容上限：与后端 zod + project_styles.content CHECK 一致（5000）。 */
export const PROJECT_STYLE_CONTENT_MAX = 5000;
/** 风格名上限：与后端 zod + 数据库 CHECK 一致（80）。 */
export const PROJECT_STYLE_NAME_MAX = 80;

/** 某媒介风格列表里的默认风格（无默认 → null；每媒介至多一个——可为空，D1 2026-08-17 修订）。 */
export function defaultProjectStyleOf(styles: readonly ProjectStyle[], kind: GenerationMediaKind): ProjectStyle | null {
  return styles.find((style) => style.media_kind === kind && style.is_default) ?? null;
}

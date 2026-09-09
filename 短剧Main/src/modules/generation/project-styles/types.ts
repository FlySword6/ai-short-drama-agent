export const projectStyleMediaKinds = ["image", "video"] as const;
export type ProjectStyleMediaKind = (typeof projectStyleMediaKinds)[number];

export const PROJECT_STYLE_NAME_MAX = 80;
export const PROJECT_STYLE_CONTENT_MAX = 5000;

/** Lite 项目级风格行（docs/design/prd-v2/lite-config-tabs-and-style.md §4.4）。 */
export interface ProjectStyle {
  id: string;
  projectId: string;
  mediaKind: ProjectStyleMediaKind;
  name: string;
  content: string;
  isDefault: boolean;
  createdByUserId: string;
  deletedByUserId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectStyleInput {
  mediaKind: ProjectStyleMediaKind;
  name: string;
  content: string;
}

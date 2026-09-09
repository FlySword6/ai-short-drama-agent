import type { PlatformRole } from "../auth/types.js";

/**
 * ⌘K 命令面板搜索(S30):一个登录用户输入关键词,跨项目/剧集/场/分镜/资产
 * 五组各出几条跳转命中。搜索是集合级读取,可见性规则与 project-access 的
 * 决策矩阵同源:member 只看自己 owner/成员的项目,admin/operator 全可见;
 * 集合查询没有单项目决策点可用,内联同一规则(先例见 production 模块
 * listProjects 的 leftJoin 写法),不另起一套过滤口径。
 */

export const COMMAND_PALETTE_SEARCH_GROUPS = ["projects", "episodes", "scenes", "shots", "assets"] as const;

export type CommandPaletteSearchGroup = (typeof COMMAND_PALETTE_SEARCH_GROUPS)[number];

/** 每组命中条数上限:面板是快捷入口不是列表页,宁少而准。 */
export const COMMAND_PALETTE_PER_GROUP_LIMIT = 5;

export interface CommandPaletteActor {
  id: string;
  role?: PlatformRole;
}

export interface CommandPaletteProjectHit {
  id: string;
  name: string;
  description: string | null;
}

export interface CommandPaletteEpisodeHit {
  id: string;
  projectId: string;
  episodeNo: number;
  name: string | null;
}

export interface CommandPaletteSceneHit {
  id: string;
  projectId: string;
  episodeId: string;
  sceneNo: number;
  name: string | null;
}

export interface CommandPaletteShotHit {
  id: string;
  projectId: string;
  episodeId: string;
  shotCode: string;
  title: string | null;
}

export interface CommandPaletteAssetHit {
  id: string;
  projectId: string;
  name: string;
  displayName: string | null;
  assetKind: string;
}

export interface CommandPaletteSearchResults {
  projects: CommandPaletteProjectHit[];
  episodes: CommandPaletteEpisodeHit[];
  scenes: CommandPaletteSceneHit[];
  shots: CommandPaletteShotHit[];
  assets: CommandPaletteAssetHit[];
}

export interface CommandPaletteRepository {
  /**
   * Search every group with the actor's visibility applied in SQL. `query` is
   * the raw user input; the repository escapes LIKE wildcards itself.
   */
  searchVisible(actor: CommandPaletteActor, query: string, perGroupLimit: number): Promise<CommandPaletteSearchResults>;
}

/* ============================================================
   version.ts — 应用版本号单一来源（S14-13：页脚与所有出现版本号的地方
   共用这一个导出常量，不许散落硬编码；读 package.json，不写死）。
   ============================================================ */

import packageJson from "../package.json";

/** 运行中应用版本（package.json 单一来源；未声明 version 时回退当前发布线）。 */
export const APP_VERSION = (packageJson as { version?: string }).version ?? "0.1.1";

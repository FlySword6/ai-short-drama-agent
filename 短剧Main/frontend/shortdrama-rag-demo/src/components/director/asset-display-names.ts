/**
 * 3D 导演台 · 内置资产中文显示名映射（P1-10 · 资产中文化）
 *
 * 键 = 内置资产 id（assets-library.ts BUILTIN_ASSETS 的 `builtin:*` 标识）；
 * 值 = 资产面板 / 场景对象清单 / 属性面板默认展示的中文名。
 * 原始英文名仍保留在 asset.name 上：列表行 title 悬浮与属性面板「来源」区
 * （object.fileName，如 Female_LookingUp.glb）继续可见。
 *
 * 维护规则：BUILTIN_ASSETS 新增内置资产时必须在此登记中文名，
 * assets-library.test.ts 有「映射覆盖全部内置资产」断言兜底。
 */
export const BUILTIN_ASSET_DISPLAY_NAMES: Record<string, string> = {
  // 角色（quaternius 人体模型）
  "builtin:quaternius/human/Female_LookingUp": "仰望的女性",
  // 场景（kenney 城市商业）
  "builtin:kenney/city-commercial/building-a": "商业建筑 A",
  // 道具（kenney 家具 / 载具、quaternius 食物）
  "builtin:kenney/furniture/bathroomCabinet": "浴室柜",
  "builtin:kenney/vehicle/ambulance": "救护车",
  "builtin:quaternius/food/Apple": "苹果",
};

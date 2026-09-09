/**
 * 费用单位文案唯一出口（板09 验收项）。
 *
 * DC 已拍板（2026-07-21）：1 积分 = 1 分钱——后端 fen 字段数值直接读作积分数。
 * 全站（估价确认卡/批量清单/消耗看板/版本弹窗）费用一律显示积分；
 * 费用文案只准从这里出，禁止在页面里写死单位字样或换算比例。
 */

/** 结算单位显示名（口径：积分）。 */
export const COST_UNIT_LABEL = "积分";

/** 数据库与服务端金额字段的单位是分（fen）。口径：1 积分 = 1 分，恒等读取。 */
export const FEN_PER_CREDIT = 1;

/** 费用 → 积分数值（1 积分 = 1 分钱，恒等；口径变更时只改这里）。 */
export function fenToCredits(fen: number): number {
  return fen / FEN_PER_CREDIT;
}

/** 大额积分缩写：12,400 → "1.24 万"；小于一万原样千分位。 */
export function formatCredits(fen: number): string {
  const credits = fenToCredits(fen);
  if (Math.abs(credits) >= 10_000) {
    const wan = credits / 10_000;
    return `${Number(wan.toFixed(2))} 万`;
  }
  return credits.toLocaleString("zh-CN");
}

/** 带单位的完整展示：≈120 积分 / 5.37 万 积分。 */
export function formatCreditsWithUnit(fen: number, options: { approx?: boolean } = {}): string {
  return `${options.approx ? "≈" : ""}${formatCredits(fen)} ${COST_UNIT_LABEL}`;
}

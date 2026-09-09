/**
 * 轻量埋点（W6-C）：track(event, props) → POST /api/v1/events { event, props, ts }。
 *
 * 纪律：
 * - 失败静默（含端点未上线的 404/501、断网、5xx）——埋点永远不挡用户主流程；
 * - 调用侧不 await（void 放飞），不在埋点里抛错；
 * - 端点已上线（POST /api/v1/events，UTC 聚合），合同 { event, props, ts } 不变；
 * - generation_result 按 request_id 去重（轮询会多次拿到终态，只报一次）。
 */

const REPORTED_RESULT_KEY = "shortdrama_v011_telemetry_results";

/** 已上报终态的 generation_request_id 集合（sessionStorage 持久，防轮询重复上报）。 */
function reportedResults(): Set<string> {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(REPORTED_RESULT_KEY) || "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function markResultReported(requestId: string): void {
  try {
    const current = reportedResults();
    current.add(requestId);
    window.sessionStorage.setItem(REPORTED_RESULT_KEY, JSON.stringify([...current].slice(-200)));
  } catch { /* 存储失败就让它去重失败一次，不挡流程 */ }
}

/** generation_result 去重判定：已报过返回 false（纯函数，可测）。 */
export function shouldReportResult(requestId: string, status: string, reported: ReadonlySet<string>): boolean {
  if (!requestId) return false;
  if (status !== "succeeded" && status !== "failed" && status !== "cancelled") return false;
  return !reported.has(requestId);
}

/** 事件负载（合同：{ event, props, ts }）。 */
export interface TelemetryPayload {
  event: string;
  props: Record<string, unknown>;
  ts: number;
}

/** 组装事件负载（纯函数，可测）。 */
export function buildTelemetryPayload(event: string, props: Record<string, unknown> = {}, now = Date.now()): TelemetryPayload {
  return { event, props, ts: now };
}

/**
 * 发送埋点：永远 resolve，永不 throw。
 * sender 注入以便测试；默认 fetch 直连（不走 api.request 的 401 处理——埋点 401 不该踢用户下线）。
 */
export async function sendTelemetry(
  payload: TelemetryPayload,
  sender: (payload: TelemetryPayload) => Promise<void> = defaultSender,
): Promise<void> {
  try {
    await sender(payload);
  } catch { /* 静默：404/断网/5xx 都不影响主流程 */ }
}

async function defaultSender(payload: TelemetryPayload): Promise<void> {
  const token = window.sessionStorage.getItem("shortdrama_v01_token");
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  await fetch("/api/v1/events", { method: "POST", headers, body: JSON.stringify(payload) });
}

/** 主入口：track("login") / track("generation_submit", { media_kind }) — 调用侧 void 放飞。 */
export function track(event: string, props: Record<string, unknown> = {}): void {
  void sendTelemetry(buildTelemetryPayload(event, props));
}

/** generation_result 专用：终态去重后上报（succeeded/failed/cancelled 各报一次）。 */
export function trackGenerationResult(requestId: string, status: string, props: Record<string, unknown> = {}): void {
  const reported = reportedResults();
  if (!shouldReportResult(requestId, status, reported)) return;
  markResultReported(requestId);
  track("generation_result", { request_id: requestId, status, ...props });
}

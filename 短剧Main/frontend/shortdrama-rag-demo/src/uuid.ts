/* ============================================================
   uuid.ts — 全站唯一 UUID 生成入口（K2 卡 secure-context-uuid）

   病根：crypto.randomUUID() 仅在安全上下文（HTTPS 或 localhost）可用；
   测试站 http://shortdrama-main-test.col.com 是非安全上下文，该 API 为
   undefined，生成图片估价直接抛「crypto.randomUUID is not a function」。
   本地 8080/5173 都是 localhost（安全上下文），所以本地永远复现不了。

   三档降级（前两档同为 CSPRNG、122 bit 熵，强度等价）：
   1. crypto.randomUUID()          —— 原生 v4（安全上下文）
   2. crypto.getRandomValues 手搓 v4 —— 不受安全上下文限制（http 站点可用），
      自置 version=4 / variant=10xx 位；测试站实际走的就是这一档
   3. Math.random 手搓 v4          —— 非加密随机，仅在没有 Web Crypto 的极端
      环境（老 WebView/内嵌浏览器）兜底；幂等键用弱随机源的风险见
      docs/validation/k2-secure-context-uuid.md「幂等键弱随机风险」节

   门禁：src/ 下除本文件外禁止出现裸 crypto.randomUUID / crypto.subtle，
   见 secure-context-guard.test.ts（防复发守卫，比修复本身更重要）。
   ============================================================ */

const HEX = "0123456789abcdef";

/** 16 字节随机数 → RFC 4122 v4 文本（置 version=4 / variant=10xx 位）。 */
function formatV4(bytes: Uint8Array): string {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  let out = "";
  for (let index = 0; index < 16; index += 1) {
    if (index === 4 || index === 6 || index === 8 || index === 10) out += "-";
    const byte = bytes[index]!;
    out += HEX.charAt(byte >> 4) + HEX.charAt(byte & 0x0f);
  }
  return out;
}

/** 生成 RFC 4122 v4 UUID；安全上下文缺失时自动降级（见文件头三档）。 */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
    return formatV4(bytes);
  }
  // 档 3：仅在没有 Web Crypto 的极端环境才会走到（非加密随机源，风险见文件头）
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return formatV4(bytes);
}

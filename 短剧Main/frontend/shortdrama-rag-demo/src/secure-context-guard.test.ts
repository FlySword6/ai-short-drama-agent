/* ============================================================
   secure-context-guard.test.ts — K2 卡 secure-context-uuid 防复发守卫

   病根：crypto.randomUUID 与 crypto.subtle 仅在安全上下文（HTTPS 或
   localhost）可用；测试站 http://shortdrama-main-test.col.com 是非安全
   上下文，这两个 API 为 undefined，裸用即运行时抛 TypeError——而本地
   8080/5173 都是 localhost（安全上下文），裸用在本地永远测不出来。
   （crypto.getRandomValues 不受安全上下文限制，故不在禁列。）

   机制（与 s17-dev-copy-guard 同一手法）：剥掉注释后全量扫描 src/
   （含 .test.ts），除共享工具 uuid.ts（三档降级唯一合法裸用点）与本
   守卫自身（禁词字面量所在）外，命中受限 API 即失败。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** 豁免：共享工具（唯一合法裸用点）+ 本守卫（禁词字面量所在）。 */
const EXEMPT = new Set(["uuid.ts", "secure-context-guard.test.ts"]);

/** 受安全上下文限制的 Web Crypto API（getRandomValues 不受限，故意不禁）。 */
const BANNED = ["crypto.randomUUID", "crypto.subtle"] as const;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "node_modules") yield* walk(path);
    } else if (/\.(tsx|ts)$/.test(entry)) {
      yield path;
    }
  }
}

/** 剥注释（块注释+行注释），只留可执行代码与字符串。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("禁裸用受限 Web Crypto（全量扫描）", () => {
  it("src/ 下除 uuid.ts 与本守卫外零命中 crypto.randomUUID / crypto.subtle", () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (EXEMPT.has(rel)) continue;
      const stripped = stripComments(readFileSync(file, "utf8"));
      for (const token of BANNED) {
        let index = stripped.indexOf(token);
        while (index !== -1) {
          const line = stripped.slice(0, index).split("\n").length;
          violations.push(`${rel}:${line} [${token}] ${stripped.split("\n")[line - 1]!.trim().slice(0, 80)}`);
          index = stripped.indexOf(token, index + token.length);
        }
      }
    }
    assert.deepEqual(violations, [], `裸用受限 Web Crypto：\n${violations.join("\n")}`);
  });

  it("uuid.ts 提供 newId 三档降级；六个原裸调文件全部改走 newId", () => {
    const uuidSource = readFileSync(new URL("./uuid.ts", import.meta.url), "utf8");
    assert.ok(uuidSource.includes("export function newId"), "uuid.ts 缺 newId 导出");
    assert.ok(uuidSource.includes("crypto.randomUUID"), "uuid.ts 缺档 1（原生 randomUUID）");
    assert.ok(uuidSource.includes("crypto.getRandomValues"), "uuid.ts 缺档 2（getRandomValues 手搓 v4）");
    const callers: Array<[file: string, specifier: string]> = [
      ["api.ts", "./uuid"],
      ["app.tsx", "./uuid"],
      ["components/asset-widgets.tsx", "../uuid"],
      ["pages/reference-tests-page.tsx", "../uuid"],
      ["pages/workbench-page.tsx", "../uuid"],
      ["pages/batch-generate-drawer.tsx", "../uuid"],
    ];
    for (const [file, specifier] of callers) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      assert.ok(source.includes(`from "${specifier}"`), `${file} 未引共享 uuid 工具`);
      assert.ok(source.includes("newId("), `${file} 未走 newId()`);
    }
  });
});

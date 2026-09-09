/* shot-ready 单测：标记存取 / 批量读取 / 摘要格式（本地存储适配）。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatReadyMark, loadReadyMark, loadReadyMarks, saveReadyMark } from "./shot-ready";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
  } as unknown as Storage;
}

describe("shot-ready 标记", () => {
  it("标记 → 读取 → 撤销全链路", () => {
    const storage = fakeStorage();
    assert.equal(loadReadyMark(storage, "s1"), null);
    saveReadyMark(storage, "s1", { by: "Alice", at: "2026-07-22T10:03:00.000Z" });
    assert.deepEqual(loadReadyMark(storage, "s1"), { by: "Alice", at: "2026-07-22T10:03:00.000Z" });
    saveReadyMark(storage, "s1", null);
    assert.equal(loadReadyMark(storage, "s1"), null);
  });

  it("批量读取只含已标记；脏数据视为未标记", () => {
    const storage = fakeStorage();
    saveReadyMark(storage, "s1", { by: "Alice", at: "2026-07-22T10:03:00.000Z" });
    storage.setItem("shortdrama_shot_ready_v1:s2", "{bad");
    const marks = loadReadyMarks(storage, ["s1", "s2", "s3"]);
    assert.deepEqual(Object.keys(marks), ["s1"]);
  });

  it("摘要包含标记人；非法日期回退原文", () => {
    assert.ok(formatReadyMark({ by: "Alice", at: "2026-07-22T10:03:00.000Z" }).startsWith("Alice · "));
    assert.equal(formatReadyMark({ by: "Bob", at: "not-a-date" }), "Bob · not-a-date");
  });
});

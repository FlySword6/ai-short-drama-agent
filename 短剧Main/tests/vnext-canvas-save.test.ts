import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDocumentDelta,
  diffDocuments,
  VnextCanvasSync,
  type VnextCanvasView,
  type VnextSaveStatus,
} from "../frontend/shortdrama-rag-demo/src/vnext/canvas-sync.js";
import type {
  VnextGraphDocument,
  VnextGraphNode,
  VnextGraphSnapshot,
} from "../frontend/shortdrama-rag-demo/src/vnext/api.js";

/**
 * vNext 画布保存竞态合同（issue #345 复审 P1-4/P1-5，无 DB、确定性）：
 * - 串行：任何时刻只有一笔 PUT 在飞；飞行期编辑不丢，落地后按新 revision 续发。
 * - 409：本地增量重放到远端最新事实，远端新增与本地拖动/新增都保留。
 * - 网络错误/5xx：未确认成功的编辑保留为 dirty/error，显式 retry() 恢复。
 */

interface FakeSaveCall {
  expectedRevision: number;
  document: VnextGraphDocument;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function node(id: string, x = 0, y = 0): VnextGraphNode {
  return { id, kind: "scene", label: `节点 ${id}`, position: { x, y } };
}

function doc(nodes: VnextGraphNode[], edges: VnextGraphDocument["edges"] = []): VnextGraphDocument {
  return { schema_version: 1, nodes, edges };
}

function snapshot(
  revision: number,
  document: VnextGraphDocument,
  kind: "human" | "agent" = "human",
): VnextGraphSnapshot {
  return {
    project_id: "project-1",
    revision,
    document,
    updated_at: `2026-08-13T00:00:0${revision}Z`,
    last_write: { kind, user_id: "user-1", at: `2026-08-13T00:00:0${revision}Z` },
  };
}

function conflictError() {
  return Object.assign(new Error("画布已被其他写入方更新"), { status: 409, code: "vnext_revision_conflict" });
}

function networkError() {
  return Object.assign(new Error("无法连接 vNext 服务"), { status: 0, code: "network_error" });
}

function serverError() {
  return Object.assign(new Error("vNext 服务内部错误"), { status: 500, code: "internal" });
}

interface Harness {
  sync: VnextCanvasSync;
  saveCalls: FakeSaveCall[];
  statuses: VnextSaveStatus[];
  errors: (string | null)[];
  views: VnextCanvasView[];
  saveQueue: Array<{
    respond: (snap: VnextGraphSnapshot) => void;
    fail: (reason: unknown) => void;
  }>;
  loads: VnextGraphSnapshot[];
  nextLoad: (snap: VnextGraphSnapshot) => void;
}

function createHarness(initial: VnextGraphSnapshot, maxConflictReplays = 3): Harness {
  const saveCalls: FakeSaveCall[] = [];
  const statuses: VnextSaveStatus[] = [];
  const errors: (string | null)[] = [];
  const views: VnextCanvasView[] = [];
  const saveQueue: Harness["saveQueue"] = [];
  const loadQueue: VnextGraphSnapshot[] = [];
  const sync = new VnextCanvasSync({
    loadDocument: async () => {
      const next = loadQueue.shift();
      assert.ok(next, "测试未预备 loadDocument 结果");
      return next;
    },
    saveDocument: (expectedRevision, document) => {
      saveCalls.push({ expectedRevision, document });
      const gate = deferred<VnextGraphSnapshot>();
      saveQueue.push({ respond: gate.resolve, fail: gate.reject });
      return gate.promise;
    },
    isConflict: (error) => (error as { status?: number }).status === 409,
    describeError: (error) => (error as Error).message,
    onView: (view) => views.push(view),
    onStatus: (status) => statuses.push(status),
    onError: (message) => errors.push(message),
    maxConflictReplays,
  });
  loadQueue.push(initial);
  return {
    sync,
    saveCalls,
    statuses,
    errors,
    views,
    saveQueue,
    loads: loadQueue,
    nextLoad: (snap) => loadQueue.push(snap),
  };
}

test("增量 diff/重放：本地删节点丢弃悬空边，远端新增节点保留", () => {
  const base = doc([node("A"), node("B")], [{ id: "e1", source: "A", target: "B" }]);
  const local = doc([node("A", 50, 0)]); // 本地拖 A 并删掉 B
  const delta = diffDocuments(base, local);
  assert.deepEqual(delta.removeNodeIds, ["B"]);
  assert.deepEqual(delta.removeEdgeIds, ["e1"]);

  const remote = doc([node("A"), node("B"), node("D")], [{ id: "e1", source: "A", target: "B" }]);
  const merged = applyDocumentDelta(remote, delta);
  assert.deepEqual(
    merged.nodes.map((n) => [n.id, n.position.x]),
    [
      ["A", 50], // 本地拖动覆盖同 ID 远端版本
      ["D", 0], // 远端新增保留
    ],
  );
  assert.deepEqual(merged.edges, []); // 悬空边随 B 一起丢弃
});

test("串行写入：飞行期只有一笔 PUT，新编辑落地后按新 revision 续发", async () => {
  const base = doc([node("A")]);
  const h = createHarness(snapshot(1, base));
  await h.sync.open();
  assert.equal(h.sync.currentRevision, 1);

  // 第一次编辑：拖动 A。
  const firstEdit = doc([node("A", 10, 0)]);
  h.sync.localChange(firstEdit);
  const flushing = h.sync.flush();
  await tick();
  assert.equal(h.saveCalls.length, 1, "只应发起一笔保存");
  assert.equal(h.saveCalls[0].expectedRevision, 1);

  // 飞行期间再次编辑：再拖 A 并新增 C；不允许并行第二笔 PUT。
  const secondEdit = doc([node("A", 20, 0), node("C", 5, 5)]);
  h.sync.localChange(secondEdit);
  const secondFlush = h.sync.flush();
  await tick();
  assert.equal(h.saveCalls.length, 1, "飞行期不得并行第二笔保存");

  // 第一笔落地后，循环必须拿「最新草稿 + 新 revision」续发，而不是旧快照。
  h.saveQueue[0].respond(snapshot(2, firstEdit));
  await tick();
  await tick();
  assert.equal(h.saveCalls.length, 2, "落地后必须续发飞行期编辑");
  assert.equal(h.saveCalls[1].expectedRevision, 2, "续发必须使用服务端新 revision");
  assert.deepEqual(h.saveCalls[1].document, secondEdit, "续发必须是飞行期最新草稿");

  h.saveQueue[1].respond(snapshot(3, secondEdit));
  await flushing;
  await secondFlush;
  assert.equal(h.statuses.at(-1), "synced");
  assert.equal(h.sync.hasUnsavedChanges(), false);
  assert.equal(h.sync.currentRevision, 3);
});

test("409 冲突：本地增量重放到远端最新事实，远端新增与本地编辑都保留", async () => {
  const base = doc([node("A")]);
  const h = createHarness(snapshot(1, base));
  await h.sync.open();

  // 本地：拖动 A + 新增 C。
  const localEdit = doc([node("A", 100, 0), node("C", 7, 7)]);
  h.sync.localChange(localEdit);
  const flushing = h.sync.flush();
  await tick();
  assert.equal(h.saveCalls[0].expectedRevision, 1);

  // Agent 抢先写入：远端 revision 2 多了节点 B；本地保存被拒 409。
  const remoteFresh = snapshot(2, doc([node("A"), node("B", 1, 1)]));
  h.nextLoad(remoteFresh);
  h.saveQueue[0].fail(conflictError());
  await tick();
  await tick();

  // 重放后必须用 fresh.revision 续发，且合并结果同时含 A 新位置、远端新增 B、本地新增 C。
  assert.equal(h.saveCalls.length, 2, "409 后必须自动续发合并结果");
  assert.equal(h.saveCalls[1].expectedRevision, 2, "续发必须基于 fresh revision");
  const merged = h.saveCalls[1].document;
  assert.deepEqual(
    merged.nodes.map((n) => [n.id, n.position.x]).sort(),
    [
      ["A", 100],
      ["B", 1],
      ["C", 7],
    ],
    "远端新增节点与本地拖动/新增必须同时保留",
  );

  h.saveQueue[1].respond(snapshot(3, merged));
  await flushing;
  assert.equal(h.statuses.at(-1), "synced");
  assert.equal(h.sync.hasUnsavedChanges(), false);
  const finalView = h.views.at(-1);
  assert.ok(finalView);
  assert.deepEqual(finalView.document, merged, "最终视图必须呈现合并后的事实");
});

test("409 重放预算耗尽：保留未确认编辑并落 error，不伪造 synced", async () => {
  const base = doc([node("A")]);
  const h = createHarness(snapshot(1, base), 1);
  await h.sync.open();
  const localEdit = doc([node("A", 30, 0)]);
  h.sync.localChange(localEdit);
  const flushing = h.sync.flush();
  await tick();

  h.nextLoad(snapshot(2, doc([node("A"), node("B")])));
  h.saveQueue[0].fail(conflictError());
  await tick();
  await tick();
  assert.equal(h.saveCalls.length, 2, "第一次重放应自动续发");

  h.nextLoad(snapshot(3, doc([node("A"), node("B"), node("D")])));
  h.saveQueue[1].fail(conflictError());
  await flushing;

  assert.equal(h.statuses.at(-1), "error", "预算耗尽必须落 error");
  assert.equal(h.sync.hasUnsavedChanges(), true, "未确认编辑必须保留");
  assert.ok(h.errors.at(-1)?.includes("合并失败"));
});

test("网络错误：pending 文档不清空，落 error 后显式 retry 恢复且不丢编辑", async () => {
  const base = doc([node("A")]);
  const h = createHarness(snapshot(1, base));
  await h.sync.open();
  const localEdit = doc([node("A", 60, 0), node("C", 3, 3)]);
  h.sync.localChange(localEdit);
  const flushing = h.sync.flush();
  await tick();

  h.saveQueue[0].fail(networkError());
  await flushing;
  assert.equal(h.statuses.at(-1), "error", "网络错误必须落 error 而不是 synced");
  assert.equal(h.sync.hasUnsavedChanges(), true, "未确认成功的编辑必须保留为未保存");
  assert.deepEqual(h.sync.currentDocument, localEdit, "draft 必须原样保留");
  assert.ok(h.errors.at(-1)?.includes("无法连接"));

  // 显式重试：用原 expectedRevision 重新提交同一份草稿。
  const retrying = h.sync.retry();
  await tick();
  assert.equal(h.saveCalls.length, 2, "retry 必须重新发起保存");
  assert.equal(h.saveCalls[1].expectedRevision, 1, "revision 未确认前进，重试仍用旧 expectedRevision");
  assert.deepEqual(h.saveCalls[1].document, localEdit, "重试必须提交保留的草稿");
  h.saveQueue[1].respond(snapshot(2, localEdit));
  await retrying;
  assert.equal(h.statuses.at(-1), "synced");
  assert.equal(h.sync.hasUnsavedChanges(), false);
  assert.equal(h.errors.at(-1), null, "恢复后错误条必须清除");
});

test("5xx：同样保留未确认编辑，retry 后恢复", async () => {
  const base = doc([node("A")]);
  const h = createHarness(snapshot(1, base));
  await h.sync.open();
  const localEdit = doc([node("A", 80, 0)]);
  h.sync.localChange(localEdit);
  const flushing = h.sync.flush();
  await tick();

  h.saveQueue[0].fail(serverError());
  await flushing;
  assert.equal(h.statuses.at(-1), "error");
  assert.equal(h.sync.hasUnsavedChanges(), true);

  const retrying = h.sync.retry();
  await tick();
  h.saveQueue[1].respond(snapshot(2, localEdit));
  await retrying;
  assert.equal(h.statuses.at(-1), "synced");
  assert.equal(h.sync.currentRevision, 2);
});

test("刷新与在途保存串行：旧保存响应不得覆盖刷新读到的新事实", async () => {
  const base = doc([node("A")]);
  const h = createHarness(snapshot(1, base));
  await h.sync.open();
  const localEdit = doc([node("A", 20, 0)]);
  h.sync.localChange(localEdit);
  const flushing = h.sync.flush();
  await tick();

  const agentFact = doc([node("A", 20, 0), node("B", 5, 5)]);
  h.nextLoad(snapshot(3, agentFact, "agent"));
  const refreshing = h.sync.open();
  await tick();
  assert.equal(h.loads.length, 1, "在途保存未落定前不得提前消费刷新结果");

  h.saveQueue[0].respond(snapshot(2, localEdit));
  await flushing;
  await refreshing;

  assert.equal(h.sync.currentRevision, 3);
  assert.deepEqual(h.sync.currentDocument, agentFact, "刷新后的 Agent 事实不得被旧保存响应倒灌");
  assert.equal(h.views.at(-1)?.lastWrite?.kind, "agent");
  assert.equal(h.statuses.at(-1), "synced");
  assert.equal(h.saveCalls.length, 1, "刷新事实不能被误判为本地草稿再次写回");
});

test("Agent 增量刷新：远端新 revision 自动呈现，本地 dirty 编辑仍保留", async () => {
  const base = doc([node("A")]);
  const h = createHarness(snapshot(1, base));
  await h.sync.open();

  const agentFact = doc([node("A"), node("B", 1, 1)]);
  h.nextLoad(snapshot(2, agentFact, "agent"));
  await h.sync.open();
  assert.equal(h.sync.currentRevision, 2);
  assert.deepEqual(h.sync.currentDocument, agentFact);
  assert.equal(h.views.at(-1)?.lastWrite?.kind, "agent", "页面状态必须来自服务端 Agent revision");

  const localEdit = doc([node("A", 99, 0), node("B", 1, 1), node("C", 2, 2)]);
  h.sync.localChange(localEdit);
  const newerAgentFact = doc([node("A"), node("B", 1, 1), node("D", 3, 3)]);
  h.nextLoad(snapshot(3, newerAgentFact, "agent"));
  await h.sync.open();

  assert.equal(h.sync.currentRevision, 3);
  assert.deepEqual(
    h.sync.currentDocument?.nodes.map((item) => [item.id, item.position.x]).sort(),
    [["A", 99], ["B", 1], ["C", 2], ["D", 3]],
    "刷新必须同时保留 Agent 新增与本地未保存增量",
  );
  assert.equal(h.sync.hasUnsavedChanges(), true);
  assert.equal(h.statuses.at(-1), "dirty");
});

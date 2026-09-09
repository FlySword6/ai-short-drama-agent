import type { VnextGraphDocument, VnextGraphEdge, VnextGraphNode, VnextGraphSnapshot, VnextLastWrite } from "./api";

export type VnextSaveStatus = "synced" | "dirty" | "saving" | "error";

export interface VnextCanvasView {
  revision: number;
  document: VnextGraphDocument;
  updatedAt: string;
  lastWrite: VnextLastWrite | null;
}

/** 本地未确认编辑相对服务端已确认事实的增量(按节点/边的稳定 ID 对齐)。 */
export interface VnextDocumentDelta {
  upsertNodes: VnextGraphNode[];
  removeNodeIds: string[];
  upsertEdges: VnextGraphEdge[];
  removeEdgeIds: string[];
}

function sameNode(left: VnextGraphNode, right: VnextGraphNode): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameEdge(left: VnextGraphEdge, right: VnextGraphEdge): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function documentsEqual(left: VnextGraphDocument, right: VnextGraphDocument): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** base=服务端已确认事实, local=本地最新草稿;delta 只含本地新增/改动/删除。 */
export function diffDocuments(base: VnextGraphDocument, local: VnextGraphDocument): VnextDocumentDelta {
  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
  const localNodeIds = new Set(local.nodes.map((node) => node.id));
  const baseEdges = new Map(base.edges.map((edge) => [edge.id, edge]));
  const localEdgeIds = new Set(local.edges.map((edge) => edge.id));
  return {
    upsertNodes: local.nodes.filter((node) => {
      const previous = baseNodes.get(node.id);
      return !previous || !sameNode(previous, node);
    }),
    removeNodeIds: base.nodes.filter((node) => !localNodeIds.has(node.id)).map((node) => node.id),
    upsertEdges: local.edges.filter((edge) => {
      const previous = baseEdges.get(edge.id);
      return !previous || !sameEdge(previous, edge);
    }),
    removeEdgeIds: base.edges.filter((edge) => !localEdgeIds.has(edge.id)).map((edge) => edge.id),
  };
}

/**
 * 把本地增量重放到远端最新事实上:远端新增的节点/边保留,本地拖动/新增/删除
 * 覆盖同 ID 的远端版本;因本地删节点而悬空的边一并丢弃。
 */
export function applyDocumentDelta(remote: VnextGraphDocument, delta: VnextDocumentDelta): VnextGraphDocument {
  const removedNodes = new Set(delta.removeNodeIds);
  const upsertedNodes = new Map(delta.upsertNodes.map((node) => [node.id, node]));
  const nodes: VnextGraphNode[] = [];
  const seen = new Set<string>();
  for (const node of remote.nodes) {
    if (removedNodes.has(node.id)) continue;
    const override = upsertedNodes.get(node.id);
    nodes.push(override ?? node);
    seen.add(node.id);
  }
  for (const node of delta.upsertNodes) {
    if (!seen.has(node.id)) nodes.push(node);
  }
  const nodeIds = new Set(nodes.map((node) => node.id));

  const removedEdges = new Set(delta.removeEdgeIds);
  const upsertedEdges = new Map(delta.upsertEdges.map((edge) => [edge.id, edge]));
  const edges: VnextGraphEdge[] = [];
  const seenEdges = new Set<string>();
  for (const edge of remote.edges) {
    if (removedEdges.has(edge.id)) continue;
    const override = upsertedEdges.get(edge.id);
    const merged = override ?? edge;
    if (nodeIds.has(merged.source) && nodeIds.has(merged.target)) edges.push(merged);
    seenEdges.add(edge.id);
  }
  for (const edge of delta.upsertEdges) {
    if (!seenEdges.has(edge.id) && nodeIds.has(edge.source) && nodeIds.has(edge.target)) edges.push(edge);
  }
  return { schema_version: 1, nodes, edges };
}

export interface VnextCanvasSyncOptions {
  loadDocument: () => Promise<VnextGraphSnapshot>;
  saveDocument: (expectedRevision: number, document: VnextGraphDocument) => Promise<VnextGraphSnapshot>;
  /** 判定 409 修订冲突;其余错误一律按「未确认成功」处理。 */
  isConflict: (error: unknown) => boolean;
  describeError: (error: unknown) => string;
  onView: (view: VnextCanvasView) => void;
  onStatus: (status: VnextSaveStatus) => void;
  /** null 表示清除错误条;非空为可展示给用户的一行中文。 */
  onError: (message: string | null) => void;
  maxConflictReplays?: number;
}

/**
 * 画布保存串行器(issue #345 复审 P1-4/P1-5)。
 *
 * - 任何时刻只有一笔 PUT 在飞;飞行期间的新编辑只改 draft,落地后循环接着发,
 *   绝不拿旧 revision 并行写,也绝不拿旧响应覆盖 draft(只吸收 revision/写入事实)。
 * - 409:重读服务端最新事实,把「本地已确认事实→当前草稿」的增量重放上去
 *   (远端新增与本地拖动/新增都保留),再用新 revision 继续;超过上限才报错。
 * - 网络错误/5xx:未确认成功的编辑一律保留在 draft,状态置 error,只能显式
 *   retry() 或刷新恢复;绝不悄悄清空 pending 再显示「已同步」。
 */
export class VnextCanvasSync {
  private base: { revision: number; document: VnextGraphDocument } | null = null;
  private draft: VnextGraphDocument | null = null;
  private view: { updatedAt: string; lastWrite: VnextLastWrite | null } = { updatedAt: "", lastWrite: null };
  private running: Promise<void> | null = null;
  private opening: Promise<void> | null = null;
  private conflictReplays = 0;
  private failed = false;
  private readonly maxConflictReplays: number;

  constructor(private readonly options: VnextCanvasSyncOptions) {
    this.maxConflictReplays = options.maxConflictReplays ?? 3;
  }

  get currentDocument(): VnextGraphDocument | null {
    return this.draft;
  }

  get currentRevision(): number {
    return this.base?.revision ?? 0;
  }

  hasUnsavedChanges(): boolean {
    return this.draft !== null && this.base !== null && !documentsEqual(this.draft, this.base.document);
  }

  async open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.reload();
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  /** 本地编辑只前进 draft;保存由调用方(防抖后)触发 flush。 */
  localChange(document: VnextGraphDocument): void {
    this.draft = document;
    this.emitView();
    this.options.onStatus("dirty");
  }

  /** 网络/5xx 失败后的显式重试;未确认成功的编辑始终还在 draft 里。 */
  async retry(): Promise<void> {
    this.failed = false;
    this.conflictReplays = 0;
    this.options.onError(null);
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      // open()/后台事实刷新和保存共用一条串行通道。刷新先开始时保存等刷新，
      // 保存先开始时刷新等整批保存，旧保存响应不可能在刷新后回头覆盖新事实。
      if (this.opening) await this.opening;
      do {
        await this.drain();
      } while (!this.failed && this.hasUnsavedChanges());
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async reload(): Promise<void> {
    // 手动/轮询刷新若撞上在途保存，必须先等保存落定；否则旧保存响应可能在
    // fresh 响应之后把 base 倒退，再把刷新读到的文档误判为本地编辑写回去。
    if (this.running) await this.running;
    const previousBase = this.base;
    const previousDraft = this.draft;
    const previousFailed = this.failed;
    const fresh = await this.options.loadDocument();
    const hasPending = previousBase !== null
      && previousDraft !== null
      && !documentsEqual(previousDraft, previousBase.document);
    const remoteChanged = previousBase !== null
      && (fresh.revision !== previousBase.revision || !documentsEqual(fresh.document, previousBase.document));

    this.base = { revision: fresh.revision, document: fresh.document };
    this.draft = hasPending && previousBase && previousDraft
      ? applyDocumentDelta(fresh.document, diffDocuments(previousBase.document, previousDraft))
      : fresh.document;
    this.view = { updatedAt: fresh.updated_at, lastWrite: fresh.last_write };
    this.conflictReplays = 0;
    this.failed = previousFailed && hasPending;
    if (!hasPending) {
      this.failed = false;
      this.options.onError(null);
    } else if (remoteChanged) {
      this.options.onError(
        previousFailed
          ? "已读取最新事实，未保存更改仍保留；请重试保存"
          : "Agent 或其他写入方更新了画布，已在最新修订上保留你的未保存更改",
      );
    }
    this.emitView();
    this.options.onStatus(hasPending ? (this.failed ? "error" : "dirty") : "synced");
  }

  private async drain(): Promise<void> {
    while (!this.failed && this.hasUnsavedChanges()) {
      const base = this.base;
      const attempt = this.draft;
      if (!base || !attempt) return;
      this.options.onStatus("saving");
      try {
        const saved = await this.options.saveDocument(base.revision, attempt);
        this.base = { revision: saved.revision, document: attempt };
        this.view = { updatedAt: saved.updated_at, lastWrite: saved.last_write };
        this.conflictReplays = 0;
        this.options.onError(null);
        this.emitView();
      } catch (reason) {
        if (this.options.isConflict(reason)) {
          const replayed = await this.replayOnFreshFact();
          if (!replayed) return;
          continue;
        }
        // 未确认成功:draft 原样保留,状态落 error,等待显式重试。
        this.failed = true;
        this.options.onStatus("error");
        this.options.onError(this.options.describeError(reason));
        return;
      }
    }
    if (!this.failed) this.options.onStatus(this.hasUnsavedChanges() ? "dirty" : "synced");
  }

  /** 409 之后的合并重放:返回 false 表示重放预算耗尽,进入 error 等人工处理。 */
  private async replayOnFreshFact(): Promise<boolean> {
    this.conflictReplays += 1;
    if (this.conflictReplays > this.maxConflictReplays || !this.base || !this.draft) {
      this.failed = true;
      this.options.onStatus("error");
      this.options.onError("画布持续被其他写入方更新，合并失败；请刷新画布读取最新事实后重试");
      return false;
    }
    let fresh: VnextGraphSnapshot;
    try {
      fresh = await this.options.loadDocument();
    } catch (reason) {
      this.failed = true;
      this.options.onStatus("error");
      this.options.onError(this.options.describeError(reason));
      return false;
    }
    const delta = diffDocuments(this.base.document, this.draft);
    const merged = applyDocumentDelta(fresh.document, delta);
    this.base = { revision: fresh.revision, document: fresh.document };
    this.draft = merged;
    this.view = { updatedAt: fresh.updated_at, lastWrite: fresh.last_write };
    this.emitView();
    this.options.onError("画布被其他写入方更新过，已在最新修订上合并你的修改后继续保存");
    return true;
  }

  private emitView(): void {
    if (!this.base || !this.draft) return;
    this.options.onView({
      revision: this.base.revision,
      document: this.draft,
      updatedAt: this.view.updatedAt,
      lastWrite: this.view.lastWrite,
    });
  }
}

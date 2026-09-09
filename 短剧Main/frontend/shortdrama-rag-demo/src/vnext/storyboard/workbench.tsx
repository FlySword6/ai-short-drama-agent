import { ArrowClockwise, ImageSquare, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { newId } from "../../uuid";
import { storyboardApi, type StoryboardBoard, type StoryboardCell } from "./api";
import "./storyboard.css";

export function StoryboardWorkbench({ projectId, confirmationId }: { projectId: string; confirmationId: string }): React.JSX.Element {
  const [board, setBoard] = useState<StoryboardBoard | null>(null);
  const [selected, setSelected] = useState<StoryboardCell | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef(newId());
  const load = useCallback(async () => {
    setError("");
    try { const state = await storyboardApi.load(projectId, confirmationId); setBoard(state.board); setSelected((current) => state.board?.cells.find((cell) => cell.id === current?.id) ?? state.board?.cells[0] ?? null); }
    catch (reason) { setError(message(reason)); }
  }, [confirmationId, projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setPrompt(selected?.version.prompt ?? ""); }, [selected]);

  async function generate(): Promise<void> {
    setBusy(true); setError("");
    try { const result = await storyboardApi.generate(projectId, confirmationId, key.current); key.current = newId(); setBoard(result.board); setSelected(result.board.cells[0] ?? null); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function redraw(): Promise<void> {
    if (!selected || !prompt.trim()) return;
    setBusy(true); setError("");
    try { const result = await storyboardApi.redraw(projectId, confirmationId, selected.id, prompt.trim(), key.current); key.current = newId(); setBoard(result.board); setSelected(result.board.cells.find((cell) => cell.id === selected.id) ?? null); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  return <section className="storyboard-workbench" aria-label="故事板工作台">
    <header><div><p className="storyboard-eyebrow">IMMUTABLE STORYBOARD</p><h2>镜头故事板</h2><p>每次重绘仅创建所选格的新版本，其他格保留原始媒体哈希。</p></div><Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={busy}><ArrowClockwise size={16} />重新加载</Button></header>
    {error && <p role="alert" className="storyboard-error"><WarningCircle size={18} />{error}</p>}
    {!board ? <div className="storyboard-empty"><ImageSquare size={28} /><p>尚未生成故事板。确认分镜后可创建首个不可变版本。</p><Button type="button" onClick={() => void generate()} disabled={busy}>{busy ? "生成中…" : "生成故事板"}</Button></div> : <div className="storyboard-layout">
      <div className="storyboard-grid" role="list">{board.cells.map((cell) => <button type="button" role="listitem" className={selected?.id === cell.id ? "storyboard-card selected" : "storyboard-card"} key={cell.id} onClick={() => setSelected(cell)}>
        <img src={cell.version.media_url} alt={`镜头 ${cell.position + 1}`} /><span>镜头 {cell.position + 1}</span><small>Cell {cell.id.slice(0, 8)} · v{cell.version.version}</small><small>sha256 {cell.version.media_sha256.slice(0, 12)}…</small>
      </button>)}</div>
      {selected && <aside className="storyboard-inspector"><h3>镜头 {selected.position + 1}</h3><label>重绘提示词<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={busy} /></label><Button type="button" onClick={() => void redraw()} disabled={busy || !prompt.trim()}>{busy ? "重绘中…" : "重绘此格"}</Button><dl><dt>稳定 Cell</dt><dd>{selected.id}</dd><dt>版本 / 媒体</dt><dd>v{selected.version.version} · {selected.version.media_sha256}</dd><dt>供应商</dt><dd>{selected.version.provider} / {selected.version.model}</dd><dt>计费收据</dt><dd>{selected.version.billing_receipt_id}</dd><dt>来源镜头</dt><dd>{selected.shot_id}</dd><dt>当前看板</dt><dd>v{board.version} · {board.source_kind}{board.base_board_id ? ` · 基于 ${board.base_board_id}` : ""}</dd></dl></aside>}
    </div>}
  </section>;
}
function message(reason: unknown): string { return reason instanceof Error ? reason.message : "故事板操作失败，请刷新后重试"; }

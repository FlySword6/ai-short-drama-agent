import { useEffect, useState } from 'react';
import './production.css';

type Project = { id: string; title: string; source: { url: string; title?: string; author?: string; chapterTitle?: string } | null; currentScriptVersionId: string | null; activePlanRevisionId: string | null; activeStoryboardRevisionId: string | null };
type Run = { id: string; status: string; scriptVersionId: string; modelConfig: { model: string } };
type Ref = { quote: string; start: number; end: number };
type Entity = { id: string; name: { value: string }; sourceRefs: Ref[] };
type Plan = { id: string; content: { synopsis: { value: string; sourceRefs: Ref[] } | null;
  characters: Entity[]; locations: Entity[]; props: Entity[];
  scenes: Array<{ id: string; order: number; title: { value: string }; sourceRefs: Ref[] }>;
  dialogues: Array<{ id: string; sceneId: string; speakerId: string | null; sourceRef: Ref }> } };
type Check = { id: string; result: 'passed' | 'failed' };
type Issue = { id: string; code: string; message: string; sourceRefs: Ref[] };
type Storyboard = { id: string; sourcePlanRevisionId: string; shots: Array<{ id: string; sceneId: string; order: number;
  design: { origin: 'designSuggestion'; visualDescription: string; shotSize: string; cameraMovement: string; durationMs: number };
  sourceRefs: Ref[]; dialogueIds: string[] }> };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message ?? `请求失败（${response.status}）`);
  return data as T;
}

export default function ProductionPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [title, setTitle] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [script, setScript] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [allowPaid, setAllowPaid] = useState(false);
  const [allowStoryboardPaid, setAllowStoryboardPaid] = useState(false);
  const [storyboards, setStoryboards] = useState<Storyboard[]>([]);
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  async function refreshProjects(selectedId?: string) {
    const data = await api<{ items: Project[] }>('/api/projects');
    setProjects(data.items);
    const selected = data.items.find(item => item.id === selectedId);
    if (selected) setProject(selected);
    else if (!selectedId && data.items[0]) await chooseProject(data.items[0].id);
  }
  async function chooseProject(id: string) {
    setMessage(''); setRun(null); setPlan(null); setCheck(null); setIssues([]); setStoryboard(null);
    const [selected, versions, history, boards] = await Promise.all([
      api<Project>(`/api/projects/${id}`),
      api<{ items: Array<{ id: string }> }>(`/api/projects/${id}/script-versions`),
      api<{ items: Run[] }>(`/api/projects/${id}/breakdown-runs`),
      api<{ items: Storyboard[] }>(`/api/projects/${id}/storyboards`),
    ]);
    setProject(selected); setRuns(history.items); setRun(history.items[0] ?? null);
    setStoryboards(boards.items); setStoryboard(boards.items[0] ?? null);
    const latest = versions.items[0];
    if (latest) {
      const saved = await api<{ rawText: string }>(`/api/projects/${id}/script-versions/${latest.id}`);
      setScript(saved.rawText);
    } else setScript('');
    const recent = history.items[0];
    if (recent) await loadCandidate(recent.id);
    else if (selected.activePlanRevisionId) setPlan(await api<Plan>(`/api/plan-revisions/${selected.activePlanRevisionId}`));
  }
  async function loadCandidate(runId: string) {
    const candidates = await api<{ items: Plan[] }>(`/api/breakdown-runs/${runId}/candidate-plan-revisions`);
    const current = candidates.items.at(-1) ?? null;
    setPlan(current); setCheck(null); setIssues([]);
    if (current) {
      const checks = await api<{ items: Check[] }>(`/api/plan-revisions/${current.id}/checks`);
      const latest = checks.items[0] ?? null;
      setCheck(latest);
      if (latest) setIssues((await api<{ items: Issue[] }>(`/api/plan-revisions/${current.id}/checks/${latest.id}/issues`)).items);
    }
  }
  useEffect(() => { void refreshProjects().catch(error => setMessage(String(error.message))); }, []);
  async function action(name: string, work: () => Promise<void>) {
    setBusy(name); setMessage('');
    try { await work(); }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失败。'); }
    finally { setBusy(''); }
  }
  function createProject() {
    void action('创建项目', async () => {
      const created = await api<Project>('/api/projects', {
        title: title.trim(),
        ...(sourceUrl.trim() ? { source: { url: sourceUrl.trim() } } : {}),
      });
      setTitle(''); setSourceUrl('');
      await refreshProjects(created.id);
      setScript(''); setRuns([]); setRun(null); setPlan(null); setCheck(null); setIssues([]);
      setStoryboards([]); setStoryboard(null);
      setMessage('项目已创建，请粘贴原文并保存新版本。');
    });
  }
  const active = Boolean(project && plan && project.activePlanRevisionId === plan.id);
  const activeBoard = Boolean(project && storyboard && project.activeStoryboardRevisionId === storyboard.id);
  return <div className="production-page">
    <section className="production-create" aria-labelledby="create-project-title">
      <div><span>NEW PROJECT / 开始创作</span><h1 id="create-project-title">新建项目</h1><p>给故事起名，创建后粘贴原文。来源链接可选，保存为出处，不会自动抓取网页。</p></div>
      <form onSubmit={event => { event.preventDefault(); if (!busy && title.trim()) createProject(); }}>
        <label htmlFor="new-project-title">项目名称</label><input id="new-project-title" aria-label="新项目名称" required maxLength={160} placeholder="例如：诸天万界蹭车系统" value={title} onChange={event => setTitle(event.target.value)} />
        <label htmlFor="new-project-source">来源链接 <small>可选</small></label><input id="new-project-source" aria-label="来源链接" type="url" placeholder="https://…" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} />
        <button className="production-primary" type="submit" disabled={!!busy || !title.trim()}>{busy === '创建项目' ? '正在创建…' : '创建项目'}</button>
      </form>
    </section>
    <header className="production-hero"><span>LOCAL PRODUCTION / 真实项目</span><h1>从剧本到可核对的拆解结果。</h1><p>这里保存到本机 PostgreSQL。原文和 Agent 草稿分开，检查通过后再采用。示例工作区仍保留在左侧导航。</p></header>
    <div className="production-grid"><section className="production-card"><h2>01 · 项目与剧本</h2>
      <div className="production-row"><select aria-label="选择项目" value={project?.id ?? ''} onChange={event => void action('选择项目', () => chooseProject(event.target.value))}><option value="">选择已有项目</option>{projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
      {project?.source && <p className="production-source">来源：<a href={project.source.url} target="_blank" rel="noreferrer">{project.source.chapterTitle ?? project.source.title ?? project.source.url}</a>{project.source.author && ` · ${project.source.author}`}</p>}
      <label className="production-label" htmlFor="production-script">创作原文（小说或剧本）</label><textarea id="production-script" value={script} onChange={event => setScript(event.target.value)} placeholder="粘贴一章小说或一集中文剧本。每次保存会创建新版本，已有版本不会被覆盖。" />
      <div className="production-actions"><button disabled={!!busy || !project || !script.trim()} onClick={() => void action('保存剧本', async () => { await api(`/api/projects/${project!.id}/script-versions`, { rawText: script }); await refreshProjects(project!.id); setRun(null); setPlan(null); setCheck(null); setIssues([]); setStoryboard(null); setStoryboards([]); setMessage('已保存新的剧本版本；请创建新的 Run 并重新拆解。'); })}>保存新版本</button><small>{project?.currentScriptVersionId ? '已有剧本版本' : '请先创建项目并保存剧本'}</small></div>
    </section><section className="production-card"><h2>02 · 拆解运行</h2><p>保存后创建一个 Run。执行时调用所配置的模型代理，可能产生费用；同一次 Run 不自动重试。</p>
      <div className="production-actions"><button disabled={!!busy || !project?.currentScriptVersionId} onClick={() => void action('创建 Run', async () => { const created = await api<Run>(`/api/projects/${project!.id}/breakdown-runs`, { maxModelCalls: 1, maxOutputTokens: 8192, requirements: { language: '中文' } }); setRun(created); setRuns([created, ...runs]); setPlan(null); setCheck(null); setIssues([]); setMessage('Run 已创建，尚未调用模型。'); })}>创建拆解 Run</button></div>
      {runs.length > 0 && <select aria-label="选择运行记录" value={run?.id ?? ''} onChange={event => void action('选择 Run', async () => { const chosen = runs.find(item => item.id === event.target.value) ?? null; setRun(chosen); if (chosen) await loadCandidate(chosen.id); })}><option value="">选择历史 Run</option>{runs.map(item => <option key={item.id} value={item.id}>{item.id.slice(0, 15)} · {item.status}</option>)}</select>}
      {run && <div className="production-run"><span>状态：{run.status}</span><span>模型：{run.modelConfig.model}</span></div>}
      <label className="production-consent"><input type="checkbox" checked={allowPaid} onChange={event => setAllowPaid(event.target.checked)} />我确认此次调用模型，可能产生费用</label>
      <button className="production-primary" disabled={!!busy || !run || run.status !== 'draft' || run.scriptVersionId !== project?.currentScriptVersionId || !allowPaid} onClick={() => void action('运行拆解', async () => { const result = await api<{ plan: Plan }>(`/api/breakdown-runs/${run!.id}/execute`, { allowPaid: true }); setPlan(result.plan); setRun(await api<Run>(`/api/breakdown-runs/${run!.id}`)); setAllowPaid(false); setCheck(null); setIssues([]); setMessage('已生成候选拆解，请运行程序校验。'); })}>{busy === '运行拆解' ? '正在拆解…' : '运行事实拆解 Agent'}</button>
    </section></div>
    {message && <p className="production-message" role="status">{message}</p>}
    {plan && <section className="production-card production-result"><div className="production-result-head"><div><span>03 · 候选结果</span><h2>{active ? '已采用的拆解' : '待核对的拆解'}</h2></div><div className="production-actions"><button disabled={!!busy} onClick={() => void action('程序校验', async () => { const result = await api<{ check: Check; issues: Issue[] }>(`/api/plan-revisions/${plan.id}/checks`, {}); setCheck(result.check); setIssues(result.issues); setMessage(result.check.result === 'passed' ? '程序校验通过。请人工核对语义后采用。' : '发现阻断问题，请修正后重新运行。'); })}>运行程序校验</button><button className="production-primary" disabled={!!busy || active || check?.result !== 'passed'} onClick={() => void action('采用', async () => { await api(`/api/projects/${project!.id}/adoptions`, { planRevisionId: plan.id, checkId: check!.id, expectedActivePlanRevisionId: project!.activePlanRevisionId }); await refreshProjects(project!.id); setMessage('已采用这版事实拆解。'); })}>采用结果</button></div></div>
      <div className="production-status">程序校验：{check ? (check.result === 'passed' ? '通过' : `未通过 · ${issues.length} 项`) : '未运行'} · 人工需核对剧情语义与镜头建议</div>
      {issues.length > 0 && <div className="production-issues"><h3>待处理问题</h3>{issues.map(issue => <div key={issue.id}><strong>{issue.message}</strong><small>{issue.code}</small>{issue.sourceRefs.map((ref, i) => <blockquote key={i}>{ref.quote}</blockquote>)}</div>)}</div>}
      <div className="production-facts"><article><h3>梗概</h3><p>{plan.content.synopsis?.value ?? '未提取'}</p>{plan.content.synopsis?.sourceRefs.map((ref, i) => <small key={i}>原文：「{ref.quote}」</small>)}</article><article><h3>人物 / 场景 / 道具</h3><p>人物：{plan.content.characters.map(item => item.name.value).join('、') || '无'}</p><p>地点：{plan.content.locations.map(item => item.name.value).join('、') || '无'}</p><p>道具：{plan.content.props.map(item => item.name.value).join('、') || '无'}</p></article></div>
      <h3 className="production-scenes-title">场次与原文引用</h3>{plan.content.scenes.map(scene => <article className="production-scene" key={scene.id}><div><strong>{String(scene.order).padStart(2, '0')} · {scene.title.value}</strong><small>{scene.sourceRefs.length} 段原文</small></div>{plan.content.dialogues.filter(line => line.sceneId === scene.id).map(line => <blockquote key={line.id}><b>{plan.content.characters.find(item => item.id === line.speakerId)?.name.value ?? '待确认人物'}：</b>{line.sourceRef.quote}</blockquote>)}</article>)}
    </section>}
    {project?.activePlanRevisionId && <section className="production-card production-result">
      <div className="production-result-head"><div><span>04 · 分镜设计</span><h2>一行一个连续镜头</h2></div>
        <button className="production-primary" disabled={!!busy || !allowStoryboardPaid} onClick={() => void action('生成分镜', async () => {
          const generated = await api<Storyboard>(`/api/projects/${project.id}/storyboards`, { allowPaid: true });
          setStoryboard(generated); setStoryboards([generated, ...storyboards]); setAllowStoryboardPaid(false);
          setMessage('候选分镜已生成。程序核验了场次、原文引用和对白覆盖；请核对画面设计。');
        })}>{busy === '生成分镜' ? '正在生成…' : '生成候选分镜'}</button></div>
      <label className="production-consent"><input type="checkbox" checked={allowStoryboardPaid} onChange={event => setAllowStoryboardPaid(event.target.checked)} />我确认此次分镜生成调用模型，可能产生费用</label>
      {storyboards.length > 0 && <select aria-label="选择分镜版本" value={storyboard?.id ?? ''} onChange={event => setStoryboard(storyboards.find(item => item.id === event.target.value) ?? null)}>{storyboards.map(item => <option key={item.id} value={item.id}>{item.id.slice(0, 18)}{project.activeStoryboardRevisionId === item.id ? ' · 已采用' : ' · 候选'}</option>)}</select>}
      {storyboard && <><div className="production-status">{activeBoard ? '已采用' : '候选版本'} · {storyboard.shots.length} 个连续镜头 · 景别、运镜与画面描述是 AI 建议</div>
        <div className="production-shot-list">{storyboard.shots.map(shot => <article key={shot.id}><div><strong>场次 {shot.sceneId.slice(0, 12)} · 镜头 {shot.order}</strong><span>AI 设计建议</span></div><p>{shot.design.visualDescription}</p><small>{shot.design.shotSize} · {shot.design.cameraMovement} · {(shot.design.durationMs / 1000).toFixed(1)} 秒</small><blockquote>原文：{shot.sourceRefs.map(ref => ref.quote).join(' / ')}</blockquote></article>)}</div>
        <div className="production-actions"><button className="production-primary" disabled={!!busy || activeBoard || storyboard.sourcePlanRevisionId !== project.activePlanRevisionId} onClick={() => void action('采用分镜', async () => {
          await api(`/api/projects/${project.id}/storyboards/${storyboard.id}/adoptions`, { expectedActiveStoryboardRevisionId: project.activeStoryboardRevisionId });
          await refreshProjects(project.id); setMessage('已采用这版分镜。');
        })}>核对后采用分镜</button></div></>}
    </section>}
  </div>;
}

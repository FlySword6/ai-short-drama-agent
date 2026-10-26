import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, ArrowUpRight, Boxes, Check, ChevronDown, ChevronRight, CircleDot, Clock3, Film,
  Gauge, Inbox, Layers3, LoaderCircle, MoreHorizontal, Pause, Play, RefreshCw, RotateCcw,
  Settings2, ShieldCheck, Sparkles, WalletCards, WandSparkles,
} from 'lucide-react';
import {
  defaultProductionForm, mergeProductionRuns, money, parseProductionRun, parseProductionRuns, parseProjectOptions,
  parseScriptVersionOptions, productionApi, ProductionApiError, productionCreateBody, productionRunActive, productionTaskCanRetry, runTitle, taskShotId,
  validateProductionForm, type ProductionCandidate, type ProductionForm, type ProductionIssue, type ProductionRun,
  type ProductionTask, type ProjectOption, type ScriptVersionOption,
} from './production-automation';
import './production-automation.css';

const pendingKey = 'ohao:production-run-pending:v1';
const createStages = ['剧本拆解', '资产准备', '分镜设计', '3D 预演', '镜头生产包', '视频抽卡', '自动技术复核', '成片时间线合成', '最终出片'];
const runLabels: Record<string, string> = { queued: '准备中', running: '制作中', waitingHuman: '等待处理', paused: '已暂停', pausedBudget: '预算已暂停', reconciling: '正在对账', completed: '已完成', partial: '部分完成', failed: '未完成', cancelled: '已取消' };
const taskLabels: Record<string, string> = { pending: '等待', ready: '就绪', running: '进行中', waitingExternal: '等待模型', validating: '校验中', retryWait: '等待重试', reconciling: '正在对账', waitingHuman: '待处理', succeeded: '完成', failed: '失败', skipped: '按需跳过', cancelled: '已取消', invalidated: '已失效', superseded: '已替代', needsAttention: '需处理' };
const stageAliases = {
  assets: ['asset'], storyboard: ['storyboard'], director: ['director', 'previs', '3d'],
  video: ['video', 'generation'], candidates: ['candidate', 'selection'], review: ['review', 'quality', 'qc'],
};
type MatrixColumn = keyof typeof stageAliases;
const matrixColumns: Array<{ key: MatrixColumn; label: string }> = [
  { key: 'assets', label: '资产' }, { key: 'storyboard', label: '分镜' }, { key: 'director', label: '3D' },
  { key: 'video', label: '视频' }, { key: 'candidates', label: '候选' }, { key: 'review', label: '镜头技术复核' },
];

function errorText(error: unknown) { return error instanceof Error && error.name !== 'AbortError' ? error.message : '本地后端连接超时，请稍后重试。'; }
function pendingFromSession() {
  try { const value: unknown = JSON.parse(sessionStorage.getItem(pendingKey) || 'null'); return value && typeof value === 'object' && typeof (value as { clientRequestId?: unknown }).clientRequestId === 'string' ? (value as { clientRequestId: string }).clientRequestId : ''; }
  catch { return ''; }
}
function dateText(value: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未记录';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function statusIcon(status: string, size = 14) {
  if (['completed', 'succeeded'].includes(status)) return <Check size={size} />;
  if (['running', 'waitingExternal', 'validating', 'retryWait', 'reconciling'].includes(status)) return <LoaderCircle size={size} className="pa-spin" />;
  if (['waitingHuman', 'failed', 'needsAttention'].includes(status)) return <AlertCircle size={size} />;
  if (status === 'skipped') return <MoreHorizontal size={size} />;
  return <CircleDot size={size} />;
}
function stageMatches(task: ProductionTask, column: MatrixColumn) {
  const stage = task.stage.toLowerCase(); return stageAliases[column].some(alias => stage.includes(alias));
}
function shotRows(run: ProductionRun) {
  const byId = new Map<string, { id: string; scene: string; label: string; tasks: ProductionTask[] }>();
  for (const task of run.tasks) {
    const shotId = taskShotId(task); if (!shotId) continue;
    const previous = byId.get(shotId); const scene = typeof task.inputManifest.find(item => item.kind === 'scene')?.id === 'string' ? task.inputManifest.find(item => item.kind === 'scene')!.id : '按镜头';
    if (previous) previous.tasks.push(task); else byId.set(shotId, { id: shotId, scene, label: shotId, tasks: [task] });
  }
  return [...byId.values()].sort((a, b) => `${a.scene}/${a.id}`.localeCompare(`${b.scene}/${b.id}`, 'zh-CN'));
}
function taskForColumn(tasks: ProductionTask[], column: MatrixColumn) { return tasks.find(task => stageMatches(task, column)); }
function selectedCandidate(run: ProductionRun, taskId: string) { return run.candidateSets.find(set => set.taskId === taskId) ?? null; }

function CreatePanel({ form, projects, versions, loading, consent, onConsent, onChange, onProject, onSubmit }:
  { form: ProductionForm; projects: ProjectOption[]; versions: ScriptVersionOption[]; loading: boolean; consent: boolean;
    onConsent: (value: boolean) => void; onChange: (patch: Partial<ProductionForm>) => void; onProject: (id: string) => void; onSubmit: () => void }) {
  const error = validateProductionForm(form);
  return <div className="pa-create-layout">
    <section className="pa-create-card" aria-labelledby="pa-create-title">
      <div className="pa-card-head"><div><span>NEW PRODUCTION</span><h2 id="pa-create-title">创建一次完整制作</h2></div><WandSparkles size={20} /></div>
      <p className="pa-card-intro">选择已经保存的剧本，Story Studio 会建立可恢复的生产任务；模型未接入的环节会明确停下，不会伪造完成。</p>
      <div className="pa-form-grid">
        <label className="pa-wide"><span>项目</span><select aria-label="自动制作项目" value={form.projectId} disabled={loading} onChange={event => onProject(event.target.value)}><option value="">选择已有剧本项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
        <label className="pa-wide"><span>剧本版本</span><select aria-label="自动制作剧本版本" value={form.scriptVersionId} disabled={loading || !form.projectId} onChange={event => onChange({ scriptVersionId: event.target.value })}><option value="">{form.projectId ? '选择剧本版本' : '请先选择项目'}</option>{versions.map(version => <option key={version.id} value={version.id}>版本 {version.version}{version.id === projects.find(project => project.id === form.projectId)?.currentScriptVersionId ? ' · 当前' : ''}</option>)}</select></label>
        <label><span>画面比例</span><select aria-label="整集画面比例" value={form.ratio} onChange={event => onChange({ ratio: event.target.value as ProductionForm['ratio'] })}><option>9:16</option><option>16:9</option></select></label>
        <label><span>目标时长</span><select aria-label="整集目标时长" value={form.targetDurationSec} onChange={event => onChange({ targetDurationSec: Number(event.target.value) })}><option value={60}>约 1 分钟</option><option value={90}>约 1.5 分钟</option><option value={120}>约 2 分钟</option><option value={180}>约 3 分钟</option></select></label>
        <label className="pa-wide"><span>视觉风格</span><textarea aria-label="自动制作视觉风格" maxLength={500} value={form.visualStyle} onChange={event => onChange({ visualStyle: event.target.value })} /></label>
        <label><span>生产策略</span><select aria-label="生产策略" value={form.qualityPreset} onChange={event => onChange({ qualityPreset: event.target.value as ProductionForm['qualityPreset'] })}><option value="fast">快速试片</option><option value="balanced">均衡制作</option><option value="quality">高质量</option></select></label>
        <label><span>自动化模式</span><select aria-label="自动化模式" value={form.automationMode} onChange={event => onChange({ automationMode: event.target.value as ProductionForm['automationMode'] })}><option value="auto">全自动</option><option value="checkpoints">关键节点确认</option><option value="coDirector">共同导演</option></select></label>
        <label><span>每镜候选</span><select aria-label="每镜候选数量" value={form.candidateLimit} onChange={event => onChange({ candidateLimit: Number(event.target.value) })}>{[1, 2, 3, 4].map(value => <option value={value} key={value}>{value} 个</option>)}</select></label>
        <label><span>3D 预演</span><select aria-label="3D 预演策略" value={form.directorPolicy} onChange={event => onChange({ directorPolicy: event.target.value as ProductionForm['directorPolicy'] })}><option value="auto">按需判断</option><option value="always">全部预演</option><option value="never">暂不使用</option></select></label>
        <label className="pa-wide"><span>整次预算上限</span><div className="pa-money-input"><b>¥</b><input aria-label="整次预算上限" type="number" min="0" max="1000000" step="1" value={form.budgetYuan} onChange={event => onChange({ budgetYuan: Number(event.target.value) })} /><small>候选与返修共用此上限</small></div></label>
      </div>
      <label className="pa-consent"><input type="checkbox" checked={consent} onChange={event => onConsent(event.target.checked)} /><span>授权本次运行在 ¥{form.budgetYuan.toFixed(0)} 上限内调用已配置的模型和媒体服务，可能产生费用；达到上限或遇到未知提交会暂停。</span></label>
      <button className="pa-primary" disabled={loading || !consent || Boolean(error)} onClick={onSubmit}>{loading ? <LoaderCircle size={16} className="pa-spin" /> : <Sparkles size={16} />}{loading ? '正在创建运行…' : '开始自动制作'}</button>
      {error && <p className="pa-field-error">{error}</p>}
    </section>
    <section className="pa-preview-card" aria-labelledby="pa-preview-title">
      <div className="pa-card-head"><div><span>PRODUCTION PLAN</span><h2 id="pa-preview-title">一条可接管的制作链</h2></div><Layers3 size={20} /></div>
      <ol className="pa-create-stages">{createStages.map((label, index) => <li key={label}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{label}</strong><p>{index === 3 ? '复杂镜头按策略进入；普通镜头可跳过' : index === 5 ? `每镜最多 ${form.candidateLimit} 个候选` : index === 8 ? '完成本地技术校验后形成可交付成片' : '创建后由真实任务状态驱动'}</p></div></li>)}</ol>
      <div className="pa-preview-note"><ShieldCheck size={17} /><p>剧本版本、策略和预算会在运行创建时冻结。局部失败只暂停相关依赖，可从具体节点继续。</p></div>
    </section>
  </div>;
}

function InboxPanel({ run, busy, onSelect, onResolve, onRetry }: { run: ProductionRun; busy: string; onSelect: (taskId: string) => void; onResolve: (issue: ProductionIssue) => void; onRetry: (task: ProductionTask) => void }) {
  const issues = run.issues.filter(issue => issue.status === 'open');
  if (!issues.length) return null;
  return <section className="pa-inbox" aria-labelledby="pa-inbox-title"><div className="pa-inbox-title"><span><Inbox size={17} /></span><div><h2 id="pa-inbox-title">需要你处理</h2><p>{issues.length} 项决定正在等待</p></div></div><div className="pa-inbox-items">{issues.map(issue => {
    const task = run.tasks.find(item => item.id === issue.taskId);
    const location = issue.scope.kind === 'episode' ? '整集' : `${issue.scope.kind === 'scene' ? '场次' : issue.scope.kind === 'shot' ? '镜头' : '资产'} ${issue.scope.id ?? ''}`;
    const candidateDecision = issue.code === 'CANDIDATE_SELECTION_REQUIRED';
    const checkpoint = issue.code === 'CHECKPOINT_REVIEW_REQUIRED';
    return <article key={issue.id}><button className="pa-inbox-copy" onClick={() => { if (issue.taskId) onSelect(issue.taskId); }}><small>{location}</small><strong>{issue.title}</strong><p>{issue.message}</p>{issue.impact.length > 0 && <span>影响：{issue.impact.join('、')}</span>}</button><div className="pa-inbox-actions">{checkpoint && <button disabled={Boolean(busy) || !issue.taskId} onClick={() => onResolve(issue)}>确认并继续</button>}{task && task.status === 'failed' && productionTaskCanRetry(task) && <button disabled={Boolean(busy)} onClick={() => onRetry(task)}><RotateCcw size={12} />重试节点</button>}{issue.taskId && <button onClick={() => onSelect(issue.taskId!)}>{candidateDecision ? '选择候选' : '查看详情'}<ChevronRight size={12} /></button>}</div></article>;
  })}</div></section>;
}

function StageTrack({ run, onStage }: { run: ProductionRun; onStage: (key: string) => void }) {
  return <section className="pa-stage-track" aria-label="制作阶段轨道">{run.stages.map((stage, index) => <button key={stage.key} className={`pa-stage pa-stage-${stage.state}`} onClick={() => onStage(stage.key)}><span className="pa-stage-index">{stage.state === 'succeeded' ? <Check size={13} /> : String(index + 1).padStart(2, '0')}</span><div><strong>{stage.label}</strong><small>{stage.total > 0 ? `${Math.min(stage.completed, stage.total)} / ${stage.total}` : stage.state === 'skipped' ? '按需跳过' : taskLabels[stage.state] || stage.state}</small></div>{stage.needsAttention > 0 && <b>{stage.needsAttention}</b>}</button>)}</section>;
}

function CandidateList({ run, task, busy, onReview }: { run: ProductionRun; task: ProductionTask; busy: string; onReview: (decision: string, candidate?: ProductionCandidate) => void }) {
  const set = selectedCandidate(run, task.id); if (!set) return null;
  return <div className="pa-candidates"><h3>{set.kind}候选</h3>{set.candidates.map(candidate => { const artifact = run.artifacts.find(item => item.id === candidate.artifactId); const preview = candidate.previewUrl || artifact?.url; return <article key={candidate.id} className={set.selectedCandidateId === candidate.id ? 'selected' : ''}><div className="pa-candidate-top"><span><Film size={14} />{candidate.label}</span><small>{set.selectedCandidateId === candidate.id ? '已采用' : candidate.status}</small></div>{candidate.summary && <p>{candidate.summary}</p>}<div className="pa-candidate-actions">{preview && <a href={preview} target="_blank" rel="noopener noreferrer">打开预览<ArrowUpRight size={12} /></a>}<button disabled={Boolean(busy) || Boolean(set.selectedCandidateId)} onClick={() => onReview('selectCandidate', candidate)}>采用</button></div></article>; })}</div>;
}

function TaskDetail({ run, task, busy, onRetry, onReview }: { run: ProductionRun; task: ProductionTask | null; busy: string; onRetry: (task: ProductionTask) => void; onReview: (task: ProductionTask, decision: string, candidate?: ProductionCandidate) => void }) {
  if (!task) return <aside className="pa-detail pa-detail-empty"><Boxes size={27} /><h2>选择一个制作节点</h2><p>点击镜头矩阵里的状态，查看输入、候选、复核结果和可以执行的操作。</p></aside>;
  const checks = run.qualityChecks.filter(check => check.taskId === task.id);
  const candidateSet = selectedCandidate(run, task.id);
  const checkpointRequired = run.issues.some(issue => issue.taskId === task.id && issue.status === 'open' && issue.code === 'CHECKPOINT_REVIEW_REQUIRED');
  const canRetry = productionTaskCanRetry(task);
  return <aside className="pa-detail"><div className="pa-detail-head"><div><span>{task.scope.kind === 'episode' ? '整集制作节点' : `${task.scope.kind} · ${task.scope.id}`}</span><h2>{task.label}</h2></div><i className={`pa-task-state pa-task-${task.status}`}>{statusIcon(task.status)}{taskLabels[task.status] || task.status}</i></div>
    {task.blockingReason && <div className="pa-block-reason"><AlertCircle size={15} /><p>{task.blockingReason.message}</p></div>}
    <dl className="pa-detail-meta"><div><dt>阶段</dt><dd>{run.stages.find(stage => stage.key === task.stage)?.label || task.stage}</dd></div><div><dt>尝试</dt><dd>{task.attemptCount} / {task.maxAttempts} 次</dd></div><div><dt>更新时间</dt><dd>{dateText(task.updatedAt)}</dd></div><div><dt>依赖</dt><dd>{task.dependencies.length ? `${task.dependencies.length} 个节点` : '无'}</dd></div></dl>
    {checks.length > 0 && <div className="pa-quality"><h3>镜头技术复核</h3>{checks.map(check => <div key={check.id} className={`pa-quality-${check.result}`}>{check.result === 'pass' ? <Check size={13} /> : <AlertCircle size={13} />}<span><strong>{check.label}</strong>{check.issues.length > 0 && <small>{check.issues.join('；')}</small>}</span></div>)}</div>}
    <CandidateList run={run} task={task} busy={busy} onReview={(decision, candidate) => onReview(task, decision, candidate)} />
    <div className="pa-detail-actions">{canRetry && <button disabled={Boolean(busy)} onClick={() => onRetry(task)}><RotateCcw size={13} />{candidateSet ? '整组重做' : '局部重试'}</button>}{checkpointRequired && <button className="primary" disabled={Boolean(busy)} onClick={() => onReview(task, 'approve')}><Check size={13} />确认并继续</button>}</div>
    <details><summary>高级信息<ChevronDown size={13} /></summary><pre>{JSON.stringify({ taskId: task.id, status: task.status, version: task.version, inputManifest: task.inputManifest }, null, 2)}</pre></details>
  </aside>;
}

function RunDashboard({ run, runs, projects, selectedTaskId, busy, onRun, onTask, onAction, onResolve, onRetry, onReview }:
  { run: ProductionRun; runs: ProductionRun[]; projects: ProjectOption[]; selectedTaskId: string; busy: string; onRun: (id: string) => void; onTask: (id: string) => void;
    onAction: (type: 'pause' | 'resume') => void; onResolve: (issue: ProductionIssue) => void; onRetry: (task: ProductionTask) => void;
    onReview: (task: ProductionTask, decision: string, candidate?: ProductionCandidate) => void }) {
  const rows = shotRows(run); const task = run.tasks.find(item => item.id === selectedTaskId) ?? null;
  const budget = run.summary.budget; const used = budget.spentMicros + budget.reservedMicros;
  return <div className="pa-dashboard">
    <header className="pa-run-head"><div><div className="pa-run-kicker"><span className={`pa-live pa-live-${run.status}`} />{runLabels[run.status] || run.status}<span>·</span><span>{run.ratio || '画幅已冻结'}</span></div><h1>{runTitle(run, projects)}</h1><p>整集自动制作 · 剧本版本 {run.scriptVersionId.slice(-8)}</p></div><div className="pa-run-controls"><label><span className="pa-sr-only">选择制作运行</span><select value={run.id} onChange={event => onRun(event.target.value)}>{runs.map(item => <option key={item.id} value={item.id}>{runTitle(item, projects)} · {dateText(item.createdAt)}</option>)}</select></label>{['paused', 'pausedBudget'].includes(run.status) ? <button disabled={Boolean(busy) || run.status === 'pausedBudget'} onClick={() => onAction('resume')}><Play size={14} />继续</button> : productionRunActive(run) && <button disabled={Boolean(busy)} onClick={() => onAction('pause')}><Pause size={14} />暂停</button>}</div></header>
    <section className="pa-run-stats"><div><Film size={16} /><span><strong>{run.summary.shots.completed} / {run.summary.shots.total}</strong><small>镜头完成</small></span></div><div><Gauge size={16} /><span><strong>{run.summary.tasks.running}</strong><small>正在执行</small></span></div><div><Inbox size={16} /><span><strong>{run.summary.tasks.waitingHuman}</strong><small>等待决定</small></span></div><div><WalletCards size={16} /><span><strong>{money(used, budget.currency)}</strong><small>已用与预留 / {money(budget.limitMicros, budget.currency)}</small></span></div></section>
    <InboxPanel run={run} busy={busy} onSelect={onTask} onResolve={onResolve} onRetry={onRetry} />
    <StageTrack run={run} onStage={key => { const match = run.tasks.find(item => item.stage === key); if (match) onTask(match.id); }} />
    <div className="pa-workspace"><section className="pa-matrix-card"><div className="pa-section-head"><div><span>SHOT MATRIX</span><h2>镜头生产矩阵</h2></div><small>{rows.length ? `${rows.length} 个镜头` : '等待分镜展开'}</small></div>{rows.length ? <div className="pa-matrix-scroll"><table className="pa-matrix"><thead><tr><th>镜头</th>{matrixColumns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}><th><small>{row.scene}</small><strong>{row.label}</strong></th>{matrixColumns.map(column => { const cell = taskForColumn(row.tasks, column.key); return <td key={column.key}>{cell ? <button aria-label={`${row.label} ${column.label} ${taskLabels[cell.status] || cell.status}`} className={`pa-cell pa-cell-${cell.status} ${selectedTaskId === cell.id ? 'active' : ''}`} onClick={() => onTask(cell.id)}>{statusIcon(cell.status)}<span>{taskLabels[cell.status] || cell.status}</span></button> : <span className="pa-cell-empty">—</span>}</td>; })}</tr>)}</tbody></table></div> : <div className="pa-matrix-empty"><LoaderCircle size={22} className={run.status === 'running' ? 'pa-spin' : ''} /><h3>镜头任务尚未展开</h3><p>完成剧本拆解与分镜设计后，这里会按真实场次和镜头显示节点。</p></div>}</section><TaskDetail run={run} task={task} busy={busy} onRetry={onRetry} onReview={onReview} /></div>
    <div className="pa-bottom-grid"><section className="pa-timeline"><div className="pa-section-head"><div><span>ACTIVITY</span><h2>运行记录</h2></div><Clock3 size={16} /></div>{run.timeline.length ? <ol>{run.timeline.slice(0, 10).map(item => <li key={item.id}><i /><div><strong>{item.message}</strong><small>{dateText(item.createdAt)}</small></div></li>)}</ol> : <p className="pa-empty-copy">运行建立后，真实状态变化和人工决定会记录在这里。</p>}</section><section className="pa-delivery"><div className="pa-section-head"><div><span>DELIVERY</span><h2>最终交付</h2></div><Film size={16} /></div>{run.delivery?.status === 'ready' && run.delivery.videoUrl ? <><p>{run.delivery.message || '整集已通过本地技术校验，可以打开最终成片。'}</p><a href={run.delivery.videoUrl} target="_blank" rel="noopener noreferrer">打开最终成片<ArrowUpRight size={14} /></a></> : <><p>{run.delivery?.message || '镜头选择、镜头技术复核与成片时间线合成完成后，成片会出现在这里。'}</p><span className="pa-delivery-wait">{run.delivery?.status || '等待上游完成'}</span></>}</section></div>
  </div>;
}

export default function ProductionAutomationPage({ onUnsavedChange }: { onUnsavedChange?: (dirty: boolean) => void }) {
  const [form, setForm] = useState<ProductionForm>({ ...defaultProductionForm });
  const [projects, setProjects] = useState<ProjectOption[]>([]); const [versions, setVersions] = useState<ScriptVersionOption[]>([]);
  const [runs, setRuns] = useState<ProductionRun[]>([]); const [selectedRunId, setSelectedRunId] = useState(''); const [selectedTaskId, setSelectedTaskId] = useState('');
  const [consent, setConsent] = useState(false); const [dirty, setDirty] = useState(false); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [loadError, setLoadError] = useState(''); const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const [pendingClientId, setPendingClientId] = useState(pendingFromSession);
  const mutation = useRef(false); const controllerRef = useRef<AbortController | null>(null);
  const explicitRejection = useRef(false);
  const run = creating ? null : runs.find(item => item.id === selectedRunId) ?? runs[0] ?? null;
  const isCreate = creating || !run;

  const currentProject = useMemo(() => projects.find(project => project.id === form.projectId) ?? null, [projects, form.projectId]);
  useEffect(() => { onUnsavedChange?.(isCreate && dirty); return () => onUnsavedChange?.(false); }, [dirty, isCreate, onUnsavedChange]);
  useEffect(() => { if (!isCreate || !dirty) return; const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave); }, [dirty, isCreate]);

  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined; let controller: AbortController | undefined;
    async function poll() {
      controller = new AbortController(); const timeout = setTimeout(() => controller?.abort(), 12000);
      const [projectResult, runResult] = await Promise.allSettled([
        productionApi('/api/projects', undefined, controller.signal).then(parseProjectOptions),
        productionApi('/api/production-runs', undefined, controller.signal).then(parseProductionRuns),
      ]); clearTimeout(timeout); if (disposed) return;
      const failures: string[] = [];
      if (projectResult.status === 'fulfilled') setProjects(projectResult.value); else failures.push(`项目列表：${errorText(projectResult.reason)}`);
      if (runResult.status === 'fulfilled') {
        setRuns(current => mergeProductionRuns(current, runResult.value));
        setSelectedRunId(current => current || runResult.value[0]?.id || '');
        const recovered = pendingClientId ? runResult.value.find(item => item.clientRequestId === pendingClientId) : null;
        if (recovered) {
          try { sessionStorage.removeItem(pendingKey); } catch { /* Server state remains authoritative. */ }
          setPendingClientId(''); setSelectedRunId(recovered.id); setCreating(false); setDirty(false); setConsent(false);
          setMessage('已找到刚才创建的运行，继续读取真实进度；没有重复创建。');
        }
      } else failures.push(`制作运行：${errorText(runResult.reason)}`);
      setLoadError(failures.join(' '));
      setLoading(false); timer = setTimeout(() => void poll(), 4000);
    }
    void poll(); return () => { disposed = true; clearTimeout(timer); controller?.abort(); };
  }, [refresh, pendingClientId]);

  useEffect(() => {
    if (!form.projectId) { setVersions([]); return; }
    const controller = new AbortController();
    void productionApi(`/api/projects/${encodeURIComponent(form.projectId)}/script-versions`, undefined, controller.signal).then(parseScriptVersionOptions).then(items => {
      if (controller.signal.aborted) return; setVersions(items); setForm(previous => ({ ...previous, scriptVersionId: items.find(item => item.id === currentProject?.currentScriptVersionId)?.id || items.at(-1)?.id || '' }));
    }).catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, [form.projectId, currentProject?.currentScriptVersionId]);

  useEffect(() => {
    if (!selectedRunId) return; const controller = new AbortController();
    void productionApi(`/api/production-runs/${encodeURIComponent(selectedRunId)}`, undefined, controller.signal).then(parseProductionRun).then(value => { if (!controller.signal.aborted) setRuns(current => mergeProductionRuns(current, [value])); }).catch(() => undefined);
    return () => controller.abort();
  }, [selectedRunId, refresh]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  function edit(patch: Partial<ProductionForm>) { setForm(current => ({ ...current, ...patch })); setConsent(false); setDirty(true); }
  function selectProject(projectId: string) { edit({ projectId, scriptVersionId: '' }); }
  async function mutate(label: string, path: string, body: unknown) {
    if (mutation.current) return null; mutation.current = true; explicitRejection.current = false; setBusy(label); setMessage(''); setError('');
    const controller = new AbortController(); controllerRef.current = controller; const timeout = setTimeout(() => controller.abort(), 20000);
    try { const result = parseProductionRun(await productionApi(path, body, controller.signal)); setRuns(current => mergeProductionRuns(current, [result])); setSelectedRunId(result.id); return result; }
    catch (cause) { explicitRejection.current = cause instanceof ProductionApiError; setError(errorText(cause)); return null; }
    finally { clearTimeout(timeout); mutation.current = false; setBusy(''); setRefresh(value => value + 1); }
  }
  async function create() {
    if (!consent || mutation.current || pendingClientId) return;
    const clientRequestId = crypto.randomUUID();
    try { sessionStorage.setItem(pendingKey, JSON.stringify({ clientRequestId, createdAt: new Date().toISOString() })); setPendingClientId(clientRequestId); } catch { setError('浏览器无法保存本次创建标识，尚未提交。'); return; }
    const result = await mutate('create', '/api/production-runs', productionCreateBody(form, clientRequestId));
    if (result) { try { sessionStorage.removeItem(pendingKey); } catch { /* Server record remains authoritative. */ } setPendingClientId(''); setConsent(false); setDirty(false); setCreating(false); setMessage('自动制作运行已建立。任务会在预算与人工门禁内推进。'); }
    else if (explicitRejection.current) { try { sessionStorage.removeItem(pendingKey); } catch { /* no-op */ } setPendingClientId(''); setConsent(false); setMessage('后端已明确拒绝创建，没有启动运行。请按提示修改后再试。'); }
    else setMessage('创建响应未确认。系统不会自动重新提交，请先刷新运行历史核对。');
  }
  async function action(type: 'pause' | 'resume') { if (!run) return; const result = await mutate(type, `/api/production-runs/${encodeURIComponent(run.id)}/actions`, { type }); if (result) setMessage(type === 'pause' ? '运行已暂停，当前成果和任务状态已保留。' : '运行已继续，调度器会从可执行节点恢复。'); }
  async function retry(task: ProductionTask) { if (!run) return; const result = await mutate('retry', `/api/production-runs/${encodeURIComponent(run.id)}/actions`, { type: 'retryTask', taskId: task.id, reason: '用户从生产总控台明确发起局部重试' }); if (result) setMessage(`已为「${task.label}」创建一次局部重试。`); }
  async function review(task: ProductionTask, decision: string, candidate?: ProductionCandidate, issue?: ProductionIssue) {
    if (!run) return; const body = { taskId: task.id, decision, ...(candidate ? { candidateId: candidate.id } : {}), ...(issue ? { issueId: issue.id } : {}), feedback: '用户在生产总控台作出明确决定' };
    const result = await mutate('review', `/api/production-runs/${encodeURIComponent(run.id)}/reviews`, body); if (result) setMessage(decision === 'reject' ? '候选已拒绝，决定已保存。' : '决定已保存，受影响的下游任务会按依赖继续。');
  }
  function resolve(issue: ProductionIssue) {
    const task = run?.tasks.find(item => item.id === issue.taskId);
    if (task) void review(task, issue.code === 'CHECKPOINT_REVIEW_REQUIRED' ? 'approve' : 'resolveIssue', undefined, issue);
  }

  return <div className="pa-page">
    {isCreate && <header className="pa-page-head"><div><span className="pa-head-icon"><Sparkles size={20} /></span><div><h1>自动制作</h1><p>把剧本交给 Story Studio，完成一整条可见、可暂停、可返修的制作流程。</p></div></div><div><a href="#/automation/video"><Film size={14} />单镜头视频工具<ArrowUpRight size={12} /></a><a href="#/settings/models"><Settings2 size={14} />模型设置</a></div></header>}
    {isCreate ? <CreatePanel form={form} projects={projects} versions={versions} loading={loading || busy === 'create' || Boolean(pendingClientId)} consent={consent} onConsent={setConsent} onChange={edit} onProject={selectProject} onSubmit={() => void create()} />
      : <RunDashboard run={run} runs={runs} projects={projects} selectedTaskId={selectedTaskId} busy={busy} onRun={id => { setCreating(false); setSelectedRunId(id); setSelectedTaskId(''); }} onTask={setSelectedTaskId} onAction={type => void action(type)} onResolve={resolve} onRetry={task => void retry(task)} onReview={(task, decision, candidate) => void review(task, decision, candidate)} />}
    {pendingClientId && <div className="pa-recovery" role="alert"><AlertCircle size={15} /><p>正在核对刚才的创建结果。暂不允许再次创建，避免重复启动一整条付费流水线。</p><button onClick={() => setRefresh(value => value + 1)}>重新读取</button><button onClick={() => { if (!window.confirm('只有确认后端没有这次运行时才应解除。确定解除待确认状态？')) return; try { sessionStorage.removeItem(pendingKey); } catch { /* no-op */ } setPendingClientId(''); setConsent(false); }}>确认未创建</button></div>}
    {(message || error || loadError) && <div className={`pa-toast-inline ${error || loadError ? 'error' : ''}`} role={error || loadError ? 'alert' : 'status'}>{error || loadError ? <AlertCircle size={15} /> : <Check size={15} />}<p>{error || loadError || message}</p>{(error || loadError) && <button onClick={() => { setError(''); setLoadError(''); setRefresh(value => value + 1); }}><RefreshCw size={12} />刷新</button>}</div>}
    {!isCreate && <button className="pa-new-run" onClick={() => { setCreating(true); setSelectedTaskId(''); setDirty(false); setConsent(false); }}>新建一次制作</button>}
  </div>;
}

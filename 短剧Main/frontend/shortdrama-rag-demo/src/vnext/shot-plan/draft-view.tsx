import type { VnextFormalShotPlan, VnextShotPlanDraft } from "../api";

export function ShotPlanDiagnostics({ warnings }: { warnings: string[] }): React.JSX.Element | null {
  if (warnings.length === 0) return null;
  return <section
    id="vnext-script-diagnostics"
    aria-labelledby="vnext-script-diagnostics-title"
    className="rounded-md border border-amber-300/30 bg-amber-200/10 p-4 text-amber-50"
  >
    <h3 id="vnext-script-diagnostics-title" className="text-sm font-semibold">
      解析诊断（{warnings.length}）
    </h3>
    <p className="mt-1 text-xs leading-5 text-amber-100">
      请逐项检查对应场景或镜头。需要时修正原剧本，再点击“重试解析”。
    </p>
    <ol className="mt-3 space-y-2 text-xs leading-5">
      {warnings.map((warning, index) => <li key={`${index}-${warning}`} className="rounded bg-black/15 px-3 py-2">
        <span className="font-semibold">问题 {index + 1}：</span>{warning}
      </li>)}
    </ol>
  </section>;
}

export function ShotPlanDraftView({
  draft,
  formalFacts,
}: {
  draft: VnextShotPlanDraft;
  formalFacts: VnextFormalShotPlan | null;
}): React.JSX.Element {
  const sceneByKey = new Map(draft.scenes.map((scene) => [scene.key, scene]));
  return <div className="grid gap-4 lg:grid-cols-[0.7fr_1fr_1.7fr]">
    <section className="rounded-md border border-white/10 bg-black/20 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">角色</h3>
      <div className="mt-3 space-y-3">{draft.characters.map((character) => <article key={character.key}>
        <strong className="text-sm text-white">{character.name}</strong>
        <p className="mt-1 text-xs leading-5 text-slate-300">{character.description}</p>
      </article>)}</div>
    </section>
    <section className="rounded-md border border-white/10 bg-black/20 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">场景</h3>
      <div className="mt-3 space-y-3">{draft.scenes.map((scene) => <article key={scene.key}>
        <strong className="text-sm text-white">{scene.position + 1}. {scene.title}</strong>
        <p className="mt-1 text-xs leading-5 text-slate-300">{scene.summary}</p>
      </article>)}</div>
    </section>
    <section className="rounded-md border border-white/10 bg-black/20 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">分镜规划</h3>
      <div className="mt-3 space-y-3">{draft.shots.map((shot) => <article key={shot.key} className="rounded border border-white/10 bg-white/[0.03] p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-cyan-200">
          <span>{sceneByKey.get(shot.scene_key)?.title ?? "未命名场景"}</span>
          <span>镜头 {shot.position + 1}</span>
          <span>{shot.shot_size}</span>
          <span>{shot.camera_movement}</span>
        </div>
        <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs leading-5 text-slate-300 sm:grid-cols-[3rem_1fr]">
          <dt>动作</dt><dd>{shot.action}</dd>
          <dt>节奏</dt><dd>{shot.rhythm}</dd>
          <dt>对白</dt><dd>{shot.dialogue}</dd>
          <dt>声音</dt><dd>{shot.sound}</dd>
        </dl>
      </article>)}</div>
      {formalFacts ? <p className="mt-4 rounded bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">
        已形成正式事实：{formalFacts.characters.length} 个角色、{formalFacts.scenes.length} 个场景、{formalFacts.shots.length} 个镜头
      </p> : null}
    </section>
  </div>;
}

/* ============================================================
   project-assets-makeup.tsx — P-07 定妆两件套+通用库推荐(批次二第 3 卡,174:146 定稿)

   SPEC(Fable 逐字转录):定妆两件套卡×2+三视图卡+推荐行×4+Button Ghost×4(拉入项目);
   字段=R120 定妆两件套=大头照+全身照(seedance-asset-registration 域),「缺全身照」=就绪
   缺失警示;三视图仅供人看不入生成参考(明示标注);交互=编辑适配→P-04(0.3s);
   壳=资产 current;accent:壳 3,装饰 0(本文件 0 accent,警示走 Badge warning 语义色)。
   随单裁定:推荐行=通用库 browse v1 综合排序前 4;「拉入项目」走现有引用链(addProjectAsset,
   宿主 addAsset/projectAssetAddReducer);候选三分组本卡不实现(DC 有话再补)。
   就绪口径:形态分桶=MediaVersion.metadata.view_angle→title 关键词约定(后端无一等形态
   字段,browse 形态组挂 v1.1 同批);词表落地后换源,卡面两档计数不变。
   ============================================================ */
import { ArrowRight, Image as ImageIcon, User } from "@phosphor-icons/react";
import * as React from "react";
import { api } from "../api";
import { Badge, Skeleton } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import { demoCommonAssets } from "../demo";
import { navigate, projectStoryboardPath } from "../routing";
import { useResource } from "../ui";
import type { Asset, MediaVersion } from "../types";

/* ---------- 两件套就绪(纯函数,约定关键词分桶) ---------- */

const HEADSHOT_RE = /特写|大头|肖像|肩部以上/;
const FULLBODY_RE = /全身/;
const TURNAROUND_RE = /三视图/;

export interface MakeupReadiness {
  headshot: boolean;
  fullBody: boolean;
  turnaroundCount: number;
  /** 0..2:大头照+全身照各一分。 */
  ready: number;
  missing: Array<"大头照" | "全身照">;
}

function versionAngleText(version: MediaVersion): string {
  const meta = version.metadata && typeof version.metadata === "object" ? version.metadata as Record<string, unknown> : {};
  return String(meta.view_angle ?? version.title ?? "");
}

export function makeupReadiness(versions: MediaVersion[]): MakeupReadiness {
  const images = versions.filter((version) => version.media_kind === "image");
  const headshot = images.some((version) => HEADSHOT_RE.test(versionAngleText(version)));
  const fullBody = images.some((version) => FULLBODY_RE.test(versionAngleText(version)));
  const turnaroundCount = images.filter((version) => TURNAROUND_RE.test(versionAngleText(version))).length;
  const missing: Array<"大头照" | "全身照"> = [];
  if (!headshot) missing.push("大头照");
  if (!fullBody) missing.push("全身照");
  return { headshot, fullBody, turnaroundCount, ready: 2 - missing.length, missing };
}

function isCharacterAsset(asset: Asset): boolean {
  const kind = (asset.asset_kind ?? "").toLowerCase();
  return kind === "character" || kind === "animal" || asset.role === "character_identity";
}

function assetName(asset: Asset): string {
  return asset.display_name || asset.name || "未命名资产";
}

/* ---------- 定妆两件套 section ---------- */

function MakeupReadinessSection({ projectId, demoMode, assets, demoVersionsFor }: {
  projectId: string;
  demoMode: boolean;
  assets: Asset[];
  demoVersionsFor: (assetId: string) => MediaVersion[];
}): React.JSX.Element {
  const characters = React.useMemo(() => assets.filter(isCharacterAsset), [assets]);
  const [versionsById, setVersionsById] = React.useState<Record<string, MediaVersion[] | "loading" | "error">>({});
  const inflight = React.useRef(new Map<string, Promise<MediaVersion[]>>());
  const characterKey = characters.map((asset) => asset.id).join(",");

  /* 逐角色一次 assetVersions,promise 存 ref(StrictMode 双跑共享),与宿主版本摘要同款。 */
  React.useEffect(() => {
    if (demoMode) {
      setVersionsById((current) => {
        const next = { ...current };
        for (const asset of characters) if (!next[asset.id]) next[asset.id] = demoVersionsFor(asset.id);
        return next;
      });
      return;
    }
    let active = true;
    for (const asset of characters) {
      let promise = inflight.current.get(asset.id);
      if (!promise) {
        promise = api.assetVersions(asset.id).then((result) => result.items);
        inflight.current.set(asset.id, promise);
        setVersionsById((current) => (current[asset.id] ? current : { ...current, [asset.id]: "loading" }));
      }
      void promise.then((items) => {
        if (active) setVersionsById((current) => ({ ...current, [asset.id]: items }));
      }).catch(() => {
        if (active) setVersionsById((current) => ({ ...current, [asset.id]: "error" }));
      });
    }
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, characterKey]);

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-tk-border-1 bg-tk-panel px-4 py-3" aria-label="定妆两件套">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-section-title text-tk-ink-1">定妆两件套</h2>
        <span className="text-[11px] text-tk-ink-2">大头照+全身照=就位；三视图仅供人看，不入生成参考。</span>
      </header>
      {characters.length === 0 ? (
        <p className="px-1 py-3 text-xs text-tk-ink-3">项目还没有角色资产，从资产中心引入或看下方通用库推荐。</p>
      ) : (
        <div className="grid gap-3 min-[720px]:grid-cols-2">
          {characters.map((asset) => {
            const versions = versionsById[asset.id];
            const readiness = Array.isArray(versions) ? makeupReadiness(versions) : null;
            return (
              <div key={asset.id} className="flex flex-col gap-2 rounded-md border border-tk-border-1 bg-tk-elevated px-3 py-2" aria-label={`${assetName(asset)}定妆就绪`}>
                <header className="flex items-center gap-2">
                  {asset.thumbnail_url || asset.storage_url ? (
                    <img src={asset.thumbnail_url || asset.storage_url || ""} alt="" className="size-9 flex-none rounded-sm bg-tk-panel object-cover" />
                  ) : (
                    <span className="flex size-9 flex-none items-center justify-center rounded-sm bg-tk-panel text-tk-ink-2"><User aria-hidden="true" className="size-4" /></span>
                  )}
                  <strong className="truncate text-xs font-semibold text-tk-ink-1">{assetName(asset)}</strong>
                  <span className="ml-auto flex items-center gap-2">
                    {versions === "loading" || versions === undefined ? (
                      <Skeleton className="h-4 w-10" />
                    ) : versions === "error" ? (
                      <span className="text-[11px] text-tk-ink-2">版本读不到</span>
                    ) : readiness ? (
                      <span className="font-tkmono text-xs text-tk-ink-2" aria-label={`两件套就位 ${readiness.ready}/2`}>{readiness.ready}/2 就位</span>
                    ) : null}
                    <Button size="sm" variant="ghost" icon={<ArrowRight />} title="去生产页适配这角色（P-04 域）" onClick={() => navigate(projectStoryboardPath(projectId))}>编辑适配</Button>
                  </span>
                </header>
                {readiness ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {readiness.missing.length === 0 ? (
                      <span className="text-[11px] text-tk-ink-3">两件套已就位</span>
                    ) : readiness.missing.map((piece) => (
                      <Badge key={piece} tone="warning">缺{piece}</Badge>
                    ))}
                    {readiness.turnaroundCount > 0 ? (
                      <span className="text-[11px] text-tk-ink-2" title="三视图仅供人看，不入生成参考">三视图 ×{readiness.turnaroundCount}（仅供人看）</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ---------- 通用库推荐 section(综合排序前 4,拉入项目走现有引用链) ---------- */

function CommonRecommendSection({ demoMode, introducedIds, onAddAsset }: {
  demoMode: boolean;
  introducedIds: ReadonlySet<string>;
  onAddAsset: (asset: Asset) => Promise<boolean>;
}): React.JSX.Element {
  const recsState = useResource(
    () => api.assets({ scope: "common", sort: "composite", page: 1, pageSize: 4 }),
    { items: demoCommonAssets.slice(0, 4), count: 4 },
    demoMode,
    [],
  );
  const [addingId, setAddingId] = React.useState("");
  const recs = recsState.data?.items ?? [];

  async function add(asset: Asset): Promise<void> {
    if (addingId) return; // 闸门:一次拉入未完不再点
    setAddingId(asset.id);
    try {
      await onAddAsset(asset);
    } finally {
      setAddingId("");
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-tk-border-1 bg-tk-panel px-4 py-3" aria-label="通用库推荐">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-section-title text-tk-ink-1">通用库推荐</h2>
        <span className="text-[11px] text-tk-ink-2">综合排序前 4；拉入项目走引用，不动资产本体。</span>
      </header>
      {recsState.loading ? (
        <div className="flex flex-col gap-1.5"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div>
      ) : recsState.error ? (
        <p className="px-1 py-2 text-xs text-tk-ink-3" role="alert">推荐暂时读不到，<button type="button" className="text-tk-ink-1 underline-offset-2 hover:underline" onClick={recsState.retry}>重试</button></p>
      ) : recs.length === 0 ? (
        <p className="px-1 py-2 text-xs text-tk-ink-3">通用库还没有可推荐的资产。</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {recs.map((asset) => {
            const introduced = introducedIds.has(asset.id);
            return (
              <li key={asset.id} className="flex items-center gap-3 rounded-md border border-tk-border-1 bg-tk-elevated px-3 py-1.5">
                {asset.thumbnail_url || asset.storage_url ? (
                  <img src={asset.thumbnail_url || asset.storage_url || ""} alt="" className="size-8 flex-none rounded-sm bg-tk-panel object-cover" />
                ) : (
                  <span className="flex size-8 flex-none items-center justify-center rounded-sm bg-tk-panel text-tk-ink-2"><ImageIcon aria-hidden="true" className="size-4" /></span>
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <strong className="truncate text-xs font-semibold text-tk-ink-1">{assetName(asset)}</strong>
                  {asset.category || asset.asset_kind ? <span className="truncate text-[11px] text-tk-ink-3">{asset.category ?? asset.asset_kind}</span> : null}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={introduced || addingId !== ""}
                  loading={addingId === asset.id}
                  title={introduced ? "已在项目中" : "拉入项目（建立引用，采用计数随引用链走）"}
                  onClick={() => void add(asset)}
                >
                  {introduced ? "已引入" : "拉入项目"}
                </Button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** P-07 两段:定妆两件套(角色就绪)+通用库推荐(拉入项目)。宿主=ProjectAssetsPage。 */
export function ProjectAssetsMakeupSections({ projectId, demoMode, assets, introducedIds, demoVersionsFor, onAddAsset }: {
  projectId: string;
  demoMode: boolean;
  assets: Asset[];
  introducedIds: ReadonlySet<string>;
  demoVersionsFor: (assetId: string) => MediaVersion[];
  onAddAsset: (asset: Asset) => Promise<boolean>;
}): React.JSX.Element {
  return (
    <>
      <MakeupReadinessSection projectId={projectId} demoMode={demoMode} assets={assets} demoVersionsFor={demoVersionsFor} />
      <CommonRecommendSection demoMode={demoMode} introducedIds={introducedIds} onAddAsset={onAddAsset} />
    </>
  );
}

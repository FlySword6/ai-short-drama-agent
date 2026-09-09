/* ============================================================
   topics-page.tsx — 选题雷达榜(批次一卡 6;设计稿 docs/design/topic-radar-p05-design.md 已批 v1)

   口径:榜单 24 行/页+分页器;fresh/stale/未配置/不可用四态(stale 显实际 data_date,
   未配置不装空数组);commercial_display_status=pending 期间「数据仅内部参考」常驻
   (合规件不可关);link 外链一律不导;选中行→「用这道题,去写剧本」CTA(立项预填剧名)。
   demo=雾岛宇宙示例榜,标注「示例数据」。
   ============================================================ */
import { ArrowLeft, ArrowRight, CalendarBlank, WarningCircle } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { ApiClientError, api } from "../api";
import type { TopicRadarItem } from "../types";
import { navigate } from "../routing";
import { useResource } from "../ui";
import { Button } from "../components/ui/button";
import { EmptyState, Skeleton } from "../components/ui/primitives";
import { ListPager } from "./global-pages";
import type { PageRuntimeProps } from "./global-pages";

const RADAR_PAGE_SIZE = 24;

const DEMO_RADAR_ITEMS: TopicRadarItem[] = [
  { rank: 1, title: "《傅先生马甲藏不住了》", heat: "98.6w" },
  { rank: 2, title: "《无双》", heat: "95.1w" },
  { rank: 3, title: "《八零年代当后妈》", heat: "91.7w" },
  { rank: 4, title: "《裴总每天都想父凭子贵》", heat: "88.3w" },
  { rank: 5, title: "《皇后娘娘来打工》", heat: "85.9w" },
];

interface RadarState {
  kind: "ready" | "unconfigured" | "error";
  items: TopicRadarItem[];
  dataDate: string;
  stale: boolean;
  pendingApproval: boolean;
  message?: string;
}

function rankLabel(rank: number): string {
  return String(rank).padStart(2, "0");
}

export function TopicsPage({ demoMode, notify }: PageRuntimeProps): React.JSX.Element {
  const demoState = useMemo<RadarState>(() => ({
    kind: "ready",
    items: DEMO_RADAR_ITEMS,
    dataDate: "2026-07-31",
    stale: false,
    pendingApproval: true,
  }), []);
  const state = useResource<RadarState>(
    async () => {
      try {
        /* request 自动解 {ok,data} 信封——返回值已是 data 本体(TopicRadarHot)。 */
        const data = await api.topicRadarHot();
        return {
          kind: "ready",
          items: Array.isArray(data.items) ? data.items : [],
          dataDate: data.data_date,
          stale: data.freshness === "stale",
          pendingApproval: data.commercial_display_status === "pending_vendor_written_approval",
        };
      } catch (reason) {
        /* 未配置(合同:发出任何上游请求前返回明确错误)→ 专属态,不装空榜。 */
        const message = reason instanceof Error ? reason.message : "榜单读取失败";
        if (reason instanceof ApiClientError && /尚未配置|未配置|not[_ ]?configured/i.test(message)) {
          return { kind: "unconfigured", items: [], dataDate: "", stale: false, pendingApproval: true, message };
        }
        throw reason;
      }
    },
    demoState,
    demoMode,
    [],
  );

  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<TopicRadarItem | null>(null);

  if (state.loading) {
    return (
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-4" aria-busy="true" aria-label="正在读取榜单">
        <h1 className="text-xl font-semibold text-ink-1">短剧热度榜</h1>
        <div className="flex flex-col gap-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={`sk-${i}`} className="h-10 w-full" />)}</div>
      </section>
    );
  }
  if (state.error || !state.data) {
    return (
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <h1 className="text-xl font-semibold text-ink-1">短剧热度榜</h1>
        <EmptyState title="榜单暂时读不到" description="稍后再试;多次读不到请联系项目负责人。" action={<Button icon={<WarningCircle />} onClick={state.retry}>重试</Button>} />
      </section>
    );
  }

  const radar = state.data;
  if (radar.kind === "unconfigured") {
    return (
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <h1 className="text-xl font-semibold text-ink-1">短剧热度榜</h1>
        <EmptyState title="选题雷达尚未配置" description="榜单数据源还没有开通。需要用它辅助选题时,请联系项目负责人开通。" />
      </section>
    );
  }

  const totalPages = Math.max(1, Math.ceil(radar.items.length / RADAR_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = radar.items.slice((safePage - 1) * RADAR_PAGE_SIZE, safePage * RADAR_PAGE_SIZE);

  function useTopic(): void {
    if (!selected) return;
    /* 立项落点:新建项目弹窗预填剧名(项目管理页 create 深链读 topic 参数)。 */
    navigate(`/projects?create=1&topic=${encodeURIComponent(selected.title)}`);
  }

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold text-ink-1">短剧热度榜</h1>
        {radar.dataDate ? (
          <span className="inline-flex items-center gap-1 font-mono text-xs text-ink-3">
            <CalendarBlank aria-hidden="true" />{radar.dataDate}
            {radar.stale ? <span className="text-ink-4">(非今日,显示最近可用)</span> : null}
          </span>
        ) : null}
        {demoMode ? <span className="text-xs text-ink-4">示例数据</span> : null}
        {radar.pendingApproval ? <span className="text-xs text-ink-3">数据仅内部参考</span> : null}
      </header>

      <ul className="flex list-none flex-col overflow-hidden rounded-xl bg-surface-1" aria-label="热度榜">
        {pageItems.map((item) => {
          const active = selected?.rank === item.rank && selected?.title === item.title;
          return (
            <li key={`${item.rank}-${item.title}`}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => setSelected(active ? null : item)}
                className={`flex w-full items-center gap-4 px-5 py-3 text-left transition-colors ${active ? "bg-surface-2" : "hover:bg-surface-2/60"}`}
              >
                <span className="w-8 font-mono text-sm text-ink-3">{rankLabel(item.rank)}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-1">{item.title}</span>
                <span className="font-mono text-sm text-ink-2">{item.heat}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {radar.items.length > RADAR_PAGE_SIZE ? (
        <ListPager page={safePage} total={radar.items.length} onPageChange={setPage} itemNoun="条" ariaLabel="榜单分页" pageSize={RADAR_PAGE_SIZE} />
      ) : null}

      <footer className="flex items-center justify-between gap-4">
        <p className="text-xs text-ink-3">选定一条榜题,这部戏就送去立项写剧本。</p>
        <span className="inline-flex items-center gap-2">
          <Button variant="ghost" icon={<ArrowLeft />} onClick={() => navigate("/projects")}>回项目管理</Button>
          <Button variant="primary" icon={<ArrowRight />} disabled={!selected} onClick={useTopic}>
            {selected ? "用这道题,去写剧本" : "确定选题,去写剧本"}
          </Button>
        </span>
      </footer>
    </section>
  );
}

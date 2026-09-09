/* ============================================================
   cost-charts.tsx — 数据看板专业图表（F 包：ECharts 按需引入 + 暗色主题）

   - 按需 use：折线/条形/环形 + Grid/Tooltip/Legend + Canvas 渲染（不引全量 echarts）；
   - 暗色主题：表面/墨色/描边全部取 token 同族色值（lit 与 tokens.css 对应）；
   - 经 React.lazy 分包加载（看板首屏不背图表库体积），本文件不进主包。
   ============================================================ */

import { BarChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import type { EChartsCoreOption } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";

import type { CostBarRow } from "../cost-board";
import { fenToCredits } from "../cost-units";

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

/* 暗色主题色（与 tokens.css 同族；canvas 不读 CSS 变量，集中在此维护） */
const CHART = {
  accent: "#35e0b3",     // accent 薄荷青（按日消耗主线/面积）
  image: "#6ea8fe",      // 图片
  video: "#35e0b3",      // 视频
  other: "#f5a623",      // 其他（AI 辅助）
  text: "#a9b0ba",       // ink-2
  faint: "#6b7280",      // ink-3 轴线/刻度
  split: "rgba(255,255,255,0.07)",
  tooltipBg: "#20242c",  // surface-2
  tooltipBorder: "rgba(255,255,255,0.14)",
};

/* S46-A 计量口径：换算唯一出口=../cost-units（1 积分 = 1 分钱口径,÷1）;
   此前本地 ÷100 与卡片口径自相矛盾——图表数值比总计卡小两个量级,属真实计量 bug。 */

function baseTooltip(unitLabel: string): Record<string, unknown> {
  return {
    trigger: "item",
    backgroundColor: CHART.tooltipBg,
    borderColor: CHART.tooltipBorder,
    borderWidth: 1,
    textStyle: { color: "#e8eaee", fontSize: 12 },
    valueFormatter: (value: number) => `${value} ${unitLabel}`,
  };
}

function baseAxis(): Record<string, unknown> {
  return {
    axisLine: { lineStyle: { color: CHART.split } },
    axisLabel: { color: CHART.text, fontSize: 11 },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: CHART.split } },
  };
}

/** 单图容器：初始化/resize/销毁（不泄漏实例；option 变更整包替换）。 */
export function EChart({ option, height = 220, onClick }: {
  option: EChartsCoreOption;
  height?: number;
  onClick?: (name: string) => void;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = echarts.init(host);
    chartRef.current = chart;
    chart.on("click", (params) => {
      const name = (params as { name?: string }).name;
      if (name && clickRef.current) clickRef.current(name);
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={hostRef} style={{ height }} role="img" aria-label="消耗图表" />;
}

/* ---------- 按日消耗：面积折线 ---------- */

export function CostTrendChart({ rows, unitLabel }: { rows: CostBarRow[]; unitLabel: string }): React.JSX.Element {
  const option: EChartsCoreOption = {
    grid: { left: 48, right: 16, top: 16, bottom: 28 },
    tooltip: { ...baseTooltip(unitLabel), trigger: "axis" },
    xAxis: {
      type: "category",
      data: rows.map((row) => row.label),
      boundaryGap: false,
      ...baseAxis(),
      splitLine: { show: false },
    },
    yAxis: { type: "value", ...baseAxis() },
    series: [{
      type: "line",
      smooth: true,
      symbol: "circle",
      symbolSize: 5,
      data: rows.map((row) => fenToCredits(row.fen)),
      lineStyle: { color: CHART.accent, width: 2 },
      itemStyle: { color: CHART.accent },
      areaStyle: {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: "rgba(53,224,179,0.28)" },
            { offset: 1, color: "rgba(53,224,179,0.02)" },
          ],
        },
      },
    }],
  };
  return <EChart option={option} />;
}

/* ---------- 项目消耗排行：横向条形 ---------- */

export interface ProjectRankItem {
  project_id: string;
  project_name: string;
  estimated_cost_fen: number;
}

export function ProjectRankChart({ items, unitLabel, onOpenProject }: {
  items: ProjectRankItem[];
  unitLabel: string;
  onOpenProject?: (projectId: string) => void;
}): React.JSX.Element {
  const top = items.slice(0, 10);
  const option: EChartsCoreOption = {
    grid: { left: 8, right: 56, top: 8, bottom: 8, containLabel: true },
    tooltip: baseTooltip(unitLabel),
    xAxis: { type: "value", ...baseAxis(), splitLine: { lineStyle: { color: CHART.split } } },
    yAxis: {
      type: "category",
      inverse: true,
      data: top.map((item) => item.project_name),
      ...baseAxis(),
      splitLine: { show: false },
      axisLabel: { color: CHART.text, fontSize: 12, width: 120, overflow: "truncate" },
    },
    series: [{
      type: "bar",
      data: top.map((item) => fenToCredits(item.estimated_cost_fen)),
      barMaxWidth: 14,
      itemStyle: { color: CHART.accent, borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: "right", color: CHART.text, fontSize: 11, fontFamily: "monospace" },
    }],
  };
  return (
    <EChart
      option={option}
      height={Math.max(160, top.length * 34 + 24)}
      onClick={onOpenProject ? (name) => {
        const target = top.find((item) => item.project_name === name);
        if (target) onOpenProject(target.project_id);
      } : undefined}
    />
  );
}

/* ---------- 消耗占比：环形 ---------- */

export function CostShareChart({ imageFen, videoFen, otherFen, unitLabel }: {
  imageFen: number | null;
  videoFen: number | null;
  otherFen: number | null;
  unitLabel: string;
}): React.JSX.Element | null {
  const slices = [
    { name: "图片", value: imageFen, color: CHART.image },
    { name: "视频", value: videoFen, color: CHART.video },
    { name: "其他（AI 辅助）", value: otherFen, color: CHART.other },
  ].filter((slice): slice is { name: string; value: number; color: string } => typeof slice.value === "number" && slice.value > 0);
  if (slices.length === 0) return null;
  const option: EChartsCoreOption = {
    tooltip: baseTooltip(unitLabel),
    legend: { bottom: 0, textStyle: { color: CHART.text, fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
    series: [{
      type: "pie",
      radius: ["52%", "74%"],
      center: ["50%", "44%"],
      avoidLabelOverlap: true,
      label: { show: false },
      itemStyle: { borderColor: "#16181d", borderWidth: 2 },
      data: slices.map((slice) => ({ name: slice.name, value: fenToCredits(slice.value), itemStyle: { color: slice.color } })),
    }],
  };
  return <EChart option={option} height={220} />;
}

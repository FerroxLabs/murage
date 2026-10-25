// Copyright OpenMausBot contributors
// SPDX-License-Identifier: Apache-2.0
//
// Ported from OpenMausBot shared/widget-chart.ts (PRs #2820, #3002), adapted by Ferrox Labs for Murage 1.0.4: Murage has no
// Vega, so a widget's Chart is plain SVG geometry computed here (bars side by side or stacked by `stack`, lines, areas and
// an x axis of row labels) and drawn by src/components/widget/WidgetChart.tsx. Pure.
import { widgetNumber, type WidgetNode } from "./widget.ts";

export interface ChartSeries {
  type: "bar" | "line" | "area";
  dataKey: string;
  label: string;
  stack?: string;
}

/** The inside of a 600px card, used until the chart has been measured. */
export const WIDGET_CHART_WIDTH = 560;
/** The legend's line under the plot. */
const LEGEND_BAND = 24;
/** The row labels under the plot. */
const AXIS_BAND = 20;
const TOP = 4;
const Y_LABELS = 40;

export function readChart(node: WidgetNode): { rows: Array<Record<string, unknown>>; series: ChartSeries[]; xKey: string } {
  const rows = (Array.isArray(node.data) ? node.data as unknown[] : []).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
  const series = (Array.isArray(node.series) ? node.series as unknown[] : []).flatMap((item): ChartSeries[] => {
    const record: Record<string, unknown> = item && typeof item === "object" ? item as Record<string, unknown> : {};
    if (typeof record.dataKey !== "string") return [];
    return [{
      type: record.type === "line" || record.type === "area" ? record.type : "bar",
      dataKey: record.dataKey,
      label: typeof record.label === "string" ? record.label : record.dataKey,
      ...(typeof record.stack === "string" ? { stack: record.stack } : {}),
    }];
  }).slice(0, 4);
  const axis = node.xAxis && typeof node.xAxis === "object" ? node.xAxis as { dataKey?: unknown } : {};
  return { rows, series, xKey: typeof axis.dataKey === "string" ? axis.dataKey : "" };
}

/** A legend is worth its line when there is more than one series, or the one
 * series has a name of its own. */
export function hasLegend(node: WidgetNode, series: ChartSeries[]): boolean {
  return node.showLegend !== false && (series.length > 1 || (series.length === 1 && series[0]!.label !== series[0]!.dataKey));
}

/** The chart's height, legend included, for a card `width` wide: its own
 * height, else its aspect ratio, else 160; the plot never under 80 or over 400. */
export function widgetChartHeight(node: WidgetNode, width: number): number {
  const ratio = widgetNumber(node, "aspectRatio");
  const plot = Math.round(Math.min(400, Math.max(80, widgetNumber(node, "height") ?? (ratio ? width / ratio : 160))));
  return plot + (hasLegend(node, readChart(node).series) ? LEGEND_BAND : 0);
}

export interface ChartBar { x: number; y: number; width: number; height: number; series: number; tip: string }
export interface ChartPath { series: number; d: string }
export interface ChartGeometry {
  width: number;
  /** The drawing's height: the plot and its row labels, not the legend under it. */
  height: number;
  plot: { left: number; top: number; width: number; height: number };
  bars: ChartBar[];
  lines: ChartPath[];
  areas: ChartPath[];
  /** Where each hairline sits, and the number it stands for when the y axis is shown. */
  grid: Array<{ y: number; text?: string }>;
  xLabels: Array<{ x: number; text: string }>;
  legend: Array<{ series: number; label: string }>;
  points: Array<{ x: number; y: number; series: number; tip: string }>;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** The SVG geometry of a Chart node for a card `width` wide, or null when there is nothing to draw. Bars that share a
 * `stack` pile up in one slot of the row's band (rising and falling piles apart); the rest sit side by side. Lines and
 * areas break where a row has no value. */
export function widgetChartGeometry(node: WidgetNode, width = WIDGET_CHART_WIDTH): ChartGeometry | null {
  const { rows, series, xKey } = readChart(node);
  if (!rows.length || !series.length) return null;
  const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 });
  const showY = node.showYAxis === true;
  const showGrid = node.showGrid !== false;
  const total = widgetChartHeight(node, width);
  const height = total - (hasLegend(node, series) ? LEGEND_BAND : 0);
  const left = showY ? Y_LABELS : 0;
  const plot = { left, top: TOP, width: Math.max(1, width - left), height: Math.max(20, height - TOP - AXIS_BAND) };
  const labels = rows.map((row) => {
    const value = row[xKey];
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  });
  const valueAt = (row: Record<string, unknown>, key: string): number | null => {
    const raw = row[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  };
  // Bars: each bar group (a stack, or one series on its own) takes one slot in a row's band.
  const groups: string[] = [];
  series.forEach((item, index) => {
    const group = item.stack ? `stack:${item.stack}` : `series:${index}`;
    if (item.type === "bar" && !groups.includes(group)) groups.push(group);
  });
  // The y domain: every pile's reach up and down, every line value, and zero.
  let high = 0;
  let low = 0;
  rows.forEach((row) => {
    const up = new Map<string, number>();
    const down = new Map<string, number>();
    series.forEach((item, index) => {
      const value = valueAt(row, item.dataKey);
      if (value === null) return;
      if (item.type !== "bar") {
        high = Math.max(high, value);
        low = Math.min(low, value);
        return;
      }
      const group = item.stack ? `stack:${item.stack}` : `series:${index}`;
      const book = value >= 0 ? up : down;
      book.set(group, (book.get(group) ?? 0) + value);
    });
    for (const sum of up.values()) high = Math.max(high, sum);
    for (const sum of down.values()) low = Math.min(low, sum);
  });
  if (high === low) high = low + 1;
  const y = (value: number) => round(plot.top + plot.height - ((value - low) / (high - low)) * plot.height);
  const band = plot.width / rows.length;
  const x0 = (at: number) => plot.left + at * band;
  const centre = (at: number) => round(x0(at) + band / 2);
  const bars: ChartBar[] = [];
  const slot = (band * 0.8) / Math.max(1, groups.length);
  rows.forEach((row, at) => {
    const up = new Map<string, number>();
    const down = new Map<string, number>();
    series.forEach((item, index) => {
      if (item.type !== "bar") return;
      const value = valueAt(row, item.dataKey);
      if (value === null) return;
      const group = item.stack ? `stack:${item.stack}` : `series:${index}`;
      const book = value >= 0 ? up : down;
      const from = book.get(group) ?? 0;
      book.set(group, from + value);
      const a = y(from);
      const b = y(from + value);
      const slotAt = groups.indexOf(group);
      const gap = slot * 0.08;
      bars.push({
        x: round(x0(at) + band * 0.1 + slotAt * slot + gap / 2),
        y: Math.min(a, b),
        width: round(Math.max(1, slot - gap)),
        height: round(Math.max(1, Math.abs(a - b))),
        series: index,
        tip: `${labels[at]} · ${item.label}: ${compact.format(value)}`,
      });
    });
  });
  // Lines and areas break where a row has no value.
  const lines: ChartPath[] = [];
  const areas: ChartPath[] = [];
  const points: ChartGeometry["points"] = [];
  const base = y(Math.max(low, Math.min(high, 0)));
  series.forEach((item, index) => {
    if (item.type === "bar") return;
    const runs: Array<Array<{ x: number; y: number }>> = [];
    let run: Array<{ x: number; y: number }> = [];
    rows.forEach((row, at) => {
      const value = valueAt(row, item.dataKey);
      if (value === null) {
        if (run.length) runs.push(run);
        run = [];
        return;
      }
      const point = { x: centre(at), y: y(value) };
      run.push(point);
      if (rows.length <= 40) points.push({ ...point, series: index, tip: `${labels[at]} · ${item.label}: ${compact.format(value)}` });
    });
    if (run.length) runs.push(run);
    const d = runs.map((part) => part.map((point, at) => `${at ? "L" : "M"}${point.x} ${point.y}`).join(" ")).join(" ");
    if (d) lines.push({ series: index, d });
    if (item.type === "area") {
      const fill = runs.map((part) => `${part.map((point, at) => `${at ? "L" : "M"}${point.x} ${point.y}`).join(" ")} L${part[part.length - 1]!.x} ${base} L${part[0]!.x} ${base} Z`).join(" ");
      if (fill) areas.push({ series: index, d: fill });
    }
  });
  const grid = showGrid || showY
    ? Array.from({ length: 4 }, (_, step) => {
      const value = low + ((high - low) * step) / 3;
      return { y: y(value), ...(showY ? { text: compact.format(value) } : {}) };
    })
    : [];
  // As many row labels as fit, evenly spaced.
  const every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(plot.width / 56))));
  const xLabels = labels.flatMap((text, at) => (at % every === 0 && text ? [{ x: centre(at), text: text.length > 12 ? `${text.slice(0, 11)}…` : text }] : []));
  const legend = hasLegend(node, series) ? series.map((item, index) => ({ series: index, label: item.label })) : [];
  return { width, height, plot, bars, lines, areas, grid, xLabels, legend, points };
}

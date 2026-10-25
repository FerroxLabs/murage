// Copyright OpenMausBot contributors
// SPDX-License-Identifier: Apache-2.0
//
// Ported from OpenMausBot src/components/widget/WidgetChart.tsx (PRs #2820, #3002), adapted by Ferrox Labs for Murage 1.0.4:
// inline SVG in Murage's own tokens (no Vega).
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import type { WidgetNode } from "../../../shared/widget";
import { WIDGET_CHART_WIDTH, widgetChartGeometry } from "../../../shared/widget-chart";
import { boxStyle } from "./widget-style";

/** One colour per series, in the order the series are listed. */
export const WIDGET_SERIES_COLOURS: readonly string[] = ["var(--color-accent)", "var(--color-success)", "var(--color-warning)", "var(--color-danger)"];
const colour = (series: number) => WIDGET_SERIES_COLOURS[series % WIDGET_SERIES_COLOURS.length]!;

export function WidgetChart({ node, width: given }: { node: WidgetNode; width?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(given ?? WIDGET_CHART_WIDTH);
  const width = given ?? measured;
  const shape = useMemo(() => widgetChartGeometry(node, width), [node, width]);

  useEffect(() => {
    const element = host.current;
    if (given !== undefined || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0) setMeasured(element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [given]);

  if (!shape) return null;
  const series = (node.series as Array<{ label?: string; dataKey: string }>).map((item) => item.label ?? item.dataKey);
  const { height: _height, aspectRatio: _ratio, ...box } = boxStyle(node);
  const label = t("widget.chart.label", { series: series.join(", "), count: (node.data as unknown[]).length });
  return (
    <div ref={host} className="min-w-0" style={box}>
      <svg role="img" aria-label={label} viewBox={`0 0 ${shape.width} ${shape.height}`} width="100%" height={shape.height} className="block overflow-visible text-ink-secondary">
        {shape.grid.map((line, at) => (
          <g key={at}>
            <line x1={shape.plot.left} x2={shape.plot.left + shape.plot.width} y1={line.y} y2={line.y} stroke="var(--color-hairline)" strokeOpacity={0.4} strokeWidth={1} />
            {line.text && <text x={shape.plot.left - 6} y={line.y + 3} textAnchor="end" fontSize={10} fill="currentColor">{line.text}</text>}
          </g>
        ))}
        {shape.areas.map((area) => <path key={`a${area.series}`} d={area.d} fill={colour(area.series)} fillOpacity={0.18} />)}
        {shape.bars.map((bar, at) => (
          <rect key={at} x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={2} fill={colour(bar.series)}><title>{bar.tip}</title></rect>
        ))}
        {shape.lines.map((line) => <path key={`l${line.series}`} d={line.d} fill="none" stroke={colour(line.series)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
        {shape.points.map((point, at) => <circle key={at} cx={point.x} cy={point.y} r={2.5} fill={colour(point.series)}><title>{point.tip}</title></circle>)}
        {shape.xLabels.map((item, at) => (
          <text key={at} x={item.x} y={shape.plot.top + shape.plot.height + 14} textAnchor="middle" fontSize={11} fill="currentColor">{item.text}</text>
        ))}
      </svg>
      {shape.legend.length > 0 && (
        <ul className="mt-1 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[12px] leading-4 text-ink-secondary">
          {shape.legend.map((item) => (
            <li key={item.series} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2 rounded-full" style={{ background: colour(item.series) }} />
              <span dir="auto">{item.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

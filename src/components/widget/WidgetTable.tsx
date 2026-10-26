// Copyright OpenMausBot contributors
// SPDX-License-Identifier: Apache-2.0
//
// Ported from OpenMausBot src/components/widget/WidgetTable.tsx (PRs #2820, #3002), adapted by Ferrox Labs for Murage 1.0.4:
// a plain styled table in the look of a reply's table (Murage has no sortable table component).
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { widgetNumber, widgetString, type WidgetNode } from "../../../shared/widget";
import { COL_SIZE, kids } from "./widget-style";

const TEXT_ALIGN: Record<string, string> = { start: "text-start", center: "text-center", end: "text-end" };
const V_ALIGN: Record<string, string> = { start: "align-top", center: "align-middle", end: "align-bottom" };

/** The words of a cell, for a screen reader and for tests. */
export function widgetCellText(node: WidgetNode): string {
  switch (node.type) {
    case "Text": case "Title": case "Caption": case "Label": case "Markdown":
      return widgetString(node, "value") ?? "";
    case "Badge": case "Button":
      return widgetString(node, "label") ?? "";
    case "Progress":
      return `${Math.round((widgetNumber(node, "value") ?? 0) * 100)}%`;
    default:
      return kids(node).map(widgetCellText).filter(Boolean).join(" ");
  }
}

export function WidgetTable({ node, drawCell, name }: { node: WidgetNode; drawCell: (cell: WidgetNode) => ReactNode; name: string }) {
  const rows = kids(node).filter((row) => row.type === "Table.Row");
  const head = rows.find((row) => row.header === true);
  const body = rows.filter((row) => row !== head);
  const cellClass = (cell: WidgetNode, header: boolean) => cn(
    "px-2 py-1.5 text-[13.5px]",
    header ? "border-b border-hairline/40 font-semibold" : "border-b border-hairline/20",
    TEXT_ALIGN[widgetString(cell, "align") ?? ""] ?? "text-start",
    !header && (V_ALIGN[widgetString(cell, "vAlign") ?? ""] ?? "align-top"),
  );
  const cellStyle = (cell: WidgetNode) => {
    const width = typeof cell.width === "number" ? cell.width : COL_SIZE[widgetString(cell, "colSize") ?? ""];
    return width === undefined ? undefined : { width, minWidth: width };
  };
  const draw = (cell: WidgetNode, header: boolean, index: number) => {
    const Tag = header ? "th" : "td";
    return (
      <Tag key={cell.id ?? index} colSpan={widgetNumber(cell, "colSpan")} rowSpan={widgetNumber(cell, "rowSpan")} scope={header ? "col" : undefined} className={cellClass(cell, header)} style={cellStyle(cell)}>
        {drawCell(cell)}
      </Tag>
    );
  };
  return (
    <div className="min-w-0 overflow-x-auto" data-widget-table>
      <table aria-label={name} className="w-full border-collapse text-ink">
        {head && <thead><tr>{kids(head).map((cell, index) => draw(cell, true, index))}</tr></thead>}
        <tbody>{body.map((row, at) => <tr key={row.id ?? at}>{kids(row).map((cell, index) => draw(cell, false, index))}</tr>)}</tbody>
      </table>
    </div>
  );
}

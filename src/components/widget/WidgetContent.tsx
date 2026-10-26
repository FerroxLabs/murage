// Copyright OpenMausBot contributors
// SPDX-License-Identifier: Apache-2.0
//
// Ported from OpenMausBot src/components/widget/WidgetContent.tsx (PRs #2820, #3002), adapted by Ferrox Labs for Murage 1.0.4.
import type { CSSProperties } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { widgetNumber, widgetString, type WidgetNode } from "../../../shared/widget";
import { MarkdownImage } from "../ImageMedia";
import type { WidgetWhere } from "./WidgetNodes";
import { BADGE_DOT, BADGE_INK, BADGE_SIZE, BADGE_SOLID, boxStyle } from "./widget-style";

/**
 * An Image draws only what the normaliser kept: a data: image or one of Murage's own attachments, through the same
 * image component a reply's picture uses. No src (a remote address is dropped before it is stored) draws its alt as a
 * quiet placeholder; nothing is ever fetched on sight.
 */
export function WidgetImage({ node, where }: { node: WidgetNode; where: WidgetWhere }) {
  const src = widgetString(node, "src");
  const box = boxStyle(node);
  const thumb = where.item === true && where.lead === true && box.width === undefined && box.height === undefined;
  const edge = node.flush === true ? where.card : undefined;
  const alt = widgetString(node, "alt");
  const style: CSSProperties = {
    ...box,
    ...(thumb ? { width: 40, height: 40, flexShrink: 0 } : box.width === undefined && box.height === undefined ? { width: "100%" } : {}),
    borderRadius: edge ? 0 : box.borderRadius ?? (thumb ? 10 : 12),
    ...(edge ? { marginLeft: -edge.left, marginRight: -edge.right, marginTop: -edge.top, width: `calc(100% + ${edge.left + edge.right}px)`, maxWidth: "none" } : {}),
  };
  const frame = node.frame === true && "bg-inset ring-1 ring-ink/10";
  if (!src) {
    return (
      <div
        role="img"
        aria-label={alt || t("widget.image")}
        data-widget-image="placeholder"
        className={cn("flex max-w-full items-center justify-center gap-1.5 overflow-hidden bg-inset px-3 text-center text-[12px] leading-4 text-ink-secondary", !thumb && "min-h-[64px] py-3", frame)}
        style={style}
      >
        <ImageOff aria-hidden="true" size={thumb ? 16 : 14} className="shrink-0" />
        {!thumb && alt && <span dir="auto" className="min-w-0 break-words">{alt}</span>}
      </div>
    );
  }
  return (
    <div className={cn("block max-w-full overflow-hidden", frame)} style={style} data-widget-image="shown">
      <MarkdownImage src={src} alt={alt ?? ""} />
    </div>
  );
}

export function WidgetBadge({ node }: { node: WidgetNode }) {
  const label = widgetString(node, "label") ?? "";
  const color = widgetString(node, "color") ?? "secondary";
  const variant = widgetString(node, "variant") ?? "soft";
  if (variant === "dot") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[13px] leading-[18px] text-ink-secondary">
        <span aria-hidden="true" className={cn("size-[7px] shrink-0 rounded-full", BADGE_DOT[color] ?? BADGE_DOT.secondary)} />
        <span dir="auto">{label}</span>
      </span>
    );
  }
  return (
    <span
      dir="auto"
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap font-medium", BADGE_SIZE[widgetString(node, "size") ?? "md"] ?? BADGE_SIZE.md,
        node.pill === false ? "rounded-[7px]" : "rounded-full",
        variant === "solid" ? BADGE_SOLID[color] ?? BADGE_SOLID.secondary : BADGE_INK[color] ?? BADGE_INK.secondary,
        variant === "outline" && "shadow-[inset_0_0_0_1px_color-mix(in_srgb,currentColor_45%,transparent)]",
        variant !== "solid" && variant !== "outline" && "bg-[color:color-mix(in_srgb,currentColor_13%,transparent)]",
      )}
    >
      {label}
    </span>
  );
}

export function WidgetProgress({ node }: { node: WidgetNode }) {
  const percent = Math.round(Math.min(1, Math.max(0, widgetNumber(node, "value") ?? 0)) * 100);
  const label = widgetString(node, "label");
  return (
    <div className="min-w-0">
      <div
        role="progressbar"
        aria-label={t("widget.progress")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={label ? `${percent}%, ${label}` : undefined}
        className="h-1.5 overflow-hidden rounded-full bg-ink/[0.1]"
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3 text-[13px] leading-[18px]">
        <span className="tabular-nums text-ink-secondary">{percent}%</span>
        {label && <span dir="auto" className="min-w-0 truncate text-ink-secondary">{label}</span>}
      </div>
    </div>
  );
}

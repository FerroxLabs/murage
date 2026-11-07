// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fold row under a bot section past eight bots (UX L6B, scale). Closed it
// reads "12 more · 2 working", so the hidden bots' work stays in sight; open it
// reads "Show less". The working dot pulses while any hidden bot works.

import { ChevronDown, ChevronUp } from "lucide-react";
import { t } from "@/lib/i18n";
import type { SidebarSectionAttention } from "@/lib/sidebar-attention";
import { cn } from "@/lib/cn";

/** "2 working · 1 needs you": what the hidden rows are doing, in one line. */
export function railFoldMeta(attention: SidebarSectionAttention): string {
  const parts: string[] = [];
  if (attention.working > 0) parts.push(t("ux.l6b.rail.working", { n: attention.working }));
  if (attention.waiting === 1) parts.push(t("ux.l6b.rail.needYouOne"));
  if (attention.waiting > 1) parts.push(t("ux.l6b.rail.needYouMany", { n: attention.waiting }));
  if (attention.unread > 0) parts.push(t("ux.l6b.rail.unread", { n: attention.unread }));
  return parts.join(" · ");
}

export function RailFoldRow({
  hidden,
  attention,
  open,
  iconsOnly,
  onToggle,
}: {
  hidden: number;
  attention: SidebarSectionAttention;
  open: boolean;
  iconsOnly: boolean;
  onToggle: () => void;
}) {
  const meta = open ? "" : railFoldMeta(attention);
  const label = open ? t("ux.l6b.rail.less") : t("ux.l6b.rail.showMore", { n: hidden });
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      data-rail-fold={open ? "open" : "closed"}
      aria-expanded={open}
      aria-label={meta ? `${label}, ${meta}` : label}
      title={iconsOnly ? (meta ? `${label}, ${meta}` : label) : undefined}
      onClick={onToggle}
      className={cn(
        "relative flex min-h-9 items-center gap-2 rounded-lg text-left text-[12.5px] text-ink-secondary hover:bg-raised/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus",
        iconsOnly ? "justify-center px-1" : "px-3",
      )}
    >
      {iconsOnly ? (
        <span className="font-medium">{open ? <Chevron size={14} aria-hidden="true" /> : t("ux.l6b.rail.moreShort", { n: hidden })}</span>
      ) : (
        <>
          <span className="shrink-0 font-medium">{open ? t("ux.l6b.rail.less") : t("ux.l6b.rail.more", { n: hidden })}</span>
          {meta && <span className="min-w-0 truncate">· {meta}</span>}
          <Chevron size={14} aria-hidden="true" className="ml-auto shrink-0" />
        </>
      )}
      {!open && attention.working > 0 && (
        <span aria-hidden="true" data-working-pulse className="absolute right-1 top-1 size-2 rounded-full bg-success animate-status-pulse" />
      )}
    </button>
  );
}

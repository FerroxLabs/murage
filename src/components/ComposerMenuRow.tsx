// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** One row of the @mention menu: an avatar, the name, a tag, and a line saying what it is. */
export function ComposerMenuRow({
  index, highlighted, leading, name, tag, description, onPick, onHover,
}: {
  index: number;
  highlighted: boolean;
  leading: ReactNode;
  name: string;
  tag: string;
  description?: string;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    <button
      data-mention-index={index}
      role="option"
      aria-selected={highlighted}
      onClick={onPick}
      onMouseEnter={onHover}
      className={cn("flex w-full items-center gap-2.5 px-3 py-2 text-left", highlighted ? "bg-raised-hover" : "")}
    >
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">{name}</span>
        {description ? <span className="block truncate text-xs text-ink-secondary">{description}</span> : null}
      </span>
      <span className="shrink-0 text-xs text-ink-secondary">{tag}</span>
    </button>
  );
}

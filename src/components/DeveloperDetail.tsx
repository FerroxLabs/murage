// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Commands, image references and limits for people who want them (1.0.21 Settings pass): closed until asked for, so a
// card leads with what to do in plain words. A button, not a <details> fold: the regrouped pages keep the old folds out.
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

export function DeveloperDetail({ children, label = "Details for developers", defaultOpen = false }: { children: ReactNode; label?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div data-developer-detail={open ? "open" : "closed"} className="text-[12px] text-ink-secondary">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded text-[12px] text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open && <div className="mt-2 flex flex-col gap-2">{children}</div>}
    </div>
  );
}

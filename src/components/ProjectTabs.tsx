// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { Settings } from "lucide-react";
import type { ProjectTab } from "@/lib/project-tab";
const labels = (tab: ProjectTab): string => t(`projects.tabs.${tab}`);
export function ProjectTabs({ isProject, value, onChange, onSettings, settingsOpen = false, board = true }: {
  isProject: boolean; value: ProjectTab; onChange: (tab: ProjectTab) => void; onSettings: (trigger: HTMLButtonElement) => void; settingsOpen?: boolean; board?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const tabs: ProjectTab[] = isProject ? ["chat", ...(board ? ["board" as const] : []), "overview", "files", "memory", "activity"] : ["chat", "files", "memory"];
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => { if (open) menu.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [open]);
  const buttonClass = "min-h-11 rounded-lg px-3 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
  return <nav aria-label={isProject ? t("projects.tabs.projectViews") : t("projects.tabs.channelViews")} className="relative flex min-w-0 items-center gap-1 px-2">
    <div role="tablist" aria-label={t("projects.tabs.conversationViews")} className="flex min-w-0" onKeyDown={(event) => {
      if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].filter((button) => button.offsetParent !== null);
      const current = buttons.indexOf(event.target as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index]?.focus(); buttons[index]?.click();
    }}>
      {tabs.map((tab) => <button key={tab} type="button" role="tab" aria-selected={value === tab} onClick={() => onChange(tab)}
        className={`${buttonClass} ${value === tab ? "bg-accent/15 text-ink underline decoration-accent underline-offset-4" : "text-ink-secondary hover:bg-raised"} ${tab === "chat" || tab === "board" ? "" : "max-md:hidden"}`}>{labels(tab)}</button>)}
    </div>
    <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className={`${buttonClass} md:hidden`}>
      {value !== "chat" && value !== "board" ? labels(value) : t("projects.tabs.moreViews")}
    </button>
    {open && <div ref={menu} role="menu" aria-label={t("projects.tabs.moreViews")} className="absolute left-3 top-full z-20 min-w-40 rounded-lg border border-hairline bg-card p-1 shadow-lg md:hidden"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
          const i = buttons.indexOf(event.target as HTMLButtonElement);
          buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (i + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
      }}>{tabs.filter((tab) => tab !== "chat" && tab !== "board").map((tab) => <button key={tab} type="button" role="menuitem" className={`${buttonClass} block w-full text-left hover:bg-raised`} onClick={() => { onChange(tab); close(); }}>{labels(tab)}</button>)}</div>}
    <button type="button" aria-label={isProject ? t("projects.tabs.projectSettings") : t("projects.tabs.channelSettings")} aria-haspopup="menu" aria-expanded={settingsOpen} onClick={(event) => onSettings(event.currentTarget)} className={`${buttonClass} ml-auto shrink-0`}><Settings size={16} /></button>
  </nav>;
}

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Memory (1.0.19 page 5 of 14; PAGES-A-astra.md). Seven cards, then a visible "Memory upkeep" section of five.
// The page hosts MemorySection once (one status, one history, one revision) and each card is a slot the section sends its
// piece to (PartsHost), so every control keeps its shipped component, key and default. memory.limit (the monthly learning
// limit) is SETPAGES-B's: it moved to Usage, and the section keeps sending that piece to a `memory.limit` slot.
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import MemorySection from "../../MemorySection";
import { MemoryBrowser } from "../../MemorySettings";
import { PartSlot, PartsHost } from "../../SettingsPrimitives";
import { PageCards } from "../PageCards";
import { deviceGate } from "./page-kit";

// Mount the fold with the page, before the asynchronous memory status arrives:
// Settings clears a landing request as soon as its card anchor exists.
function MemoryBrowserSlot({ children }: { children: ReactNode }) {
  const { state } = useStore();
  return <MemoryBrowser anchor={state.appSettingsAnchor}>{children}</MemoryBrowser>;
}

export function memoryCards({ desktop }: Pick<SettingsPageProps, "desktop">): SettingsPageCard[] {
  const card = (name: string, anchor: string, render: () => ReactNode): SettingsPageCard => ({
    id: `memory.${name}`, anchor, simple: false, render: () => deviceGate(desktop, anchor, render),
  });
  const slot = (name: string, surface = false) => () => <PartSlot id={`memory.${name}`} card={surface} />;
  return [
    card("overview", "memory-heading", slot("overview")),
    card("how-it-learns", "memory-how-heading", slot("how-it-learns")),
    card("bots", "memory-bots-heading", slot("bots")),
    card("learned", "memory-learned-heading", slot("learned")),
    card("mode", "memory-mode-heading", slot("mode", true)),
    card("people", "memory-people-heading", () => <MemoryBrowserSlot><PartSlot id="memory.people" card /></MemoryBrowserSlot>),
    card("import", "memory-import-heading", slot("import", true)),
    // The "Memory upkeep" section starts with its first card and stays visible to the end of the page.
    card("connection", "memory-connection-heading", () => (
      <>
        <h2 className="pt-2 text-[15px] font-medium text-ink">{t("settings.l2.upkeep")}</h2>
        <PartSlot id="memory.connection" card />
      </>
    )),
    card("audience", "memory-audience-heading", slot("audience", true)),
    card("procedures", "memory-procedures-heading", slot("procedures", true)),
    card("reindex", "memory-reindex-heading", slot("reindex", true)),
    card("health", "memory-health-heading", slot("health", true)),
  ];
}

export default function MemoryPage({ mode, desktop }: SettingsPageProps) {
  return (
    <PartsHost>
      {desktop === true && <MemorySection cards />}
      <PageCards cards={memoryCards({ desktop })} mode={mode} />
    </PartsHost>
  );
}

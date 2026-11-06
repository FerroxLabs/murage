// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Bring what you already use (COMPETITOR-GAP rows 61 and 85): two doors into
// flows that already exist. A Grok Bot comes in through the Team library Import
// tab (server/grok-import.ts); what another assistant knows comes in through
// Settings > Memory > Learn about me. Pressing an entry only navigates. Nothing
// is imported, kept or switched, and the engine is never touched.
import { useId } from "react";
import { t } from "@/lib/i18n";
import { DISCARD_SETTINGS_CHANGES, settingsDrafts } from "@/lib/settings-drafts";
import { useStore, type Action } from "@/state/store";
import { FIRST_RUN_CHIP, FIRST_RUN_FOCUS } from "./FirstRunChrome";
import { LAM_ANCHOR } from "./ExportPasteNote";

export type BringYourAiFlow = "grok" | "learn";

/** Closing Settings for the Grok import asks first when About me or House rules
 *  hold unsaved words, the same guard as Settings' own close (SettingsModal). */
function leaveSettings(): boolean {
  if (settingsDrafts.anyUnsaved() && !window.confirm(DISCARD_SETTINGS_CHANGES)) return false;
  settingsDrafts.clear();
  return true;
}

/** Navigation only. Importing and reviewing stay in their existing screens. */
export function openBringYourAi(flow: BringYourAiFlow, dispatch: (action: Action) => void, canLeave: () => boolean = leaveSettings) {
  if (flow === "grok") {
    if (!canLeave()) return;
    dispatch({ type: "toggleAppSettings", open: false });
    dispatch({ type: "showTeamLibrary", view: "bots", tab: "import" });
  } else {
    dispatch({ type: "toggleAppSettings", open: true, section: "memory", anchor: LAM_ANCHOR });
  }
}

/** `settingControl` marks the first button as the card's one landing control (designs/UX-L3A2-LANDING-1017.md). */
function Buttons({ className, settingControl }: { className: string; settingControl?: string }) {
  const { dispatch } = useStore();
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" data-setting-control={settingControl} className={className} onClick={() => openBringYourAi("grok", dispatch)}>{t("bringYourAi.grok")}</button>
      <button type="button" className={className} onClick={() => openBringYourAi("learn", dispatch)}>{t("bringYourAi.learn")}</button>
    </div>
  );
}

/** Settings > General, under About me. Always there on the desktop. */
export function BringYourAi() {
  const heading = useId();
  return (
    <section aria-labelledby={heading} data-testid="bring-your-ai" className="space-y-2 rounded-xl border border-hairline/40 p-3">
      <h3 id={heading} className="text-[14px] font-medium text-ink">{t("bringYourAi.title")}</h3>
      <p className="text-[13px] text-ink-secondary">{t("bringYourAi.lead")}</p>
      <Buttons className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`} settingControl="bring-your-ai-heading" />
    </section>
  );
}

/** One quiet row in the first-run Next card: a choice among the others, never a step. */
export function BringYourAiRow() {
  return (
    <li data-testid="bring-your-ai-row" className="grid gap-2 rounded-xl border border-hairline/40 bg-inset px-3 py-2.5">
      <span className="min-w-0">
        <span className="block text-[14px] font-medium text-ink">{t("bringYourAi.title")}</span>
        <span className="block text-[12.5px] leading-relaxed text-ink-secondary">{t("bringYourAi.firstRunLine")}</span>
      </span>
      <Buttons className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`} />
    </li>
  );
}

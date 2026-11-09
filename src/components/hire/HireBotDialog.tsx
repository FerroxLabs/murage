// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-L6A part 2: hire a bot in one sentence (UX-FIRSTRUN-SCALE-1012 sections
// 1.2 and 1.8; build plan L6A part 2). One box for the job, a suggested name
// the owner can change, one line saying how the bot starts, and
// [Browse templates] [Cancel] [Hire this bot]. The new bot opens in its own
// chat with the sentence as its job. The engine is the server's birth rule
// (BIRTH-FUIGO), never picked here.
//
// The level line names the level a new bot really starts on: a new bot has
// no auto-approve, so `permissionModeOf` reads it as Ask (src/lib/permission-mode.ts).
//
// No Undo toast: the shared Undo host is local-only and refuses anything that
// needs a request (src/lib/undo.ts), and putting a hire back is an archive
// request. The bot is archived from its row like any other.
import { LayerSurface } from "@/components/LayerSurface";
import type { LoadedLayerProps } from "@/components/LazyOverlay";
import { LazyOverlay } from "@/components/LazyOverlay";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "@/components/ui/BoxShell";
import { failureText } from "@/components/FirstRunChrome";
import { retryableLazy } from "@/components/LazyBoundary";
import type { TeamImportResult } from "@/components/TeamLibraryPanel";
import { track } from "@/lib/analytics";
import { levelName } from "@/lib/fold-words";
import { HIRE_NAME_MAX, HIRE_SENTENCE_MAX, hireProfile, hireReady, suggestHireName } from "@/lib/hire-defaults";
import { useFocusTrap } from "@/lib/focus-trap";
import { t } from "@/lib/i18n";
import { permissionModeOf } from "@/lib/permission-mode";
import { useStore } from "@/state/store";

const NewFromTemplateDialog = retryableLazy(() => import("@/components/NewFromTemplateDialog").then((module) => ({ default: module.NewFromTemplateDialog })));

// Anchored to the visual viewport (--vvh) and capped by it on a phone too, so
// the bottom sheet stays above the software keyboard. Exported for
// phone-cards.human.spec.ts, which measures them with a keyboard up.
export const HIRE_BACKDROP = "overlay-inset fixed inset-x-0 top-0 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/40 max-md:items-end";
export const HIRE_BOX = "max-h-[min(560px,calc(var(--vvh,100dvh)-32px))] w-[min(520px,calc(100vw-32px))] rounded-2xl border border-hairline bg-panel shadow-2xl max-md:max-h-[min(85dvh,calc(var(--vvh,100dvh)-0.5rem))] max-md:w-full max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0";

export interface HireBotDialogProps {
  onClose: () => void;
  /** Where Browse templates goes. Absent: the template chooser opens here. */
  onBrowseTemplates?: () => void;
  /** Where focus goes when the sheet closes. The chooser button that opened Hire is gone by then, so a caller passes
   *  a control that stays (Astra L6A-HIRE-FOCUS-RETURN). Absent: whatever had focus when the sheet opened. */
  returnFocusTo?: HTMLElement | null;
  /** A team or bot made from a template in the chooser opened here. */
  onTemplateCreated?: (result: TeamImportResult) => void;
}

export function HireBotDialog({ layerLifecycle, onClose, onBrowseTemplates, onTemplateCreated, returnFocusTo }: HireBotDialogProps & { layerLifecycle?: LoadedLayerProps }) {
  const { state, dispatch } = useStore();
  const taken = useMemo(() => state.bots.map((bot) => bot.name), [state.bots]);
  const [sentence, setSentence] = useState("");
  const [name, setName] = useState(() => suggestHireName(taken));
  const [tried, setTried] = useState(false);
  const [hiring, setHiring] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [failed, setFailed] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  // A hire still in flight when this sheet was dismissed must not close or
  // touch a sheet opened after it.
  const live = useRef(true);
  // Set on mount as well as cleared on unmount, so a Strict Mode effect replay keeps the sheet live.
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // Focus stays inside the sheet, starts in the job box, Escape closes, and
  // focus goes back to whatever opened it (src/lib/focus-trap.ts).

  const layer = useFocusTrap(dialog, !browsing, { name: "hire-bot", kind: "dialog", initialFocus: "#hire-bot-job", onEscape: onClose, returnFocusTo: layerLifecycle?.opener ?? returnFocusTo ?? undefined, lease: layerLifecycle?.lease });
  if (browsing) {
    return (
      <LazyOverlay opener={layerLifecycle?.opener ?? returnFocusTo} name="hire-bot-templates" kind="dialog" covers="while-loading" onRetry={NewFromTemplateDialog.retry} onDismiss={onClose}>
          {loadedLayer => (<NewFromTemplateDialog.Component layerLifecycle={loadedLayer}
            kind="bot"
            onClose={loadedLayer.dismiss}
            onBlank={() => { track("bot_created"); dispatch({ type: "newBot" }); onClose(); }}
            onOpenFile={() => { dispatch({ type: "showTeamLibrary", tab: "import" }); onClose(); }}
            onCreated={(result) => { onTemplateCreated?.(result); onClose(); }}
          />)}
      </LazyOverlay>
    );
  }

  const ready = hireReady(sentence);
  const shownName = name.trim() || suggestHireName(taken);
  const hire = () => {
    setTried(true);
    if (!ready || hiring) return;
    setHiring(true);
    setFailed("");
    // The sheet and its words stay until the server has made the bot; a
    // refusal (offline, workspace full) is said here with the draft kept.
    dispatch({
      type: "newBot",
      profile: hireProfile(sentence, name, taken),
      onSettled: (error) => {
        if (!live.current) return;
        if (error === null) {
          track("bot_created");
          onClose();
          return;
        }
        setHiring(false);
        setFailed(failureText(error, t("ux.l6a.hire.failed")));
      },
    });
  };

  return <LayerSurface handle={layer}><div className={HIRE_BACKDROP} data-phone-bottom-sheet onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="hire-bot-title" data-hire-bot
        className={`${BOX_FRAME} ${HIRE_BOX}`}>
        <BoxHead className="border-b border-hairline/40 px-5 py-3">
          <h2 id="hire-bot-title" className="text-[17px] font-semibold text-ink">{t("ux.l6a.hire.title")}</h2>
          <button type="button" aria-label={t("ux.l6a.hire.close")} onClick={onClose} className="flex size-9 items-center justify-center rounded-lg hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:size-11"><X size={17} /></button>
        </BoxHead>
        <BoxBody className="px-5 py-4">
          <form id="hire-bot-form" onSubmit={(event) => { event.preventDefault(); hire(); }}>
            <label htmlFor="hire-bot-job" className="block text-[14px] font-medium text-ink">{t("ux.l6a.hire.ask")}</label>
            <textarea
              id="hire-bot-job"
              rows={3}
              maxLength={HIRE_SENTENCE_MAX}
              value={sentence}
              placeholder={t("ux.l6a.hire.placeholder")}
              aria-describedby="hire-bot-level hire-bot-short"
              onChange={(event) => setSentence(event.target.value)}
              className="mt-2 w-full resize-none rounded-lg border border-hairline bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
            <p id="hire-bot-short" role="status" className="mt-1 text-[12.5px] text-warning empty:hidden">{tried && !ready ? t("ux.l6a.hire.tooShort") : ""}</p>
            <label htmlFor="hire-bot-name" className="mt-3 block text-[13px] text-ink-secondary">{t("ux.l6a.hire.nameLabel")}</label>
            <input
              id="hire-bot-name"
              value={name}
              maxLength={HIRE_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-lg border border-hairline bg-inset px-3 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
            <p role="alert" className="mt-3 text-[13px] text-warning empty:hidden">{failed}</p>
            <p id="hire-bot-level" className="mt-3 text-[13px] leading-relaxed text-ink-secondary">
              {t("ux.l6a.hire.level", { name: shownName, level: levelName(permissionModeOf({ autoApprove: false, fullAccess: false })) })}
            </p>
          </form>
        </BoxBody>
        <BoxFoot className="flex flex-wrap items-center gap-3 border-t border-hairline/40 px-5 py-3">
          {/* Off while a hire is in flight: a late result must not close the chooser this opened (Astra L6A-HIRE-STALE-NAV). */}
          <button type="button" disabled={hiring} onClick={() => (onBrowseTemplates ? onBrowseTemplates() : setBrowsing(true))}
            className="min-h-11 text-[13.5px] text-ink-secondary hover:text-ink disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {t("ux.l6a.hire.browse")}
          </button>
          <span className="flex-1" />
          <button type="button" onClick={onClose}
            className="min-h-11 rounded-lg px-4 text-[14px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {t("ux.l6a.hire.cancel")}
          </button>
          <button type="submit" form="hire-bot-form" disabled={hiring} aria-disabled={!ready}
            className="min-h-11 rounded-lg bg-accent px-4 text-[14px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-60 aria-disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {hiring ? t("ux.l6a.hire.going") : t("ux.l6a.hire.go")}
          </button>
        </BoxFoot>
      </div>
    </div></LayerSurface>;
}

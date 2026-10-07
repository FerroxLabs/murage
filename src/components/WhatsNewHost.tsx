// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where each What's new shortcut goes. Mounted by Sidebar.tsx, which owns the
// You menu entry that reopens the page (Settings > Help & updates asks it to,
// through lib/app-events.ts). The dialog itself, art included,
// loads the first time the page opens, so it stays out of the first paint.
import { Suspense } from "react";
import { useStore, type Action } from "@/state/store";
import { whatsNewPage } from "@/lib/whats-new";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
import type { WhatsNewAction } from "./WhatsNewDialog";

const Dialog = retryableLazy(() => import("./WhatsNewDialog").then((module) => ({ default: module.WhatsNewDialog })));

/** Wait for an element that the next render puts on screen, then run. */
function whenRendered(find: () => Element | null, then: (element: Element) => void, frames = 60): void {
  const element = find();
  if (element) then(element);
  else if (frames > 0) requestAnimationFrame(() => whenRendered(find, then, frames - 1));
}

/** A setting in an open Settings section: in view, and focused when it can take focus. */
function showSetting(element: Element): void {
  if (!(element instanceof HTMLElement)) return;
  element.scrollIntoView({ block: "start" });
  element.focus();
  // Settings focuses its own dialog as it mounts; take focus back once.
  if (document.activeElement !== element) requestAnimationFrame(() => element.focus());
}

/** The shortcuts, apart from the React tree so they can be tested. Returns
 *  false when the shortcut goes nowhere, so the host keeps the view as it is. */
export function runWhatsNewAction(action: WhatsNewAction, dispatch: (action: Action) => void): boolean {
  switch (action) {
    // Every team and who is on it, rooms included.
    case "teams":
    case "rooms":
      dispatch({ type: "showTeamMap" });
      return true;
    // Settings > Images: the model and its limits (Setup), and the library
    // of saved blocks and reference packs (its own tab since 0.1.62).
    case "shapes":
      dispatch({ type: "toggleAppSettings", open: true, section: "images" });
      whenRendered(() => document.getElementById("image-settings-heading"), showSetting);
      return true;
    case "blocks":
    case "packs":
      dispatch({ type: "toggleAppSettings", open: true, section: "images" });
      whenRendered(() => document.getElementById("images-tab-library"), (tab) => {
        if (tab instanceof HTMLElement) tab.click();
        showSetting(tab);
      });
      return true;
    case "gemini":
      dispatch({ type: "toggleAppSettings", open: true, section: "models" });
      return true;
    // Settings > Bot defaults > Channel turns: the no activity limit, the one
    // clock left, which counts silence rather than working time.
    case "longwork":
      dispatch({ type: "toggleAppSettings", open: true, section: "botDefaults" });
      whenRendered(() => document.getElementById("room-turn-timeout"), showSetting);
      return true;
  }
}

export function WhatsNewHost({
  whatsNew,
  onNavigate,
}: {
  whatsNew: { open: boolean; close: () => void };
  /** Closes the sidebar drawer on a narrow window, so the destination shows. */
  onNavigate: () => void;
}) {
  const { dispatch } = useStore();
  const page = whatsNewPage();
  if (!page || !whatsNew.open) return null;
  return (
    <LazyBoundary onRetry={Dialog.retry} onDismiss={whatsNew.close}>
      <Suspense fallback={null}>
        <Dialog.Component
          open
          releaseNotesUrl={page.releaseNotesUrl}
          onClose={whatsNew.close}
          onAction={(action) => {
            whatsNew.close();
            if (runWhatsNewAction(action, dispatch)) onNavigate();
          }}
        />
      </Suspense>
    </LazyBoundary>
  );
}

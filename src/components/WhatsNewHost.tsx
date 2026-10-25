// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where each What's new shortcut goes. Mounted by Sidebar.tsx, which owns the
// You menu entry that reopens the page (Settings > About & updates asks it to,
// through lib/app-events.ts). The dialog itself, art included,
// loads the first time the page opens, so it stays out of the first paint.
import { Suspense } from "react";
import { useStore, type Action } from "@/state/store";
import { whatsNewTarget } from "@/lib/whats-new";
import { MURAGE_FOR_CHROME_STORE_URL } from "@/lib/chrome-web-store";
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

/** A page outside the app, in the system browser. Loaded on use, so it stays out of the first paint. */
function openOutside(url: string): void {
  void import("@/lib/open-external").then((module) => module.openExternalPage(url, "Murage could not open the Chrome Web Store.")).catch(() => {});
}

/** The shortcuts, apart from the React tree so they can be tested. Returns
 *  false when the shortcut goes nowhere in the app (Murage for Chrome opens
 *  its store page outside), so the host keeps the view as it is. */
export function runWhatsNewAction(action: WhatsNewAction, dispatch: (action: Action) => void, openPage: (url: string) => void = openOutside): boolean {
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
    // 1.0.2. Settings > Bot defaults, at the switch for who answers in channels.
    // It lives under the page's Advanced, so the anchor opens that first.
    case "routing":
      dispatch({ type: "toggleAppSettings", open: true, section: "botDefaults", anchor: "room-routing-label" });
      return true;
    // Settings > Engines, where each engine is set up.
    case "engines":
      dispatch({ type: "toggleAppSettings", open: true, section: "engines" });
      return true;
    // Murage for Chrome's Chrome Web Store page, where the person adds it.
    // Settings has no store link; the setup card and each bot's Browser panel
    // carry one only once the extension is wanted.
    case "chrome":
      openPage(MURAGE_FOR_CHROME_STORE_URL);
      return false;
    // Settings > Memory: what needs you, and Flux Memory for each bot.
    case "memory":
    case "speed":
      dispatch({ type: "toggleAppSettings", open: true, section: "memory" });
      return true;
    // Settings > Computer & browser, at the per-bot desktops limit.
    case "desktops":
      dispatch({ type: "toggleAppSettings", open: true, section: "computer" });
      whenRendered(() => document.getElementById("local-vm-max-instances"), showSetting);
      return true;
    // The team library, on its Teams view, Ferrox Labs teams included.
    case "library":
      dispatch({ type: "showTeamLibrary", view: "teams" });
      return true;
    // 1.0.6. All chats: every conversation in one searchable list.
    case "allChats":
      dispatch({ type: "showAllChats" });
      return true;
    // The library's Bots view, where Ticket Triage, a draft-only bot, is.
    case "draftOnly":
      dispatch({ type: "showTeamLibrary", view: "bots" });
      return true;
    // The Team map: every team and room, and who is in each.
    case "venues":
      dispatch({ type: "showTeamMap" });
      return true;
    case "ownWords":
      dispatch({ type: "toggleAppSettings", open: true, section: "memory" });
      return true;
    case "fuigo":
      dispatch({ type: "toggleAppSettings", open: true, section: "engines" });
      return true;
    case "backups":
      dispatch({ type: "toggleAppSettings", open: true, section: "backups" });
      return true;
    // Settings > Bot defaults > Channel turns: the no activity limit, the one
    // clock left, which counts silence rather than working time.
    case "longwork":
      dispatch({ type: "toggleAppSettings", open: true, section: "botDefaults", anchor: "room-turn-timeout" });
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
  const target = whatsNewTarget();
  if (target.kind !== "page" || !whatsNew.open) return null;
  return (
    <LazyBoundary onRetry={Dialog.retry} onDismiss={whatsNew.close}>
      <Suspense fallback={null}>
        <Dialog.Component
          open
          version={target.version}
          releaseNotesUrl={target.releaseNotesUrl}
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

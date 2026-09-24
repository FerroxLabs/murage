// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where each What's new shortcut goes. Mounted by Sidebar.tsx, which owns the
// New Project panel and the Tools menu entry that reopens the page.
import { useStore, type AppState, type Action } from "@/state/store";
import { requestCall } from "@/lib/call";
import { whatsNewPage, whatsNewTargetBot } from "@/lib/whats-new";
import { FOCUS_COMPOSER_EVENT } from "@/lib/composer-focus";
import { WhatsNewDialog, type WhatsNewAction } from "./WhatsNewDialog";

/** Wait for an element that the next render puts on screen, then run. */
function whenRendered(find: () => Element | null, then: (element: Element) => void, frames = 60): void {
  const element = find();
  if (element) then(element);
  else if (frames > 0) requestAnimationFrame(() => whenRendered(find, then, frames - 1));
}

/** The shortcuts, apart from the React tree so they can be tested. */
export function runWhatsNewAction(
  action: WhatsNewAction,
  state: Pick<AppState, "bots" | "groups" | "selectedId">,
  dispatch: (action: Action) => void,
  openNewProject: () => void,
): void {
  const target = whatsNewTargetBot(state.bots, state.selectedId);
  const showBot = () => {
    if (!target) return false;
    if (state.selectedId !== target.id) dispatch({ type: "select", id: target.id });
    return true;
  };
  switch (action) {
    case "call":
      // The bot's own call button answers, so missing voice setup gets the
      // same help a click would give.
      if (showBot()) requestCall(target!.id);
      return;
    case "project":
      openNewProject();
      return;
    case "search":
      dispatch({ type: "toggleAppSettings", open: true, section: "connections" });
      whenRendered(() => document.getElementById("web-search-settings-title"), (heading) => heading.scrollIntoView({ block: "start" }));
      return;
    case "skills":
      dispatch({ type: "toggleAppSettings", open: true, section: "skills" });
      return;
    case "houseRules":
      dispatch({ type: "toggleAppSettings", open: true, section: "houseRules" });
      return;
    case "fullAccess":
      if (showBot()) dispatch({ type: "toggleSettings", open: true, intent: { section: "permissions" } });
      return;
    case "shapes":
      if (showBot()) dispatch({ type: "toggleSettings", open: true, intent: { section: "shapes" } });
      return;
    case "commands": {
      // Any open chat has a composer; with none open, the target bot's.
      const chatOpen = state.bots.some((bot) => bot.id === state.selectedId) || state.groups.some((group) => group.id === state.selectedId);
      if (!chatOpen && !showBot()) return;
      requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT, { detail: { slash: true } }))));
      return;
    }
  }
}

export function WhatsNewHost({
  whatsNew,
  onNewProject,
  onNavigate,
}: {
  whatsNew: { open: boolean; close: () => void };
  onNewProject: () => void;
  /** Closes the sidebar drawer on a narrow window, so the destination shows. */
  onNavigate: () => void;
}) {
  const { state, dispatch } = useStore();
  const page = whatsNewPage();
  if (!page) return null;
  return (
    <WhatsNewDialog
      open={whatsNew.open}
      releaseNotesUrl={page.releaseNotesUrl}
      onClose={whatsNew.close}
      onAction={(action) => {
        whatsNew.close();
        if (action !== "project") onNavigate();
        runWhatsNewAction(action, state, dispatch, onNewProject);
      }}
    />
  );
}

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where each What's new shortcut goes. Mounted by Sidebar.tsx, which owns the
// Tools menu entry that reopens the page.
import { useStore, type Action } from "@/state/store";
import { whatsNewPage } from "@/lib/whats-new";
import { WhatsNewDialog, type WhatsNewAction } from "./WhatsNewDialog";

/** Wait for an element that the next render puts on screen, then run. */
function whenRendered(find: () => Element | null, then: (element: Element) => void, frames = 60): void {
  const element = find();
  if (element) then(element);
  else if (frames > 0) requestAnimationFrame(() => whenRendered(find, then, frames - 1));
}

/** The off-site section of Settings > Backups: opened, in view and focused. */
function showOffsite(toggle: Element): void {
  if (!(toggle instanceof HTMLElement)) return;
  if (toggle.getAttribute("aria-expanded") === "false") toggle.click();
  toggle.scrollIntoView({ block: "start" });
  toggle.focus();
}

/** The shortcuts, apart from the React tree so they can be tested. Returns
 *  false when the shortcut goes nowhere, so the host keeps the view as it is. */
export function runWhatsNewAction(action: WhatsNewAction, dispatch: (action: Action) => void): boolean {
  switch (action) {
    case "backups":
      dispatch({ type: "toggleAppSettings", open: true, section: "backups" });
      return true;
    case "offsite":
      dispatch({ type: "toggleAppSettings", open: true, section: "backups" });
      whenRendered(() => document.getElementById("backup-offsite-toggle"), showOffsite);
      return true;
    case "routines":
      dispatch({ type: "showRoutines" });
      return true;
    case "phone":
      dispatch({ type: "toggleAppSettings", open: true, section: "companion" });
      return true;
    case "aboutMe":
      dispatch({ type: "toggleAppSettings", open: true, section: "aboutMe" });
      return true;
    case "delete":
      // Nothing in the app explains deleting, and the docs section on it
      // does not cover engine history, so this one only closes the page.
      return false;
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
  if (!page) return null;
  return (
    <WhatsNewDialog
      open={whatsNew.open}
      releaseNotesUrl={page.releaseNotesUrl}
      onClose={whatsNew.close}
      onAction={(action) => {
        whatsNew.close();
        if (runWhatsNewAction(action, dispatch)) onNavigate();
      }}
    />
  );
}

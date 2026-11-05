// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The group room view is its own chunk (BUNDLE-HEADROOM-1017). It loads once
// the app is idle, and earlier when a pointer or keyboard focus reaches a room
// in the rail, so the room is usually ready by the click and its composer
// takes the first keystroke.
let groupView: Promise<typeof import("@/components/GroupView")> | null = null;

export function loadGroupView(): Promise<typeof import("@/components/GroupView")> {
  if (!groupView) {
    // a failed fetch is forgotten so the next open fetches again
    groupView = import("@/components/GroupView").catch((cause) => { groupView = null; throw cause; });
  }
  return groupView;
}

/** Warm the room view without waiting on it; a failure shows on open, not here. */
export function preloadGroupView(): void {
  void loadGroupView().catch(() => undefined);
}

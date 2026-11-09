// SPDX-License-Identifier: AGPL-3.0-or-later
// Main-side channels for the start-up screens (FIRSTRUN-1019 sections 1.5, 2.1 and 2.2).
//
//   startup-picture:save          the renderer hands over the two composed faces and the next tip; main validates and saves them
//   startup-picture:session-tip   the tip index the saved picture held when this start began (null when there was none): the point the
//                                 renderer rotates from, so the daily tip moves on by one each start and survives a restart (slice B)
//   startup:pending-whats-new     has the person pressed "What's new" on the update screen and not had it shown yet
//   startup:ack-whats-new         the renderer has shown it: clear the request
//   startup:whats-new             main -> renderer event, sent while a request is pending and the page can hear it
//
// `gate` is the owned-main gate from createOwnedMainIpc, so every handler here is refused before it runs unless the sender
// is the main Murage window (a subframe, another window or a navigated-away origin gets the gate's refusal).

import { readStartupPicture, writeStartupPicture } from "./startup-picture.mjs";

export function registerStartupIpc({ gate, userData, getMainContents, writePicture = writeStartupPicture, readPicture = readStartupPicture } = {}) {
  let pending = false;
  // The tip this start showed. Read once, and before anything is saved (a save latches it first), so a rewrite made later in the
  // same session can never move the rotation point. undefined means not read yet.
  let sessionTip;
  const latchSessionTip = () => {
    if (sessionTip === undefined) {
      try { sessionTip = readPicture({ userData })?.tipNext ?? null; } catch { sessionTip = null; }
    }
    return sessionTip;
  };
  /** Tell the main window, if it exists and its page can hear us. A press that arrives earlier is kept and delivered on load. */
  const deliver = () => {
    if (!pending) return false;
    try {
      const contents = getMainContents?.();
      if (!contents || contents.isDestroyed?.() || contents.isLoadingMainFrame?.()) return false;
      contents.send("startup:whats-new");
      return true;
    } catch { return false; }
  };
  gate.handle("startup-picture:save", (_event, payload) => { latchSessionTip(); return writePicture({ userData, picture: payload }); });
  gate.handle("startup-picture:session-tip", () => latchSessionTip());
  gate.handle("startup:pending-whats-new", () => pending);
  gate.handle("startup:ack-whats-new", () => { pending = false; return true; });
  return {
    /** The person pressed "What's new" on the update screen: only sets the request, then delivers it when it can. */
    requestWhatsNew() { pending = true; deliver(); },
    deliver,
    get pending() { return pending; },
  };
}

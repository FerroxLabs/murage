// Who may start a call with which bot (voice-host and call-note).
//
// Calls were desktop-only because the voice-host snapshot includes the
// Inbox. C1 made the Inbox safe to show a proven phone, scoped to the
// threads its sidebar shows, so the same scoping now decides calls. A
// hidden bot answers "not-found", never "forbidden": the phone must not be
// able to tell a hidden bot from a missing one.
import type { InboxDoor, InboxRosterStore } from "../inbox-access.ts";
import { visibleToCompanion } from "../sse-visibility.ts";

export type CallAccess = "allowed" | "forbidden" | "not-found";

export function callAccess(store: InboxRosterStore, door: InboxDoor, botId: string): CallAccess {
  if (door === "unproven") return "forbidden";
  if (door === "desktop") return "allowed";
  return visibleToCompanion(store, { scope: "bot", botId }) ? "allowed" : "not-found";
}

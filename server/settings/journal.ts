// J0 Changed-recently journal (C12).
// Owner: lane core (Settings v10 BUILD-PLAN §3). Seated by core as a no-op stub; core fills it.
import type { SettingsV10Router } from "./v10-router.ts";

export function registerJournalRoutes(router: SettingsV10Router): void {
  router.add("core", () => false);
}

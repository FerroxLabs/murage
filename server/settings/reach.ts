// R0 effective access read (C7).
// Owner: lane access (Settings v10 BUILD-PLAN §3). Seated by core as a no-op stub; access fills it.
import type { SettingsV10Router } from "./v10-router.ts";

export function registerReachRoutes(router: SettingsV10Router): void {
  router.add("access", () => false);
}

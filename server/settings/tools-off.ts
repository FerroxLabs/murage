// T2/G4 tool on/off truth (C16).
// Owner: lane tools (Settings v10 BUILD-PLAN §3). Seated by core as a no-op stub; tools fills it.
import type { SettingsV10Router } from "./v10-router.ts";

export function registerToolsOffRoutes(router: SettingsV10Router): void {
  router.add("tools", () => false);
}

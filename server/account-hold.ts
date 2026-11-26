// AG0 account hold at Sign in.
// Owner: lane access (Settings v10 BUILD-PLAN §3). Seated by core as a no-op stub; access fills it.
import type { SettingsV10Router } from "./settings/v10-router.ts";

export function registerAccountHoldRoutes(router: SettingsV10Router): void {
  router.add("access", () => false);
}

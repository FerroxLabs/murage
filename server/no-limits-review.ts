// G1 (v7-v10) Move all plan, digest and recovery (C2).
// Owner: lane core (Settings v10 BUILD-PLAN §3). Seated by core as a no-op stub; core fills it.
import type { SettingsV10Router } from "./settings/v10-router.ts";

export function registerNoLimitsReviewRoutes(router: SettingsV10Router): void {
  router.add("core", () => false);
}

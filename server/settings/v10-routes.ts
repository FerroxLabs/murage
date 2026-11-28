// Settings v10 route registrations (owner: core). One line per lane module; each module's own lane fills it.
import { SettingsV10Router, type SettingsV10Deps } from "./v10-router.ts";
import { registerAccountHoldRoutes } from "../account-hold.ts";
import { registerReachRoutes } from "./reach.ts";
import { registerWebReadRoutes } from "./web-read.ts";
import { registerToolsOffRoutes } from "./tools-off.ts";
import { registerSkillsBulkRoutes } from "../skills-bulk.ts";
import { registerNewBotLevelRoutes } from "./new-bot-level.ts";
import { registerReplyLanguageRoutes } from "./reply-language.ts";
import { registerJournalRoutes } from "./journal.ts";
import { registerNoLimitsReviewRoutes } from "../no-limits-review.ts";
import { registerSaidYesRoutes } from "./said-yes.ts";

export function settingsV10Router(deps: SettingsV10Deps): SettingsV10Router {
  const router = new SettingsV10Router();
  registerAccountHoldRoutes(router);   // access
  registerReachRoutes(router);         // access
  registerWebReadRoutes(router);       // tools
  registerToolsOffRoutes(router);      // tools
  registerSkillsBulkRoutes(router);    // skills
  registerNewBotLevelRoutes(router);   // core
  registerReplyLanguageRoutes(router); // core
  registerJournalRoutes(router, deps);   // core
  registerNoLimitsReviewRoutes(router, { move: deps.noLimitsMove }); // core
  registerSaidYesRoutes(router, deps);  // core
  return router;
}

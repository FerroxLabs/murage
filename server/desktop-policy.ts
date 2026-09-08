/** Direct administration requires the renderer's per-launch proof. Keep this
 * inventory at the HTTP boundary, before parsing bodies or performing work.
 * Normal conversation sends and owner-bound single-use confirmations are
 * separate from changing durable execution authority. */
export const DESKTOP_AUTHORITY_ROUTES: ReadonlyArray<{
  methods: readonly string[];
  path: RegExp;
  purpose: string;
}> = [
  { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], path: /^\/api\/memory(?:\/|$)/, purpose: "memory authority, sharing, retention and configuration" },
  { methods: ["PATCH", "PUT"], path: /^\/api\/config$/, purpose: "application, credentials, browser and computer configuration" },
  { methods: ["PATCH", "DELETE"], path: /^\/api\/bots\/[\w-]+$/, purpose: "bot authority, engine, working folder and deletion" },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/always-allow$/, purpose: "persistent permission grants" },
  { methods: ["PATCH", "DELETE"], path: /^\/api\/groups\/[\w-]+$/, purpose: "room configuration and deletion" },
  { methods: ["PATCH"], path: /^\/api\/groups\/[\w-]+\/setup$/, purpose: "room working folder and execution setup" },
  { methods: ["POST"], path: /^\/api\/teams\/(import|export)$/, purpose: "team configuration and filesystem import/export" },
  { methods: ["POST"], path: /^\/api\/packages\/import$/, purpose: "review and commit a local package archive" },
  { methods: ["POST"], path: /^\/api\/packages\/export$/, purpose: "review and export selected local skill files" },
  { methods: ["POST"], path: /^\/api\/starter-profiles$/, purpose: "review and install a local starter profile" },
  { methods: ["GET", "POST"], path: /^\/api\/telegram\/(status|pair|resume|revoke)$/, purpose: "pair and revoke the Telegram owner channel" },
  { methods: ["POST"], path: /^\/api\/team-library\/github$/, purpose: "download team packages to disk" },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/(assistant-profile|skills(?:\/library)?)$/, purpose: "install executable instructions" },
  { methods: ["PATCH", "DELETE"], path: /^\/api\/bots\/[\w-]+\/skills\/[^/]+$/, purpose: "enable, change or delete installed skills" },
  { methods: ["PUT"], path: /^\/api\/(section-context|bots\/[\w-]+\/memory)$/, purpose: "persistent workspace instructions" },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/checkpoints\/restore$/, purpose: "restore files in a working folder" },
  { methods: ["POST"], path: /^\/api\/local-computer\/(pull|run|start|stop|remove|interrupt|screenshot)$/, purpose: "shared host computer lifecycle and capture" },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/local-computer\/(run|stop|remove|screenshot)$/, purpose: "per-bot host computer lifecycle and capture" },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/computer\/(provision|sleep|exec|screenshot|remove|control|viewer-close)$/, purpose: "cloud computer provisioning and control" },
  { methods: ["POST"], path: /^\/api\/cli-test$/, purpose: "execute a supplied engine binary" },
  { methods: ["POST"], path: /^\/api\/engine-setup-command$/, purpose: "resolve a trusted engine setup recipe" },
  { methods: ["GET", "POST"], path: /^\/api\/engine-management\/[\w.-]+$/, purpose: "inspect and install managed engines" },
  { methods: ["GET", "PUT"], path: /^\/api\/bots\/[\w-]+\/access$/, purpose: "review scoped connected-app authority" },
  { methods: ["PATCH"], path: /^\/api\/instances\/[\w.-]+$/, purpose: "change engine launch configuration" },
  { methods: ["POST"], path: /^\/api\/mcp\/servers(?:\/[a-z][a-z0-9_-]{0,31}\/test)?$/, purpose: "install and probe MCP servers" },
  { methods: ["PUT", "PATCH", "DELETE"], path: /^\/api\/mcp\/servers\/[a-z][a-z0-9_-]{0,31}$/, purpose: "change MCP launch configuration" },
  { methods: ["POST"], path: /^\/api\/(routines|calendar-calls)$/, purpose: "create a durable spawn schedule" },
  { methods: ["PATCH", "DELETE"], path: /^\/api\/(routines|calendar-calls)\/[\w-]+$/, purpose: "change a durable spawn schedule" },
  { methods: ["POST"], path: /^\/api\/webhooks(?:\/[\w-]+\/(rotate|test))?$/, purpose: "create or exercise external triggers" },
  { methods: ["PATCH", "DELETE"], path: /^\/api\/webhooks\/[\w-]+$/, purpose: "change external trigger configuration" },
  { methods: ["POST"], path: /^\/api\/connectors\/[\w-]+\/authorize$/, purpose: "authorize a connected account" },
  { methods: ["DELETE"], path: /^\/api\/connectors\/[\w-]+(?:\/accounts\/[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$/, purpose: "revoke connected accounts" },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/authorize$/, purpose: "authorize an account through an inline card" },
];

export function requiresDesktopAuthority(method: string, path: string): boolean {
  return DESKTOP_AUTHORITY_ROUTES.some((route) => route.methods.includes(method) && route.path.test(path));
}

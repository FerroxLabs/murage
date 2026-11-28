// Settings v10 G2 said-yes lists (owner: core). What the owner already said yes to: trusted folders (folder-trust.ts) and each
// bot's remembered recipients (stop-line-state.ts). Removing one makes the next use ask again. Desktop only, like the folder
// Forget it sits beside; a folder record is removed through the shipped DELETE /api/folder-trust?key=.
import { forgetRecipient, knownRecipients } from "../stop-line-state.ts";
import type { SettingsV10Deps, SettingsV10Router } from "./v10-router.ts";

export const SAID_YES_PATH = "/api/settings/said-yes";
export const SAID_YES_RECIPIENT_PATH = "/api/settings/said-yes/recipient";

export function registerSaidYesRoutes(router: SettingsV10Router, deps: Pick<SettingsV10Deps, "dataDir" | "folderTrust">): void {
  router.add("core", async ({ method, path, url, req, res, json, readBody, store, surface }) => {
    if (path !== SAID_YES_PATH && path !== SAID_YES_RECIPIENT_PATH) return false;
    if (surface !== "desktop") { json(res, 403, { error: "What you said yes to is changed on the desktop." }); return true; }
    if (path === SAID_YES_PATH && method === "GET") {
      const botId = url.searchParams.get("bot");
      const bot = botId ? store.bot(botId) : null;
      if (botId && !bot) { json(res, 404, { error: "no such bot" }); return true; }
      const folders = deps.folderTrust.list().map(({ key, decision, source }) => ({ key, decision, source }));
      json(res, 200, { folders, ...(bot ? { recipients: [...knownRecipients(deps.dataDir, bot.id)] } : {}) });
      return true;
    }
    if (path === SAID_YES_RECIPIENT_PATH && method === "DELETE") {
      const body = await readBody(req);
      const botId = body && typeof body === "object" && typeof body.bot === "string" ? body.bot : "";
      const recipient = body && typeof body === "object" && typeof body.recipient === "string" ? body.recipient : "";
      const bot = botId ? store.bot(botId) : null;
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      if (!recipient || !forgetRecipient(deps.dataDir, bot.id, recipient)) { json(res, 404, { error: "no such recipient" }); return true; }
      json(res, 200, { ok: true });
      return true;
    }
    json(res, 405, { error: "method not allowed" });
    return true;
  });
}

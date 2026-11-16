// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// S4a uses the same captured token/transport as Mac and Linux. No IDs, commands
// or replies travel in activation arguments. Production outsideOk stays false
// until S0 supplies qualified envelopes; this adapter does not override it.
import { subscribeWindowsActivation } from "./windows-notification-activation.mjs";
import { nativeBannerLabels } from "./native-banner-labels.mjs";

export const SURFACE = "banner-win";
const MAX_ROUTES = 1024;
const TOKEN = /^[a-f0-9]{32}$/;
const ARGUMENT = /^murage-act:([a-f0-9]{32}):([adro])$/;
const escapeXml = text => text.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

function toastOptions(display, token, silent, labels) {
  const args = action => `murage-act:${token}:${action}`;
  const button = (letter, label) => `<action content="${escapeXml(label)}" arguments="${args(letter)}" activationType="foreground"${letter === "r" ? ' hint-inputId="reply"' : ""}/>`;
  return { toastXml: `<toast launch="${args("o")}"><visual><binding template="ToastGeneric"><text>${escapeXml(display.botName)}</text><text>${escapeXml(display.title)}</text><text>${escapeXml(display.willRun)}</text></binding></visual><actions><input id="reply" type="text"/>${button("a", labels.allow)}${button("d", labels.deny)}${button("r", labels.reply)}</actions>${silent ? '<audio silent="true"/>' : '<audio src="ms-winsoundevent:Notification.Reminder" loop="false"/>'}</toast>` };
}

export function createWindowsBanners({ platform = process.platform, Notification, mint, act, invalidate, open,
  locked = () => true, language = () => "en", log = () => {} }) {
  const routes = new Map();
  let unsubscribe = null, disposed = false;
  const report = stage => { try { log(`windows-banners: ${stage}`); } catch { /* No card content in diagnostics. */ } };
  const available = () => {
    try { return !disposed && platform === "win32" && Notification.isSupported() === true && typeof Notification.handleActivation === "function"; }
    catch { return false; }
  };
  const unlocked = () => { try { return locked() === false; } catch { return false; } };
  const forgetToken = id => { try { invalidate?.(id); } catch { report("invalidation failed"); } };
  function retire(id) {
    const item = routes.get(id);
    if (!item) return;
    routes.delete(id); // close may synchronously emit failed/activation
    item.dead = true;
    forgetToken(item.surfaceId);
    try { item.notice.close(); } catch { report("withdrawal failed"); }
    try { item.notice.removeAllListeners(); } catch { /* Native object may already be gone. */ }
  }
  async function respond(details) {
    if (disposed || !["click", "action", "reply"].includes(details?.type) || typeof details.arguments !== "string") return;
    const parsed = ARGUMENT.exec(details.arguments);
    if (!parsed) return;
    const [, token, letter] = parsed, id = `wb:${token}`, item = routes.get(id);
    if (!item || item.dead || item.consumed) return;
    item.consumed = true; // spend before any effect/await, including Open
    const openCard = () => { if (!item.dead) { try { open(item.route, item.home); } catch { report("open failed"); } } };
    try {
      if (letter === "o") { openCard(); return; }
      // Custom XML uses userInputs.reply. Never infer approval from actionIndex
      // or from text. Real-OS S0 must also confirm this on the shipped Electron.
      const reply = letter === "r" && details.userInputs && Object.hasOwn(details.userInputs, "reply") ? details.userInputs.reply : undefined;
      const result = await act(token, { a: "allow", d: "deny", r: "reply" }[letter], reply);
      if (result?.ok !== true) openCard();
    } catch { report("answer failed"); openCard(); }
    finally { retire(id); }
  }
  return {
    available,
    async show({ entry, record, actionsOn, silent = false, transport, identity, cancelled = () => false, onFailed }) {
      const stopped = () => { try { return disposed || cancelled() === true; } catch { return true; } };
      const display = record?.display;
      if (stopped() || !available() || !unlocked() || routes.size >= MAX_ROUTES || actionsOn !== true ||
          record?.open !== true || record?.requestId !== entry?.frame?.requestId || record?.outsideOk?.[SURFACE] !== true ||
          typeof record.digest !== "string" || !record.digest || !display ||
          ![display.botName, display.title, display.willRun].every(value => typeof value === "string" && value.trim().length > 0)) return null;
      let id, item;
      try {
        if (!unsubscribe) unsubscribe = subscribeWindowsActivation(Notification, details => { void respond(details); });
        if (stopped() || !unlocked()) return null;
        // Mint needs the surface ID before a token exists; use an independent
        // opaque ID, then retain it for invalidation when the native route dies.
        const surfaceId = `wb-slot:${++sequence}`;
        const token = mint({ entry, surface: SURFACE, surfaceId, digest: record.digest, transport, identity });
        if (typeof token !== "string" || !TOKEN.test(token)) { forgetToken(surfaceId); return null; }
        id = `wb:${token}`;
        try {
          const notice = new Notification(toastOptions(display, token, silent === true, nativeBannerLabels(language())));
          item = { notice, surfaceId, consumed: false, dead: false, posted: false, home: entry.home,
            route: { botId: entry.frame.botId, threadId: entry.frame.threadId, messageId: entry.frame.messageId } };
          routes.set(id, item);
          notice.on("failed", () => {
            if (routes.get(id) !== item) return;
            const posted = item.posted;
            retire(id);
            if (posted) { try { onFailed?.(); } catch { /* Retired already. */ } }
          });
          // Only the global callback understands custom XML arguments. An
          // instance click can accompany an action; it must not steal it.
          notice.show();
          if (stopped() || !unlocked()) { retire(id); return null; }
          if (routes.get(id) !== item) return null;
          item.posted = true;
          return [id];
        } catch (error) { forgetToken(surfaceId); throw error; }
      } catch { if (id) retire(id); report("post failed"); return null; }
    },
    close(ids) { for (const id of ids ?? []) retire(id); },
    size: () => routes.size,
    dispose() {
      disposed = true;
      for (const id of [...routes.keys()]) retire(id);
      unsubscribe?.(); unsubscribe = null;
    },
  };
}
let sequence = 0;

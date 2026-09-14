// Approval-only native presentation. OS sound settings and DND remain authoritative.
export const APPROVAL_SOUND = "murage-approval.wav";
const fields = new Set(["botId", "threadId", "requestId", "messageId", "requestTurnId", "title", "body"]);
const identity = value => typeof value === "string" && value.length > 0 && value.length <= 512 && /^[\w.:-]+$/.test(value);
export function approvalPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.has(key))) return null;
  if (![value.botId, value.threadId, value.requestId, value.messageId].every(identity)) return null;
  if (value.requestTurnId !== undefined && !identity(value.requestTurnId)) return null;
  if (typeof value.title !== "string" || value.title.length > 300 || typeof value.body !== "string" || value.body.length > 1000) return null;
  return { ...value };
}
const xml = value => value.replace(/[<>&"']/g, char => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;", "'":"&apos;" })[char]);
export function approvalOptions(payload, platform) {
  if (platform === "darwin") return { title: payload.title, body: payload.body, sound: APPROVAL_SOUND, silent: false };
  if (platform === "win32") return {
    toastXml: `<toast><visual><binding template="ToastGeneric"><text>${xml(payload.title)}</text><text>${xml(payload.body)}</text></binding></visual><audio src="ms-winsoundevent:Notification.Reminder" loop="false"/></toast>`,
  };
  return null;
}

/** Bounded identities survive renderer remounts for this desktop launch.
 * Oldest of 1024 identities is evicted; SSE replay suppression is independent. */
export function createApprovalNotifications({ Notification, platform, onOpen, limit = 1024 }) {
  const seen = new Set();
  const active = new Map();
  return input => {
    const payload = approvalPayload(input);
    if (!payload) return { accepted: false };
    const options = approvalOptions(payload, platform);
    if (!options || !Notification.isSupported()) return { accepted: false };
    const key = JSON.stringify([payload.botId, payload.threadId, payload.requestTurnId ?? "", payload.requestId]);
    if (seen.has(key)) return { accepted: false };
    seen.add(key);
    if (seen.size > limit) seen.delete(seen.values().next().value);
    try {
      const notice = new Notification(options);
      active.set(key, notice);
      let opened = false;
      notice.on("click", () => {
        if (opened) return;
        opened = true;
        try { onOpen({ botId: payload.botId, threadId: payload.threadId }); } catch { /* Navigation failure never changes authority. */ }
      });
      const release = () => active.delete(key);
      notice.on("close", release);
      notice.on("failed", release);
      // Keep native callbacks bounded even when an OS omits close events.
      if (active.size > limit) {
        const oldest = active.keys().next().value;
        const retired = active.get(oldest);
        active.delete(oldest);
        retired?.removeAllListeners();
      }
      notice.show();
      return { accepted: true };
    } catch {
      active.delete(key);
      return { accepted: false };
    }
  };
}

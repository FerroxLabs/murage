// Desktop notifications, driven by the harness's {kind:"notify"} frames.
// The server decides *whether* something is worth an interruption (it owns
// the per-bot toggle); this only decides how to show it here.
import type { Notification } from "../../server/notify.ts";
import { notificationBridge } from "./cloud-workspace";
import { collectingAttentionDisplay, type AttentionDisplay } from "./attention-offer";
import { notificationSoundsEnabled } from "./notification-sounds";
import { HEALTH_PAGE_BODY, HEALTH_PAGE_TITLE, type HealthPageNotification } from "../../shared/notification-preferences";

export type NotifyFrame = Notification;

export type NotificationTarget = Pick<NotifyFrame, "botId" | "threadId"> & { reconnectIncidentId?: string };

/** Recent delivery identities only, never notification text or persisted history. */
export function createApprovalDeduper(limit = 1024) {
  const seen = new Set<string>();
  return (frame: NotifyFrame): boolean => {
    if (!frame.requestId || !frame.messageId) return false;
    const key = JSON.stringify([frame.botId, frame.threadId, frame.requestTurnId ?? "", frame.requestId]);
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > limit) seen.delete(seen.values().next().value!);
    return true;
  };
}
const claimApproval = createApprovalDeduper();

// The browser fallback has no main-process ledger. Store opaque incident ids only.
const browserConnectorReceipts = new Set<string>();
function connectorAlreadyShown(id: string): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem("murage.connector-notices") ?? "[]");
    if (Array.isArray(saved)) for (const value of saved.slice(-4096)) if (typeof value === "string") browserConnectorReceipts.add(value);
  } catch { /* Storage can be unavailable; this launch still deduplicates. */ }
  return browserConnectorReceipts.has(id);
}
function rememberConnectorNotice(id: string) {
  browserConnectorReceipts.add(id);
  while (browserConnectorReceipts.size > 4096) browserConnectorReceipts.delete(browserConnectorReceipts.values().next().value!);
  try { localStorage.setItem("murage.connector-notices", JSON.stringify([...browserConnectorReceipts])); } catch { /* Keep this launch's receipt. */ }
}

/** Ask while handling the settings click. Browsers may reject permission
 * requests that are triggered later by an incoming SSE frame. */
export function requestNotificationPermission(): Promise<NotificationPermission> | null {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return null;
  return Notification.requestPermission();
}

/** The identity a notification groups under: one bot, wherever it was
 * working. Keyed by bot rather than thread so a single bot running across
 * tasks and rooms coalesces into one stack instead of stacking banners. */
export interface NotificationBotIdentity {
  id: string;
  avatarUrl?: string | null;
}

/** Presentation options for one bot's notifications: the stable per-bot
 * coalescing key platforms replace on (`tag`) and its avatar, when the
 * profile has one. Pure so the grouping rule stays testable on its own. */
export function buildNotificationOptions(bot: NotificationBotIdentity): NotificationOptions {
  return { tag: `murage:${bot.id}`, icon: bot.avatarUrl ?? undefined };
}

/** Return display fields on the router path. Otherwise show one unless its conversation is visible.
 * A focused app may still be showing another task (routine runs are detached),
 * so window focus alone is not proof that the actionable card can be seen. */
export function showNotification(
  frame: NotifyFrame,
  onOpen: (target: NotificationTarget) => void,
  avatarUrl?: string | null,
  visibleThreadId?: string | null,
): AttentionDisplay | (() => void) | void {
  if (collectingAttentionDisplay() || notificationBridge()?.attention) {
    const fields: AttentionDisplay = {
      title: frame.title.slice(0, 256), body: frame.body.slice(0, 1024),
      botId: frame.botId, threadId: frame.threadId,
      privatePreview: frame.privatePreview === true, silent: !notificationSoundsEnabled(),
    };
    if (!fields.privatePreview && typeof avatarUrl === "string" && avatarUrl.length <= 65536 && /^data:image\/png;base64,[a-z0-9+/]*={0,2}$/i.test(avatarUrl)) fields.icon = avatarUrl;
    return fields;
  }
  if (typeof Notification === "undefined") return;
  if (frame.kind !== "approval" && document.hasFocus() && visibleThreadId === frame.threadId) return;
  if (Notification.permission !== "granted") return;
  if (frame.kind === "connector-reconnect" && frame.deliveryId && connectorAlreadyShown(frame.deliveryId)) return;
  if (frame.kind === "approval" && frame.requestId && frame.messageId) {
    if (!claimApproval(frame)) return;
    const bridge = notificationBridge();
    if (bridge?.approvalNotifications && (bridge.platform === "darwin" || bridge.platform === "win32")) {
      // Only server-filtered text and opaque routing identity cross the bridge.
      // A failed native delivery is not retried with a second audible channel.
      try {
        void bridge.approvalNotifications.show({
          botId: frame.botId, threadId: frame.threadId, requestId: frame.requestId, messageId: frame.messageId,
          ...(frame.requestTurnId ? { requestTurnId: frame.requestTurnId } : {}), title: frame.title, body: frame.body,
          ...(notificationSoundsEnabled() ? {} : { silent: true }),
        }).catch(() => {});
      } catch { /* A disposed bridge must not interrupt the SSE fold. */ }
      return;
    }
  }

  const open = () => {
    window.focus();
    onOpen({ botId: frame.botId, threadId: frame.threadId, ...(frame.kind === "connector-reconnect" ? { reconnectIncidentId: frame.deliveryId } : {}) });
  };

  if (Notification.permission === "granted") {
    const options: NotificationOptions = {
      body: frame.body,
      ...buildNotificationOptions({ id: frame.botId, avatarUrl: frame.privatePreview ? undefined : avatarUrl }),
      // The banner still lands; only the sound is held back on a computer
      // that muted notification sounds.
      ...(notificationSoundsEnabled() ? {} : { silent: true }),
    };
    const notification = new Notification(frame.title, options);
    if (frame.kind === "connector-reconnect" && frame.deliveryId) rememberConnectorNotice(frame.deliveryId);
    notification.onclick = open;
    // This closer belongs only to the no-router display path.
    return () => { try { notification.close(); } catch { /* already closed by the OS */ } };
  }
}

/** A Health page (1.0.9 Sentinel): installation-scoped, no bot or thread. The OS notification always shows the fixed
 * generic title and body, whatever the frame or the preview setting carries, so the lock screen never names a model,
 * a path, a metric or the issue. One per delivery id; a replayed frame is never shown (the caller skips replays). */
export function isHealthPage(notification: unknown): notification is HealthPageNotification {
  return typeof notification === "object" && notification !== null && (notification as { kind?: unknown }).kind === "health-page";
}
const seenHealthPages = new Set<string>();
export function showHealthPage(frame: HealthPageNotification, onOpen: () => void): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  if (typeof frame.deliveryId !== "string" || seenHealthPages.has(frame.deliveryId)) return false;
  seenHealthPages.add(frame.deliveryId);
  if (seenHealthPages.size > 64) seenHealthPages.delete(seenHealthPages.values().next().value!);
  const notification = new Notification(HEALTH_PAGE_TITLE, {
    body: HEALTH_PAGE_BODY, tag: "murage:health",
    ...(notificationSoundsEnabled() ? {} : { silent: true }),
  });
  notification.onclick = () => { window.focus(); onOpen(); };
  return true;
}

/** A Needs you row the owner snoozed came back (UX L2B), while the app is open. Like a Health page, the banner says
 * only fixed words the caller passes from the catalogue, never what the card asks, so the lock screen shows nothing
 * private. One banner per row id; `tag` folds several returns at the same minute into one. */
const seenSnoozeReturns = new Set<string>();
export function showSnoozeReturn(id: string, words: { title: string; body: string }, onOpen: () => void): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  if (seenSnoozeReturns.has(id)) return false;
  seenSnoozeReturns.add(id);
  if (seenSnoozeReturns.size > 256) seenSnoozeReturns.delete(seenSnoozeReturns.values().next().value!);
  const notification = new Notification(words.title, {
    body: words.body, tag: "murage:needs-snooze",
    ...(notificationSoundsEnabled() ? {} : { silent: true }),
  });
  notification.onclick = () => { window.focus(); onOpen(); };
  return true;
}

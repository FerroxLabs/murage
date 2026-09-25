// Desktop notifications, driven by the harness's {kind:"notify"} frames.
// The server decides *whether* something is worth an interruption (it owns
// the per-bot toggle); this only decides how to show it here.
import type { Notification } from "../../server/notify.ts";
import { notificationSoundsEnabled } from "./notification-sounds";

export type NotifyFrame = Notification;

export type NotificationTarget = Pick<NotifyFrame, "botId" | "threadId">;

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

/** Show one unless the exact destination conversation is already visible.
 * A focused app may still be showing another task (routine runs are detached),
 * so window focus alone is not proof that the actionable card can be seen. */
export function showNotification(
  frame: NotifyFrame,
  onOpen: (target: NotificationTarget) => void,
  avatarUrl?: string | null,
  visibleThreadId?: string | null,
) {
  if (typeof Notification === "undefined") return;
  if (frame.kind !== "approval" && document.hasFocus() && visibleThreadId === frame.threadId) return;
  if (Notification.permission !== "granted") return;
  if (frame.kind === "approval" && frame.requestId && frame.messageId) {
    if (!claimApproval(frame)) return;
    const bridge = window.muragebox;
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
    onOpen({ botId: frame.botId, threadId: frame.threadId });
  };

  if (Notification.permission === "granted") {
    const options: NotificationOptions = {
      body: frame.body,
      ...buildNotificationOptions({ id: frame.botId, avatarUrl: frame.privatePreview ? undefined : avatarUrl }),
      // The banner still lands; only the sound is held back on a computer
      // that muted notification sounds.
      ...(notificationSoundsEnabled() ? {} : { silent: true }),
    };
    new Notification(frame.title, options).onclick = open;
  }
}

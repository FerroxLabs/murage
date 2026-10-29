import { z } from "zod";

const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timeZone = z.string().min(1).max(100).refine(value => {
  if (value.trim() !== value || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}, "Choose a valid time zone");
export const notificationPreferencesSchema = z.object({
  attention: z.boolean().default(true), completion: z.boolean().default(true), failures: z.boolean().default(true), memories: z.boolean().default(true), previewContent: z.boolean().default(true),
  quietHours: z.object({ enabled: z.boolean(), start: clockTime, end: clockTime, timeZone }).strict()
    .refine(value => value.start !== value.end, "Quiet hours must have different start and end times").optional(),
}).strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export function resolveNotificationPreferences(value?: unknown): NotificationPreferences {
  // A config that says `"notifications": null` (never set, or cleared) means the
  // defaults. Parsing null threw, and every caller swallows notification
  // errors, so a host with null silently sent no notification or push at all.
  return notificationPreferencesSchema.parse(value === undefined || value === null ? {} : value);
}
export interface PreferenceNotification {
  kind: "approval" | "question" | "takeover" | "done" | "routine-failed" | "turn-failed" | "backup-waiting" | "memories-waiting" | "email-digest" | "email-status";
  botId: string;
  threadId: string;
  title: string;
  body: string;
  botName?: string;
  avatarUrl?: string;
  privatePreview?: boolean;
  requestId?: string;
  messageId?: string;
  requestTurnId?: string;
}
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
/** Whether the owner's quiet hours cover `now` (the one quiet-hours rule: notifications here, bot calls in
 * server/bot-calls-policy.ts). Off, or not set, is never quiet. */
export function quietHoursActive(currentPrefs: unknown, now: Date): boolean {
  const quiet = resolveNotificationPreferences(currentPrefs).quietHours;
  if (!quiet?.enabled) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  const current = Number(parts.find(part => part.type === "hour")?.value) * 60 + Number(parts.find(part => part.type === "minute")?.value);
  const start = minutes(quiet.start), end = minutes(quiet.end);
  return start < end ? current >= start && current < end : current >= start || current < end;
}
/** Whether `now` falls inside the owner's enabled quiet hours. */
export function inQuietHours(prefs: NotificationPreferences, now: Date): boolean {
  const quiet = prefs.quietHours;
  if (!quiet?.enabled) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  const current = Number(parts.find(part => part.type === "hour")?.value) * 60 + Number(parts.find(part => part.type === "minute")?.value);
  const start = minutes(quiet.start), end = minutes(quiet.end);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/** The installation-scoped Health page (1.0.9 Sentinel, GAP-SENTINEL-109 section 8.2): no bot, no thread, and nothing
 * about the issue on the lock screen. titleKey and bodyKey name fixed copy for the in-app Health view; the shown
 * title and body are always the generic pair below, whatever the preview setting says. */
export interface HealthPageNotification {
  kind: "health-page";
  installationId: string;
  deliveryId: string;
  titleKey: string;
  bodyKey: string;
  route: "health";
  title: string;
  body: string;
}
export const HEALTH_PAGE_TITLE = "Murage";
export const HEALTH_PAGE_BODY = "A health check needs your attention. Open Health to see it.";
export const HEALTH_PAGE_BODY_KEY = "health.page.body";

/** The Health page through the owner's preferences: it is a failures notification (the category switch and quiet hours
 * apply), and its text is always generic. Null when suppressed; a suppressed page is never queued or replayed. */
export function applyHealthPagePreferences(notification: Omit<HealthPageNotification, "title" | "body"> & Partial<Pick<HealthPageNotification, "title" | "body">>, currentPrefs: unknown, now: Date): HealthPageNotification | null {
  const prefs = resolveNotificationPreferences(currentPrefs);
  if (!prefs.failures || inQuietHours(prefs, now)) return null;
  return { kind: "health-page", installationId: notification.installationId, deliveryId: notification.deliveryId, titleKey: notification.titleKey,
    bodyKey: notification.bodyKey, route: "health", title: HEALTH_PAGE_TITLE, body: HEALTH_PAGE_BODY };
}
/** A pure delivery filter: suppression does not queue work, replay alerts,
 * approve a request, or affect the conversation's own pending cards. */
export function applyNotificationPreferences<T extends PreferenceNotification>(notification: T, currentPrefs: unknown, now: Date): T | null {
  const prefs = resolveNotificationPreferences(currentPrefs);
  const category = notification.kind === "done" ? "completion"
    : notification.kind === "memories-waiting" ? "memories"
    : notification.kind === "routine-failed" || notification.kind === "turn-failed" ? "failures" : "attention";
  if (!prefs[category]) return null;
  if (quietHoursActive(prefs, now)) return null;
  if (prefs.previewContent) return notification;
  // Construct an allowlisted frame instead of spreading unknown presentation
  // fields that could carry private details in a future notification version.
  return { kind: notification.kind, botId: notification.botId, threadId: notification.threadId,
    ...(notification.requestId ? { requestId: notification.requestId } : {}),
    ...(notification.messageId ? { messageId: notification.messageId } : {}),
    ...(notification.requestTurnId ? { requestTurnId: notification.requestTurnId } : {}),
    botName: "", title: "Murage", body: category === "attention" ? "Your attention is needed."
      : category === "memories" ? "Memories are waiting for you."
      : category === "completion" ? "A task has finished." : "A task needs review after a failure.",
    privatePreview: true } as T;
}

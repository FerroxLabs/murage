import { z } from "zod";

const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timeZone = z.string().min(1).max(100).refine(value => {
  if (value.trim() !== value || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}, "Choose a valid time zone");
export const notificationPreferencesSchema = z.object({
  attention: z.boolean().default(true), completion: z.boolean().default(true), failures: z.boolean().default(true), previewContent: z.boolean().default(true),
  quietHours: z.object({ enabled: z.boolean(), start: clockTime, end: clockTime, timeZone }).strict()
    .refine(value => value.start !== value.end, "Quiet hours must have different start and end times").optional(),
}).strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export function resolveNotificationPreferences(value?: unknown): NotificationPreferences {
  return notificationPreferencesSchema.parse(value === undefined ? {} : value);
}
export interface PreferenceNotification {
  kind: "approval" | "question" | "takeover" | "done" | "routine-failed" | "turn-failed";
  botId: string;
  threadId: string;
  title: string;
  body: string;
  botName?: string;
  avatarUrl?: string;
  privatePreview?: boolean;
}
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
/** A pure delivery filter: suppression does not queue work, replay alerts,
 * approve a request, or affect the conversation's own pending cards. */
export function applyNotificationPreferences<T extends PreferenceNotification>(notification: T, currentPrefs: unknown, now: Date): T | null {
  const prefs = resolveNotificationPreferences(currentPrefs);
  const category = notification.kind === "done" ? "completion"
    : notification.kind === "routine-failed" || notification.kind === "turn-failed" ? "failures" : "attention";
  if (!prefs[category]) return null;
  const quiet = prefs.quietHours;
  if (quiet?.enabled) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
    const current = Number(parts.find(part => part.type === "hour")?.value) * 60 + Number(parts.find(part => part.type === "minute")?.value);
    const start = minutes(quiet.start), end = minutes(quiet.end);
    if (start < end ? current >= start && current < end : current >= start || current < end) return null;
  }
  if (prefs.previewContent) return notification;
  // Construct an allowlisted frame instead of spreading unknown presentation
  // fields that could carry private details in a future notification version.
  return { kind: notification.kind, botId: notification.botId, threadId: notification.threadId,
    botName: "", title: "Murage", body: category === "attention" ? "Your attention is needed."
      : category === "completion" ? "A task has finished." : "A task needs review after a failure.",
    privatePreview: true } as T;
}

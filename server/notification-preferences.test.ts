import { describe, expect, it } from "vitest";
import { applyNotificationPreferences, notificationPreferencesSchema, resolveNotificationPreferences, type PreferenceNotification } from "../shared/notification-preferences.ts";

const notification: PreferenceNotification = { kind: "approval", botId: "bot-click-target", threadId: "thread-click-target", botName: "Private bot", title: "Private title", body: "Private content", avatarUrl: "https://private.invalid/avatar" };
const at = (time: string) => new Date(`2026-09-06T${time}:00Z`);
describe("notification preference delivery policy", () => {
  it("preserves current notification behavior when preferences are absent", () => {
    expect(resolveNotificationPreferences()).toEqual({ attention: true, completion: true, failures: true, previewContent: true });
    expect(applyNotificationPreferences(notification, undefined, at("12:00"))).toBe(notification);
    expect(notificationPreferencesSchema.safeParse({ attention: "false" }).success).toBe(false);
    expect(notificationPreferencesSchema.safeParse({ unexpected: true }).success).toBe(false);
  });
  it("separates attention, completion and failure categories", () => {
    for (const kind of ["approval", "question", "takeover"] as const) expect(applyNotificationPreferences({ ...notification, kind }, { attention: false }, at("12:00"))).toBeNull();
    expect(applyNotificationPreferences({ ...notification, kind: "done" }, { completion: false }, at("12:00"))).toBeNull();
    for (const kind of ["routine-failed", "turn-failed"] as const) expect(applyNotificationPreferences({ ...notification, kind }, { failures: false }, at("12:00"))).toBeNull();
    expect(applyNotificationPreferences(notification, { completion: false, failures: false }, at("12:00"))).not.toBeNull();
  });
  it("uses half-open day and overnight quiet intervals in the explicit time zone", () => {
    const daytime = { quietHours: { enabled: true, start: "09:00", end: "17:00", timeZone: "UTC" } };
    for (const time of ["09:00", "12:00", "16:59"]) expect(applyNotificationPreferences(notification, daytime, at(time))).toBeNull();
    for (const time of ["08:59", "17:00"]) expect(applyNotificationPreferences(notification, daytime, at(time))).not.toBeNull();
    const overnight = { quietHours: { enabled: true, start: "22:00", end: "07:00", timeZone: "Asia/Bangkok" } };
    // UTC 15:00 = 22:00 Bangkok; UTC 00:00 = 07:00 Bangkok.
    for (const time of ["15:00", "16:00", "23:59"]) expect(applyNotificationPreferences(notification, overnight, at(time))).toBeNull();
    for (const time of ["14:59", "00:00"]) expect(applyNotificationPreferences(notification, overnight, at(time))).not.toBeNull();
    expect(applyNotificationPreferences(notification, { quietHours: { ...overnight.quietHours, enabled: false } }, at("16:00"))).not.toBeNull();
  });
  it("rejects invalid zones, missing explicit zones, equal times and malformed times", () => {
    const quietHours = { enabled: true, start: "22:00", end: "07:00", timeZone: "UTC" };
    for (const patch of [{ timeZone: "Not/AZone" }, { timeZone: undefined }, { end: "22:00" }, { start: "24:00" }, { start: "9:00" }]) {
      expect(notificationPreferencesSchema.safeParse({ quietHours: { ...quietHours, ...patch } }).success).toBe(false);
    }
  });
  it("removes private previews and avatars while retaining exact click targets", () => {
    const privateFrame = applyNotificationPreferences({ ...notification, name: "Private extra name", detail: "Private extra detail", avatar: "Private avatar" }, { previewContent: false }, at("12:00"))!;
    expect(privateFrame).toEqual({ kind: "approval", botId: notification.botId, threadId: notification.threadId, botName: "", title: "Murage", body: "Your attention is needed.", privatePreview: true });
    expect(JSON.stringify(privateFrame)).not.toMatch(/Private|private\.invalid|avatar/);
    expect(notification.body).toBe("Private content");
  });
});

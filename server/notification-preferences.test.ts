import { describe, expect, it } from "vitest";
import { HEALTH_PAGE_BODY, HEALTH_PAGE_BODY_KEY, HEALTH_PAGE_TITLE, applyHealthPagePreferences, applyNotificationPreferences, inQuietHours, notificationPreferencesSchema, resolveNotificationPreferences, type PreferenceNotification } from "../shared/notification-preferences.ts";

const notification: PreferenceNotification = { kind: "approval", botId: "bot-click-target", threadId: "thread-click-target", botName: "Private bot", title: "Private title", body: "Private content", avatarUrl: "https://private.invalid/avatar" };
const at = (time: string) => new Date(`2026-09-06T${time}:00Z`);
describe("notification preference delivery policy", () => {
  it("retains only opaque approval identity through private previews", () => {
    expect(applyNotificationPreferences({ ...notification, requestId: "request", messageId: "card", requestTurnId: "turn", secret: "not allowed" }, { previewContent: false }, at("12:00"))).toEqual({ kind: "approval", botId: notification.botId, threadId: notification.threadId, requestId: "request", messageId: "card", requestTurnId: "turn", botName: "", title: "Murage", body: "Your attention is needed.", privatePreview: true });
  });
  it("preserves current notification behavior when preferences are absent", () => {
    expect(resolveNotificationPreferences()).toEqual({ attention: true, completion: true, failures: true, memories: true, previewContent: true });
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

describe("a config with notifications: null", () => {
  it("uses the defaults instead of throwing (review host: every push silently lost)", () => {
    expect(() => resolveNotificationPreferences(null)).not.toThrow();
    expect(resolveNotificationPreferences(null)).toEqual(resolveNotificationPreferences(undefined));
    const approval = { kind: "approval" as const, botId: "b", threadId: "t", title: "Trip Planner", body: "wants to run a command", requestId: "r" };
    expect(applyNotificationPreferences(approval, null, new Date("2026-10-06T06:30:00Z"))).not.toBeNull();
  });
});

// 1.0.9 Sentinel (GAP-SENTINEL-109 section 8.2): the Health page is a failures notification with generic text always.
describe("the Health page through the owner's preferences", () => {
  const page = { kind: "health-page" as const, installationId: "0123456789abcdef0123456789abcdef", deliveryId: "ab".repeat(16), titleKey: "health.backup.not-protected", bodyKey: HEALTH_PAGE_BODY_KEY, route: "health" as const };
  it("maps to the failures switch: off means no page", () => {
    expect(applyHealthPagePreferences(page, { failures: false }, at("12:00"))).toBeNull();
    expect(applyHealthPagePreferences(page, { attention: false, completion: false, memories: false }, at("12:00"))).not.toBeNull();
  });
  it("honours quiet hours, start inclusive and end exclusive, across midnight", () => {
    const quiet = { quietHours: { enabled: true, start: "22:00", end: "07:00", timeZone: "UTC" } };
    expect(applyHealthPagePreferences(page, quiet, at("21:59"))).not.toBeNull();
    expect(applyHealthPagePreferences(page, quiet, at("22:00"))).toBeNull();
    expect(applyHealthPagePreferences(page, quiet, at("06:59"))).toBeNull();
    expect(applyHealthPagePreferences(page, quiet, at("07:00"))).not.toBeNull();
    expect(applyHealthPagePreferences(page, { quietHours: { ...quiet.quietHours, enabled: false } }, at("23:00"))).not.toBeNull();
  });
  it("shows only the generic lock-screen text, even with previews on, and keeps the routing fields", () => {
    for (const prefs of [{ previewContent: true }, { previewContent: false }, undefined]) {
      const shown = applyHealthPagePreferences({ ...page, title: "No recent verified backup at /Users/x", body: "claude-opus 52 MiB/min" }, prefs, at("12:00"));
      expect(shown).toEqual({ ...page, title: HEALTH_PAGE_TITLE, body: HEALTH_PAGE_BODY });
      expect(`${shown?.title} ${shown?.body}`).not.toMatch(/backup|MiB|claude|\/|\d/i);
    }
    expect(HEALTH_PAGE_BODY).not.toMatch(/—|\b(safe|safely|safety|unsafe)\b/i);
  });
  it("shares the quiet-hours rule with every other notification", () => {
    const prefs = resolveNotificationPreferences({ quietHours: { enabled: true, start: "09:00", end: "17:00", timeZone: "UTC" } });
    expect(inQuietHours(prefs, at("09:00"))).toBe(true);
    expect(inQuietHours(prefs, at("17:00"))).toBe(false);
    expect(applyNotificationPreferences({ ...notification, kind: "turn-failed" }, prefs, at("12:00"))).toBeNull();
  });
});

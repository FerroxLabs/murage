import { describe, expect, it } from "vitest";
import { applyNotificationPreferences, notificationDropReason } from "./notification-preferences.ts";

const frame = (kind: string, extra = {}) => ({ kind, botId: "b", threadId: "t", title: "X finished", body: "private words", botName: "X", ...extra }) as never;
const quiet = { quietHours: { enabled: true, start: "22:00", end: "07:00", timeZone: "UTC" } };
const night = new Date("2026-11-09T23:00:00Z"), day = new Date("2026-11-09T12:00:00Z");

describe("notificationDropReason", () => {
  it("is quiet only when quiet hours are the only reason", () => {
    expect(notificationDropReason(frame("approval"), quiet, night)).toBe("quiet");
    expect(notificationDropReason(frame("approval"), quiet, day)).toBeNull();
    expect(notificationDropReason(frame("done"), { ...quiet, completion: false }, night)).toBe("category");
    expect(notificationDropReason(frame("turn-failed"), { failures: false }, day)).toBe("category");
  });
  it("agrees with applyNotificationPreferences", () => {
    for (const [prefs, now] of [[quiet, night], [quiet, day], [{ completion: false }, day]] as const) {
      expect(applyNotificationPreferences(frame("done"), prefs, now) === null).toBe(notificationDropReason(frame("done"), prefs, now) !== null);
    }
  });
});
describe("done frames with previews off", () => {
  it("keep deliveryId and durationMs (an id and a number) and strip the receipt and the words", () => {
    const out = applyNotificationPreferences(frame("done", { deliveryId: "d1", durationMs: 125000, receipt: { engineLabel: "Fuigo", filesTouched: 2, sent: "an email" } }), { previewContent: false }, day) as Record<string, unknown>;
    expect(out).toMatchObject({ deliveryId: "d1", durationMs: 125000, body: "A task has finished." });
    expect(out.receipt).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/private words|an email|Fuigo/);
  });
  it("keep the whole frame with previews on", () => {
    expect((applyNotificationPreferences(frame("done", { deliveryId: "d1", receipt: { engineLabel: "Fuigo", filesTouched: 0, sent: null } }), {}, day) as Record<string, unknown>).receipt).toBeDefined();
  });
});

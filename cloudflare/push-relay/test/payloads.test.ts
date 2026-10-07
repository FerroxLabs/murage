import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apnsRequest, fcmMessage, IOS_CATEGORY } from "../src/payloads";
import { GENERIC_TEXT, PUSH_CATEGORIES, type RelayEvent } from "../../../shared/mobile-push";

const push = JSON.parse(readFileSync(join(import.meta.dirname, "../../../apps/mobile/contract/push.json"), "utf8"));
const p = push.provider as { event: RelayEvent; now: number; deviceBadge: number; apns: { path: string; headers: Record<string, string>; body: unknown }; apnsResolved: { headers: Record<string, string>; aps: unknown }; fcm: unknown };

describe("provider requests match the contract byte for byte", () => {
  it("APNs: generic alert, mutable-content, category, thread-id, badge, time-sensitive, collapse and expiry", () => {
    const request = apnsRequest(p.event, p.deviceBadge, "TOKEN", "com.murage.mobile");
    expect(request.path).toBe(p.apns.path);
    expect(request.headers).toEqual(p.apns.headers);
    expect(request.body).toEqual(p.apns.body);
  });
  it("a resolution uses the original collapse id, is passive and silent", () => {
    const resolved = { ...p.event, category: "resolved" as const, revision: 2, timeSensitive: false };
    const request = apnsRequest(resolved, p.deviceBadge, "TOKEN", "com.murage.mobile");
    expect(request.headers).toMatchObject(p.apnsResolved.headers);
    expect((request.body as { aps: unknown }).aps).toEqual(p.apnsResolved.aps);
  });
  it("an approval that is not blocking work is active, not time-sensitive", () => {
    const request = apnsRequest({ ...p.event, timeSensitive: false }, 0, "TOKEN", "com.murage.mobile");
    expect((request.body as { aps: Record<string, unknown> }).aps["interruption-level"]).toBe("active");
  });
  it("FCM: data-only, high priority, strings (plus threadGroup), no collapse key, TTL to the expiry", () => {
    expect(fcmMessage(p.event, "TOKEN", "com.murage.mobile", p.now)).toEqual(p.fcm);
    expect(JSON.stringify(fcmMessage(p.event, "TOKEN", "com.murage.mobile", p.now))).not.toContain('"notification"');
  });
  it("FCM never carries a collapse_key: FCM keeps four per device, so five offline requests would lose one (B5)", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...p.event, eventRef: String(i).repeat(64).slice(0, 64), collapseKey: String(i).repeat(32).slice(0, 32) }));
    for (const category of PUSH_CATEGORIES) {
      for (const e of five) {
        const message = fcmMessage({ ...e, category }, "TOKEN", "com.murage.mobile", p.now).message;
        expect(Object.keys(message.android)).not.toContain("collapse_key");
        // The collapse key still rides in data: the app dedupes and replaces by it and the revision.
        expect(message.data).toHaveProperty("collapseKey", e.collapseKey);
      }
    }
  });
  it("uses the contract's iOS categories", () => {
    expect(IOS_CATEGORY).toEqual(push.iosCategory);
  });
});

describe("provider requests carry nothing outside the contract", () => {
  const payloadKeys = Object.keys(push.payloads[0].value).sort();
  // The contract's event plus a field a careless host might add: none of it may leak.
  const leaky = { ...p.event, title: "Scout wants to delete prod", threadId: "thread-42" } as RelayEvent;
  for (const category of PUSH_CATEGORIES) {
    it(`APNs ${category}: only aps and murage, the generic text, and the payload fields`, () => {
      const { body, headers } = apnsRequest({ ...leaky, category }, 1, "TOKEN", "com.murage.mobile");
      expect(Object.keys(body).sort()).toEqual(["aps", "murage"]);
      const aps = body.aps as Record<string, unknown>;
      for (const key of Object.keys(aps)) expect(["alert", "mutable-content", "category", "thread-id", "badge", "interruption-level", "sound"]).toContain(key);
      expect(aps.alert).toEqual(GENERIC_TEXT[category]);
      expect(Object.keys(body.murage as object).sort()).toEqual(payloadKeys);
      expect(Object.keys(headers).sort()).toEqual(Object.keys(p.apns.headers).sort());
      expect(JSON.stringify({ body, headers })).not.toMatch(/Scout|thread-42|title":"Scout|threadId/);
    });
    it(`FCM ${category}: data-only strings of the payload fields plus threadGroup`, () => {
      const message = (fcmMessage({ ...leaky, category }, "TOKEN", "com.murage.mobile", p.now) as unknown as { message: Record<string, Record<string, unknown>> }).message;
      expect(Object.keys(message).sort()).toEqual(["android", "data", "token"]);
      expect(Object.keys(message.data).sort()).toEqual([...payloadKeys, "threadGroup"].sort());
      expect(Object.values(message.data).every((v) => typeof v === "string")).toBe(true);
      expect(Object.keys(message.android).sort()).toEqual(["priority", "restricted_package_name", "ttl"]);
      expect(JSON.stringify(message)).not.toMatch(/Scout|thread-42|threadId|"notification"/);
    });
  }
});

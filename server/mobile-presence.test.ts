import { describe, expect, it } from "vitest";
import { Presence, parsePresenceBody } from "./mobile-presence.ts";

describe("Presence", () => {
  it("is present only while a client reported visible within 90 s", () => {
    let now = 0;
    const presence = new Presence(() => now);
    expect(presence.present()).toBe(false);
    presence.report("tab-a", true);
    now = 89_999;
    expect(presence.present()).toBe(true);
    now = 90_000;
    expect(presence.present()).toBe(false);
  });
  it("a hidden report ends that client's presence at once", () => {
    let now = 0;
    const presence = new Presence(() => now);
    presence.report("tab-a", true);
    presence.report("tab-a", false);
    expect(presence.present()).toBe(false);
  });
  it("keeps at most 64 clients", () => {
    const presence = new Presence(() => 0);
    for (let i = 0; i < 100; i++) presence.report(`c${i}`, true);
    expect(presence.size).toBe(64);
  });
  it("takes exactly {clientId, visible}", () => {
    expect(parsePresenceBody({ clientId: "abcdefgh", visible: true })).toEqual({ clientId: "abcdefgh", visible: true });
    expect(parsePresenceBody({ clientId: "abcdefgh", visible: "yes" })).toBeNull();
    expect(parsePresenceBody({ clientId: "a", visible: true })).toBeNull();
    expect(parsePresenceBody({ clientId: "abcdefgh", visible: true, x: 1 })).toBeNull();
  });

  // The diagnostic for the flap (2026-09-28): server.log names why a desk
  // that was present stopped being present. Content-free: a 4-char id prefix
  // and counts, never the whole id.
  it("logs only changes of the answer, never a steady beat, and never a whole id", () => {
    let now = 0;
    const lines: string[] = [];
    const presence = new Presence(() => now, (line) => lines.push(line));
    presence.report("abcd1234efgh5678", true);
    for (now = 30_000; now <= 600_000; now += 30_000) presence.report("abcd1234efgh5678", true);
    presence.report("wxyz9876", true);
    presence.report("wxyz9876", false);
    expect(lines).toEqual(["presence began"]);
    presence.report("abcd1234efgh5678", false);
    expect(lines).toEqual(["presence began", "presence ended by a hidden report client=abcd after 0 ms since last beat"]);
    expect(lines.join("\n")).not.toContain("abcd1234");
  });

  // Fix round 1: a report the client gave up on (10 s timeout) can still
  // reach the host after the newer one it sent next. The per-page seq lets
  // the host tell which is newer.
  it("ignores a late report whose seq is not newer than the last one taken from that client", () => {
    const presence = new Presence(() => 0, () => {});
    presence.report("tab-a-12345678", true, 1);
    presence.report("tab-a-12345678", true, 3);
    presence.report("tab-a-12345678", false, 2);
    expect(presence.present()).toBe(true);
    presence.report("tab-a-12345678", false, 3);
    expect(presence.present()).toBe(true);
  });
  it("applies a report with a higher seq, hidden included", () => {
    const presence = new Presence(() => 0, () => {});
    presence.report("tab-a-12345678", true, 1);
    presence.report("tab-a-12345678", false, 2);
    expect(presence.present()).toBe(false);
    presence.report("tab-a-12345678", true, 7);
    expect(presence.present()).toBe(true);
  });
  it("still takes a report without seq from an older renderer, in arrival order", () => {
    const presence = new Presence(() => 0, () => {});
    presence.report("tab-a-12345678", true);
    expect(presence.present()).toBe(true);
    presence.report("tab-a-12345678", false);
    expect(presence.present()).toBe(false);
  });
  it("reads seq as an optional positive integer, bounded", () => {
    expect(parsePresenceBody({ clientId: "abcdefgh", visible: true, seq: 1 })).toEqual({ clientId: "abcdefgh", visible: true, seq: 1 });
    expect(parsePresenceBody({ clientId: "abcdefgh", visible: true, seq: 2_147_483_647 })).toEqual({ clientId: "abcdefgh", visible: true, seq: 2_147_483_647 });
    for (const seq of [0, -1, 1.5, "2", null, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parsePresenceBody({ clientId: "abcdefgh", visible: true, seq })).toBeNull();
    }
    expect(parsePresenceBody({ clientId: "abcdefgh", visible: true })).toEqual({ clientId: "abcdefgh", visible: true });
  });

  it("logs the lapse once per lapse, with the time since the last beat", () => {
    let now = 0;
    const lines: string[] = [];
    const presence = new Presence(() => now, (line) => lines.push(line));
    presence.report("abcd1234", true);
    expect(lines).toContain("presence began");
    now = 60_000;
    expect(presence.present()).toBe(true);
    now = 95_000;
    expect(presence.present()).toBe(false);
    expect(presence.present()).toBe(false);
    now = 200_000;
    expect(presence.present()).toBe(false);
    expect(lines.filter((line) => line.startsWith("presence lapsed"))).toEqual(["presence lapsed after 95000 ms since last beat"]);
    // back, then lapsed again: a second line
    presence.report("abcd1234", true);
    now = 300_000;
    expect(presence.present()).toBe(false);
    expect(lines.filter((line) => line.startsWith("presence lapsed"))).toHaveLength(2);
    expect(lines.filter((line) => line === "presence began")).toHaveLength(2);
  });

  it("names a hidden report that ends presence, and does not call it a lapse", () => {
    let now = 0;
    const lines: string[] = [];
    const presence = new Presence(() => now, (line) => lines.push(line));
    presence.report("abcd1234", true);
    now = 5_000;
    presence.report("abcd1234", false);
    expect(presence.present()).toBe(false);
    expect(lines).toContain("presence ended by a hidden report client=abcd after 5000 ms since last beat");
    expect(lines.some((line) => line.startsWith("presence lapsed"))).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { CueCache } from "./cue-cache";

afterEach(() => setLocale("en"));

const blob = (text: string) => new Blob([text]);

describe("CueCache", () => {
  it("prewarm fetches each key in order, one at a time, and get hits after", async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const fetchClip = vi.fn(async (text: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(text);
      await Promise.resolve();
      active -= 1;
      return blob(text);
    });
    const cache = new CueCache(fetchClip);
    const o = { botId: "b", voiceId: "v", locale: "en" };
    await cache.prewarm({ ...o, keys: ["calls.ack.look", "calls.ack.oneSec"] });
    expect(order).toEqual(["Let me have a look.", "One sec."]);
    expect(maxActive).toBe(1);
    expect(fetchClip).toHaveBeenCalledTimes(2);
    expect(await cache.get({ ...o, key: "calls.ack.look" })?.text()).toBe("Let me have a look.");
    expect(cache.get({ ...o, key: "calls.ack.onIt" })).toBeNull();
  });

  it("a voice, bot or locale change misses", async () => {
    const cache = new CueCache(async (t) => blob(t));
    await cache.prewarm({ botId: "b", voiceId: "v", locale: "en", keys: ["calls.ack.look"] });
    const base = { botId: "b", voiceId: "v", locale: "en", key: "calls.ack.look" as const };
    expect(cache.get(base)).not.toBeNull();
    expect(cache.get({ ...base, voiceId: "w" })).toBeNull();
    expect(cache.get({ ...base, voiceId: undefined })).toBeNull();
    expect(cache.get({ ...base, botId: "c" })).toBeNull();
    expect(cache.get({ ...base, locale: "de" })).toBeNull();
  });

  it("does not fetch a clip it already holds", async () => {
    const fetchClip = vi.fn(async (t: string) => blob(t));
    const cache = new CueCache(fetchClip);
    const o = { botId: "b", locale: "en", keys: ["calls.ack.look" as const] };
    await cache.prewarm(o);
    await cache.prewarm(o);
    expect(fetchClip).toHaveBeenCalledTimes(1);
  });

  it("the 17th entry evicts the oldest", async () => {
    const cache = new CueCache(async (t) => blob(t));
    for (let i = 0; i < 17; i += 1) {
      await cache.prewarm({ botId: `b${i}`, locale: "en", keys: ["calls.ack.look"] });
    }
    expect(cache.get({ botId: "b0", locale: "en", key: "calls.ack.look" })).toBeNull();
    expect(cache.get({ botId: "b1", locale: "en", key: "calls.ack.look" })).not.toBeNull();
    expect(cache.get({ botId: "b16", locale: "en", key: "calls.ack.look" })).not.toBeNull();
  });

  it("a get refreshes recency", async () => {
    const cache = new CueCache(async (t) => blob(t), 2);
    const k = (botId: string) => ({ botId, locale: "en", key: "calls.ack.look" as const });
    await cache.prewarm({ botId: "a", locale: "en", keys: ["calls.ack.look"] });
    await cache.prewarm({ botId: "b", locale: "en", keys: ["calls.ack.look"] });
    expect(cache.get(k("a"))).not.toBeNull();
    await cache.prewarm({ botId: "c", locale: "en", keys: ["calls.ack.look"] });
    expect(cache.get(k("a"))).not.toBeNull();
    expect(cache.get(k("b"))).toBeNull();
  });

  it("a failing fetch leaves get null, does not reject, and later keys still load", async () => {
    const fetchClip = vi.fn(async (t: string) => {
      if (t === "Let me have a look.") throw new Error("down");
      return blob(t);
    });
    const cache = new CueCache(fetchClip);
    const o = { botId: "b", locale: "en" };
    await expect(cache.prewarm({ ...o, keys: ["calls.ack.look", "calls.ack.oneSec"] })).resolves.toBeUndefined();
    expect(cache.get({ ...o, key: "calls.ack.look" })).toBeNull();
    expect(cache.get({ ...o, key: "calls.ack.oneSec" })).not.toBeNull();
  });

  it("speaks the phrase in the app language", async () => {
    await setLocale("de");
    const texts: string[] = [];
    const cache = new CueCache(async (t) => (texts.push(t), blob(t)));
    await cache.prewarm({ botId: "b", locale: "de", keys: ["calls.ack.oneSec"] });
    expect(texts).toEqual(["Einen Moment."]);
  });

  it("put stores a live-fetched clip so the next cue for that phrase hits", async () => {
    const cache = new CueCache(vi.fn(async () => blob("x")));
    const o = { botId: "b", voiceId: "v", locale: "en", key: "calls.ack.look" as const };
    expect(cache.get(o)).toBeNull();
    cache.put(o, blob("live"));
    expect(await cache.get(o)?.text()).toBe("live");
  });
});

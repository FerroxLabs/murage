// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// C31: an own ElevenLabs key searches its account and the public Voice
// Library, finds a pasted share link or voice id, and adds a library voice to
// the account before it is picked. Driven against a stubbed fetch.
import { afterEach, describe, expect, it, vi } from "vitest";

import { addSharedVoice, listVoices, pastedVoice } from "./elevenlabs.ts";
import * as tts from "./index.ts";
import type { AppConfig } from "../config.ts";

const OWN = [{ voice_id: "acc1", name: "Rachel", labels: { accent: "american" } }];
const LIBRARY = [
  { voice_id: "lib1", name: "Brian Narrator", public_owner_id: "own1", accent: "british", description: "deep" },
  { voice_id: "acc1", name: "Rachel", public_owner_id: "own9", is_added_by_user: true },
  { voice_id: "bad/id", name: "Odd", public_owner_id: "own2" },
];

function stub(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname.replace(/^\/v1/, "");
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}/`));
    if (!key) return new Response(JSON.stringify({ detail: "nope" }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("ElevenLabs Voice Library (own key)", () => {
  it("lists only the account's voices without a search", async () => {
    const calls = stub({ "/voices": { voices: OWN }, "/shared-voices": { voices: LIBRARY } });
    expect((await listVoices("k")).map((v) => v.id)).toEqual(["acc1"]);
    expect(calls.some((c) => c.url.includes("/shared-voices"))).toBe(false);
  });

  it("a search adds the Voice Library's matches after the account's, once each, with an owner only where it can be added", async () => {
    const calls = stub({ "/voices": { voices: OWN }, "/shared-voices": { voices: LIBRARY } });
    const voices = await listVoices("k", { query: "rach" });
    expect(voices.map((v) => v.id)).toEqual(["acc1", "lib1"]);
    expect(voices.find((v) => v.id === "lib1")?.publicOwnerId).toBe("own1");
    expect(voices.find((v) => v.id === "acc1")?.publicOwnerId).toBeUndefined();
    const search = calls.find((c) => c.url.includes("/shared-voices"));
    expect(search?.url).toContain("search=rach");
    // the key goes in a header, never the URL, and no request follows a redirect
    for (const c of calls) {
      expect(c.init?.redirect).toBe("error");
      expect((c.init?.headers as Record<string, string>)["xi-api-key"]).toBe("k");
    }
  });

  it("a pasted share link finds that one voice by its owner", async () => {
    const calls = stub({ "/voices": { voices: OWN }, "/shared-voices": { voices: LIBRARY } });
    const voices = await listVoices("k", { query: "https://elevenlabs.io/app/voice-library/share/own1/lib1?x=1" });
    expect(voices.map((v) => v.id)).toEqual(["lib1"]);
    expect(calls.find((c) => c.url.includes("/shared-voices"))?.url).toContain("owner_id=own1");
  });

  it("reads share links, voiceId links and bare ids, and nothing else", () => {
    expect(pastedVoice("https://x/share/abc/def")).toEqual({ owner: "abc", id: "def" });
    expect(pastedVoice("https://x/voice?voiceId=abc123")).toEqual({ id: "abc123" });
    expect(pastedVoice("ABCDEFGHIJ0123456789")).toEqual({ id: "ABCDEFGHIJ0123456789" });
    expect(pastedVoice("warm british")).toBeUndefined();
  });

  it("adds a library voice to the account and returns the id it was given", async () => {
    const calls = stub({ "/voices/add": { voice_id: "newid" } });
    expect(await addSharedVoice("k", "own1", "lib1", "Brian")).toBe("newid");
    expect(calls[0].url).toMatch(/\/voices\/add\/own1\/lib1$/);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ new_name: "Brian" });
    expect(calls[0].init?.redirect).toBe("error");
  });

  it("the workspace passes the search through for an own key only, and refuses to add without one", async () => {
    stub({ "/voices": { voices: OWN }, "/shared-voices": { voices: LIBRARY } });
    const own = { tts: { provider: "elevenlabs", key: "k" } } as unknown as AppConfig;
    expect((await tts.listVoices(own, undefined, "elevenlabs", { query: "brian" })).map((v) => v.id)).toContain("lib1");
    const none = { tts: { provider: "elevenlabs" } } as unknown as AppConfig;
    await expect(tts.addSharedVoice(none, "own1", "lib1", "Brian")).rejects.toBeInstanceOf(tts.NoVoiceConfigured);
  });
});

describe("ElevenLabs Voice Library review fixes", () => {
  it("a search still finds the account's own voice by its description", async () => {
    stub({ "/voices": { voices: OWN }, "/shared-voices": { voices: [] } });
    expect((await listVoices("k", { query: "american" })).map((v) => v.id)).toEqual(["acc1"]);
  });

  it("the add route needs a stepped-up owner on a Cloud home", async () => {
    const { routePolicy } = await import("../route-policy.ts");
    expect(routePolicy("POST", "/api/tts/voices/add")).toMatchObject({ class: "desktop", cloudWrite: "step-up" });
  });

  it("on a Cloud home only the owner desktop reaches the add route, and only after a step-up", async () => {
    const { cloudRouteDecision } = await import("../route-policy.ts");
    const body = { publicOwnerId: "own1", voiceId: "lib1", name: "Brian" };
    for (const steppedUp of [false, true]) {
      for (const scope of ["owner-phone", "owner-browser", "browser", "remembered-owner", "service", "anonymous"] as const) {
        expect(cloudRouteDecision("POST", "/api/tts/voices/add", scope, body, steppedUp), `${scope} steppedUp=${steppedUp}`).toBe("deny");
      }
    }
    expect(cloudRouteDecision("POST", "/api/tts/voices/add", "owner-desktop", body, false)).toBe("step-up required");
    expect(cloudRouteDecision("POST", "/api/tts/voices/add", "owner-desktop", body, true)).toBe("allow");
  });

  it("a Flux config that still holds an own key never searches the Voice Library, and no key reaches a URL", async () => {
    const calls = stub({ "/voices": { voices: OWN }, "/shared-voices": { voices: LIBRARY } });
    const cfg = { tts: { provider: "flux", key: "own-secret-key" } } as unknown as AppConfig;
    const voices = await tts.listVoices(cfg, undefined, "flux", { query: "brian" });
    expect(voices.map((v) => v.id)).not.toContain("lib1");
    expect(calls.some((c) => c.url.includes("/shared-voices"))).toBe(false);
    for (const c of calls) expect(c.url).not.toContain("own-secret-key");
    // an own-key search and add carry the key in a header only
    const own = stub({ "/voices": { voices: OWN }, "/shared-voices": { voices: LIBRARY } });
    await listVoices("own-secret-key", { query: "brian" });
    await addSharedVoice("own-secret-key", "own1", "lib1", "Brian").catch(() => undefined);
    expect(own.length).toBeGreaterThan(0);
    for (const c of own) expect(c.url).not.toContain("own-secret-key");
  });
});

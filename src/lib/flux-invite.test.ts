// When the Flux offer is allowed to appear, and the two states in which
// showing it would be a bug rather than a nag.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  FLUX_COPY,
  FLUX_INVITE_DISMISSED_KEY,
  fluxInviteVisible,
  fluxKeyPatch,
  fluxKeyPlaceholder,
  type FluxInviteFacts,
} from "./flux-invite";

const facts = (over: Partial<FluxInviteFacts> = {}): FluxInviteFacts => ({
  desktop: true,
  configured: false,
  dismissed: false,
  firstRunGate: false,
  ...over,
});

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("who gets offered a Flux key", () => {
  it("offers it on a fresh desktop with no key", () => {
    // The POSITIVE control for every refusal below. Without this the rig
    // could be a function that returns false and every other test would pass.
    expect(fluxInviteVisible(facts())).toBe(true);
  });

  it("says nothing to someone who already has a key", () => {
    expect(fluxInviteVisible(facts({ configured: true }))).toBe(false);
  });

  it("takes no for an answer, permanently", () => {
    expect(fluxInviteVisible(facts({ dismissed: true }))).toBe(false);
    // and the no outlives not having a key, which is the whole point
    expect(fluxInviteVisible(facts({ dismissed: true, configured: false }))).toBe(false);
  });

  it("does not flash before config has answered", () => {
    // `null` is "GET /api/config has not come back yet", not "no key". Reading
    // it as no-key would show the offer for a frame on every single launch of
    // a machine that already has one.
    expect(fluxInviteVisible(facts({ configured: null }))).toBe(false);
  });

  it("stays off any surface that is not a confirmed desktop", () => {
    // The Connections section it points at is desktopOnly: a phone through the
    // browser door is not allowed to see or edit workspace keys, so offering
    // there is an invitation to open a door that surface does not have.
    expect(fluxInviteVisible(facts({ desktop: false }))).toBe(false);
    // Not answered yet takes the same silent answer the welcome gate does.
    expect(fluxInviteVisible(facts({ desktop: undefined }))).toBe(false);
  });

  it("does not stack itself on the first-run welcome screen", () => {
    expect(fluxInviteVisible(facts({ firstRunGate: true }))).toBe(false);
  });
});

describe("the dismissal is remembered, and survives a browser that refuses to", () => {
  it("keys off one stable name", () => {
    expect(FLUX_INVITE_DISMISSED_KEY).toBe("murage-flux-invite-dismissed");
  });

  it("writes the no to localStorage and reads it back on the next launch", () => {
    const hook = readFileSync(join(srcRoot, "lib/use-flux-invite.ts"), "utf8");
    expect(hook).toMatch(/localStorage\.setItem\(key, "1"\)/);
    expect(hook).toMatch(/return localStorage\.getItem\(key\) === "1"/);
    // Seeded from storage at mount, not defaulted to false: a dismissal made
    // last launch has to be in hand before the first render decides.
    expect(hook).toMatch(/useState\(\(\) => stored\(FLUX_INVITE_DISMISSED_KEY\)\)/);
  });

  it("never throws in a private window", () => {
    const hook = readFileSync(join(srcRoot, "lib/use-flux-invite.ts"), "utf8");
    expect(hook).toMatch(/try \{\s*return localStorage\.getItem/);
    expect(hook).toMatch(/try \{\s*localStorage\.setItem/);
  });
});

describe("the key never leaves the renderer except as a write", () => {
  it("patches exactly the field the server accepts", () => {
    expect(fluxKeyPatch("flux-live-abc")).toBe('{"flux":{"apiKey":"flux-live-abc"}}');
  });

  it("clears the key with an empty string rather than a delete", () => {
    // server/config.ts syncCredentialEnv reads "" as "the user cleared this"
    // and drops FLUX_API_KEY; `undefined` would mean "leave it alone".
    expect(fluxKeyPatch("")).toBe('{"flux":{"apiKey":""}}');
  });

  it("has no saved value to put in the placeholder, and does not pretend to", () => {
    // GET /api/config answers `flux: { configured }` and nothing else, so
    // there is no key here to mask. The configured placeholder must say a key
    // is saved without presenting itself AS the key.
    expect(fluxKeyPlaceholder(true)).toBe("Saved. Paste a new key to replace it.");
    expect(fluxKeyPlaceholder(false)).toBe("Paste your Flux Router key");
    expect(fluxKeyPlaceholder(true)).not.toMatch(/[•*]/);
  });
});

describe("copy rules", () => {
  it("uses no em dashes anywhere a person can read", () => {
    for (const [name, line] of Object.entries(FLUX_COPY)) {
      expect(`${name}: ${line}`).not.toContain("—");
    }
    // POSITIVE control: prove the assertion above can actually fail, rather
    // than passing because the matcher never sees the character.
    expect(() => expect("a — dash").not.toContain("—")).toThrow();
  });

  it("promises only what Murage actually routes today", () => {
    // WHY THE GUARD THAT USED TO BE HERE WAS WRONG, so nobody restores it.
    //
    // It read `expect(claims).not.toMatch(/voice|speech|image|picture|avatar/)`
    // and its comment said Flux "is not voice, not image generation". That was
    // a claim about FLUX, and it was false. FluxRouter serves a metered
    // POST /v1/images/generations (flux-router/src/images_route.py) across
    // seven provider arms (capability_image.py), and an audio route besides.
    // Probed live 2026-09-03: an unauthenticated POST to
    // https://api.fluxrouter.ai/v1/images/generations answers 401
    // {"error":{"message":"unauthorized"}}, which is that handler's own 401 and
    // only runs AFTER the FLUX_CAP_IMAGE_ENABLED dark gate would have returned
    // 404. The capability is live, so a blanket ban on the word "image" was
    // guarding a fact that was not true.
    //
    // The real risk was never "Flux cannot do this". It is "MURAGE DOES NOT
    // ROUTE THIS YET" — copy that sends someone to a key that then does
    // nothing. So the list below is unrouted CAPABILITIES, and whether images
    // count is read off the code rather than off anybody's belief. An entry
    // leaves this list in the same change that wires it.
    const avatarSource = readFileSync(join(srcRoot, "..", "server", "avatar-image.ts"), "utf8");
    const routesImages = /images\/generations/.test(avatarSource) && /flux/i.test(avatarSource);

    const unrouted: [string, RegExp][] = [
      // Voice is being wired separately and is NOT this key yet: `tts` is its
      // own credential (server/config.ts) and nothing in tts.ts reads
      // flux-config.ts. Delete this row in the change that routes it.
      ["voice", /voice|speech|speak|out loud/],
      ["video", /video/],
    ];
    if (!routesImages) unrouted.push(["image generation", /image|picture|avatar/]);
    const promises = (copy: string) =>
      unrouted.filter(([, pattern]) => pattern.test(copy)).map(([name]) => name);

    const claims = [FLUX_COPY.keyHelp, FLUX_COPY.inviteBody].join(" ").toLowerCase();
    expect(promises(claims)).toEqual([]);
    expect(claims).not.toMatch(/every (agent|bot|engine)|all (agents|bots|engines)/);
    // and it does name the three engines that are actually routable
    expect(claims).toContain("claude");
    expect(claims).toContain("codex");
    expect(claims).toContain("qwen");

    // POSITIVE control, unrouted side: copy that promised speech would fail.
    expect(promises("your bots can speak their replies out loud")).toEqual(["voice"]);
    // POSITIVE control, routed side: images are wired, so naming them is
    // allowed now — and the SAME sentence is caught the moment they are not.
    expect(routesImages).toBe(true);
    expect(promises("it also draws your bot avatars")).toEqual([]);
    const asIfUnwired: [string, RegExp][] = [...unrouted, ["image generation", /image|picture|avatar/]];
    expect(
      asIfUnwired.filter(([, pattern]) => pattern.test("it also draws your bot avatars")).map(([name]) => name),
    ).toEqual(["image generation"]);
  });

  it("says what the person gets, not what the system is", () => {
    const all = Object.values(FLUX_COPY).join(" ").toLowerCase();
    expect(all).not.toMatch(/configure your|set up your .*api key|enter your api key/);
  });
});

describe("nothing in the app is gated on a Flux key", () => {
  // Murage's engines are separately authenticated: a signed-in Claude, Codex
  // or Gemini CLI is what makes the app work. A Flux key is additive, so no
  // surface outside the card that enters it, the offer that points at the card,
  // and the one panel whose work the key actually performs may condition
  // anything on it.
  //
  // BotProfileAvatarCard was added to this list deliberately, not to quiet a
  // failure. Avatar generation now routes at Flux when a Flux key exists
  // (server/avatar-image.ts), so the panel has to name the provider that will
  // really send the bill. It is NOT gated: with no Flux key the panel keeps the
  // OpenAI image key path exactly as it was and only adds a pointer to
  // Settings. A new entry here has to clear that same bar.
  const OWNERS = new Set([
    "components/BotProfileAvatarCard.tsx",
    "components/FluxKeyCard.tsx",
    "components/FluxInvite.tsx",
    "lib/flux-invite.ts",
    "lib/use-flux-invite.ts",
    // Composer reads it to tell PushToTalk whether to OFFER voice typing or to
    // point at Settings. It clears the same bar: with no Flux key the mic is
    // still drawn, muted, and pressing it says where to add one — the feature
    // is not removed, a pointer is added. If that ever becomes a `hidden`,
    // this entry has to go with it.
    "components/Composer.tsx",
  ]);

  const sources = (): string[] => {
    const out: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
      }
    })(srcRoot);
    return out;
  };

  it("reads flux?.configured in the two places that own the offer, and nowhere else", () => {
    const readers = sources()
      .filter((path) => /flux\?\.configured|flux\.configured/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(srcRoot.length + 1).replace(/\\/g, "/"))
      // store.tsx declares the type; declaring it is not gating on it
      .filter((rel) => rel !== "state/store.tsx");
    expect(readers.sort()).toEqual([...OWNERS].filter((o) => readers.includes(o)).sort());
    for (const rel of readers) expect(OWNERS.has(rel)).toBe(true);
    // POSITIVE control: the scan does find real readers, so an empty result
    // cannot be mistaken for a clean one.
    expect(readers).toContain("lib/use-flux-invite.ts");
  });

  it("offers the key without blocking anything: no overlay, no dialog", () => {
    const invite = readFileSync(join(srcRoot, "components/FluxInvite.tsx"), "utf8");
    // A backdrop over the whole viewport, or a dialog role, would make this
    // something a person has to deal with before using an app that already
    // works. Both are forbidden here.
    expect(invite).not.toMatch(/inset-0/);
    expect(invite).not.toMatch(/role="dialog"|aria-modal/);
    expect(invite).toMatch(/role="complementary"/);
  });
});

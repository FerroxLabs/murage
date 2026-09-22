// The onboarding signup is what builds the list, and the desktop's half of it
// no longer holds a credential at all.
//
// WHAT THIS FILE IS NOW FOR. `SENDLANE_API_KEY` and `SENDLANE_HASH_KEY` are
// write credentials for a whole marketing account, and they used to ship
// inside the app. `electron-builder.yml` sets `asar: true`, and an ASAR is an
// archive, not encryption, so every installed copy carried both keys in the
// clear. They are Worker secrets now. Three properties matter here, and all
// three are asserted below rather than reasoned about:
//
//   1. A DESKTOP BUILD CANNOT SEND A SENDLANE CREDENTIAL ANYWHERE. Not from
//      config, not from the environment, not through the request body. The
//      test plants both keys everywhere this module could still read them and
//      watches what actually goes out on the wire.
//   2. A SIGNUP FAILURE NEVER BLOCKS ENTRY TO THE APP. `subscribe` may not
//      throw, whatever the network does, because the worst acceptable outcome
//      of the control plane being down is a missed subscriber.
//   3. A BUILD THAT CANNOT COLLECT SAYS SO. "disabled" used to be logged
//      nowhere, so a build that collected nothing collected nothing in
//      silence, for ever.
//
// NO REAL CREDENTIAL APPEARS IN THIS FILE. Every value below is obviously fake
// and is asserted on only for absence.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR, WORKSPACE_CREDENTIAL_ENV } from "./config.ts";
import {
  ANNOUNCEMENTS_SUBSCRIBE_PATH,
  announcementsBaseUrl,
  announcementsStartupNotice,
  DEFAULT_ANNOUNCEMENTS_BASE_URL,
  subscribe,
} from "./sendlane.ts";

const CONFIG_PATH = join(DATA_DIR, "config.json");

/** The environment a packaged build runs in: an Electron utility child says so
 *  with `MURAGE_DESKTOP_PARENT`, and that is the only state in which the
 *  hosted default applies. */
const PACKAGED = { MURAGE_DESKTOP_PARENT: "1" };

/** Obviously not credentials. They exist so the test can plant them in every
 *  place this module could conceivably still read one, and then prove that
 *  nothing carries them out. */
const FAKE = {
  SENDLANE_API_KEY: "test-api-not-a-real-key",
  SENDLANE_HASH_KEY: "test-hash-not-a-real-key",
};

afterEach(() => {
  rmSync(CONFIG_PATH, { force: true });
});

function writeSendlaneConfig(sendlane: Record<string, string>): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify({ sendlane }), { mode: 0o600 });
}

/** One injected fetch that records what it was asked and answers a queue of
 *  canned responses. The last answer repeats, so a retry test does not have to
 *  count the attempts twice. */
function fakeFetch(answers: Array<{ status: number } | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const answer = answers[Math.min(i++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: async () => "" };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const OK = { status: 200 };

/** Every byte of one recorded request: url, method, headers and body. */
function wire(call: { url: string; init: RequestInit }): string {
  return [
    call.url,
    String(call.init.method ?? ""),
    JSON.stringify(call.init.headers ?? {}),
    String(call.init.body ?? ""),
  ].join("\n");
}

describe("the desktop holds no Sendlane credential", () => {
  it("sends the address and the name, and nothing that could be a key", async () => {
    // Both keys are planted in the environment AND in the sendlane config
    // block, which is every door this module ever read them through. If any
    // of that still reaches the wire, this fails.
    writeSendlaneConfig({ ...FAKE, listId: "37", apiKey: FAKE.SENDLANE_API_KEY });
    const fetcher = fakeFetch([OK]);
    const result = await subscribe("Someone@Example.COM ", "  Someone  ", {
      env: { ...PACKAGED, ...FAKE },
      fetchImpl: fetcher.impl,
    });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetcher.calls).toHaveLength(1);
    const sent = wire(fetcher.calls[0]!);
    expect(sent).not.toContain(FAKE.SENDLANE_API_KEY);
    expect(sent).not.toContain(FAKE.SENDLANE_HASH_KEY);
    // And it is not going to Sendlane at all: the control plane is the only
    // thing this side talks to.
    expect(sent).not.toContain("sendlane.com");
    expect(fetcher.calls[0]!.url)
      .toBe(`${DEFAULT_ANNOUNCEMENTS_BASE_URL}${ANNOUNCEMENTS_SUBSCRIBE_PATH}`);
    expect(JSON.parse(String(fetcher.calls[0]!.init.body)))
      .toEqual({ email: "someone@example.com", name: "Someone" });
  });

  it("has no environment variable left that could carry one", () => {
    // The strip list is the desktop's inventory of workspace credentials. A
    // name on it is a credential this app expects to hold; neither of these
    // is, any more, and nothing may re-introduce them here without also
    // re-introducing a key in the build.
    expect(WORKSPACE_CREDENTIAL_ENV as readonly string[]).not.toContain("SENDLANE_API_KEY");
    expect(WORKSPACE_CREDENTIAL_ENV as readonly string[]).not.toContain("SENDLANE_HASH_KEY");
  });

  it("omits a name it does not have rather than sending an empty one", async () => {
    const noName = fakeFetch([OK]);
    await subscribe("someone@example.com", "   ", { env: { ...PACKAGED }, fetchImpl: noName.impl });
    // Sendlane leaves omitted fields intact, so an absent name must be absent
    // rather than an empty string that would wipe a name it already has. The
    // Worker forwards what it is given, so the rule starts here.
    expect(JSON.parse(String(noName.calls[0]!.init.body))).toEqual({ email: "someone@example.com" });
  });
});

describe("where a signup is posted", () => {
  it("uses the hosted control plane in a packaged build, and collects nothing elsewhere", () => {
    expect(announcementsBaseUrl({ ...PACKAGED })).toBe(DEFAULT_ANNOUNCEMENTS_BASE_URL);
    // A dev run and a test fixture write to a real mailing list if this is
    // wrong, so they are off unless somebody says otherwise.
    expect(announcementsBaseUrl({})).toBeNull();
  });

  it("lets a fork point at its own worker, from config or from the environment", () => {
    expect(announcementsBaseUrl({ MURAGE_ANNOUNCEMENTS_URL: "https://accounts.example.test/" }))
      .toBe("https://accounts.example.test");
    // http is allowed on loopback alone, so `wrangler dev` works and a plain
    // http host on the internet does not.
    expect(announcementsBaseUrl({ MURAGE_ANNOUNCEMENTS_URL: "http://127.0.0.1:8787" }))
      .toBe("http://127.0.0.1:8787");
    writeSendlaneConfig({ baseUrl: "https://accounts.fork.test" });
    expect(announcementsBaseUrl({})).toBe("https://accounts.fork.test");
    // Config beats env, the same order every other non-secret field uses.
    expect(announcementsBaseUrl({ MURAGE_ANNOUNCEMENTS_URL: "https://accounts.example.test" }))
      .toBe("https://accounts.fork.test");
  });

  it("disables the signup on an override it cannot use, rather than falling back to ours", async () => {
    // Somebody who typed a URL meant that URL. Posting their users' addresses
    // to Murage's own list instead would be the worst reading of a typo.
    for (const bad of [
      "http://accounts.example.test",
      "https://user:secret@accounts.example.test",
      "https://accounts.example.test/v1",
      "not a url",
    ]) {
      expect(announcementsBaseUrl({ ...PACKAGED, MURAGE_ANNOUNCEMENTS_URL: bad }), bad).toBeNull();
    }
    const fetcher = fakeFetch([OK]);
    const result = await subscribe("someone@example.com", "Someone", {
      env: { ...PACKAGED, MURAGE_ANNOUNCEMENTS_URL: "not a url" },
      fetchImpl: fetcher.impl,
    });
    expect(result).toEqual({ ok: false, reason: "disabled" });
    expect(fetcher.calls).toHaveLength(0);
  });
});

describe("the startup notice", () => {
  it("says so when the signup cannot possibly work", () => {
    expect(announcementsStartupNotice({})).toContain("recorded nowhere");
    expect(announcementsStartupNotice({ MURAGE_ANNOUNCEMENTS_URL: "not a url" }))
      .toContain("MURAGE_ANNOUNCEMENTS_URL");
  });

  it("says nothing when the build can collect", () => {
    expect(announcementsStartupNotice({ ...PACKAGED })).toBeNull();
    expect(announcementsStartupNotice({ MURAGE_ANNOUNCEMENTS_URL: "https://accounts.fork.test" }))
      .toBeNull();
  });

  it("never puts a value in the notice", () => {
    // Nothing on this side is a credential any more, but the notice reads an
    // override somebody may have pasted a URL with a token in, and a
    // diagnostic that echoed one would put it in a log and a support bundle.
    const notice = announcementsStartupNotice({
      MURAGE_ANNOUNCEMENTS_URL: "https://user:secret-not-a-real-token@accounts.example.test",
    }) ?? "";
    expect(notice).toBeTruthy();
    expect(notice).not.toContain("secret-not-a-real-token");
  });
});

describe("subscribe", () => {
  it("rejects an address that is not an address, before any request", async () => {
    const fetcher = fakeFetch([OK]);
    for (const bad of ["", "   ", "someone", "someone@", "@example.com", "some one@example.com", "someone@example.c"]) {
      const result = await subscribe(bad, "Someone", { env: { ...PACKAGED }, fetchImpl: fetcher.impl });
      expect(result, bad).toEqual({ ok: false, reason: "invalid-email" });
    }
    expect(fetcher.calls).toHaveLength(0);
  });

  it("retries a control-plane server error and gives up after the last attempt", async () => {
    const fetcher = fakeFetch([{ status: 503 }]);
    const result = await subscribe("someone@example.com", undefined, {
      env: { ...PACKAGED },
      fetchImpl: fetcher.impl,
      retries: 2,
    });
    expect(result).toEqual({ ok: false, reason: "upstream", status: 503 });
    expect(fetcher.calls).toHaveLength(2);
  });

  it("does not retry a refusal", async () => {
    // A 4xx is the control plane saying no on purpose — a rejected address, a
    // rate limit. Hammering it changes nothing and costs the person a wait.
    for (const status of [400, 429]) {
      const fetcher = fakeFetch([{ status }]);
      const result = await subscribe("someone@example.com", "Someone", {
        env: { ...PACKAGED },
        fetchImpl: fetcher.impl,
        retries: 3,
      });
      expect(result, String(status)).toEqual({ ok: false, reason: "upstream", status });
      expect(fetcher.calls, String(status)).toHaveLength(1);
    }
  });

  it("never throws, whatever the network does, so nothing can block entry to the app", async () => {
    const thrown = fakeFetch([new Error("ECONNREFUSED")]);
    await expect(
      subscribe("someone@example.com", "Someone", { env: { ...PACKAGED }, fetchImpl: thrown.impl, retries: 2 }),
    ).resolves.toEqual({ ok: false, reason: "upstream", status: undefined });

    // The disabled path is the one every non-packaged build takes on every
    // signup, so it must be the calmest of all: no request, no throw.
    await expect(
      subscribe("someone@example.com", "Someone", { env: {}, fetchImpl: thrown.impl }),
    ).resolves.toEqual({ ok: false, reason: "disabled" });
  });
});

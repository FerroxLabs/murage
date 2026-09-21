// The onboarding signup is what builds the list, and until now it had no test
// at all: a 105-line module holding a write credential for a whole marketing
// account, with retry and HTML-error handling, at zero coverage.
//
// Two properties matter more than any other here, and both are asserted below
// rather than reasoned about:
//
//   1. A SENDLANE FAILURE NEVER BLOCKS ENTRY TO THE APP. `subscribe` may not
//      throw, whatever the network does, because the worst acceptable outcome
//      of Sendlane being down is a missed subscriber.
//   2. A BUILD THAT CANNOT COLLECT SAYS SO. "disabled" used to be logged
//      nowhere, so a packaged build without credentials collected nothing for
//      ever, in silence.
//
// NO REAL CREDENTIAL APPEARS IN THIS FILE. Every value below is obviously
// fake and is asserted on only for shape and routing, never as a secret.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  SENDLANE_DEFAULT_LIST_ID,
  sendlaneCredentials,
  sendlaneMissing,
  sendlaneStartupNotice,
  subscribe,
} from "./sendlane.ts";

const CONFIG_PATH = join(DATA_DIR, "config.json");

/** Obviously not a credential. Long enough to be shaped like one and nothing
 *  more; it is never sent anywhere but the injected fetch below. */
const FAKE = { SENDLANE_API_KEY: "test-api-not-a-real-key", SENDLANE_HASH_KEY: "test-hash-not-a-real-key" };

afterEach(() => {
  rmSync(CONFIG_PATH, { force: true });
});

/**
 * Written by hand rather than through `saveConfig`, and that is worth
 * recording: `sendlane` is NOT in saveConfig's section-merge list, so the
 * block can only arrive by hand-edited config.json or by environment. That is
 * defensible for a write credential nobody should be able to set from the UI,
 * but it means "put it in config" is a file edit, not a settings screen.
 */
function writeSendlaneConfig(sendlane: Record<string, string>): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify({ sendlane }), { mode: 0o600 });
}

/** One injected fetch that records what it was asked and answers a queue of
 *  canned responses. The last answer repeats, so a retry test does not have to
 *  count the attempts twice. */
function fakeFetch(answers: Array<{ status: number; body: string } | Error>) {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? "")) });
    const answer = answers[Math.min(i++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: async () => answer.body };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const OK = { status: 200, body: '{"status":200}' };
const HTML = { status: 200, body: "<!DOCTYPE html><html><body>Server Error</body></html>" };

describe("sendlane credentials", () => {
  it("is disabled when the write credentials are absent, and never calls out", async () => {
    const fetcher = fakeFetch([OK]);
    const result = await subscribe("someone@example.com", "Someone", { env: {}, fetchImpl: fetcher.impl });
    expect(result).toEqual({ ok: false, reason: "disabled" });
    // Not merely "not ok": nothing was sent. A disabled build must not make a
    // request with half a credential in it.
    expect(fetcher.calls).toHaveLength(0);
  });

  it("stays disabled when only one of the two write credentials is present", () => {
    expect(sendlaneCredentials({ SENDLANE_API_KEY: FAKE.SENDLANE_API_KEY })).toBeNull();
    expect(sendlaneCredentials({ SENDLANE_HASH_KEY: FAKE.SENDLANE_HASH_KEY })).toBeNull();
  });

  it("defaults the list to Murage's own, and never defaults a write credential", () => {
    // The owner's ruling: "List ID 37 is Murage's list." A list id is
    // configuration; the two keys are write credentials for the whole account
    // and are still required, so a default cannot make an unconfigured build
    // look configured.
    expect(SENDLANE_DEFAULT_LIST_ID).toBe("37");
    expect(sendlaneCredentials({ ...FAKE })).toEqual({
      apiKey: FAKE.SENDLANE_API_KEY,
      hashKey: FAKE.SENDLANE_HASH_KEY,
      listId: "37",
    });
    expect(sendlaneCredentials({ SENDLANE_LIST_ID: "37" })).toBeNull();
  });

  it("lets an explicit list id win, from the environment or from config", () => {
    expect(sendlaneCredentials({ ...FAKE, SENDLANE_LIST_ID: "412" })?.listId).toBe("412");
    writeSendlaneConfig({ listId: "908" });
    expect(sendlaneCredentials({ ...FAKE })?.listId).toBe("908");
    // Config beats env, the same order every other credential in loadConfig
    // uses for a non-secret field.
    expect(sendlaneCredentials({ ...FAKE, SENDLANE_LIST_ID: "412" })?.listId).toBe("908");
  });

  it("posts to the configured list, tagged, without inventing a name", async () => {
    const fetcher = fakeFetch([OK]);
    await subscribe("Someone@Example.COM ", "  Someone  ", { env: { ...FAKE }, fetchImpl: fetcher.impl });
    const sent = fetcher.calls[0]!.body;
    expect(fetcher.calls[0]!.url).toContain("/list-subscriber-add");
    expect(sent.get("list_id")).toBe("37");
    expect(sent.get("email")).toBe("someone@example.com");
    expect(sent.get("first_name")).toBe("Someone");
    expect(sent.get("tag_names")).toBe("murage,app-onboarding");

    const noName = fakeFetch([OK]);
    await subscribe("someone@example.com", "   ", { env: { ...FAKE }, fetchImpl: noName.impl });
    // Sendlane leaves omitted fields intact, so an absent name must be absent
    // rather than an empty string that would wipe a name it already has.
    expect(noName.calls[0]!.body.has("first_name")).toBe(false);
  });
});

describe("sendlane startup notice", () => {
  it("says so, loudly and once, when the signup cannot possibly work", () => {
    const notice = sendlaneStartupNotice({});
    expect(notice).toBeTruthy();
    expect(notice).toContain("SENDLANE_API_KEY");
    expect(notice).toContain("SENDLANE_HASH_KEY");
    expect(sendlaneMissing({})).toEqual(["SENDLANE_API_KEY", "SENDLANE_HASH_KEY"]);
  });

  it("says nothing when the build is configured", () => {
    expect(sendlaneStartupNotice({ ...FAKE })).toBeNull();
    expect(sendlaneMissing({ ...FAKE })).toEqual([]);
  });

  it("never puts a credential value in the notice", () => {
    const notice = sendlaneStartupNotice({ SENDLANE_API_KEY: FAKE.SENDLANE_API_KEY }) ?? "";
    expect(notice).not.toContain(FAKE.SENDLANE_API_KEY);
  });
});

describe("sendlane subscribe", () => {
  it("rejects an address that is not an address, before any request", async () => {
    const fetcher = fakeFetch([OK]);
    for (const bad of ["", "   ", "someone", "someone@", "@example.com", "some one@example.com", "someone@example.c"]) {
      const result = await subscribe(bad, "Someone", { env: { ...FAKE }, fetchImpl: fetcher.impl });
      expect(result, bad).toEqual({ ok: false, reason: "invalid-email" });
    }
    expect(fetcher.calls).toHaveLength(0);
  });

  it("treats an HTML error body as retryable, not as a rejection", async () => {
    // Sendlane answers with an HTML error page instead of JSON when it is
    // unhappy, including under concurrency, and it does it with a 200. Read as
    // a success that body would report a subscriber who was never added.
    const fetcher = fakeFetch([HTML, HTML, OK]);
    const result = await subscribe("someone@example.com", "Someone", {
      env: { ...FAKE },
      fetchImpl: fetcher.impl,
      retries: 3,
    });
    expect(result.ok).toBe(true);
    expect(fetcher.calls).toHaveLength(3);
  });

  it("retries a server error and gives up after the last attempt", async () => {
    const fetcher = fakeFetch([{ status: 503, body: "upstream is unwell" }]);
    const result = await subscribe("someone@example.com", undefined, {
      env: { ...FAKE },
      fetchImpl: fetcher.impl,
      retries: 2,
    });
    expect(result).toEqual({ ok: false, reason: "upstream", status: 503 });
    expect(fetcher.calls).toHaveLength(2);
  });

  it("does not retry a plain rejection", async () => {
    // A 4xx that is not an HTML error page is Sendlane saying no on purpose.
    // Hammering it three times changes nothing and costs the person a wait.
    const fetcher = fakeFetch([{ status: 400, body: '{"status":400,"message":"nope"}' }]);
    const result = await subscribe("someone@example.com", "Someone", {
      env: { ...FAKE },
      fetchImpl: fetcher.impl,
      retries: 3,
    });
    expect(result).toEqual({ ok: false, reason: "upstream", status: 400 });
    expect(fetcher.calls).toHaveLength(1);
  });

  it("never throws, whatever the network does, so nothing can block entry to the app", async () => {
    const thrown = fakeFetch([new Error("ECONNREFUSED")]);
    await expect(
      subscribe("someone@example.com", "Someone", { env: { ...FAKE }, fetchImpl: thrown.impl, retries: 2 }),
    ).resolves.toEqual({ ok: false, reason: "upstream", status: undefined });

    // The disabled path is the one a packaged build without credentials takes
    // on every signup, so it must be the calmest of all: no request, no throw.
    await expect(
      subscribe("someone@example.com", "Someone", { env: {}, fetchImpl: thrown.impl }),
    ).resolves.toEqual({ ok: false, reason: "disabled" });
  });
});

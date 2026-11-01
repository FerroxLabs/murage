// The news signup the Chief asks for on the first run (server/news-signup.ts).
// No test here reaches the network: every post goes to an injected fake, and
// the timers are driven by hand.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NEWS_BACKOFF_MS, NEWS_FILE, NEWS_GIVE_UP_MS, NewsSignup, newsBaseUrl } from "./news-signup.ts";
import { FIRST_RUN_COPY } from "../src/lib/first-run-copy.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { NEWS_CONSENT_MAX, NEWS_COPY, newsConsentText } from "../src/lib/news-consent.ts";

const HELLO_WORDS = `${FIRST_RUN_COPY.hello.welcome.heading}\n${FIRST_RUN_COPY.hello.welcome.emailHelper}`;
const SETTINGS_WORDS = `${NEWS_COPY.title}\n${NEWS_COPY.subtitle}`;

const ENV = { MURAGE_NEWS_URL: "https://news.test" } as NodeJS.ProcessEnv;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "news-signup-")); });
afterEach(() => { removeTempDirSync(dir); });

type Reply = { status: number; headers?: Record<string, string> } | "offline";

function rig(replies: Reply[], env: NodeJS.ProcessEnv = ENV) {
  let clock = 1_000_000;
  const posts: Array<{ url: string; init: RequestInit }> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    posts.push({ url: String(url), init });
    const reply = replies.shift() ?? { status: 202 };
    if (reply === "offline") throw new TypeError("fetch failed");
    return new Response(reply.status === 204 ? null : JSON.stringify({ status: "subscribed" }), { status: reply.status, headers: reply.headers });
  }) as unknown as typeof fetch;
  const make = () => new NewsSignup({
    dir, env, fetchImpl, now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); },
  });
  const news = make();
  /** Fire the one pending timer, as if its wait had passed, and let the post finish. */
  const tick = async (on: NewsSignup = news) => {
    const t = timers.shift();
    if (!t) return null;
    clock += t.ms;
    t.fn();
    await on.deliver();
    return t.ms;
  };
  const file = () => JSON.parse(readFileSync(join(dir, NEWS_FILE), "utf8"));
  return { news, make, posts, timers, tick, file, advance: (ms: number) => { clock += ms; } };
}

describe("asked once", () => {
  it("records the ask once and never over an outcome", () => {
    const { news, file } = rig([]);
    expect(news.view()).toEqual({ status: null, at: null, onList: false });
    news.markAsked();
    expect(file().status).toBe("asked");
    news.markSkipped();
    news.markAsked();
    expect(file().status).toBe("skipped");
  });

  it("never turns a subscription into a skip", () => {
    const { news, file } = rig([]);
    news.subscribe("a@example.com", "A");
    news.markSkipped();
    news.markAsked();
    expect(file().status).toBe("subscribed");
  });

  it("keeps the record owner-only on disk and shows the renderer no address", () => {
    const { news } = rig([]);
    news.subscribe("a@example.com", "A");
    if (process.platform !== "win32") expect(statSync(join(dir, NEWS_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(news.view())).not.toContain("a@example.com");
  });

  it("reads an unreadable record as nothing asked", () => {
    writeFileSync(join(dir, NEWS_FILE), "{not json");
    const { news } = rig([]);
    expect(news.read()).toBeNull();
  });
});

describe("skip", () => {
  it("posts nothing", async () => {
    const { news, posts, timers } = rig([]);
    news.markAsked();
    news.markSkipped();
    expect(timers).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });
});

describe("subscribe", () => {
  it("refuses a non-address before anything is stored or sent", () => {
    const { news, posts, timers } = rig([]);
    expect(news.subscribe("not-an-address")).toEqual({ ok: false, reason: "invalid-email" });
    expect(news.read()).toBeNull();
    expect(posts).toHaveLength(0);
    expect(timers).toHaveLength(0);
  });

  it("posts exactly email, name, source and the card's words to the news endpoint, then deletes the address", async () => {
    const { news, posts, tick, file } = rig([{ status: 202 }]);
    expect(news.subscribe("  Sean@Example.COM ", "  Sean ")).toEqual({ ok: true });
    expect(file().delivery).toMatchObject({ state: "pending", email: "sean@example.com", name: "Sean" });
    await tick();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://news.test/api/news/subscribe");
    expect(posts[0].init.method).toBe("POST");
    expect(JSON.parse(String(posts[0].init.body))).toEqual({ email: "sean@example.com", name: "Sean", source: "app", consentText: HELLO_WORDS });
    // no honeypot, no device or install id, no extra headers
    expect(String(posts[0].init.body)).not.toMatch(/nickname|device|install/i);
    expect(posts[0].init.headers).toEqual({ "content-type": "application/json" });
    expect(posts[0].init.redirect).toBe("error");
    expect(file().status).toBe("subscribed");
    expect(file().delivery).toEqual({ state: "sent", attempts: 1, lastStatus: 202 });
    expect(readFileSync(join(dir, NEWS_FILE), "utf8")).not.toContain("sean@example.com");
  });

  it("leaves the name out when there is none", async () => {
    const { news, posts, tick } = rig([{ status: 200 }]);
    news.subscribe("a@example.com");
    await tick();
    expect(JSON.parse(String(posts[0].init.body))).toEqual({ email: "a@example.com", source: "app", consentText: HELLO_WORDS });
  });

  it("sends the Settings card's words when the address was typed there", async () => {
    const { news, posts, tick, file } = rig([{ status: 202 }]);
    news.subscribe("a@example.com", undefined, "settings");
    expect(file().delivery.consentText).toBe(SETTINGS_WORDS);
    await tick();
    expect(JSON.parse(String(posts[0].init.body)).consentText).toBe(SETTINGS_WORDS);
    // and the wording goes with the address: nothing of it stays once sent
    expect(file().delivery).toEqual({ state: "sent", attempts: 1, lastStatus: 202 });
  });

  it("never takes the words from the renderer: an unknown card is the hello card", async () => {
    const { news, posts, tick } = rig([{ status: 202 }]);
    news.subscribe("a@example.com", "A", "I agree to anything");
    await tick();
    expect(JSON.parse(String(posts[0].init.body)).consentText).toBe(HELLO_WORDS);
  });

  it("keeps the wording across a restart, and fills it in for an older pending record", async () => {
    const first = rig([{ status: 202 }]);
    first.news.subscribe("a@example.com", undefined, "settings");
    first.news.stop();
    const again = first.make();
    again.start();
    expect(first.timers).toHaveLength(1);
    await first.tick(again);
    expect(first.posts).toHaveLength(1);
    expect(JSON.parse(String(first.posts[0].init.body)).consentText).toBe(SETTINGS_WORDS);

    const old = rig([{ status: 202 }]);
    writeFileSync(join(dir, NEWS_FILE), JSON.stringify({ version: 1, status: "subscribed", at: 1_000_000, delivery: { state: "pending", attempts: 0, nextAt: 0, email: "b@example.com" } }));
    old.news.start();
    await old.tick();
    expect(JSON.parse(String(old.posts[0].init.body)).consentText).toBe(HELLO_WORDS);
  });

  it("caps the wording at 500 characters and it is the words the cards show", () => {
    expect(newsConsentText("hello")).toBe(HELLO_WORDS.slice(0, NEWS_CONSENT_MAX));
    expect(newsConsentText("settings")).toBe(SETTINGS_WORDS);
    for (const from of ["hello", "settings"] as const) {
      const text = newsConsentText(from);
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(NEWS_CONSENT_MAX);
      expect(text).not.toContain("\u2014");
    }
  });

  it("takes any 2xx as success, whatever the body says", async () => {
    for (const status of [200, 201, 202, 204]) {
      const { news, tick, file } = rig([{ status }]);
      news.subscribe("a@example.com");
      await tick();
      expect(file().delivery.state).toBe("sent");
      rmSync(join(dir, NEWS_FILE));
    }
  });
});

describe("4xx and 5xx", () => {
  it("stops on 400 and drops the address", async () => {
    const { news, posts, tick, timers, file } = rig([{ status: 400 }]);
    news.subscribe("a@example.com");
    await tick();
    expect(posts).toHaveLength(1);
    expect(timers).toHaveLength(0);
    expect(file().delivery).toEqual({ state: "refused", attempts: 1, lastStatus: 400 });
    // Not on the list, so Settings offers the form again, and a new address is taken.
    expect(news.view()).toMatchObject({ status: "subscribed", onList: false });
    expect(news.subscribe("b@example.com")).toEqual({ ok: true });
    expect(news.view().onList).toBe(true);
  });

  it("waits out 429 for as long as Retry-After says, then sends", async () => {
    const { news, posts, tick, file } = rig([{ status: 429, headers: { "retry-after": "120" } }, { status: 202 }]);
    news.subscribe("a@example.com");
    await tick();
    expect(file().delivery).toMatchObject({ state: "pending", attempts: 1, lastStatus: 429 });
    expect(await tick()).toBe(120_000);
    expect(posts).toHaveLength(2);
    expect(file().delivery.state).toBe("sent");
  });

  it("retries 503 on the backoff, quietly, until it lands", async () => {
    const { news, posts, tick, file } = rig([{ status: 503 }, { status: 503 }, { status: 500 }, { status: 202 }]);
    news.subscribe("a@example.com");
    await tick();
    const waits = [await tick(), await tick(), await tick()];
    expect(waits).toEqual([NEWS_BACKOFF_MS[0], NEWS_BACKOFF_MS[1], NEWS_BACKOFF_MS[2]]);
    expect(posts).toHaveLength(4);
    expect(file().delivery).toEqual({ state: "sent", attempts: 4, lastStatus: 202 });
  });
});

describe("offline", () => {
  it("queues while offline and sends once the network is back", async () => {
    const { news, posts, tick, file } = rig(["offline", "offline", { status: 202 }]);
    news.subscribe("a@example.com", "A");
    await tick();
    expect(file().delivery).toMatchObject({ state: "pending", attempts: 1 });
    await tick();
    await tick();
    expect(posts).toHaveLength(3);
    expect(file().delivery.state).toBe("sent");
  });

  it("picks up an owed delivery after a restart", async () => {
    const first = rig(["offline"]);
    first.news.subscribe("a@example.com");
    await first.tick();
    first.news.stop();
    // a new process: same data dir, fresh object
    const second = first.make();
    second.start();
    expect(first.timers).toHaveLength(1);
    await first.tick(second);
    expect(first.posts).toHaveLength(2);
    expect(first.file().delivery.state).toBe("sent");
  });

  it("gives up after two weeks and drops the address", async () => {
    const { news, tick, file, advance } = rig(["offline"]);
    news.subscribe("a@example.com");
    await tick();
    advance(NEWS_GIVE_UP_MS);
    await tick();
    expect(file().delivery).toMatchObject({ state: "expired" });
    expect(file().delivery.email).toBeUndefined();
    expect(news.view().onList).toBe(false);
  });
});

describe("where it posts", () => {
  it("posts nowhere from a dev run, a test or a Cloud home, and drops the address it cannot send", async () => {
    const { news, posts, tick, file } = rig([], {} as NodeJS.ProcessEnv);
    news.subscribe("a@example.com");
    await tick();
    expect(posts).toHaveLength(0);
    expect(file().delivery).toEqual({ state: "expired", attempts: 0 });
    expect(readFileSync(join(dir, NEWS_FILE), "utf8")).not.toContain("a@example.com");
    expect(news.view().onList).toBe(false);
  });

  it("uses murage.ai in the packaged app and refuses a bad override", () => {
    expect(newsBaseUrl({ MURAGE_DESKTOP_PARENT: "1" } as NodeJS.ProcessEnv)).toBe("https://murage.ai");
    expect(newsBaseUrl({} as NodeJS.ProcessEnv)).toBeNull();
    expect(newsBaseUrl({ MURAGE_NEWS_URL: "http://evil.example" } as NodeJS.ProcessEnv)).toBeNull();
    expect(newsBaseUrl({ MURAGE_NEWS_URL: "https://murage.ai/api" } as NodeJS.ProcessEnv)).toBeNull();
    expect(newsBaseUrl({ MURAGE_NEWS_URL: "http://127.0.0.1:8787" } as NodeJS.ProcessEnv)).toBe("http://127.0.0.1:8787");
    // The packaged app posts to murage.ai and nowhere else: an inherited
    // variable cannot send an owner's address to another host.
    expect(newsBaseUrl({ MURAGE_NEWS_URL: "https://other.example", MURAGE_DESKTOP_PARENT: "1" } as NodeJS.ProcessEnv)).toBe("https://murage.ai");
  });
});

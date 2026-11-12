// Tester feedback (UX lane L-FB), on a real Worker with the real D1 migrations.
// No real credential appears here: the pepper, the admin token and the Discord webhook are obviously fake, and every
// Discord call is injected, so nothing can reach discord.com.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import FIXED from "../src/feedback-fixed.json";
import { createWorker } from "../src/index";
import { callerSubject, classifyEdge } from "../src/edge-limits";
import { BUSY_LINE, discordLiteral, feedbackSchema, GLOBAL_PER_DAY, PRODUCT_FEEDBACK_LABEL, DAILY_LIMIT_LINE, discordMessage, discordWebhook, ownerFeedbackRoute, RATE_LIMITED_LINE, REMOVED, RETENTION_MS, scrubSecrets, sweepOwnerFeedback, type ChatFetch } from "../src/owner-feedback";

const BASE = "https://auth.murage.test";
const PATH = "/v1/owner-feedback";
const PEPPER = "test-only-feedback-pepper-with-more-than-32-characters";
const ADMIN = "test-only-admin-token-for-owner-feedback";
const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/test-only-not-a-real-webhook-token";

function withEnv(overrides: Record<string, string | undefined> = {}): Env {
  return { ...env, MURAGE_ENV: "live", FEEDBACK_PEPPER: PEPPER, CLOUD_ADMIN_TOKEN: ADMIN, ...overrides } as unknown as Env;
}

const INSTALL = "8f7d3c2e-1b4a-4c5d-9e8f-0a1b2c3d4e5f";
function body(overrides: Record<string, unknown> = {}) {
  return {
    installId: INSTALL,
    appVersion: "1.0.12",
    os: "macos",
    surface: "desktop",
    screen: "today",
    title: "Today",
    state: { page: "general", gates: [{ id: "no-engine", reason: "No engine is connected yet" }] },
    controls: [{ id: "new-bot", label: "New bot", address: "murage://new/bot" }],
    words: "I couldn't find something on this screen.",
    createdAt: "2026-11-02T12:00:00.000Z",
    ...overrides,
  };
}

function fakeDiscord(status = 204) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const impl: ChatFetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(null, { status });
  };
  return { impl, calls };
}

let callers = 0;
async function call(method: string, path: string, options: { json?: unknown; raw?: string; ip?: string; token?: string; env?: Env } = {}) {
  // A fresh /64 per call by default, so the edge limiter (keyed by /64 for this route) never answers first.
  const headers = new Headers({ "cf-connecting-ip": options.ip ?? `2001:db8:${(++callers).toString(16)}::1` });
  if (options.json !== undefined || options.raw !== undefined) headers.set("content-type", "application/json");
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  const request = new Request(`${BASE}${path}`, { method, headers, body: options.raw ?? (options.json === undefined ? undefined : JSON.stringify(options.json)) });
  const ctx = createExecutionContext();
  const response = await createWorker().fetch(request, options.env ?? withEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function rows() {
  return (await env.DB.prepare("SELECT * FROM owner_feedback ORDER BY received_at").all<Record<string, unknown>>()).results;
}

afterEach(async () => {
  await env.DB.prepare("DELETE FROM owner_feedback").run();
});

describe("POST /v1/owner-feedback: the allowlist", () => {
  it("stores one item, with the install id only as a peppered hash", async () => {
    const response = await call("POST", PATH, { json: body() });
    expect(response.status).toBe(200);
    const answer = await response.json() as { ok: boolean; id: string };
    expect(answer.ok).toBe(true);
    const [row] = await rows();
    expect(row.id).toBe(answer.id);
    expect(row.install_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(INSTALL);
    expect(row).toMatchObject({ app_version: "1.0.12", os: "macos", surface: "desktop", screen: "today", status: "new", reply_email: null });
    expect(JSON.parse(String(row.envelope_json))).toMatchObject({ screen: "today", title: "Today", state: { page: "general" } });
  });

  it.each([
    ["an unknown top-level field holding a message body", { messageText: "the owner's private chat" }],
    ["an unknown field inside state", { state: { page: "general", draft: "half-typed message" } }],
    ["an unknown field inside a control", { controls: [{ id: "new-bot", label: "New bot", address: "murage://new/bot", value: "typed text" }] }],
    ["an unknown field inside a gate", { state: { gates: [{ id: "no-engine", reason: "No engine is connected yet", detail: "x" }] } }],
    ["free words", { words: "I could not find where to change the morning brief." }],
    ["a fixed sentence with more after it", { words: "I couldn't find something on this screen. Dear Sam, the contract is attached." }],
    ["empty words", { words: "   " }],
    ["a bad surface", { surface: "watch" }],
    ["a bad os", { os: "beos" }],
    ["an email", { replyEmail: "tester@example.com" }],
    ["an email as the words", { words: "tester@example.com" }],
    ["an email as the title", { title: "tester@example.com" }],
    ["an email as a label", { controls: [{ id: "new-bot", label: "tester@example.com", address: "murage://new/bot" }] }],
    ["a bot id", { state: { botId: "juno" } }],
    ["a section", { state: { section: "quarterly revenue" } }],
    ["open folds", { state: { openFolds: ["what-we-send"] } }],
    ["a selected card", { state: { selectedCard: "card-1" } }],
    ["a path as the words", { words: "/Users/ada/Desktop/taxes.pdf" }],
    ["a path as the page", { state: { page: "/Users/ada/Desktop/taxes.pdf" } }],
    ["a path as the title", { title: "/Users/ada/Desktop/taxes.pdf" }],
    ["a Windows path as the title", { title: "C:\\Users\\ada\\taxes.pdf" }],
    ["a path as a gate's reason", { state: { gates: [{ id: "no-engine", reason: "/Users/ada/Desktop/taxes.pdf" }] } }],
    ["a path as a control's address", { controls: [{ id: "new-bot", label: "New bot", address: "/Users/ada/.ssh/id_ed25519" }] }],
    ["a path in a control's id", { controls: [{ id: "/Users/ada", label: "New bot", address: "murage://new/bot" }] }],
    ["a sentence as the title", { title: "I could not find where to change the morning brief" }],
    ["a name as the title", { title: "Juno" }],
    ["another screen's title", { title: "Chats" }],
    ["a name as the page", { state: { page: "Ada" } }],
    ["a name as a label", { controls: [{ id: "new-bot", label: "Family group", address: "murage://new/bot" }] }],
    ["a record id as the screen", { screen: "chat:018f3c2a-7b2e-7c1a-8d4e-9a1b2c3d4e5f", title: "Chat" }],
    ["a record id as a gate", { state: { gates: [{ id: "thread-1882", reason: "Waiting on Flux Router" }] } }],
    ["a path as a murage address", { controls: [{ id: "new-bot", label: "New bot", address: "murage://users/ada/desktop/taxes" }] }],
    ["a key as the title", { title: "sk-ant-abcdefghijklmnopqrstuv" }], // secret-scan: fixture
    ["a key as a gate's reason", { state: { gates: [{ id: "no-engine", reason: "sk-ant-abcdefghijklmnopqrstuv" }] } }], // secret-scan: fixture
    ["a key as a label", { controls: [{ id: "new-bot", label: "sk-ant-abcdefghijklmnopqrstuv", address: "murage://new/bot" }] }], // secret-scan: fixture
    ["a key as a control id", { controls: [{ id: ["sk_live_", "FAKEfake", "FAKEfake", "FAKE"].join(""), label: "New bot", address: "murage://new/bot" }] }], // secret-scan: fixture
    ["a key as the version", { appVersion: "sk-ant-api03-FAKEfakeFAKEfake" }], // secret-scan: fixture
    ["a prototype key as the screen", { screen: "constructor", title: "constructor" }],
    ["a control with no address", { controls: [{ id: "new-bot", label: "New bot" }] }],
    ["a bad install id", { installId: "not-a-uuid" }],
    ["a bad createdAt", { createdAt: "yesterday" }],
    ["too many controls", { controls: Array.from({ length: 61 }, () => ({ id: "new-bot", label: "New bot", address: "murage://new/bot" })) }],
  ])("refuses %s with 400, and stores nothing", async (_name, overrides) => {
    const response = await call("POST", PATH, { json: body(overrides) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(await rows()).toHaveLength(0);
  });

  it("refuses a body over 16 KB with 413", async () => {
    const response = await call("POST", PATH, { raw: JSON.stringify(body({ title: "x".repeat(17 * 1024) })) });
    expect(response.status).toBe(413);
  });

  it("refuses a body that is not JSON", async () => {
    expect((await call("POST", PATH, { raw: "not json" })).status).toBe(400);
  });

  it("answers 503 and stores nothing while the pepper is not set", async () => {
    const response = await call("POST", PATH, { json: body(), env: withEnv({ FEEDBACK_PEPPER: undefined }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "feedback_unconfigured" });
    expect(await rows()).toHaveLength(0);
  });

  // src/feedback-fixed.json is the app's shared/feedback-fixed.json: everything the form can send has to pass here.
  it("takes every value the 1.0.12 form can send", () => {
    for (const [screen, title] of Object.entries(FIXED.titles)) expect(feedbackSchema.safeParse(body({ screen, title })).success, screen).toBe(true);
    for (const page of FIXED.pages) expect(feedbackSchema.safeParse(body({ state: { page } })).success, page).toBe(true);
    for (const [id, reason] of Object.entries(FIXED.gates)) expect(feedbackSchema.safeParse(body({ state: { gates: [{ id, reason }] } })).success, id).toBe(true);
    for (const [id, control] of Object.entries(FIXED.controls)) expect(feedbackSchema.safeParse(body({ controls: [{ id, ...control }] })).success, id).toBe(true);
    for (const words of FIXED.words) expect(feedbackSchema.safeParse(body({ words })).success, words).toBe(true);
    for (const appVersion of ["1.0.12", "1.0.12-rc.1", "dev"]) expect(feedbackSchema.safeParse(body({ appVersion })).success, appVersion).toBe(true);
  });
});

describe("scrubbing", () => {
  const fakes = [
    ["sk-", "my key is sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234"], // secret-scan: fixture
    ["ghp_", "token ghp_FAKEfakeFAKEfakeFAKEfake1234"], // secret-scan: fixture
    ["AKIA", "aws AKIAFAKEFAKEFAKE1234 here"], // secret-scan: fixture
    ["xoxb-", "slack xoxb-1234567890-FAKEFAKEFAKEFAKE"], // secret-scan: fixture
    ["github_pat_", "github_pat_FAKE_fake_FAKE_fake_FAKE_123"],
    ["JWT", ["eyJhbGci", "OiJIUzI1", "NiJ9.eyJ", "zdWIiOiJ", "mYWtlIn0", ".ZmFrZXN", "pZ25hdHV", "yZQ"].join("")],
    ["Bearer", "Authorization Bearer abcdefghijklmnop1234"],
    ["key=value", "password=hunter2hunter2"],
    ["query key", "https://example.com/x?api_key=abc123def"],
    ["PEM", ["-----BEG", "IN PRIVA", "TE KEY--", "---\nMIIf", "ake\n----", "-END PRI", "VATE KEY", "-----"].join("")],
    ["open PEM", "-----BEGIN RSA PRIVATE KEY-----\nMIIfakehalf"],
  ] as const;

  it.each(fakes)("removes a fake %s", (_name, input) => {
    const out = scrubSecrets(input);
    expect(out).toContain(REMOVED);
    expect(out).not.toMatch(/FAKE|hunter2|abc123def|MIIfake|ZmFrZXNpZ25hdHVyZQ|abcdefghijklmnop1234/);
  });

  it("masks a card number's digits, as the desktop does", () => {
    const out = scrubSecrets("my card is 4111 1111 1111 1111 thanks"); // secret-scan: fixture
    expect(out).not.toContain("4111 1111 1111 1111"); // secret-scan: fixture
  });

  it("leaves ordinary words alone", () => {
    for (const plain of ["I could not find the Send button.", "the token: leave this prose alone", "max_tokens=4096 felt slow"]) {
      expect(scrubSecrets(plain.replace("max_tokens=4096", "?max_tokens=4096"))).toBe(plain.replace("max_tokens=4096", "?max_tokens=4096"));
    }
  });
});

describe("rate limits", () => {
  it("allows one a minute per install, with a plain line", async () => {
    let now = Date.UTC(2026, 10, 2, 12);
    const run = (ip = "203.0.113.9") => ownerFeedbackRoute(new Request(`${BASE}${PATH}`, {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body()),
    }), withEnv(), { now: () => now }, "req").catch((e: unknown) => e);
    expect(((await run()) as Response).status).toBe(200);
    const second = await run("203.0.113.10") as { status: number; extra?: { message: string } };
    expect(second.status).toBe(429);
    expect(second.extra?.message).toBe(RATE_LIMITED_LINE);
    now += 61_000;
    expect(((await run()) as Response).status).toBe(200);
  });

  it("allows 20 a day per install", async () => {
    let now = Date.UTC(2026, 10, 2, 0);
    const run = () => ownerFeedbackRoute(new Request(`${BASE}${PATH}`, {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${now % 200}` }, body: JSON.stringify(body()),
    }), withEnv(), { now: () => now }, "req").catch((e: unknown) => e);
    for (let i = 0; i < 20; i += 1) {
      expect(((await run()) as Response).status).toBe(200);
      now += 61_000;
    }
    const over = await run() as { status: number; extra?: { message: string } };
    expect(over.status).toBe(429);
    expect(over.extra?.message).toBe(DAILY_LIMIT_LINE);
    expect(await rows()).toHaveLength(20);
  });

  it("answers 429 through the Worker with the line in the body", async () => {
    await call("POST", PATH, { json: body() });
    const response = await call("POST", PATH, { json: body() });
    expect(response.status).toBe(429); // a different caller, the same install
    expect(await response.json()).toEqual({ error: "rate_limited", message: RATE_LIMITED_LINE });
  });
});

describe("Discord", () => {
  it("posts the screen's name and the words only, never the envelope, version, OS or email", async () => {
    const discord = fakeDiscord();
    const response = await ownerFeedbackRoute(new Request(`${BASE}${PATH}`, {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.20" },
      body: JSON.stringify(body()),
    }), withEnv({ FEEDBACK_DISCORD_WEBHOOK_URL: WEBHOOK }), { chatFetch: discord.impl }, "req");
    expect(response?.status).toBe(200);
    expect(discord.calls).toHaveLength(1);
    const sent = discord.calls[0];
    expect(sent.url).toBe(WEBHOOK);
    expect(sent.body.allowed_mentions).toEqual({ parse: [] });
    const content = String(sent.body.content);
    expect(content.split("\n")[0]).toBe(PRODUCT_FEEDBACK_LABEL);
    expect(content).toContain("Today");
    expect(content).toContain("(today)");
    expect(content).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no item id
    expect(content).toContain(discordLiteral("I couldn't find something on this screen."));
    for (const absent of ["1.0.12", "macos", "no-engine", "No engine", "New bot"]) expect(content).not.toContain(absent);
  });

  it("keeps the row when Discord fails", async () => {
    const discord = fakeDiscord(500);
    const response = await ownerFeedbackRoute(new Request(`${BASE}${PATH}`, {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.21" }, body: JSON.stringify(body()),
    }), withEnv({ FEEDBACK_DISCORD_WEBHOOK_URL: WEBHOOK }), { chatFetch: discord.impl }, "req");
    expect(response?.status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it("posts nothing without a webhook, and refuses anything that is not a Discord webhook", async () => {
    expect(discordWebhook(withEnv())).toBeNull();
    for (const bad of ["http://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz", "https://evil.example/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz",
      "https://discord.com/api/invalid-route/123", "https://user:pw" + "@" + "discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz", "not a url"]) {
      expect(discordWebhook(withEnv({ FEEDBACK_DISCORD_WEBHOOK_URL: bad }))).toBeNull();
    }
    expect(discordWebhook(withEnv({ FEEDBACK_DISCORD_WEBHOOK_URL: WEBHOOK }))).toBe(WEBHOOK);
  });

  it("keeps a long message inside Discord's 2000 characters and a backtick cannot break the code span", () => {
    const message = discordMessage({ screen: "today", title: "To`day", words: "*".repeat(2000) });
    expect(message.content.length).toBeLessThanOrEqual(2000);
    expect(message.content).toContain("To\\`day");
    expect(message.content.endsWith("...")).toBe(true);
    expect(message.content).not.toMatch(/[^\\]\\\.\.\.$/); // never a dangling escape before the ellipsis
  });
});

describe("Discord shows untrusted text literally", () => {
  it("escapes masked links, emphasis, quotes and mentions", () => {
    const content = discordMessage({ screen: "today", title: "[Today](https://example.invalid/login)", words: "**bold** [click](https://x.invalid) @everyone > quote" }).content;
    expect(content).not.toMatch(/(^|[^\\])\[[^\]]*\]\(/);
    expect(content).toContain("\\[Today\\]\\(https\\://example\\.invalid/login\\)");
    expect(content).toContain("\\*\\*bold\\*\\*");
    expect(content).toContain("\\@everyone");
    expect(discordLiteral("a\\b")).toBe("a\\\\b");
    expect(discordLiteral("a\u2028b\u202ec")).toBe("a b c");
  });
});

describe("callers and the daily ceiling", () => {
  it("keys the edge budget by the /64, in its own key space", () => {
    expect(callerSubject("2001:db8:1:2::5")).toBe(callerSubject("2001:0db8:0001:0002:ffff:1:2:3"));
    expect(callerSubject("2001:db8:1:2::5")).not.toBe(callerSubject("2001:db8:1:3::5"));
    expect(callerSubject("203.0.113.7")).toBe("v4:203.0.113.7");
    expect(callerSubject("::ffff:203.0.113.7")).toBe("v4:203.0.113.7");
    expect(callerSubject("0:0:0:0:0:ffff:203.0.113.7")).toBe("v4:203.0.113.7");
    const edge = (ip: string, method = "POST") => classifyEdge(new Request(`${BASE}${PATH}`, { method, headers: { "cf-connecting-ip": ip } }));
    expect(edge("2001:db8:1:2::5")).toEqual({ limiter: "MACHINE_OPEN_LIMIT", key: "fb:v6:2001:db8:1:2::/64" });
    expect(edge("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toEqual(edge("2001:db8:1:2::5"));
    expect(edge("203.0.113.7")).toEqual({ limiter: "MACHINE_OPEN_LIMIT", key: "fb:v4:203.0.113.7" });
    expect(edge("203.0.113.7", "GET")).toBeNull();
  });

  it("stops storing past the daily ceiling, whatever addresses and installs a flood uses", async () => {
    const now = Date.UTC(2026, 10, 4, 12);
    const stmts = Array.from({ length: GLOBAL_PER_DAY }, (_, i) => env.DB.prepare(
      `INSERT INTO owner_feedback (id, received_at, install_hash, app_version, os, surface, screen, envelope_json, words, status)
       VALUES (?, ?, ?, '1.0.12', 'linux', 'desktop', 'today', '{}', 'w', 'new')`,
    ).bind(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, now - 1000, String(i).padStart(64, "0")));
    await env.DB.batch(stmts);
    const discord = fakeDiscord();
    const answer = await ownerFeedbackRoute(new Request(`${BASE}${PATH}`, {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.77" }, body: JSON.stringify(body()),
    }), withEnv({ FEEDBACK_DISCORD_WEBHOOK_URL: WEBHOOK }), { now: () => now, chatFetch: discord.impl }, "req").catch((e: unknown) => e) as { status: number; extra?: { message: string } };
    expect(answer.status).toBe(429);
    expect(answer.extra?.message).toBe(BUSY_LINE);
    expect(discord.calls).toHaveLength(0);
    expect(await rows()).toHaveLength(GLOBAL_PER_DAY);
  });
});

describe("operator routes", () => {
  it("lists new items, changes a status and deletes a row, behind the admin token", async () => {
    await call("POST", PATH, { json: body() });
    expect((await call("GET", `${PATH}?status=new`)).status).toBe(401);
    expect((await call("GET", `${PATH}?status=new`, { token: "wrong" })).status).toBe(401);
    const listed = await (await call("GET", `${PATH}?status=new`, { token: ADMIN })).json() as { items: Array<{ id: string; words: string; install: string }> };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].install).toHaveLength(12);
    const id = listed.items[0].id;
    expect((await call("PATCH", `${PATH}/${id}`, { json: { status: "seen" } })).status).toBe(401);
    expect((await call("PATCH", `${PATH}/${id}`, { json: { status: "done" }, token: ADMIN })).status).toBe(400);
    expect((await call("PATCH", `${PATH}/${id}`, { json: { status: "seen" }, token: ADMIN })).status).toBe(200);
    expect((await (await call("GET", `${PATH}?status=new`, { token: ADMIN })).json() as { items: unknown[] }).items).toHaveLength(0);
    expect((await (await call("GET", `${PATH}?status=seen`, { token: ADMIN })).json() as { items: unknown[] }).items).toHaveLength(1);
    expect((await call("DELETE", `${PATH}/${id}`)).status).toBe(401);
    expect((await call("DELETE", `${PATH}/${id}`, { token: ADMIN })).status).toBe(200);
    expect(await rows()).toHaveLength(0);
    expect((await call("DELETE", `${PATH}/${id}`, { token: ADMIN })).status).toBe(404);
  });

  it("refuses an unknown status filter", async () => {
    expect((await call("GET", `${PATH}?status=all`, { token: ADMIN })).status).toBe(400);
  });
});

/** env.DB with every statement's SQL recorded when it runs, so a test can count write statements. */
function recordingDb(ran: string[]): D1Database {
  const db = env.DB;
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(stmt, {
    get(target, prop) {
      if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
      if (prop === "run" || prop === "first" || prop === "all" || prop === "raw") {
        return (...args: unknown[]) => { ran.push(sql); return (target[prop] as (...a: unknown[]) => unknown).apply(target, args); };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql);

async function fillDay(at: number, count = GLOBAL_PER_DAY) {
  await env.DB.batch(Array.from({ length: count }, (_, i) => env.DB.prepare(
    `INSERT INTO owner_feedback (id, received_at, install_hash, app_version, os, surface, screen, envelope_json, words, status)
     VALUES (?, ?, ?, '1.0.12', 'linux', 'desktop', 'today', '{}', 'w', 'new')`,
  ).bind(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, at, String(i).padStart(64, "0"))));
}

describe("D1 writes are bounded (designs/UX-FEEDBACK-LIMITS-1012.md)", () => {
  const post = (db: D1Database, now: number, ip: string, installId: string) => ownerFeedbackRoute(new Request(`${BASE}${PATH}`, {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body({ installId })),
  }), withEnv({ DB: db } as unknown as Record<string, string>), { now: () => now }, "req").catch((e: unknown) => e) as Promise<Response | { status: number }>;

  it("a full day answers every request, from any /64 and any install, with no write statement", async () => {
    const now = Date.UTC(2026, 10, 5, 15);
    await fillDay(now - 60_000);
    const ran: string[] = [];
    const db = recordingDb(ran);
    for (let i = 0; i < 50; i += 1) {
      const answer = await post(db, now, `2001:db8:${(0x100 + i).toString(16)}::${i + 1}`, `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`);
      expect(answer.status).toBe(429);
    }
    expect(ran.length).toBe(50);
    expect(ran.filter(isWrite)).toHaveLength(0);
    expect(await rows()).toHaveLength(GLOBAL_PER_DAY);
  });

  it("a busy install answers 429 with no write statement", async () => {
    const now = Date.UTC(2026, 10, 5, 15);
    const ran: string[] = [];
    const db = recordingDb(ran);
    const install = "00000000-0000-4000-8000-000000000777";
    expect((await post(db, now, "203.0.113.50", install)).status).toBe(200);
    expect(ran.filter(isWrite)).toHaveLength(1);
    expect((await post(db, now + 1_000, "203.0.113.51", install)).status).toBe(429);
    expect(ran.filter(isWrite)).toHaveLength(1);
  });

  it("the ceiling is a UTC day: yesterday's 400 do not hold today's first note", async () => {
    const midnight = Date.UTC(2026, 10, 6, 0);
    await fillDay(midnight - 60_000);
    expect((await post(env.DB, midnight + 1_000, "203.0.113.60", "00000000-0000-4000-8000-000000000888")).status).toBe(200);
    expect((await post(env.DB, midnight - 1_000, "203.0.113.61", "00000000-0000-4000-8000-000000000889")).status).toBe(429);
  });

  it("the scheduled sweep removes rows older than 90 days, and only those", async () => {
    const now = Date.UTC(2026, 10, 7, 12);
    await fillDay(now - RETENTION_MS - 1, 3);
    expect((await post(env.DB, now, "203.0.113.70", "00000000-0000-4000-8000-000000000999")).status).toBe(200);
    expect(await sweepOwnerFeedback(env, now)).toBe(3);
    expect(await rows()).toHaveLength(1);
  });
});

describe("round 2 smaller points", () => {
  it("scrubs a credential in a field under 8 characters", () => {
    for (const short of ["?key=ab", "&key=a", "?token=x"]) expect(scrubSecrets(short)).toContain(REMOVED);
  });

  it("keeps the Discord screen line one line, whatever line break the title carries", () => {
    for (const title of ["Today\rOperator notice", "Today\r\nOperator", "Today\u2028Operator", "Today\u2029Operator"]) {
      const content = discordMessage({ screen: "today", title, words: "plain words" }).content;
      expect(content.split("\n")).toHaveLength(3);
    }
    expect(discordLiteral("a\u206ab\u206fc")).toBe("a b c");
  });
});

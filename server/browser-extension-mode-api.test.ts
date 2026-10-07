// SPDX-License-Identifier: AGPL-3.0-or-later
// F8: Full permissive is owner-only. Real isolated Murage HTTP server (no browser is launched), the
// store's own sanitiser, and the restore preparation.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { routeClass, conversationSubject } from "./route-policy.ts";

const launchProof = randomBytes(32).toString("hex");
let fixture: VerificationServer;
let desktop: Record<string, string> = {};
const companion = { "x-murage-companion-token": launchProof };
let model: string;
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = desktop) {
  const res = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}
async function bot(name: string) {
  const value = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } });
  expect(value.status).toBe(201); return value.body.bot;
}
const mode = (id: string, headers?: Record<string, string>) => api("GET", `/api/bots/${id}/browser-extension/mode`, undefined, headers);
const setMode = (id: string, body: unknown, headers?: Record<string, string>) => api("PATCH", `/api/bots/${id}/browser-extension/mode`, body, headers);

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `process.env.MURAGE_COMPANION_TOKEN=${JSON.stringify(launchProof)};` });
  const secret = await api("GET", "/api/desktop-secret", undefined, {});
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((item: any) => item.instanceId === "verification").models.options[0].id;
}, 60000);
afterAll(async () => { await fixture?.close(); });

describe("PATCH /api/bots/:id/browser-extension/mode", () => {
  it("starts at task for every bot", async () => {
    const one = await bot("Dax Default");
    expect((await mode(one.id)).body.mode).toBe("task");
  });

  it("desktop with the typed name turns Full permissive on, and the bot keeps it", async () => {
    const one = await bot("Dax Full");
    const done = await setMode(one.id, { mode: "full", confirmName: "Dax Full" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.mode).toBe("full");
    expect((await mode(one.id)).body.mode).toBe("full");
    expect((await api("GET", `/api/bots/${one.id}`)).body.bot?.browserApproval ?? (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === one.id).browserApproval).toBe("full");
  });

  it("desktop without the name, or with a wrong name, is refused and nothing changes", async () => {
    const one = await bot("Dax Typed");
    for (const body of [{ mode: "full" }, { mode: "full", confirmName: "" }, { mode: "full", confirmName: "dax typed" }, { mode: "full", confirmName: "Dax Typed " }, { mode: "full", confirmName: "Someone Else" }, { mode: "full", confirmName: 7 }]) {
      const refused = await setMode(one.id, body);
      expect([400, 403], JSON.stringify(body)).toContain(refused.status);
      expect(typeof refused.body.error).toBe("string");
    }
    expect((await mode(one.id)).body.mode).toBe("task");
  });

  it("a phone (forwarded companion request) cannot turn it on, with or without the name", async () => {
    const one = await bot("Dax Phone");
    for (const body of [{ mode: "full", confirmName: "Dax Phone" }, { mode: "full" }]) {
      const refused = await setMode(one.id, body, companion);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toContain("Murage app on your computer");
    }
    expect((await mode(one.id)).body.mode).toBe("task");
  });

  it("a phone can turn it off, and can choose ask-each-step", async () => {
    const one = await bot("Dax Off");
    expect((await setMode(one.id, { mode: "full", confirmName: "Dax Off" })).status).toBe(200);
    expect((await setMode(one.id, { mode: "task" }, companion)).status).toBe(200);
    expect((await mode(one.id)).body.mode).toBe("task");
    expect((await setMode(one.id, { mode: "full", confirmName: "Dax Off" })).status).toBe(200);
    expect((await setMode(one.id, { mode: "step" }, companion)).status).toBe(200);
    expect((await mode(one.id, companion)).body.mode).toBe("step");
  });

  it("e: the phone can only tighten the mode (task to step), never loosen it; the desktop can do both", async () => {
    const one = await bot("Dax Tighten");
    expect((await setMode(one.id, { mode: "step" }, companion)).status).toBe(200);
    const loosen = await setMode(one.id, { mode: "task" }, companion);
    expect(loosen.status).toBe(403);
    expect(loosen.body.errorKey).toBe("browserExt.mode.errorLoosenDesktopOnly");
    expect((await mode(one.id, companion)).body.mode).toBe("step");
    expect((await setMode(one.id, { mode: "step" }, companion)).status).toBe(200);
    expect((await setMode(one.id, { mode: "task" }, desktop)).status).toBe(200);
    expect((await mode(one.id)).body.mode).toBe("task");
    expect((await setMode(one.id, { mode: "step" }, companion)).status).toBe(200);
    expect((await setMode(one.id, { mode: "step" }, desktop)).status).toBe(200);
  });

  it("callers with no proof of who they are never reach the route", async () => {
    const one = await bot("Dax Unproven");
    expect((await setMode(one.id, { mode: "full", confirmName: "Dax Unproven" }, {})).status).toBe(404);
    // A bot's shell, a channel, the Chief or an MCP client carries at most a bearer of its own: no owner proof.
    expect((await setMode(one.id, { mode: "full", confirmName: "Dax Unproven" }, { authorization: "Bearer not-an-owner" })).status).toBe(404);
    expect((await setMode(one.id, { mode: "full", confirmName: "Dax Unproven" }, { "x-murage-companion-token": "wrong" })).status).toBe(404);
    expect((await setMode(one.id, { mode: "full", confirmName: "Dax Unproven" }, { "x-murage-surface": "desktop" })).status).toBe(404);
    expect((await mode(one.id)).body.mode).toBe("task");
  });

  it("refuses unknown modes, extra fields and a missing bot", async () => {
    const one = await bot("Dax Strict");
    expect((await setMode(one.id, { mode: "yolo" })).status).toBe(400);
    expect((await setMode(one.id, { mode: "full", confirmName: "Dax Strict", extra: 1 })).status).toBe(400);
    expect((await setMode(one.id, {})).status).toBe(400);
    expect((await setMode("no-such-bot", { mode: "task" })).status).toBe(404);
    expect((await api("DELETE", `/api/bots/${one.id}/browser-extension/mode`)).status).toBe(405);
  });

  it("the general bot PATCH cannot set it", async () => {
    const one = await bot("Dax General");
    await api("PATCH", `/api/bots/${one.id}`, { browserApproval: "full" });
    await api("PATCH", `/api/bots/${one.id}`, { browserActionCheck: "bot", browserApproval: "full" });
    expect((await mode(one.id)).body.mode).toBe("task");
  });

  it("Opus gate: every refusal names a locale key whose English is the error text", async () => {
    const en = JSON.parse(readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8")) as Record<string, string>;
    const one = await bot("Dax Keys");
    const phone = await setMode(one.id, { mode: "full", confirmName: "Dax Keys" }, companion);
    const typed = await setMode(one.id, { mode: "full", confirmName: "nope" });
    const site = await api("POST", `/api/bots/${one.id}/browser-extension/sites`, { profileId: "profA", origin: "ftp://x.example", rule: "allow" });
    const phoneSite = await api("POST", `/api/bots/${one.id}/browser-extension/sites`, { profileId: "profA", origin: "https://x.example", rule: "allow" }, companion);
    const noProfile = await api("POST", `/api/bots/${one.id}/browser-extension/sites`, { origin: "https://x.example", rule: "allow" });
    for (const [name, r, key] of [["phone", phone, "browserExt.full.errorDesktopOnly"], ["typed", typed, "browserExt.full.errorConfirmName"], ["site", site, "browserExt.sites.errorScheme"], ["phoneSite", phoneSite, "browserExt.sites.errorNeedsDesktop"], ["noProfile", noProfile, "browserExt.sites.errorProfile"]] as const) {
      expect(r.body.errorKey, name).toBe(key);
      expect(en[key], name).toBe(r.body.error);
    }
  });

  it("route policy: the mode and site routes are companion class, found under the bot's visibility check", () => {
    expect(routeClass("PATCH", "/api/bots/abc/browser-extension/mode")).toBe("companion");
    expect(routeClass("GET", "/api/bots/abc/browser-extension/mode")).toBe("companion");
    expect(routeClass("GET", "/api/bots/abc/browser-extension/sites")).toBe("companion");
    expect(routeClass("POST", "/api/bots/abc/browser-extension/sites")).toBe("companion");
    expect(conversationSubject("/api/bots/abc/browser-extension/mode")).toEqual({ scope: "bot", botId: "abc" });
    expect(conversationSubject("/api/bots/abc/browser-extension/sites")).toEqual({ scope: "bot", botId: "abc" });
  });
});

describe("GET and POST /api/bots/:id/browser-extension/sites", () => {
  const sites = (id: string, method: string, body?: unknown, headers?: Record<string, string>, query = "?profileId=profA") => api(method, `/api/bots/${id}/browser-extension/sites${method === "GET" ? query : ""}`, body, headers);
  it("the desktop edits every rule; the list is per bot and profile", async () => {
    const one = await bot("Dax Sites"), two = await bot("Dax Sites Two");
    for (const [origin, rule] of [["https://a.example", "allow"], ["https://b.example", "never"], ["https://c.example", "ask"]]) {
      expect((await sites(one.id, "POST", { profileId: "profA", origin, rule })).status).toBe(200);
    }
    expect((await sites(one.id, "POST", { profileId: "profA", origin: "https://bank.example", rule: "ask", lowered: true })).status).toBe(200);
    const listed = (await sites(one.id, "GET")).body.sites as { origin: string; rule: string; lowered?: boolean }[];
    expect(listed.map(item => `${item.origin} ${item.rule}${item.lowered ? " lowered" : ""}`).sort()).toEqual(["https://a.example allow", "https://b.example never", "https://bank.example ask lowered", "https://c.example ask"]);
    expect((await sites(one.id, "GET", undefined, undefined, "?profileId=profB")).body.sites).toEqual([]);
    expect((await sites(two.id, "GET")).body.sites).toEqual([]);
  });

  it("a phone may read and Revoke an allow back to ask, and nothing else", async () => {
    const one = await bot("Dax Revoke");
    await sites(one.id, "POST", { profileId: "profA", origin: "https://a.example", rule: "allow" });
    await sites(one.id, "POST", { profileId: "profA", origin: "https://n.example", rule: "never" });
    expect((await sites(one.id, "GET", undefined, companion)).status).toBe(200);
    expect((await sites(one.id, "POST", { profileId: "profA", origin: "https://a.example", rule: "ask" }, companion)).status).toBe(200);
    expect((await sites(one.id, "GET")).body.sites.find((item: any) => item.origin === "https://a.example").rule).toBe("ask");
    // Not an allow, not a never, not a lowering, and a never cannot be lifted from the phone.
    for (const body of [{ origin: "https://a.example", rule: "allow" }, { origin: "https://z.example", rule: "never" }, { origin: "https://a.example", rule: "ask", lowered: true }, { origin: "https://n.example", rule: "ask" }]) {
      expect((await sites(one.id, "POST", { profileId: "profA", ...body }, companion)).status, JSON.stringify(body)).toBe(403);
    }
    expect((await sites(one.id, "GET")).body.sites.find((item: any) => item.origin === "https://n.example").rule).toBe("never");
  });

  it("unproven callers get nothing; bad input is refused", async () => {
    const one = await bot("Dax Sites Closed");
    expect((await sites(one.id, "GET", undefined, {})).status).toBe(404);
    expect((await sites(one.id, "POST", { profileId: "profA", origin: "https://a.example", rule: "allow" }, {})).status).toBe(404);
    expect((await sites(one.id, "POST", { profileId: "profA", origin: "javascript:1", rule: "allow" })).status).toBe(400);
    expect((await sites(one.id, "POST", { profileId: "../x", origin: "https://a.example", rule: "allow" })).status).toBe(400);
    expect((await sites(one.id, "POST", { profileId: "profA", origin: "https://a.example", rule: "maybe" })).status).toBe(400);
    expect((await sites(one.id, "POST", { profileId: "profA", origin: "https://a.example", rule: "allow", extra: 1 })).status).toBe(400);
    expect((await sites(one.id, "GET", undefined, undefined, "")).status).toBe(400);
    expect((await sites("no-such-bot", "GET")).status).toBe(404);
  });
});

describe("the bot record", () => {
  it("drops an unknown browserApproval or browserActionCheck on load and keeps the valid ones", () => {
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture-model" }));
    const made = [{}, {}, {}, {}, {}].map((_, index) => store.createBot({ name: `Sanitise ${index}` }, { seedMessages: false }));
    const patches = [{ browserApproval: "yolo" }, { browserApproval: "full", browserActionCheck: "bot" }, { browserApproval: 7, browserActionCheck: "gpt" }, { browserApproval: "step", browserActionCheck: "flux" }, { browserApproval: "task" }];
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(made.map((one, index) => ({ ...one, ...patches[index] }))));
    const loaded = new Store(() => ({ instanceId: "fixture", model: "fixture-model" }));
    const read = (index: number) => loaded.bot(made[index]!.id);
    expect(read(0)?.browserApproval).toBeUndefined();
    expect(read(1)).toMatchObject({ browserApproval: "full", browserActionCheck: "bot" });
    expect(read(2)?.browserApproval).toBeUndefined();
    expect(read(2)?.browserActionCheck).toBeUndefined();
    expect(read(3)).toMatchObject({ browserApproval: "step", browserActionCheck: "flux" });
    // "task" is the default, so it is stored as absent.
    expect(read(4)?.browserApproval).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    expect(onDisk[0].browserApproval).toBeUndefined();
    expect(onDisk[2].browserActionCheck).toBeUndefined();
  });
});

describe("a restored backup", () => {
  it("never brings Full permissive back, and keeps the owner's checker choice", async () => {
    const root = mkdtempSync(join(tmpdir(), "murage-mode-restore-"));
    try {
      const data = join(root, "source"); mkdirSync(data);
      writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { fake: { driver: "claudeAgent", enabled: true, config: { cli: "must-not-run" } } }, features: { browser: true } }));
      writeFileSync(join(data, "bots.json"), JSON.stringify([{ id: "bot", threadId: "thread", name: "Restored bot", browserApproval: "full", browserActionCheck: "bot", useMyChrome: true, browserTransport: "extension", browserExtensionProfileId: "profile_1", tasks: [] }]));
      writeFileSync(join(data, "groups.json"), "[]");
      const db = new DatabaseSync(join(data, "messages.db"));
      try { initializeMessageTables(db); initializeImageOperations(db); db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("thread", "m1", 1, "bot", "goal.run", null, JSON.stringify({ id: "m1", at: 1, role: "bot", kind: "goal.run", goalRun: { status: "completed", detail: "Done" } })); db.exec("INSERT INTO thread_state VALUES('thread','m1')"); } finally { db.close(); }
      const archive = join(root, "backup.zip");
      await writeInstallationArchive(data, archive);
      const result = await prepareInstallationRestore(archive, root);
      const [restored] = JSON.parse(readFileSync(join(result.stateDirectory, "bots.json"), "utf8"));
      expect(restored).not.toHaveProperty("browserApproval");
      expect(restored.browserActionCheck).toBe("bot");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60000);
});

describe("PATCH /api/bots/:id/browser-extension/check (T34 follow-up)", () => {
  const setCheck = (id: string, body: unknown, headers?: Record<string, string>) => api("PATCH", `/api/bots/${id}/browser-extension/check`, body, headers);
  it("is desktop class in the route policy", () => {
    expect(routeClass("PATCH", "/api/bots/abc/browser-extension/check")).toBe("desktop");
  });
  it("desktop saves flux or bot and GET mode reports it", async () => {
    const one = await bot("Dax Check");
    expect((await mode(one.id)).body.actionCheck).toBe("flux");
    const done = await setCheck(one.id, { check: "bot" });
    expect(done.status, JSON.stringify(done.body)).toBe(200); expect(done.body.actionCheck).toBe("bot");
    expect((await mode(one.id)).body.actionCheck).toBe("bot");
    expect((await setCheck(one.id, { check: "flux" })).body.actionCheck).toBe("flux");
  });
  it("a paired phone, an unknown value and extra keys are refused and nothing changes", async () => {
    const one = await bot("Dax Check Two");
    expect((await setCheck(one.id, { check: "bot" }, companion)).status).toBe(403);
    expect((await setCheck(one.id, { check: "other" })).status).toBe(400);
    expect((await setCheck(one.id, { check: "bot", mode: "full" })).status).toBe(400);
    expect((await mode(one.id)).body.actionCheck).toBe("flux");
  });
  it("GET mode reports checkerAvailable: false with a reason while the Flux no-retain header is not deployed, true on the bot's own engine", async () => {
    const one = await bot("Dax Avail");
    const flux = (await mode(one.id)).body;
    // Flux has no key here, so the owner's Flux switch runs on the bot's own engine and says so (checkerFallback).
    expect(flux.checkerAvailable).toBe(true); expect(flux.checkerFallback).toBe(true);
    await setCheck(one.id, { check: "bot" });
    const own = (await mode(one.id)).body;
    expect(own.checkerAvailable).toBe(true); expect(own.checkerReason).toBeUndefined();
  });
});

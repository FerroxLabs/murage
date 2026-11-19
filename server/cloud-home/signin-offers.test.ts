// SPDX-License-Identifier: AGPL-3.0-or-later
// F4 C2: the create-bot sign-in step and the sticky "Sign <bot> in to <engine> and use it" offer, as the API answers them.
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setCloudIdentity } from "../cloud-request-identity.ts";
import { createEngineSignInsApi, createStepFor, pickCreateStepEngine, useEngineAfterSignIn, botSignInLines, type BotEngineRef, type BotSignInLine, type BotSignInSource } from "./engine-signins.ts";
import { createSignInOffers, SIGNIN_OFFERS_FILE } from "./signin-offers.ts";

type Answer = { signedIn: boolean; source: "home" | "bot" | null };
const none: Answer = { signedIn: false, source: null }, own: Answer = { signedIn: true, source: "bot" };

/** A little home: bots with the engine they run and the sign-ins their own stores hold. */
function home(initial: { id: string; name: string; driverKind: string; signedIn?: Record<string, Answer> }[]) {
  const bots = initial.map(bot => ({ ...bot, signedIn: bot.signedIn ?? {} }));
  const source: BotSignInSource = {
    signIn: async (kind, id) => bots.find(bot => bot.id === id)?.signedIn[kind] ?? none,
    signedInEngines: async id => Object.entries(bots.find(bot => bot.id === id)?.signedIn ?? {}).filter(([, answer]) => answer.signedIn).map(([kind]) => kind),
  };
  const refs = (): BotEngineRef[] => bots.map(({ id, name, driverKind }) => ({ id, name, driverKind }));
  return { bots, source, refs, create(id: string, name: string) { bots.push({ id, name, driverKind: "fuigoAgent", signedIn: {} }); } };
}

describe("the create-bot step", () => {
  let server: Server; let dir: string;
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); server.closeAllConnections(); if (dir) removeTempDirSync(dir); });
  const serve = async (h: ReturnType<typeof home>) => {
    dir = dir ?? mkdtempSync(join(tmpdir(), "signin-offers-"));
    const api = createEngineSignInsApi({ bots: h.refs, source: h.source, offers: createSignInOffers(join(dir, SIGNIN_OFFERS_FILE)), readBody: async req => { let text = ""; for await (const chunk of req) text += chunk; return JSON.parse(text); } });
    server = createServer((req, res) => {
      setCloudIdentity(req.headers, { id: "dev1", account: "a", scope: "owner-desktop", publicKey: "", assertionKey: "", revoked: 0, factor: false });
      void api(req, res, new URL(req.url ?? "/", "http://localhost")).then(took => { if (!took) { res.writeHead(404); res.end(); } });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const stepOf = async (base: string, bot: string) => ((await (await fetch(`${base}/api/cloud/engine-signins?forBot=${bot}`)).json()) as { createStep: { engine: string; label: string } | null }).createStep;
  const restart = async (h: ReturnType<typeof home>) => { await new Promise(resolve => server.close(resolve)); server.closeAllConnections(); return serve(h); };

  it("creating a bot while Codex is signed in on another bot shows the step; skipping leaves it on Fuigo with the offer; completing starts it on Codex", async () => {
    const h = home([{ id: "atlas", name: "Atlas", driverKind: "codex", signedIn: { codex: own } }]);
    h.create("bea", "Bea");
    const base = await serve(h);
    expect(await stepOf(base, "bea")).toEqual({ engine: "codex", label: "Codex" });
    // Skip: nothing is sent. The bot stays on Fuigo and the offer is still there on its own surface.
    expect(h.bots.find(bot => bot.id === "bea")!.driverKind).toBe("fuigoAgent");
    expect(await stepOf(base, "bea")).toEqual({ engine: "codex", label: "Codex" });
    // Complete: the per-bot sign-in ends, and the bot moves onto Codex. No token is copied: only the bot's own store changes.
    h.bots.find(bot => bot.id === "bea")!.signedIn.codex = own;
    let moved = "";
    expect(await useEngineAfterSignIn("codex", { id: "bea", driverKind: "fuigoAgent" }, kind => { moved = kind; h.bots.find(bot => bot.id === "bea")!.driverKind = kind; return true; }, h.source)).toBe("codex");
    expect(moved).toBe("codex");
    expect(await stepOf(base, "bea")).toBeNull();
    expect(h.bots.find(bot => bot.id === "atlas")!.signedIn.codex).toEqual(own); // the other bot's sign-in is untouched
  });
  it("a failed sign-in leaves the bot on Fuigo", async () => {
    const h = home([{ id: "atlas", name: "Atlas", driverKind: "codex", signedIn: { codex: own } }]);
    h.create("bea", "Bea");
    let moved = false;
    expect(await useEngineAfterSignIn("codex", { id: "bea", driverKind: "fuigoAgent" }, () => { moved = true; return true; }, h.source)).toBeNull();
    expect(moved).toBe(false);
  });
  it("the offer survives a panel reopen and a server restart", async () => {
    const h = home([{ id: "atlas", name: "Atlas", driverKind: "codex", signedIn: { codex: own } }]);
    h.create("bea", "Bea");
    let base = await serve(h);
    expect(await stepOf(base, "bea")).not.toBeNull();
    const panel = await (await fetch(`${base}/api/cloud/engine-signins`)).json() as { bots: { id: string; dismissed?: string[] }[] };
    expect(panel.bots.find(bot => bot.id === "bea")!.dismissed).toEqual([]);
    base = await restart(h);
    expect(await stepOf(base, "bea")).toEqual({ engine: "codex", label: "Codex" });
  });
  it("dismissing hides the offer for good, for that bot only, across a restart", async () => {
    const h = home([{ id: "atlas", name: "Atlas", driverKind: "codex", signedIn: { codex: own } }]);
    h.create("bea", "Bea"); h.create("cy", "Cy");
    let base = await serve(h);
    const post = (body: unknown) => fetch(`${base}/api/cloud/engine-signins/dismiss`, { method: "POST", body: JSON.stringify(body) });
    expect((await post({ bot: "bea", engine: "codex" })).status).toBe(200);
    expect(await stepOf(base, "bea")).toBeNull();
    expect(await stepOf(base, "cy")).not.toBeNull();
    const panel = await (await fetch(`${base}/api/cloud/engine-signins`)).json() as { bots: { id: string; dismissed?: string[] }[] };
    expect(panel.bots.find(bot => bot.id === "bea")!.dismissed).toEqual(["codex"]);
    base = await restart(h);
    expect(await stepOf(base, "bea")).toBeNull();
    expect((await post({ bot: "nobody", engine: "codex" })).status).toBe(400);
    expect((await post({ bot: "bea", engine: "../x" })).status).toBe(400);
  });
  it("shows no step when no other bot is signed in to anything", async () => {
    const h = home([{ id: "atlas", name: "Atlas", driverKind: "codex" }, { id: "ada", name: "Ada", driverKind: "claudeAgent", signedIn: { claudeAgent: { signedIn: true, source: "home" } } }]);
    h.create("bea", "Bea");
    const base = await serve(h);
    expect(await stepOf(base, "bea")).toBeNull();
    expect(await stepOf(base, "atlas")).toBeNull(); // a bot that is not on Fuigo has no offer
  });
});

describe("which engine a new bot is offered", () => {
  const line = (id: string, engine: string, signedIn: boolean, extra: Partial<BotSignInLine> = {}): BotSignInLine => ({ id, name: id, engine, label: engine, signedIn, uses: null, ...extra });
  it("prefers the engine most other bots are signed in to, then Codex, Claude, Grok, Kimi, OpenCode", () => {
    expect(pickCreateStepEngine([line("a", "grokAgent", true), line("b", "grokAgent", true), line("c", "codex", true)], "new")?.engine).toBe("grokAgent");
    expect(pickCreateStepEngine([line("a", "opencodeGo", true), line("b", "kimiAgent", true), line("c", "grokAgent", true)], "new")?.engine).toBe("grokAgent");
    expect(pickCreateStepEngine([line("a", "kimiAgent", true), line("b", "opencodeGo", true)], "new")?.engine).toBe("kimiAgent");
    expect(pickCreateStepEngine([line("a", "codex", true), line("b", "claudeAgent", true, { uses: "own" })], "new")?.engine).toBe("codex");
    expect(pickCreateStepEngine([line("a", "claudeAgent", true, { uses: "own" })], "new")?.engine).toBe("claudeAgent");
  });
  it("reads each bot's own store: the home-wide Claude sign-in, a signed-out bot and the new bot itself count for nothing", () => {
    expect(pickCreateStepEngine([line("a", "claudeAgent", true, { uses: "home" }), line("b", "codex", false), line("new", "codex", true)], "new")).toBeNull();
    expect(pickCreateStepEngine([line("f", "fuigoAgent", true, { signedInEngines: ["codex", "claudeAgent"] })], "new")?.engine).toBe("codex");
  });
  it("a bot already signed in to the engine, or not on Fuigo, has no step", () => {
    const lines = [line("a", "codex", true), line("f", "fuigoAgent", true, { signedInEngines: ["codex"] }), line("g", "fuigoAgent", true, { signedInEngines: [] })];
    expect(createStepFor(lines, "f")).toBeNull();
    expect(createStepFor(lines, "g")).toEqual({ engine: "codex", label: "Codex" });
    expect(createStepFor(lines, "g", ["codex"])).toBeNull();
    expect(createStepFor(lines, "a")).toBeNull();
  });
});

describe("setup status stays at home level", () => {
  it("A signed in to Codex, B not: B's line says needs sign-in; the home says Codex is set up", async () => {
    const h = home([{ id: "a", name: "A", driverKind: "codex", signedIn: { codex: own } }, { id: "b", name: "B", driverKind: "codex" }]);
    const lines = (await botSignInLines(h.refs(), h.source))!;
    expect(lines.find(line => line.id === "a")!.signedIn).toBe(true);
    expect(lines.find(line => line.id === "b")!.signedIn).toBe(false);
  });
});

describe("a deleted bot's dismissals", () => {
  it("forget removes them, and the bot delete route calls it at the commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "signin-forget-"));
    try {
      const offers = createSignInOffers(join(dir, SIGNIN_OFFERS_FILE));
      offers.dismiss("bea", "codex"); offers.dismiss("atlas", "codex");
      offers.forget("bea");
      expect(offers.dismissed("bea")).toEqual([]);
      expect(offers.dismissed("atlas")).toEqual(["codex"]);
    } finally { removeTempDirSync(dir); }
    const route = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(route).toMatch(/if \(deleted\) signInOffers\.forget\(bot\.id\);/);
    expect(route).toMatch(/offers: signInOffers,/);
  });
});

// D25-V3 (1.0.23) on the real server: create_bot's first record has connected apps off, the owner's copy action works end to end, a bot's
// own credential cannot reach it, and a create_bot turn raises no card. Same harness as create-bot-writer-hold-routes-api.test.ts (held fake-Claude turn).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { routeAdmits, routeClass, routePolicy } from "./route-policy.ts";

let fixture: VerificationServer;
let owner: Record<string, string> = {};
const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(fixture.info.url + path, { signal: AbortSignal.timeout(30_000), method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }).catch((e) => { throw new Error(`${method} ${path}: ${e}`); });
  const text = await res.text();
  return { status: res.status, body: (() => { try { return JSON.parse(text); } catch { return text; } })() as any };
};
const desktop = (method: string, path: string, body?: unknown) => request(method, path, body, owner);
async function ownerHeaders() {
  const { secret } = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
}
const bots = async () => (await desktop("GET", "/api/bots?messages=50")).body.bots as Array<{ id: string; name: string; section?: string; messages?: Array<{ card?: unknown }> }>;
const accessView = async (id: string) => (await desktop("GET", `/api/bots/${id}/access`)).body as { enabled: boolean; copyFrom?: { creatorId: string; available: boolean; sourceDigest?: string; replaces: boolean }; policy: { revision: number } };

describe("W3 route policy: the access route is the owner's desktop only", () => {
  const path = "/api/bots/abc123/access";
  it("is class desktop with a step-up on Cloud, admits the owner, and turns away a bot credential and any non-desktop caller", () => {
    expect(routePolicy("PUT", path)).toMatchObject({ class: "desktop", cloudWrite: "step-up" });
    expect(routeClass("PUT", path)).toBe("desktop");
    expect(routeAdmits("desktop", { desktop: true, companion: false, door: false, bot: false })).toBe(true);
    expect(routeAdmits(routeClass("PUT", path), { desktop: false, companion: false, door: false, bot: true })).toBe(false);
    expect(routeAdmits(routeClass("PUT", path), { desktop: false, companion: false, door: true, bot: false })).toBe(false);
    expect(routeAdmits(routeClass("PUT", path), { desktop: false, companion: true, door: false, bot: false })).toBe(false);
  });
});

describe("create_bot with connected apps off from birth", () => {
  let director: { id: string; threadId: string };
  let token = "", turnPid = 0;
  const create = async (fields: Record<string, unknown>) => request("POST", "/api/internal/create-bot", { fromBotId: director.id, fromThreadId: director.threadId, role: "Roofing specialist", instructions: "Serve the client.", ...fields }, { authorization: `Bearer ${token}` });
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    await ownerHeaders();
    director = (await desktop("POST", "/api/bots", { name: "Demo Director" })).body.bot;
    expect((await desktop("PATCH", `/api/bots/${director.id}`, { section: "Demo Machine", chiefOfStaff: true, autoApprove: true, acknowledgeLocalAuto: true })).status).toBe(200);
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await desktop("POST", `/api/bots/${director.id}/messages`, { text: "__fixture_hold_authority__", threadId: director.threadId })).status).toBe(202);
    for (const deadline = Date.now() + 45_000; !token && Date.now() < deadline; await new Promise((r) => setTimeout(r, 250))) {
      try { const dump = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); token = dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN ?? ""; turnPid = dump.pid; } catch { /* not written yet */ }
    }
    if (!token) throw new Error("the held turn never started");
  }, 120_000);
  afterAll(async () => { await fixture?.stop(); });

  it("W9 + W4 end to end: the reply raises no card, the owner's press gives the creator's apps after the turn settles, a bot credential cannot, PATCH cannot set the creator", async () => {
    const before = ((await bots()).find((bot) => bot.id === director.id)?.messages ?? []).length;
    const made = await create({ name: "Specialist One" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // While the owner's turn is open this harness stages the create; the direct reply's connectedApps:"off" is a source witness below.
    const after = (await bots()).find((bot) => bot.id === director.id)?.messages ?? [];
    expect(after.slice(before).filter((message) => message.card)).toEqual([]);
    const made2 = await create({ name: "Specialist Two" });
    expect(made2.status, JSON.stringify(made2.body)).toBe(201);

    // a bot's own credential never reaches the owner's access route: the same change the owner may make is refused for the bot and the owner's press then works
    const plain = (await desktop("POST", "/api/bots", { name: "Plain control" })).body.bot;
    const change = { action: "configure", revision: (await accessView(plain.id)).policy.revision, mode: "restricted", allowWrites: false, grants: [] };
    const botTry = await request("PUT", `/api/bots/${plain.id}/access`, change, { authorization: `Bearer ${token}` });
    expect(botTry.status).not.toBe(200);
    expect(((await accessView(plain.id)) as any).policy.mode).toBe("unrestricted");
    expect((await desktop("PUT", `/api/bots/${plain.id}/access`, change)).status).toBe(200);
    expect(((await accessView(plain.id)) as any).policy.mode).toBe("restricted");

    // the turn ends; the staged bots settle and keep their creator on record
    writeFileSync(join(fixture.fixtureFinishGateDir, String(turnPid)), "finish");
    let view = await accessView(made.body.id);
    for (const deadline = Date.now() + 30_000; !view.copyFrom && Date.now() < deadline; view = await accessView(made.body.id)) await new Promise((r) => setTimeout(r, 300));
    expect(view.enabled).toBe(false);
    expect(view.copyFrom).toMatchObject({ creatorId: director.id, available: true, replaces: false });

    // PATCH never sets the creator mark
    const other = (await desktop("POST", "/api/bots", { name: "Unrelated" })).body.bot;
    await desktop("PATCH", `/api/bots/${made2.body.id}`, { appsSourceBotId: other.id });
    expect((await accessView(made2.body.id)).copyFrom?.creatorId).toBe(director.id);

    const body = { action: "copy-from-creator", revision: view.policy.revision, sourceDigest: view.copyFrom!.sourceDigest };
    const ownerPress = await desktop("PUT", `/api/bots/${made.body.id}/access`, body);
    expect(ownerPress.status, JSON.stringify(ownerPress.body)).toBe(200);
    expect(ownerPress.body.enabled).toBe(true);
    expect((await accessView(made.body.id)).copyFrom?.replaces).toBe(true);
    // the other bot is untouched by the first one's press
    expect((await accessView(made2.body.id)).enabled).toBe(false);
  }, 120_000);
});

describe("W1/W2 handlers: both create_bot handlers hand createBot the trusted appsOff option and the reply says apps are off (source witness)", () => {
  // The held-turn harness stages every create (no direct path), so the crash window between createBot and the handler's patchBot is
  // witnessed on the Store (bot-access-copy-1023.test.ts W1) and here on the two call sites, which is what makes the store option reach disk.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const calls = [...source.matchAll(/store\.createBot\(\s*\{\s*name,\s*title: role,[\s\S]*?\n\s{8}\);/g)].map((match) => match[0]);
  it("finds both create_bot handlers", () => { expect(calls).toHaveLength(2); });
  it("each one passes appsOff with the Chief as the creator", () => {
    for (const call of calls) expect(call).toMatch(/appsOff: \{ sourceBotId: chief\.id \}/);
  });
  it("each reply body says connectedApps off", () => {
    expect([...source.matchAll(/connectedApps: "off"/g)]).toHaveLength(2);
  });
});

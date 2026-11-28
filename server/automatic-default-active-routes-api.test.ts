// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F33 (owner q1024-autodefault; FABLE/OPUS 2080dbacff H1 residual): the two creation routes the routes witness could not reach, on a fresh
// install, booted server over HTTP.
//  - POST /api/browser-extension/clients pair (index.ts pairing branch): only the browser-extension bridge module is replaced, by one that
//    reports a connected profile (as service-no-limits-routes-api.test.ts does); it is built at boot from browser-extension/approvals.json,
//    as on an install that has set the extension up. The pairing route and createBot run as shipped. BEHAVIOURAL row.
//  - an Ask chief's create_bot, allowed by the owner with the desktop app's own answer (PendingApproval.tsx; it adds the bot-card@1 render
//    receipt only when a card carries botAuthority). GUARD row, green on base by construction: the owner's answer runs the own-write create
//    (index.ts, decision ['run'], level patched from the creator's ceiling with fullAccess false), not /api/internal/create-bot's active
//    branch. That branch needs an owner-seen pass, and no server code attaches botAuthority to a card on this tree (merge 1f6267ee88), so it
//    is reached only by a No limits turn (serviceNoLimits), whose new bot takes the creator's No limits. Its call stays pinned in
//    server/testing/botcreate-spec/writers.json, so adding ownerCreated there fails bot-create-outside-1019.sites.test.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_ENGINE_NAME, launchVerificationServer, verificationInstances, type VerificationServer } from "../scripts/control-murage.ts";

const level = (bot: { autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean } | undefined) =>
  !bot ? "missing" : !bot.autoApprove ? "ask" : !bot.fullAccess ? "auto" : bot.noLimits ? "no-limits" : "full";
const PROFILE = "fixtureprofile";
// Runs before every boot. The first boot must still see no config.json (that is what makes the install fresh), so the creator engine is
// added only once the owner's config exists.
const instrumentation = `
const fs = await import('node:fs'), path = await import('node:path');
fs.mkdirSync(path.join(process.env.HOME, '.fuigo'), { recursive: true });
fs.writeFileSync(path.join(process.env.HOME, '.fuigo', 'auth.json'), '{}');
fs.mkdirSync(path.join(process.env.MURAGE_DATA_DIR, 'browser-extension'), { recursive: true, mode: 0o700 });
if (!fs.existsSync(path.join(process.env.MURAGE_DATA_DIR, 'browser-extension', 'approvals.json'))) fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'browser-extension', 'approvals.json'), '{}', { mode: 0o600 });
const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
if (fs.existsSync(file)) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.instances = { ...(cfg.instances ?? {}), creator: { driver: 'fuigoAgent', displayName: 'Inert creator', environment: {
    FAKE_ACP_MODE: 'create-peer', FAKE_ACP_MCP_READY: '1', FAKE_BOTCREATE_TWO: '0', FAKE_BOTCREATE_NAME: 'Active Seat',
    FAKE_BOTCREATE_GATE: path.join(process.env.MURAGE_DATA_DIR, 'finish-create') },
    config: { cli: path.join(process.cwd(), 'server/testing/fake-acp-cli.ts'), fullAuto: true } } };
  fs.writeFileSync(file, JSON.stringify(cfg));
}
const { registerHooks } = await import('node:module');
registerHooks({ load(url, context, next) {
  if (url.endsWith('/browser-extension-integration.ts')) return { format: 'module', shortCircuit: true, source: \`export class BrowserExtensionIntegration{constructor(){this.approvals={resolve:()=>false};}async start(){return this;}status(){return {profiles:[{profileId:'${PROFILE}',browser:'chrome',name:'Fixture profile'}],bindings:[]};}hostConfigPath(){return 'fixture-helper';}async dispatch(){return {tools:[]};}cancelThread(){}async ownerAction(){}async close(){}}export function routineThreadSignal(){return ()=>false;}export function delegatedTurnUnattended(){return false;}\` };
  return next(url, context);
} });
`;

let fixture: VerificationServer;
let owner: Record<string, string> = {};
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = owner) => {
  const res = await fetch(fixture.info.url + path, { signal: AbortSignal.timeout(30_000), method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: (() => { try { return JSON.parse(text); } catch { return text; } })() as any };
};
const ok = async (method: string, path: string, body?: unknown) => {
  const answer = await call(method, path, body);
  if (answer.status < 200 || answer.status > 299) throw new Error(`setup: ${method} ${path} answered ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body;
};
const stored = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")) as Array<{ id: string; name: string; staged?: unknown; createdByBotId?: string; autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean }>;

describe("W-F33-ACTIVE: fresh install, the creation routes the held-turn harness cannot reach", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { freshInstall: true, instrumentationSource: instrumentation });
    const config = join(fixture.info.dataDir, "config.json");
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), instances: verificationInstances(join(fixture.info.dataDir, FAKE_ENGINE_NAME)) }, null, 2));
    await fixture.restart();
    const { secret } = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    const instances = (await ok("GET", "/api/instances")).instances as Array<{ instanceId: string }>;
    if (!instances.some(item => item.instanceId === "creator")) throw new Error("setup: the creator engine was not added on restart");
    await ok("POST", "/api/memory/action", { action: "configure", mode: "off" });
  }, 240_000);
  afterAll(async () => { await fixture?.close(); });

  it("guard: an owner-approved create_bot from an Ask chief runs at once and its new bot starts at Ask", async () => {
    const chief = (await ok("POST", "/api/bots", { name: "Active Chief", section: "Fixture", modelSelection: { instanceId: "creator", model: "fake-model" } })).bot;
    expect(level(chief), "control: the owner's own bot takes the seeded Automatic level").toBe("full");
    await ok("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: "section", browser: false, computer: "off", composio: false, autoApprove: false, fullAccess: false, noLimits: false, acknowledgeLocalAuto: true });
    if (level(stored().find(bot => bot.id === chief.id)) !== "ask") throw new Error("setup: the chief did not move to Ask");
    expect((await call("POST", `/api/bots/${chief.id}/messages`, { text: "Create the active seat.", threadId: chief.threadId })).status).toBe(202);
    let answer: Record<string, unknown> | undefined, seenCards: unknown[] = [];
    for (const deadline = Date.now() + 45_000; !answer && Date.now() < deadline; await new Promise(r => setTimeout(r, 300))) {
      const cards = ((await ok("GET", `/api/threads/${chief.threadId}/messages?limit=100`)).messages as Array<{ card?: any }>).map(row => row.card).filter(Boolean);
      seenCards = cards.map(item => ({ kind: item.kind, tool: item.writer?.tool, answered: item.answered }));
      const card = cards.find(item => item?.writer?.tool === "create_bot" && item.answered === undefined);
      // the desktop app's own answer (PendingApproval.tsx): the render receipt rides along whenever the card carries botAuthority
      if (card) answer = { requestId: card.requestId, behavior: "allow", stateRevision: card.writer.stateRevision, ...(card.botAuthority && !card.botAuthority.cut ? { seen: { renderer: "bot-card@1", digest: card.botAuthority.specDigest } } : {}) };
    }
    if (!answer) throw new Error(`setup: the create_bot card never showed ${JSON.stringify(seenCards)}`);
    const answered = await call("POST", `/api/threads/${chief.threadId}/respond`, answer);
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await expect.poll(() => stored().some(bot => bot.name === "Active Seat"), { timeout: 30_000, interval: 300 }).toBe(true);
    // read while the creating turn is still held open: a staged create would carry its staging record until the turn settles
    const seat = stored().find(bot => bot.name === "Active Seat");
    writeFileSync(join(fixture.info.dataDir, "finish-create"), "1");
    expect(seat?.staged === undefined && seat?.createdByBotId === chief.id, `the owner's answer ran the chief's create ${JSON.stringify(seat)}`).toBe(true);
    expect(level(seat), "a bot the owner let an Ask chief create starts at Ask").toBe("ask");
  }, 180_000);

  it("a browser client paired on a fresh install starts at Ask", async () => {
    await ok("POST", "/api/browser-extension/clients", { action: "enabled", enabled: true });
    const preview = await ok("POST", "/api/browser-extension/clients", { action: "preview", label: "Paired Client", profileId: PROFILE });
    const paired = await call("POST", "/api/browser-extension/clients", { action: "pair", label: "Paired Client", profileId: PROFILE, disclosureKey: preview.disclosure.disclosureKey });
    // the bot is made before the browser choice is applied: read it by name, then check the route finished
    const client = stored().find(bot => bot.name === "Paired Client");
    if (!client) throw new Error(`setup: pairing made no bot (${paired.status} ${JSON.stringify(paired.body)})`);
    expect(level(client), "a paired browser client's bot starts at Ask").toBe("ask");
    expect(paired.status, JSON.stringify(paired.body)).toBe(201);
  }, 120_000);
});

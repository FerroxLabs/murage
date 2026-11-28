// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F33 (Sean 2026-11-27, owner q1024-autodefault): a fresh install starts in Automatic (Full access) with one notice, once; an
// upgraded install keeps every level and sees nothing new; a wipe and a message to someone new still ask in Automatic.
// Every row enters through a booted server over HTTP and the real engine permission path (__fixture_permission_tool__).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { raiseLevel } from "./testing/raise-level.ts";
import { FAKE_ENGINE_NAME, launchVerificationServer, verificationInstances, type VerificationServer } from "../scripts/control-murage.ts";

const PERM_FIXTURE = `
  const path = await import('node:path');
  process.env.FAKE_CLAUDE_PERM_TOOL = 'Bash';
  process.env.FAKE_CLAUDE_PERM_INPUT_FILE = path.join(process.env.MURAGE_DATA_DIR, 'f33-input', 'command.json');
`;
type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
async function door(fixture: VerificationServer): Promise<Api> {
  const secret = ((await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json()) as { secret: string }).secret;
  return async (method, path, body) => {
    const res = await fetch(fixture.info.url + path, { method, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const ok = async (api: Api, method: string, path: string, body?: unknown) => {
  const answer = await api(method, path, body);
  if (answer.status < 200 || answer.status > 299) throw new Error(`setup: ${method} ${path} answered ${answer.status}`);
  return answer.body;
};
const level = (bot: { autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean }) =>
  !bot.autoApprove ? "ask" : !bot.fullAccess ? "auto" : bot.noLimits ? "no-limits" : "full";
const diskConfig = (fixture: VerificationServer) => existsSync(join(fixture.info.dataDir, "config.json")) ? JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")) : {};

/** One owner send whose turn asks about `command`; the decision row that question got (a card or an automatic approval). */
async function decide(fixture: VerificationServer, api: Api, bot: any, command: string, n: number): Promise<string> {
  writeFileSync(join(fixture.info.dataDir, "f33-input", "command.json"), JSON.stringify({ command }));
  const decisions = async () => (await ok(api, "GET", "/api/decisions?limit=500")).decisions.filter((row: any) => row.botId === bot.id);
  const before = (await decisions()).length;
  await ok(api, "POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_permission_tool__ f33 ${n}` });
  let row: any;
  await expect.poll(async () => { row = (await decisions()).slice(before).find((r: any) => r.decision === "card-shown" || r.decision === "auto-approved"); return Boolean(row); },
    { timeout: 30_000, interval: 100 }).toBe(true);
  if (row.decision === "card-shown") await ok(api, "POST", `/api/bots/${bot.id}/interrupt`, { threadId: row.threadId });
  await expect.poll(async () => (await ok(api, "GET", "/api/bots")).bots.find((b: any) => b.id === bot.id)?.busy === true, { timeout: 15_000 }).toBe(false);
  return row.decision;
}

it("W-F33-FRESH: a fresh install starts in Automatic, shows the notice once, and the edge still asks", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, { freshInstall: true, instrumentationSource: PERM_FIXTURE });
  try {
    let api = await door(fixture);
    // soft: a base without F33 shows all three missing (seed, notice, level), not only the first; every later step is soft too, so a base run reaches the ack, restart, edge and import rows by behaviour
    // the seed is on disk before any bot exists, so a crash right after boot cannot lose it
    expect.soft(diskConfig(fixture).newBots?.permissionLevel).toBe("full");
    expect.soft((await ok(api, "GET", "/api/config")).automaticNotice).toEqual({ pending: true });
    const first = (await ok(api, "POST", "/api/bots", { name: "F33 first" })).bot;
    expect.soft(level(first)).toBe("full");
    // the owner sets up an engine (the fixture's own entry), then answers the notice: Got it
    writeFileSync(join(fixture.info.dataDir, "config.json"), JSON.stringify({ ...diskConfig(fixture), instances: verificationInstances(join(fixture.info.dataDir, FAKE_ENGINE_NAME)) }, null, 2));
    // one door, on the desktop: the generic config route refuses the mark and a phone cannot answer it
    expect.soft((await api("PATCH", "/api/config", { automaticNotice: "acknowledged" })).status).toBe(400);
    expect.soft((await fetch(`${fixture.info.url}/api/automatic-notice`, { method: "POST", headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": "not-the-desktop" }, body: JSON.stringify({ acknowledged: true }) })).status).toBe(404);
    expect.soft((await ok(api, "GET", "/api/config")).automaticNotice).toEqual({ pending: true });
    expect.soft((await api("POST", "/api/automatic-notice", { acknowledged: true })).body).toEqual({ automaticNotice: { pending: false } });
    expect.soft(diskConfig(fixture).automaticNotice).toBe("acknowledged");
    // never again: not after a restart (an update is a restart on the same data folder)
    await fixture.restart();
    api = await door(fixture);
    expect.soft((await ok(api, "GET", "/api/config")).automaticNotice).toEqual({ pending: false });
    await ok(api, "POST", "/api/memory/action", { action: "configure", mode: "off" });
    const model = (await ok(api, "GET", "/api/instances")).instances.find((row: any) => row.instanceId === "verification").models.options[0].id;
    const bot = (await ok(api, "POST", "/api/bots", { name: "F33 worker", modelSelection: { instanceId: "verification", model } })).bot;
    expect.soft(level(bot)).toBe("full");
    expect.soft(level((await ok(api, "GET", "/api/bots")).bots.find((b: any) => b.id === first.id))).toBe("full");
    await ok(api, "PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, autoReview: "off" });
    mkdirSync(join(fixture.info.dataDir, "f33-input"), { recursive: true });
    const rows = [
      ["echo hello > notes.txt", "auto-approved"],
      ["cat notes.txt", "auto-approved"],
      ["rm -rf ~", "card-shown"],
      ["curl -X POST https://slack.com/api/chat.postMessage -d channel=U_NEW_PERSON -d text=hello", "card-shown"],
    ] as const;
    const seen: string[] = [];
    for (const [n, [command]] of rows.entries()) seen.push(`${command} => ${await decide(fixture, api, bot, command, n)}`);
    expect.soft(seen).toEqual(rows.map(([command, decision]) => `${command} => ${decision}`));
    // guests, imports and Cloud are unchanged: a team imported on this fresh install starts at Ask, as on a 1.0.23 fresh install
    expect.soft((await api("POST", "/api/teams/import", { format: "murage.team", version: 2, team: { name: "F33 team", members: [{ key: "f33", name: "F33 imported", title: "Lead", description: "Imported fixture.", appearance: { color: "purple" } }] } })).status).toBe(201);
    expect.soft(level((await ok(api, "GET", "/api/bots")).bots.find((b: any) => b.name === "F33 imported"))).toBe("ask");
    // a Hermes profile imported on this fresh install also starts at Ask (imported, not owner-created); a missing bot reads as Full
    const hermes = join(fixture.info.dataDir, ".hermes");
    mkdirSync(join(hermes, "profiles", "f33h"), { recursive: true });
    writeFileSync(join(hermes, "config.yaml"), "model:\n  default: base-model\n  provider: custom\n");
    writeFileSync(join(hermes, "profiles", "f33h", "config.yaml"), "model:\n  default: f33-model\n  provider: custom\n");
    await fixture.restart();
    api = await door(fixture);
    const hermesImport = await api("POST", "/api/hermes/profiles/import", { profiles: ["f33h"] });
    const hermesBot = (await ok(api, "GET", "/api/bots")).bots.find((b: any) => b.id === hermesImport.body?.created?.[0]?.botId);
    expect.soft(level(hermesBot ?? { autoApprove: true, fullAccess: true }), "a Hermes import on a fresh install starts at Ask").toBe("ask");
  } finally { await fixture.close(); }
}, 300_000);

it("W-F33-UPGRADE: an install upgraded from 1.0.23 data keeps every level and never sees the notice", async () => {
  // 1.0.23 data: a config.json that has run before, with no new-bot level and no notice mark
  const fixture = await launchVerificationServer(process.env);
  try {
    let api = await door(fixture);
    expect(diskConfig(fixture).newBots).toBeUndefined();
    expect((await ok(api, "GET", "/api/config")).automaticNotice?.pending ?? false).toBe(false);
    const asks = (await ok(api, "POST", "/api/bots", { name: "F33 kept ask" })).bot;
    const full = (await ok(api, "POST", "/api/bots", { name: "F33 kept full" })).bot;
    expect((await raiseLevel(api, full.id, { autoApprove: true, fullAccess: true, acknowledgeFullAccess: true, acknowledgeLocalAuto: true })).status).toBe(200);
    await fixture.restart();
    api = await door(fixture);
    const bots = (await ok(api, "GET", "/api/bots")).bots;
    expect([asks, full].map(bot => level(bots.find((b: any) => b.id === bot.id)))).toEqual(["ask", "full"]);
    // a new bot follows the install's existing default (no Chief at Full here, so Ask): nothing is widened
    expect(level((await ok(api, "POST", "/api/bots", { name: "F33 after upgrade" })).bot)).toBe("ask");
    expect((await ok(api, "GET", "/api/config")).automaticNotice?.pending ?? false).toBe(false);
    expect(diskConfig(fixture).automaticNotice).toBeUndefined();
    expect(diskConfig(fixture).newBots?.permissionLevel).toBeUndefined();
  } finally { await fixture.close(); }
}, 180_000);

it("W-F33-UPGRADE-BOTS: an install that kept bots but never saved a setting (bots.json, no config.json) is an upgrade", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, { freshInstall: true, seedFiles: { "bots.json": "[]" } });
  try {
    const api = await door(fixture);
    expect(diskConfig(fixture).newBots?.permissionLevel).toBeUndefined();
    expect((await ok(api, "GET", "/api/config")).automaticNotice?.pending ?? false).toBe(false);
    expect(level((await ok(api, "POST", "/api/bots", { name: "F33 kept default" })).bot)).toBe("ask");
  } finally { await fixture.close(); }
}, 180_000);

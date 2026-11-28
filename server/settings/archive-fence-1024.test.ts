// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 archive fence (DESIGN-sv10done W4..W4e), behavioural: a real booted server, the real PATCH /api/bots/:id archive path.
// The phone service's own bot fence (setBotFence, handed in by server/index.ts) is asked by bot id after each answer, so the
// witness reads the production consumer of archivingBots, not a copy of it.
import { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-murage.ts";

const SERVICE = new URL("../phone-calls/service.ts", import.meta.url).href;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
let dataDir = "";
let call: (method: string, path: string, body?: unknown) => Promise<Response>;

beforeAll(async () => {
  // `mode` file: "unconfirm" makes the phone stop come back unconfirmed, "throw" makes it throw; `hold` makes it wait until removed.
  const instrumentationSource = `
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = process.env.MURAGE_DATA_DIR;
    fs.writeFileSync(path.join(dir, 'phone-calls.db'), '');
    const { PhoneCallService } = await import(${JSON.stringify(SERVICE)});
    const original = PhoneCallService.prototype.cancelForBot;
    PhoneCallService.prototype.cancelForBot = async function (botId) {
      fs.appendFileSync(path.join(dir, 'enter-log'), botId + '\\n');
      const entry = fs.readFileSync(path.join(dir, 'enter-log'), 'utf8').split('\\n').filter(Boolean).length;
      while (fs.existsSync(path.join(dir, 'hold'))) await new Promise((resolve) => setTimeout(resolve, 20));
      // mode-<n> answers only the n-th stop (W4e: the first archive's stop confirms, the queued second one's does not).
      const own = path.join(dir, 'mode-' + entry);
      const mode = fs.existsSync(own) ? fs.readFileSync(own, 'utf8') : fs.existsSync(path.join(dir, 'mode')) ? fs.readFileSync(path.join(dir, 'mode'), 'utf8') : '';
      if (mode === 'throw') throw new Error('phone stop failed');
      if (mode === 'unconfirm') return [{ status: 'failed' }];
      return original.call(this, botId);
    };
    const setFence = PhoneCallService.prototype.setBotFence;
    let fenced;
    PhoneCallService.prototype.setBotFence = function (fence) { fenced = fence; return setFence.call(this, fence); };
    setInterval(() => {
      const query = path.join(dir, 'fence-query');
      if (!fenced || !fs.existsSync(query)) return;
      fs.writeFileSync(path.join(dir, 'fence-answer'), String(fenced(fs.readFileSync(query, 'utf8'))));
      fs.rmSync(query);
    }, 20).unref();
  `;
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  call = (method, path, body) => fetch(fixture.info.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  dataDir = fixture.info.dataDir;
}, 120_000);

afterAll(async () => { await fixture?.close(); });

const file = (name: string) => join(dataDir, name);
const mode = (value: "" | "unconfirm" | "throw") => writeFileSync(file("mode"), value);
const hold = (on: boolean) => { if (on) writeFileSync(file("hold"), ""); else rmSync(file("hold"), { force: true }); };
const entries = () => (existsSync(file("enter-log")) ? readFileSync(file("enter-log"), "utf8").split("\n").filter(Boolean).length : 0);
async function waitEntries(count: number) { for (let waited = 0; entries() < count && waited < 300; waited++) await wait(100); expect(entries()).toBeGreaterThanOrEqual(count); }

async function fenced(botId: string): Promise<boolean> {
  rmSync(file("fence-answer"), { force: true });
  writeFileSync(file("fence-query"), botId);
  for (let waited = 0; !existsSync(file("fence-answer")) && waited < 100; waited++) await wait(50);
  return readFileSync(file("fence-answer"), "utf8") === "true";
}

async function newBot(name: string) {
  const { bot } = await (await call("POST", "/api/bots", { name })).json() as { bot: { id: string } };
  const policyRevision = async () => ((await (await call("GET", `/api/bots/${bot.id}/access`)).json()) as { policy: { revision: number } }).policy.revision;
  const configure = async () => {
    const saved = await call("PUT", `/api/bots/${bot.id}/access`, { action: "configure", revision: await policyRevision(), mode: "restricted", allowWrites: false, grants: [] });
    expect(saved.status).toBe(200);
    return ((await saved.json()) as { policy: { revision: number } }).policy.revision;
  };
  const archive = (extra: Record<string, unknown> = {}) => configureThen(extra);
  const configureThen = async (extra: Record<string, unknown>) => call("PATCH", `/api/bots/${bot.id}`, { hidden: true, accessRevision: await policyRevision(), ...extra });
  return { id: bot.id, name, configure, policyRevision, archive };
}

describe("the archive fence goes down with a refused archive and stays for an unconfirmed stop (W4)", () => {
  it("W4 a late stale expect (the name changed while the stop was held) answers 409 and the bot is not fenced", async () => {
    mode(""); hold(false);
    const bot = await newBot("Fence stale fixture");
    await bot.configure();
    const before = entries();
    hold(true);
    const archive = bot.archive({ expect: { name: bot.name } });
    await waitEntries(before + 1);
    expect((await call("PATCH", `/api/bots/${bot.id}`, { name: "Fence stale renamed" })).status).toBe(200);
    hold(false);
    const answer = await archive;
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ code: "SETTING_CHANGED" });
    expect(await fenced(bot.id)).toBe(false);
  }, 60_000);

  it("W4b a fence left by an unconfirmed stop survives a later archive refused at the late guard, and a successful retry clears it", async () => {
    mode("unconfirm"); hold(false);
    const bot = await newBot("Fence prior fixture");
    await bot.configure();
    const first = await bot.archive();
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ code: "archive_stop_unconfirmed" });
    expect(await fenced(bot.id)).toBe(true);

    // A second archive is refused at the late guard (an access save lands during its held stop): it did not raise the fence.
    mode("");
    const before = entries();
    hold(true);
    const second = bot.archive();
    await waitEntries(before + 1);
    await bot.configure();
    hold(false);
    const refused = await second;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "ACCESS_CHANGED" });
    expect(await fenced(bot.id)).toBe(true);

    // A successful retry archives the bot (an archived bot reads as fenced by its own state); restoring it then shows no fence left behind.
    const retry = await bot.archive();
    expect(retry.status).toBe(200);
    expect(await fenced(bot.id)).toBe(true);
    expect((await call("PATCH", `/api/bots/${bot.id}`, { hidden: false })).status).toBe(200);
    expect(await fenced(bot.id)).toBe(false);

    // A fresh unconfirmed stop seeds the fence again, and an explicit reverse takes it down.
    mode("unconfirm");
    expect((await bot.archive()).status).toBe(409);
    expect(await fenced(bot.id)).toBe(true);
    expect((await call("PATCH", `/api/bots/${bot.id}`, { hidden: false })).status).toBe(200);
    expect(await fenced(bot.id)).toBe(false);
    mode("");
  }, 90_000);

  it("W4c a phone stop that throws keeps the fence up (control row)", async () => {
    mode("throw"); hold(false);
    const bot = await newBot("Fence throw fixture");
    await bot.configure();
    const answer = await bot.archive();
    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(await fenced(bot.id)).toBe(true);
    mode("");
  }, 60_000);

  it("W4d a rename PATCH never clears a fence an unconfirmed stop left (control row)", async () => {
    mode("unconfirm"); hold(false);
    const bot = await newBot("Fence rename fixture");
    await bot.configure();
    expect((await bot.archive()).status).toBe(409);
    expect(await fenced(bot.id)).toBe(true);
    expect((await call("PATCH", `/api/bots/${bot.id}`, { name: "Fence rename fixture 2" })).status).toBe(200);
    expect(await fenced(bot.id)).toBe(true);
    mode("");
  }, 60_000);

  it("W4e two archives of one bot run one at a time: the second does not start its stop until the first has answered", async () => {
    mode(""); hold(false);
    const bot = await newBot("Fence overlap fixture");
    await bot.configure();
    const before = entries();
    hold(true);
    const first = bot.archive({ expect: { name: bot.name } });
    await waitEntries(before + 1);
    const second = bot.archive();
    await wait(1_500);
    expect(entries()).toBe(before + 1);
    expect((await call("PATCH", `/api/bots/${bot.id}`, { name: "Fence overlap renamed" })).status).toBe(200);
    hold(false);
    expect((await first).status).toBe(409);
    await second;
    expect(entries()).toBe(before + 2);
    appendFileSync(file("enter-log"), "");
  }, 60_000);

  it("W4e A refused late, B queued behind it ends archive_stop_unconfirmed: B's answer says so and the fence stays up", async () => {
    mode(""); hold(false);
    const bot = await newBot("Fence overlap outcome fixture");
    await bot.configure();
    const before = entries();
    writeFileSync(file(`mode-${before + 2}`), "unconfirm");
    hold(true);
    const first = bot.archive({ expect: { name: bot.name } });
    await waitEntries(before + 1);
    const second = bot.archive();
    expect((await call("PATCH", `/api/bots/${bot.id}`, { name: "Fence overlap outcome renamed" })).status).toBe(200);
    hold(false);
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(409);
    expect(await a.json()).toMatchObject({ code: "SETTING_CHANGED" });
    expect(b.status).toBe(409);
    expect(await b.json()).toMatchObject({ code: "archive_stop_unconfirmed" });
    expect(await fenced(bot.id), "the fence B's unconfirmed stop needs").toBe(true);
    rmSync(file(`mode-${before + 2}`), { force: true });
  }, 60_000);
});

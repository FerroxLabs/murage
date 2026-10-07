// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P1 through the actual server and the captured engine requests: owner-
// authored Continuity reaches a direct turn only when the bot's own switch is
// on and memory is active, on whatever engine, and survives a restart. The
// assertions read the memory bundle the adapter prefixes onto the USER turn
// (server/harness/memory-adapter.ts), not the system layers. Synthetic fixture
// text only; fake engines, loopback server, no network or credentials.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { MEMORY_REFERENCE_CLOSE, MEMORY_REFERENCE_OPEN } from "../../shared/memory.ts";

const FAKE_CODEX = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const BRIEF = "PIP_BRIEF_CANARY continue the harbour story where it paused.";
const WORK = "PIP_WORK_CANARY we plan on Mondays and review on Fridays.";
const COMMIT = "PIP_COMMIT_CANARY send the weekly summary.";
const TRAIT = "PIP_TRAIT_CANARY prefers plain words.";
// P2 order: the brief, then the self slot newest edit first (the rows were written work, commitment, trait)
const ORDER = [BRIEF, TRAIT, COMMIT, WORK];
const PIP_ONLY = [WORK, COMMIT, TRAIT];
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, models: string[], codexModel: string;
let keeper: { id: string; threadId: string }, other: { id: string; threadId: string };
let sequence = 0;
let windows: Array<number | undefined> = [];
const IDENTITY_LINE = /; (continuity-brief|reveal-state|How we work together|Commitments \(you said\)|About me \(you said\))\)/;
const identityLines = (frame: string) => frame.split("\n").filter(line => IDENTITY_LINE.test(line));
/** The remembered-context frame itself (the identity slot's bytes), found wherever an engine put it. */
function frameIn(value: unknown): string | undefined {
  if (typeof value === "string") {
    const start = value.indexOf(MEMORY_REFERENCE_OPEN), end = value.indexOf(MEMORY_REFERENCE_CLOSE);
    return start >= 0 && end > start ? value.slice(start, end + MEMORY_REFERENCE_CLOSE.length) : undefined;
  }
  if (value && typeof value === "object") for (const item of Object.values(value)) { const found = frameIn(item); if (found) return found; }
  return undefined;
}

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const api = async (method: string, path: string, body?: unknown) => {
  const answer = await call(method, path, body);
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
  return answer.body;
};
const readJson = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; } };
const escaped = (text: string) => JSON.stringify(text).slice(1, -1);
const authenticate = async () => { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret }; };
const idle = async () => { const state = await api("GET", "/api/bots?messages=0"); return !state.bots.some((bot: any) => bot.busy) && !state.groups.some((group: any) => group.busyBotId || group.working); };
const marker = () => `PIP_TURN_${++sequence}`;
const bot = async (id: string) => (await api("GET", "/api/bots?messages=0")).bots.find((item: any) => item.id === id);
const action = (body: Record<string, unknown>) => api("POST", "/api/memory/action", body);
const write = (botId: string, kind: string, key: string, text: string, expectedVersion = 0) =>
  action({ action: "identity-write", botId, kind, key, expectedVersion, text, basis: kind === "continuity-brief" ? "fiction" : "owner-fact", audience: "owner-private" });
const continuity = (botId: string) => action({ action: "continuity-read", botId });

/** Post a direct message and return the user turn (the prompt) and system layers of the Claude request. */
async function claudeTurn(botId: string, threadId: string) {
  const tag = marker();
  await api("POST", `/api/bots/${botId}/messages`, { threadId, text: `Please answer briefly. ${tag}` });
  let dump: any;
  await expect.poll(() => { dump = readJson(fixture.fixtureDumpPath); return JSON.stringify(dump?.prompt ?? null).includes(tag); }, { timeout: 30000 }).toBe(true);
  await expect.poll(idle, { timeout: 30000 }).toBe(true);
  return { prompt: JSON.stringify(dump.prompt), system: String(dump.systemPrompt ?? ""), frame: frameIn(dump.prompt) ?? "" };
}
const has = (request: { prompt: string }, text: string) => request.prompt.includes(escaped(text)) || request.prompt.includes(text);
const orderOf = (haystack: string, texts: string[]) => texts.map(text => ({ text, at: Math.max(haystack.indexOf(text), haystack.indexOf(escaped(text))) })).sort((a, b) => a.at - b.at).map(item => item.text);

posixOnly("PIP P1 owner-authored Continuity in actual dispatch payloads", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.codexTwin={driver:'codex',displayName:'Codex delivery fixture',config:{cli:${JSON.stringify(FAKE_CODEX)},fullAuto:true},environment:{FAKE_CODEX_DUMP:path.join(process.env.MURAGE_DATA_DIR,'codex-dump.json')}};
      fs.writeFileSync(file,JSON.stringify(cfg));process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
      // a hand-edited bots.json: the marker file asks this launch to write a non-true Continuity value
      const poison=path.join(process.env.MURAGE_DATA_DIR,'pip-poison');
      if(fs.existsSync(poison)){const botsFile=path.join(process.env.MURAGE_DATA_DIR,'bots.json');const list=JSON.parse(fs.readFileSync(botsFile,'utf8'));
        for(const item of list){if(item.name==='Other fixture')item.continuity='yes';}
        fs.writeFileSync(botsFile,JSON.stringify(list));fs.unlinkSync(poison);}
    ` });
    await authenticate();
    const engines = (await api("GET", "/api/instances")).instances;
    models = engines.find((engine: any) => engine.instanceId === "verification").models.options.map((option: any) => option.id);
    codexModel = engines.find((engine: any) => engine.instanceId === "codexTwin").models.options[0].id;
    // the parity case below holds the available context window fixed: both engines resolve the same one
    windows = [engines.find((engine: any) => engine.instanceId === "verification").models.options.find((option: any) => option.id === models[0])?.contextWindow, engines.find((engine: any) => engine.instanceId === "codexTwin").models.options[0].contextWindow];
    expect((await api("GET", "/api/memory/status")).mode).toBe("active");
    const create = async (name: string) => {
      const created = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model: models[0] } })).bot;
      await api("PATCH", `/api/bots/${created.id}`, { computer: "off", browser: false, composio: false });
      return created as { id: string; threadId: string };
    };
    keeper = await create("Keeper fixture"); other = await create("Other fixture");
    await write(keeper.id, "continuity-brief", "core", BRIEF);
    await write(keeper.id, "relation", "owner", WORK);
    await write(keeper.id, "commitment", "weekly-summary", COMMIT);
    await write(keeper.id, "self-trait", "plain-words", TRAIT);
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("validates the switch: only true is stored, anything else clears it, junk is refused", async () => {
    expect((await bot(keeper.id)).continuity).toBeUndefined();
    for (const junk of ["yes", 1, "true", {}, []]) expect((await call("PATCH", `/api/bots/${keeper.id}`, { continuity: junk })).status, JSON.stringify(junk)).toBe(400);
    expect((await bot(keeper.id)).continuity).toBeUndefined();
    await api("PATCH", `/api/bots/${keeper.id}`, { continuity: true });
    expect((await bot(keeper.id)).continuity).toBe(true);
    await api("PATCH", `/api/bots/${keeper.id}`, { continuity: false });
    expect(Object.hasOwn(await bot(keeper.id), "continuity")).toBe(false);
    await api("PATCH", `/api/bots/${keeper.id}`, { continuity: true });
    await api("PATCH", `/api/bots/${keeper.id}`, { continuity: null });
    expect(Object.hasOwn(await bot(keeper.id), "continuity")).toBe(false);
    await api("PATCH", `/api/bots/${other.id}`, { name: "Other fixture" });
    expect(Object.hasOwn(await bot(other.id), "continuity")).toBe(false);
  }, 30000);

  it("off: the continuity rows stay out of the turn while the brief is delivered as before", async () => {
    const off = await claudeTurn(keeper.id, keeper.threadId);
    expect(has(off, BRIEF)).toBe(true);
    for (const text of PIP_ONLY) expect(has(off, text) || off.system.includes(text)).toBe(false);
    expect(off.prompt).not.toContain("you said");
  }, 90000);

  it("on: delivered in order to the user turn; off again: gone the next turn with the rows retained; on again: back", async () => {
    await api("PATCH", `/api/bots/${keeper.id}`, { continuity: true });
    const on = await claudeTurn(keeper.id, keeper.threadId);
    for (const text of ORDER) expect(has(on, text), text).toBe(true);
    expect(orderOf(on.prompt, ORDER)).toEqual(ORDER);
    for (const text of PIP_ONLY) expect(on.system.includes(text)).toBe(false);
    // the owner is told what came along; the model is not
    // coverage is written when the disclosure is delivered, tied to that turn
    await expect.poll(async () => (await continuity(keeper.id)).coverage, { timeout: 15000 }).toMatchObject({ brought: 3, total: 3 });
    const covered = (await continuity(keeper.id)).coverage;
    expect(typeof covered.turn).toBe("string");
    expect(on.prompt).not.toMatch(/\b3 of 3\b|[Bb]rought/);

    await api("PATCH", `/api/bots/${keeper.id}`, { continuity: false });
    const off = await claudeTurn(keeper.id, keeper.threadId);
    for (const text of PIP_ONLY) expect(has(off, text), text).toBe(false);
    expect((await continuity(keeper.id)).records).toHaveLength(4);
    // an off turn makes the last success not current: the owner is never shown a stale count
    expect((await continuity(keeper.id)).coverage).toBeNull();

    await api("PATCH", `/api/bots/${keeper.id}`, { continuity: true });
    // a changed row reaches the next turn of the same thread
    await write(keeper.id, "commitment", "weekly-summary", "PIP_COMMIT_EDITED send the weekly summary by noon.", 1);
    const back = await claudeTurn(keeper.id, keeper.threadId);
    expect(has(back, "PIP_COMMIT_EDITED send the weekly summary by noon.")).toBe(true);
    expect(has(back, COMMIT)).toBe(false);
    expect(has(back, WORK) && has(back, TRAIT)).toBe(true);
  }, 150000);

  it("keeps another bot's turns free of this bot's continuity", async () => {
    await api("PATCH", `/api/bots/${other.id}`, { continuity: true });
    const turn = await claudeTurn(other.id, other.threadId);
    for (const text of ORDER) expect(has(turn, text), text).toBe(false);
    await api("PATCH", `/api/bots/${other.id}`, { continuity: false });
  }, 90000);

  it("delivers nothing unless memory is active, and keeps the switch and rows saved", async () => {
    for (const mode of ["capture", "paused", "off"]) {
      await action({ action: "configure", mode });
      const turn = await claudeTurn(keeper.id, keeper.threadId);
      for (const text of ORDER) expect(has(turn, text), `${mode} ${text}`).toBe(false);
      expect((await bot(keeper.id)).continuity).toBe(true);
      expect((await continuity(keeper.id)).records).toHaveLength(4);
      expect((await continuity(keeper.id)).coverage, mode).toBeNull();
    }
    await action({ action: "configure", mode: "active" });
    const turn = await claudeTurn(keeper.id, keeper.threadId);
    expect(has(turn, WORK)).toBe(true);
    await expect.poll(async () => (await continuity(keeper.id)).coverage, { timeout: 15000 }).not.toBeNull();
  }, 240000);

  it("gives a different engine the same continuity, in the same order, from Murage", async () => {
    // the Claude-family fixture engine first, on the same rows, for the byte comparison
    const claudeBefore = await claudeTurn(keeper.id, keeper.threadId);
    await api("PATCH", `/api/bots/${keeper.id}/tasks/${keeper.threadId}`, { modelSelection: { instanceId: "codexTwin", model: codexModel } });
    const tag = marker(), dumpPath = join(fixture.info.dataDir, "codex-dump.json");
    await api("POST", `/api/bots/${keeper.id}/messages`, { threadId: keeper.threadId, text: `Please answer briefly. ${tag}` });
    let calls: Array<{ method: string; params: unknown }> = [];
    await expect.poll(() => { calls = readJson(dumpPath)?.calls ?? []; return calls.some(call => call.method === "turn/start" && JSON.stringify(call.params).includes(tag)); }, { timeout: 30000 }).toBe(true);
    await expect.poll(idle, { timeout: 30000 }).toBe(true);
    const request = JSON.stringify(calls.filter(entry => entry.method === "turn/start"));
    for (const text of [BRIEF, WORK, TRAIT]) expect(request).toContain(escaped(text));
    expect(orderOf(request, [BRIEF, TRAIT, WORK])).toEqual([BRIEF, TRAIT, WORK]);
    // same store, same context window, two engines: the identity slot is byte-equal
    expect(windows[0]).toBe(windows[1]);
    const codexFrame = frameIn(calls.filter(entry => entry.method === "turn/start").map(entry => entry.params)) ?? "";
    expect(identityLines(codexFrame).length).toBe(4);
    expect(identityLines(codexFrame).join("\n")).toBe(identityLines(claudeBefore.frame).join("\n"));
    await api("PATCH", `/api/bots/${keeper.id}/tasks/${keeper.threadId}`, { modelSelection: { instanceId: "verification", model: models[0] } });
  }, 200000);

  it("survives a restart: rows, switch and the owner's coverage count; a hand-edited non-true value is dropped", async () => {
    const before = await continuity(keeper.id);
    expect(before.coverage).not.toBeNull();
    writeFileSync(join(fixture.info.dataDir, "pip-poison"), "1");
    await fixture.restart(); await authenticate();
    const after = await continuity(keeper.id);
    expect(after.records.map((row: any) => [row.id, row.version, row.text])).toEqual(before.records.map((row: any) => [row.id, row.version, row.text]));
    expect(after.coverage).toMatchObject({ brought: before.coverage.brought, total: before.coverage.total });
    expect((await bot(keeper.id)).continuity).toBe(true);
    expect(Object.hasOwn(await bot(other.id), "continuity")).toBe(false);
    const turn = await claudeTurn(keeper.id, keeper.threadId);
    expect(has(turn, WORK)).toBe(true);
  }, 120000);
});

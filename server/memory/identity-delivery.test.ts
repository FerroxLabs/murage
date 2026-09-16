// B28 through the actual server and the captured engine requests: the stored
// personality (or the blank default) and owner-authored continuity reach every
// direct dispatch — first task, new task, same-engine model change, a different
// engine and a restart — while other bots and rooms receive neither the private
// brief, its reveal state nor hidden canon. Synthetic fixture text only; fake
// engines, loopback server, no network or credentials.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";

const FAKE_CODEX = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const PERSONA = "Speaks  gently, in short lines.\nKeeps the lighthouse keeper's dry humour.";
const BRIEF = "B28_BRIEF_CANARY continue the fictional harbour story where it paused.";
const CANON = "B28_HIDDEN_CANON_CANARY the keeper once hid a brass key under the lamp.";
const REVEAL = "B28_REVEAL_NOTE_CANARY the owner already heard about the key.";
const PRIVATE = [BRIEF, CANON, REVEAL];
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, models: string[], codexModel: string;
let keeper: { id: string; threadId: string }, neutral: { id: string; threadId: string }, taskThread: string;
let sequence = 0;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json() as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
  return value;
};
const readJson = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; } };
const escaped = (text: string) => JSON.stringify(text).slice(1, -1);
const authenticate = async () => { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret }; };
const idle = async () => { const state = await api("GET", "/api/bots?messages=0"); return !state.bots.some((bot: any) => bot.busy) && !state.groups.some((group: any) => group.busyBotId || group.working); };
const marker = () => `B28_TURN_${++sequence}`;

/** Post a direct message and return the exact Claude request that carried it. */
async function claudeTurn(botId: string, threadId: string) {
  const tag = marker();
  await api("POST", `/api/bots/${botId}/messages`, { threadId, text: `Please answer briefly. ${tag}` });
  let dump: any;
  await expect.poll(() => { dump = readJson(fixture.fixtureDumpPath); return JSON.stringify(dump?.prompt ?? null).includes(tag); }, { timeout: 20000 }).toBe(true);
  await expect.poll(idle, { timeout: 20000 }).toBe(true);
  return { prompt: JSON.stringify(dump.prompt), system: String(dump.systemPrompt ?? ""), argv: dump.argv as string[] };
}
function expectKeeperContinuity(request: { prompt: string; system: string }) {
  expect(request.system).toContain(`Personality: ${PERSONA}`);
  expect(request.prompt).toContain(BRIEF); expect(request.prompt).toContain(REVEAL);
  expect(request.prompt).toContain("owner-authored fictional continuity; not world truth");
  expect(request.prompt + request.system).not.toContain(CANON);
}

posixOnly("B28 personality imprint and continuity in actual dispatch payloads", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.codexTwin={driver:'codex',displayName:'Codex delivery fixture',config:{cli:${JSON.stringify(FAKE_CODEX)},fullAuto:true},environment:{FAKE_CODEX_DUMP:path.join(process.env.MURAGE_DATA_DIR,'codex-dump.json')}};
      fs.writeFileSync(file,JSON.stringify(cfg));process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
    ` });
    await authenticate();
    const engines = (await api("GET", "/api/instances")).instances;
    models = engines.find((engine: any) => engine.instanceId === "verification").models.options.map((option: any) => option.id);
    codexModel = engines.find((engine: any) => engine.instanceId === "codexTwin").models.options[0].id;
    expect((await api("GET", "/api/memory/status")).mode).toBe("active");
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("delivers the exact stored imprint and private continuity to the first direct turn, and only the default to a neutral bot", async () => {
    const create = async (name: string, persona?: string) => {
      const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model: models[0] } })).bot;
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, ...(persona ? { persona } : {}) });
      return bot as { id: string; threadId: string };
    };
    keeper = await create("Keeper fixture", PERSONA); neutral = await create("Neutral fixture");
    const stored = (await api("GET", "/api/bots?messages=0")).bots;
    expect(stored.find((bot: any) => bot.id === keeper.id).persona).toBe(PERSONA);
    expect(stored.find((bot: any) => bot.id === neutral.id).persona).toBeUndefined();

    const write = (patch: Record<string, unknown>) => api("POST", "/api/memory/action", { action: "identity-write", botId: keeper.id, expectedVersion: 0, basis: "fiction", audience: "owner-private", ...patch });
    await write({ kind: "continuity-brief", key: "core", text: BRIEF });
    const canon = await write({ kind: "character-canon", key: "brass-key", text: CANON });
    await write({ kind: "reveal-state", key: "brass-key", text: REVEAL, canon: { id: canon.id, version: canon.version }, revealed: true });

    const first = await claudeTurn(keeper.id, keeper.threadId);
    expectKeeperContinuity(first);
    const other = await claudeTurn(neutral.id, neutral.threadId);
    expect(other.system).toContain("Personality: Professional and Natural");
    expect(other.system).not.toContain(PERSONA);
    for (const text of PRIVATE) expect(other.prompt + other.system).not.toContain(text);
  }, 90000);

  it("rebuilds the same imprint and continuity for a new task and a same-engine model change", async () => {
    taskThread = (await api("POST", `/api/bots/${keeper.id}/tasks`, { title: "Second chapter" })).task.threadId;
    expect(taskThread).not.toBe(keeper.threadId);
    const fresh = await claudeTurn(keeper.id, taskThread);
    expectKeeperContinuity(fresh);
    expect(fresh.argv).not.toContain("--resume");
    const changed = models.find(model => model !== models[0]) ?? models[0];
    // A bot with several tasks changes models per thread (PATCH /api/bots/:id answers 409 otherwise).
    await api("PATCH", `/api/bots/${keeper.id}/tasks/${taskThread}`, { modelSelection: { instanceId: "verification", model: changed } });
    const switched = await claudeTurn(keeper.id, taskThread);
    expectKeeperContinuity(switched);
    expect(switched.argv.join(" ")).toContain(changed);
  }, 90000);

  it("gives a different engine the same imprint and continuity from Murage, not a vendor session", async () => {
    await api("PATCH", `/api/bots/${keeper.id}/tasks/${keeper.threadId}`, { modelSelection: { instanceId: "codexTwin", model: codexModel } });
    const tag = marker(), dumpPath = join(fixture.info.dataDir, "codex-dump.json");
    await api("POST", `/api/bots/${keeper.id}/messages`, { threadId: keeper.threadId, text: `Please answer briefly. ${tag}` });
    let calls: Array<{ method: string; params: unknown }> = [];
    await expect.poll(() => { calls = readJson(dumpPath)?.calls ?? []; return calls.some(call => call.method === "turn/start" && JSON.stringify(call.params).includes(tag)); }, { timeout: 20000 }).toBe(true);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    const request = JSON.stringify(calls);
    expect(request).toContain(escaped(`Personality: ${PERSONA}`));
    expect(request).toContain(escaped(BRIEF)); expect(request).toContain(escaped(REVEAL));
    expect(request).not.toContain(escaped(CANON));
    expect(calls.some(call => call.method === "thread/resume")).toBe(false);
  }, 90000);

  it("keeps canonical identity versions, reveal state and the imprint across a server restart", async () => {
    await api("PATCH", `/api/bots/${keeper.id}/tasks/${keeper.threadId}`, { modelSelection: { instanceId: "verification", model: models[0] } });
    const snapshot = async () => (await api("POST", "/api/memory/action", { action: "identity-read", botId: keeper.id })).records.map((record: any) => ({ id: record.id, version: record.version, kind: record.kind, text: record.text }));
    const before = await snapshot();
    expect(before.map((record: any) => record.kind).sort()).toEqual(["character-canon", "continuity-brief", "reveal-state"]);
    await fixture.restart(); await authenticate();
    expect(await snapshot()).toEqual(before);
    expect((await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === keeper.id).persona).toBe(PERSONA);
    expectKeeperContinuity(await claudeTurn(keeper.id, keeper.threadId));
  }, 90000);

  it("keeps the imprint in a room but withholds private continuity, reveal state and hidden canon", async () => {
    const room = (await api("POST", "/api/groups", { name: "Harbour room", memberIds: [keeper.id, neutral.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: keeper.id } } })).group as { id: string; threadId: string };
    const tag = marker();
    await api("POST", `/api/groups/${room.id}/messages`, { text: `Please answer briefly. ${tag}` });
    let dump: any;
    await expect.poll(() => { dump = readJson(fixture.fixtureDumpPath); return JSON.stringify(dump?.prompt ?? null).includes(tag); }, { timeout: 20000 }).toBe(true);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    const system = String(dump.systemPrompt ?? ""), prompt = JSON.stringify(dump.prompt);
    expect(system).toContain('in the room "Harbour room"'); expect(system).toContain(`Personality: ${PERSONA}`);
    for (const text of PRIVATE) expect(prompt + system).not.toContain(text);
  }, 90000);
});

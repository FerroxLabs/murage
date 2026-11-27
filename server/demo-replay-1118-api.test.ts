// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 DEMO REPLAY GATE (test-only). Owners: this witness belongs to lane demoreplay-1020q; each fix it judges belongs
// to its own lane (REPLAY.md in the lane dir names them). The fixture (testing/demo-replay-1118.json) is the SHAPE of the
// four real owner-only threads from the 2026-11-18 demo (events + native records, no text copied): every Claude start
// reported a 61-entry command catalog (names only), the threads switched Claude <-> Fuigo (Opus 5.5, Sonnet 5.5), the
// bot was a team lead that builds its team mid-turn, and one turn carried an image. On 1.0.19 every reply was stored
// as «redacted» (24 audience.omitted, reason "redacted"), the divider read "Engine changed: «redacted»", every turn
// carried "Murage left remembered details out of this reply." and turns ended "I stopped this turn because some of
// its context is no longer available."
// The witness drives the real isolated server with its fake engines and reads only the OWNER's own view.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { engineDividers, type RowEngine } from "../shared/chat-engine-notes.ts";
import { LEDGER_REFUSAL_LINE } from "./ledger-refusal-line.ts";
import { LEFT_OUT_NOTE, MESSAGE_ONLY_NOTE } from "./memory/fence-recovery.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { prepareMemoryMeterFixture } from "./memory/testing/native-meter-fixture.ts";
import { stopFixtureServer } from "./testing/platform-fixtures.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(HERE, "testing", "fake-acp-cli.ts");
const replay = JSON.parse(readFileSync(join(HERE, "testing", "demo-replay-1118.json"), "utf8")) as {
  catalog: { count: number }; commands: Array<{ name: string }>; omittedTotal: number;
  threads: Record<string, Array<{ engine: string; omitted: number; model?: string }>>;
};
const MARKER = "«redacted»";
const REPLIES = ["Manchester has about 570,000 people in the city itself.", "Fixture turn finished.", "Here is the plan for the team.", "The image shows a single pixel."];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");

let fixture: VerificationServer;
let headers: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown, extra: Record<string, string> = headers, signal?: AbortSignal): Promise<{ status: number; body: any }> => {
  const res = await fetch(fixture.info.url + path, { method, ...(signal ? { signal } : {}), headers: { ...extra, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text(); let parsed: unknown = text; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
};
const rows = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages;
const terminals = async (threadId: string) => (await rows(threadId)).filter(row => row.turnTerminal).length;
const settle = (threadId: string, n: number) => expect.poll(() => terminals(threadId), { timeout: 45_000, interval: 250 }).toBeGreaterThanOrEqual(n);
let sentTerminals = 0;
const idle = (botId: string) => expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId)?.busy ?? false, { timeout: 45_000, interval: 250 }).toBe(false);
const send = async (botId: string, threadId: string, text: string) => {
  sentTerminals = await terminals(threadId);
  const sent = await api("POST", `/api/bots/${botId}/messages`, { threadId, text });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
};
const labels = new Map<string, string>();
const labelFor = (engine: RowEngine) => labels.get(engine.instanceId) ?? engine.instanceId;
const botTexts = (all: any[]) => all.filter(row => row.role === "bot" && row.kind === "text" && !row.murage).map(row => String(row.text ?? ""));
const noteLines = (all: any[]) => all.filter(row => row.role === "bot" && row.kind === "activity").map(row => String(row.tool?.name ?? row.text ?? ""));

beforeAll(async () => {
  prepareMemoryMeterFixture(process.env.HOME!);
  const commands = JSON.stringify(replay.commands);
  fixture = await launchVerificationServer(process.env, undefined, {
    turnLog: { replies: REPLIES },
    instrumentationSource: `
    const fs=await import('node:fs'),path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.verification.displayName='Claude';
    cfg.instances.verification.environment={...cfg.instances.verification.environment,FAKE_CLAUDE_COMMANDS:${JSON.stringify(commands)},FAKE_CLAUDE_MCP_READY_MS:JSON.stringify({agents:3000,'murage-memory':3000})};
    cfg.instances.fuigo={driver:'fuigoAgent',displayName:'Fuigo',environment:{FAKE_ACP_MCP_CONNECT:'1',FAKE_ACP_MCP_READY:'1'},config:{cli:${JSON.stringify(FAKE_ACP)}}};
    fs.writeFileSync(file,JSON.stringify(cfg));
    fs.mkdirSync(path.join(process.env.HOME,'.fuigo'),{recursive:true});fs.writeFileSync(path.join(process.env.HOME,'.fuigo','auth.json'),'{}');
    const {setMemoryMode}=await import(${JSON.stringify(new URL("./memory/repository.ts", import.meta.url).href)});
    setMemoryMode('active');
  ` });
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret", undefined, {})).body.secret };
  for (const instance of (await api("GET", "/api/instances")).body.instances) labels.set(instance.instanceId, instance.displayName ?? instance.instanceId);
}, 180_000);
afterAll(async () => { await fixture?.close(); });
let traced: string | undefined;
/** Diagnostics only: the thread's audience record (types, omissions) and the server's memory/refusal lines, to stderr. */
afterEach(async () => {
  if (!traced || !fixture) return;
  const file = join(fixture.info.dataDir, "events", `${traced}.ndjson`);
  const events = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const shape = events.map(e => e.type === "audience.omitted" ? `OMIT(${e.reason})` : e.type === "item.started" || e.type === "item.completed" ? `${e.type}:${e.itemType}${e.origin ? "/" + e.origin : ""}` : e.type);
  const log = existsSync(fixture.info.logPath) ? readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => /\[memory\]|refus|revoked|fence|omitted|budget/i.test(line)).slice(-40) : [];
  let shown: string[] = [];
  try { shown = (await rows(traced)).map(row => `${row.role}/${row.kind}${row.turnTerminal ? "/T" : ""} ${JSON.stringify(String(row.text ?? row.tool?.name ?? "")).slice(0, 90)}`); } catch { /* server down */ }
  const busy = await api("GET", "/api/bots?messages=0").then(r => r.body.bots?.find((b: any) => b.threadId === traced)?.busy, () => "?");
  console.error(`[demo-replay] events ${shape.join(" ")}\n[demo-replay] busy=${busy} rows\n${shown.join("\n")}\n[demo-replay] log\n${log.join("\n")}`);
});

describe("1.0.20 demo replay gate (owner-only Demo Director, Claude <-> Fuigo, team lead, attachment)", () => {
  let lead: { id: string; threadId: string };
  let claudeModel: string;

  it("fixture is the real records' shape: 61-name catalog, 4 threads, 24 omissions, both engines", () => {
    expect(replay.catalog.count).toBe(61);
    expect(replay.commands).toHaveLength(61);
    expect(Object.keys(replay.threads)).toHaveLength(4);
    expect(replay.omittedTotal).toBe(24);
    const engines = new Set(Object.values(replay.threads).flat().map(turn => turn.engine));
    expect([...engines].sort()).toEqual(["claudeAgent", "fuigoAgent"]);
  });

  it("R1 owner-only short Claude turn after a 61-command start shows the real reply and names the engine", async () => {
    claudeModel = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
    const made = await api("POST", "/api/bots", { name: "Demo Director", modelSelection: { instanceId: "verification", model: claudeModel } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    lead = made.body.bot; traced = lead.threadId;
    expect((await api("PATCH", `/api/bots/${lead.id}`, { section: "Demo Agency", chiefOfStaff: true, computer: "off", browser: false })).status).toBe(200);
    // The demo bot ran with No limits (folder-trust-v2-api.test.ts raise()).
    expect((await api("POST", "/api/no-limits/terms", { acknowledgeNoLimits: true })).status).toBe(200);
    const seen = (await api("POST", `/api/bots/${lead.id}/permissions/refresh`, { scope: "open", targetLevel: "no-limits" })).body;
    const saved = await api("PATCH", `/api/bots/${lead.id}`, { settingsScope: "defaults", previewId: seen.previewId, ifRev: seen.botRev, fullAccess: true, acknowledgeFullAccess: true, noLimits: true, acknowledgeNoLimits: true });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await api("POST", `/api/bots/${lead.id}/permissions/refresh`, { scope: "open", rosterId: seen.rosterId, targetLevel: seen.targetLevel, afterRev: saved.body.bot?.permissionRev ?? saved.body.permissionRev })).status).toBe(200);
    await send(lead.id, lead.threadId, "What's the general population of Manchester?");
    await settle(lead.threadId, sentTerminals + 1); await idle(lead.id);
    const all = await rows(lead.threadId);
    expect(botTexts(all)).toContain(REPLIES[0]);
    for (const line of engineDividers(all, labelFor).values()) expect(line).not.toContain(MARKER);
    for (const row of all.filter(r => r.role === "bot" && r.engine)) expect(JSON.stringify(row.engine)).not.toContain(MARKER);
    expect(JSON.stringify(all)).not.toContain(MARKER);
    // A first turn of a new bot has nothing remembered to leave out.
    expect(noteLines(all).filter(line => line === LEFT_OUT_NOTE || line === MESSAGE_ONLY_NOTE)).toEqual([]);
    const sidebar = (await api("GET", "/api/bots?messages=5")).body.bots.find((b: any) => b.id === lead.id);
    expect(JSON.stringify(sidebar?.messages ?? [])).not.toContain(MARKER);
  }, 90_000);

  it("R2 a team lead building its team mid-turn keeps its own turn: no ctxstop refusal, no left-out note", async () => {
    await send(lead.id, lead.threadId, "__fixture_hold_authority__ build the demo team");
    let turn: any;
    await expect.poll(() => {
      try { turn = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); return String(JSON.stringify(turn.prompt ?? turn)).includes("build the demo team"); } catch { return false; }
    }, { timeout: 45_000 }).toBe(true);
    const token = turn.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN;
    const created: Array<{ status: number; body: unknown }> = [];
    try {
      // As the demo's create_bot did: a new team's lead, then a specialist in it, from inside the lead's running turn.
      for (const [name, isLead] of [["Research Lead", true], ["Research Analyst", false]] as const) {
        created.push(await api("POST", "/api/internal/create-bot", { fromBotId: lead.id, fromThreadId: lead.threadId, name, role: "Specialist", instructions: "Serve the client.", section: "Demo Research", ...(isLead ? { lead: true } : {}) }, { authorization: `Bearer ${token}` }, AbortSignal.timeout(30_000)));
      }
    } finally {
      writeFileSync(join(fixture.fixtureFinishGateDir, String(turn.pid)), "finish");
      await idle(lead.id);
    }
    expect(created.map(c => c.status), JSON.stringify(created)).toEqual([201, 201]);
    const all = await rows(lead.threadId);
    expect(botTexts(all)).toContain("Fixture turn finished.");
    const notes = noteLines(all);
    expect(notes.filter(line => line.includes(LEDGER_REFUSAL_LINE))).toEqual([]);
    expect(botTexts(all).filter(text => text.includes(LEDGER_REFUSAL_LINE))).toEqual([]);
    // Nothing was withheld from this owner's own turn: the note may only appear when something was left out.
    expect(notes.filter(line => line === LEFT_OUT_NOTE || line === MESSAGE_ONLY_NOTE)).toEqual([]);
    expect(JSON.stringify(all)).not.toContain(MARKER);
  }, 120_000);

  it("R3 a switch to Fuigo and back to Claude names each engine on its divider and keeps every reply", async () => {
    // Its own owner-only bot, so a ctxstop left by R2 cannot decide this row.
    const made = await api("POST", "/api/bots", { name: "Demo Director Two", modelSelection: { instanceId: "verification", model: claudeModel } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const bot = made.body.bot as { id: string; threadId: string };
    traced = bot.threadId;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false })).status).toBe(200);
    await send(bot.id, bot.threadId, "What's the general population of Manchester?");
    await settle(bot.threadId, sentTerminals + 1); await idle(bot.id);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "fuigo", model: "fake-acp-model" } })).status).toBe(200);
    await send(bot.id, bot.threadId, "Plan the team's first week.");
    await settle(bot.threadId, sentTerminals + 1); await idle(bot.id);
    // The demo's "after Fuigo switches": the first Fuigo turn must not end in the ctxstop refusal.
    const afterSwitch = await rows(bot.threadId);
    expect([...botTexts(afterSwitch), ...noteLines(afterSwitch)].filter(line => line.includes(LEDGER_REFUSAL_LINE))).toEqual([]);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "verification", model: claudeModel } })).status).toBe(200);
    const uploaded = await fetch(`${fixture.info.url}/api/attachments?threadId=${bot.threadId}`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: PNG });
    expect(uploaded.status).toBe(201);
    const { path } = await uploaded.json() as { path: string };
    await send(bot.id, bot.threadId, `What is in this image? <attached-image path="${path}" />`);
    await settle(bot.threadId, sentTerminals + 1); await idle(bot.id);
    const all = await rows(bot.threadId);
    const dividers = [...engineDividers(all, labelFor).values()];
    expect(dividers.length).toBeGreaterThanOrEqual(2);
    for (const line of dividers) expect(line).not.toContain(MARKER);
    expect(dividers.some(line => line.startsWith("Engine changed: Fuigo."))).toBe(true);
    expect(dividers.some(line => line.startsWith("Engine changed: Claude."))).toBe(true);
    for (const row of all.filter(r => r.role === "bot" && r.engine)) expect(JSON.stringify(row.engine)).not.toContain(MARKER);
    expect(botTexts(all).filter(text => text.includes(MARKER))).toEqual([]);
    // The intro, the Claude reply, the Fuigo reply and the reply about the image, each with its own words.
    expect(all.filter(r => r.role === "bot" && r.kind === "text" && r.turnTerminal && String(r.text ?? "").trim()).length).toBeGreaterThanOrEqual(3);
  }, 150_000);

  it("R4 Q2 upgrade: a 1.0.19 row already stored as «redacted» masks none of the owner's other rows or its engine", async () => {
    const before = await rows(lead.threadId);
    // Upgrade: the server stops, the row is as 1.0.19 stored it, and the same profile starts again.
    await stopFixtureServer(fixture.child);
    let rewritten = "";
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try {
      // The first real reply's row, rewritten as 1.0.19 stored it.
      const stored = (db.prepare("SELECT id,json FROM messages WHERE thread_id=? AND role='bot' AND kind='text' ORDER BY at").all(lead.threadId) as Array<{ id: string; json: string }>)
        .find(candidate => JSON.parse(candidate.json).text === REPLIES[0]);
      expect(stored, "the first owner reply is stored with its real words").toBeDefined();
      const row = JSON.parse(stored!.json);
      row.text = MARKER;
      db.prepare("UPDATE messages SET text=?, json=? WHERE thread_id=? AND id=?").run(MARKER, JSON.stringify(row), lead.threadId, stored!.id);
      rewritten = stored!.id;
    } finally { db.close(); }
    traced = lead.threadId;
    await fixture.restart();
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret", undefined, {})).body.secret };
    const all = await rows(lead.threadId);
    // The persisted row's own lost words are Q3 (out of scope); everything else in the owner's view is shown on its own provenance.
    expect(botTexts(all).filter(text => text.includes(MARKER))).toHaveLength(1);
    // Every other row reads exactly as it did before the upgrade (text and engine stamp).
    const shape = (list: any[]) => list.filter(r => r.id !== rewritten).map(r => ({ id: r.id, text: r.text ?? null, tool: r.tool?.name ?? null, engine: r.engine ?? null }));
    expect(shape(all)).toEqual(shape(before));
    for (const row of all.filter(r => r.role === "bot" && r.engine)) expect(JSON.stringify(row.engine)).not.toContain(MARKER);
    for (const line of engineDividers(all, labelFor).values()) expect(line).not.toContain(MARKER);
    const userRows = all.filter(r => r.role === "user").map(r => String(r.text));
    expect(userRows).toContain("What's the general population of Manchester?");
    const sidebar = (await api("GET", "/api/bots?messages=5")).body.bots.find((b: any) => b.id === lead.id);
    const latest = (sidebar?.messages ?? []).filter((m: any) => m.role === "bot" && m.kind === "text").at(-1);
    expect(String(latest?.text ?? "")).not.toContain(MARKER);
  }, 120_000);
});

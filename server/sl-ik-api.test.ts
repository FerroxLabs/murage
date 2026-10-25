// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-K / SL-I through the real server with fake engines: Refresh
// permissions, Switch them too, a limit that offers another engine and
// fails over once, and Codex back on Default. Each test names the owner's
// failure it prevents.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_CODEX = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-codex-app-server.ts");
// The server is a child process, so the lineage wall-clock budget (TURN_LINEAGE_MS) is live there: on a loaded host a cold first
// turn after a restart runs out of it and resets the session (`lineage-warming`, the designed lineage-cold path), which these
// tests do not claim anything about. The fixture switches the time budget off in the server's own module; the node budget and
// every revocation check stay on. The time budget keeps its own proof (lineage-r3.test.ts). Design: lanes/release104/designs/SL-IK-RESUME.md
const LINEAGE_ALLOWANCE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "memory", "lineage-allowance.ts")).href;
const remote = { "x-murage-companion": "1", "x-murage-door-token": "d".repeat(64) };
let fixture: VerificationServer, headers: Record<string, string>, claudeModel: string;
const callLog = () => join(fixture.info.dataDir, "codex-calls.log");
const codexCalls = (method: string) => existsSync(callLog()) ? readFileSync(callLog(), "utf8").split("\n").filter(line => line.endsWith(` ${method}`)).length : 0;
const codexPrompts = () => { try { return JSON.stringify(JSON.parse(readFileSync(join(fixture.info.dataDir, "codex-dump.json"), "utf8")).calls); } catch { return ""; } };

const api = async (method: string, path: string, body?: unknown, extra: Record<string, string> | null = headers) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...(extra ?? {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const lines = async (threadId: string) => (await messages(threadId)).filter(m => m.kind === "activity").map(m => m.tool?.name as string);
const task = async (botId: string, threadId: string) => (await api("GET", `/api/bots/${botId}`)).body.bot.tasks.find((t: any) => t.threadId === threadId);
const idle = (botId: string) => expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId)?.busy, { timeout: 30000 }).toBe(false);
const proof = async () => { const secret = await api("GET", "/api/desktop-secret", undefined, null); headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret.body.secret }; };

beforeAll(async () => {
  chmodSync(FAKE_CODEX, 0o755);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    (await import(${JSON.stringify(LINEAGE_ALLOWANCE)})).setLineageTimeBudgetForTest(null);
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    const v=cfg.instances.verification;
    cfg.instances.limited={...v,displayName:'Limited fixture',environment:{...(v.environment||{}),FAKE_CLAUDE_MODE:'api-error',FAKE_CLAUDE_API_ERROR:'Claude AI usage limit reached|'+(Math.floor(Date.now()/1000)+7200)}};
    cfg.instances.codex={driver:'codex',displayName:'Codex fixture',environment:{FAKE_CODEX_MODE:'resume',FAKE_CODEX_DUMP:path.join(process.env.MURAGE_DATA_DIR,'codex-dump.json'),FAKE_CODEX_CALL_LOG:path.join(process.env.MURAGE_DATA_DIR,'codex-calls.log')},config:{cli:${JSON.stringify(FAKE_CODEX)},fullAuto:true}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  await proof();
  const engines = (await api("GET", "/api/instances")).body.instances;
  claudeModel = engines.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
}, 60000);
afterAll(async () => { await fixture?.close(); });

async function bot(selection: Record<string, unknown>) {
  const created = await api("POST", "/api/bots", { name: "SL-IK fixture", modelSelection: selection });
  expect(created.status).toBe(201);
  expect((await api("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return created.body.bot as { id: string; threadId: string };
}

it("Refresh permissions previews, applies that exact preview, refuses a stale one, and is the desktop's alone", async () => {
  const b = await bot({ instanceId: "verification", model: claudeModel });
  const chat = (await api("POST", `/api/bots/${b.id}/tasks`, { title: "Older chat" })).body.task;
  expect((await api("PATCH", `/api/bots/${b.id}`, { settingsScope: "defaults", autoApprove: true, acknowledgeLocalAuto: true })).status).toBe(200);
  const path = `/api/bots/${b.id}/tasks/${chat.threadId}/permissions/refresh`;
  const preview = await api("POST", path, {});
  expect(preview.status).toBe(200);
  expect(preview.body.level.to).toBe("auto");
  // the bot moves to Full between the preview and the apply: nothing applied
  expect((await api("PATCH", `/api/bots/${b.id}`, { settingsScope: "defaults", autoApprove: true, fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
  const stale = await api("POST", path, { previewId: preview.body.previewId });
  expect(stale).toMatchObject({ status: 409, body: { code: "preview_stale" } });
  expect((await task(b.id, chat.threadId)).fullAccess).not.toBe(true);
  const fresh = await api("POST", path, {});
  expect(fresh.body.level.to).toBe("full");
  const applied = await api("POST", path, { previewId: fresh.body.previewId });
  expect(applied.status).toBe(200);
  expect(applied.body.task).toMatchObject({ autoApprove: true, fullAccess: true });
  for (const [method, route] of [["POST", path], ["POST", `/api/bots/${b.id}/threads/follow-model`], ["PUT", `/api/bots/${b.id}/limit-backup`], ["DELETE", `/api/bots/${b.id}/limit-backup`]] as const) {
    expect((await api(method, route, {}, remote)).status, `${method} ${route} from a companion`).toBe(404);
  }
}, 60000);

it("a chat with no model follows the bot; Switch them too brings a picked chat back", async () => {
  const b = await bot({ instanceId: "verification", model: claudeModel });
  const picked = (await api("POST", `/api/bots/${b.id}/tasks`, { title: "Picked" })).body.task;
  expect((await api("PATCH", `/api/bots/${b.id}/tasks/${picked.threadId}`, { modelSelection: { instanceId: "codex", model: "gpt-fake-default" } })).status).toBe(200);
  expect((await task(b.id, b.threadId)).followsBotModel).toBe(true);
  expect((await task(b.id, picked.threadId)).followsBotModel).toBe(false);
  const switched = await api("POST", `/api/bots/${b.id}/threads/follow-model`, {});
  expect(switched.body).toMatchObject({ switched: 1, busy: 0 });
  expect((await task(b.id, picked.threadId)).followsBotModel).toBe(true);
}, 60000);

it("an engine at its limit before it did anything: the plain line, a card naming what each engine bills, one switch, and the message answered once", async () => {
  const b = await bot({ instanceId: "limited", model: claudeModel });
  expect((await api("POST", `/api/bots/${b.id}/messages`, { threadId: b.threadId, text: "limit-source-one" })).status).toBe(202);
  try { await expect.poll(async () => (await messages(b.threadId)).some(m => m.card?.tool === "murage_limit_offer"), { timeout: 30000 }).toBe(true); }
  catch (error) { console.log("LIMIT-DEBUG", JSON.stringify((await messages(b.threadId)).map(m => [m.role, m.kind, m.tool?.name, String(m.text ?? "").slice(0, 200), m.error]))); throw error; }
  expect((await lines(b.threadId)).some(line => /is at its limit until about/.test(line))).toBe(true);
  const card = (await messages(b.threadId)).find(m => m.card?.tool === "murage_limit_offer")!.card;
  const label = card.options.find((option: string) => option.startsWith("Codex fixture"));
  expect(label).toBe("Codex fixture (your plan)");
  expect(card.options).toContain("Wait");
  await idle(b.id);
  // a companion without owner proof cannot pick an engine for the owner
  expect((await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.requestId, behavior: "answer", message: label }, remote)).status).not.toBe(200);
  // a bot's shell on loopback cannot dismiss the owner's card either: decline is not a way around the owner-only rule
  for (const route of [`/api/threads/${b.threadId}/respond`, `/api/bots/${b.id}/respond`]) {
    expect((await api("POST", route, { threadId: b.threadId, requestId: card.requestId, behavior: "deny" }, null)).status, `deny from a shell on ${route}`).toBe(403);
    expect((await api("POST", route, { threadId: b.threadId, requestId: card.requestId, behavior: "skip" }, null)).status, `skip from a shell on ${route}`).toBe(403);
  }
  expect((await messages(b.threadId)).find(m => m.card?.requestId === card.requestId)!.card.dismissed, "the card is still open").not.toBe(true);
  const turnsBefore = codexCalls("turn/start");
  const answer = await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.requestId, behavior: "answer", message: label, limitNextTime: true });
  expect(answer).toMatchObject({ status: 200, body: { outcome: "switched" } });
  const again = await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.requestId, behavior: "answer", message: label });
  expect(again).toMatchObject({ status: 409, body: { code: "already_settled" } });
  await expect.poll(() => codexPrompts().includes("limit-source-one"), { timeout: 30000 }).toBe(true);
  await idle(b.id);
  expect((await lines(b.threadId)).some(line => /hit its limit; Codex fixture took over until it resets/.test(line))).toBe(true);
  expect(codexCalls("turn/start"), "the double answer resent nothing").toBe(turnsBefore + 1);
  expect((await api("GET", `/api/bots/${b.id}`)).body.bot.limitBackup).toMatchObject({ selection: { instanceId: "codex" }, routines: false });
  // with the backup chosen, the next chat fails over by itself, without a card
  const other = (await api("POST", `/api/bots/${b.id}/tasks`, { title: "Second" })).body.task;
  expect((await api("POST", `/api/bots/${b.id}/messages`, { threadId: other.threadId, text: "limit-source-two" })).status).toBe(202);
  await expect.poll(() => codexPrompts().includes("limit-source-two"), { timeout: 30000 }).toBe(true);
  expect((await messages(other.threadId)).some(m => m.card?.tool === "murage_limit_offer")).toBe(false);
  // the owner picks a model while on the backup: the failover ends and a restart never brings it back
  await idle(b.id);
  expect((await api("PATCH", `/api/bots/${b.id}/tasks/${other.threadId}`, { modelSelection: { instanceId: "verification", model: claudeModel } })).status).toBe(200);
  await fixture.restart(); await proof();
  expect((await task(b.id, other.threadId)).modelSelection).toMatchObject({ instanceId: "verification" });
}, 120000);

it("a Codex chat moved to Default starts its session fresh once, and never again on the next Default turn or after a restart", async () => {
  const b = await bot({ instanceId: "codex", model: "gpt-fake-default", effort: "high" });
  const send = async (text: string) => { expect((await api("POST", `/api/bots/${b.id}/messages`, { threadId: b.threadId, text })).status).toBe(202); await expect.poll(() => codexPrompts().includes(text), { timeout: 30000 }).toBe(true); await idle(b.id); };
  await send("effort-high-one");
  const startsAfterHigh = codexCalls("thread/start");
  expect((await api("PATCH", `/api/bots/${b.id}/tasks/${b.threadId}`, { modelSelection: { instanceId: "codex", model: "gpt-fake-default" } })).status).toBe(200);
  await send("effort-default-one");
  expect(codexCalls("thread/start")).toBe(startsAfterHigh + 1);
  expect((await lines(b.threadId)).filter(line => line === "Codex is back on Default for this chat")).toHaveLength(1);
  await send("effort-default-two");
  await fixture.restart(); await proof();
  await send("effort-default-three");
  expect(codexCalls("thread/start")).toBe(startsAfterHigh + 1);
  expect((await lines(b.threadId)).filter(line => line === "Codex is back on Default for this chat")).toHaveLength(1);
}, 120000);

it("a Codex chat from before 1.0.4 (a session with no effort on record) starts fresh once when Default is chosen", async () => {
  const b = await bot({ instanceId: "codex", model: "gpt-fake-default", effort: "high" });
  expect((await api("POST", `/api/bots/${b.id}/messages`, { threadId: b.threadId, text: "pre-upgrade-one" })).status).toBe(202);
  await expect.poll(() => codexPrompts().includes("pre-upgrade-one"), { timeout: 30000 }).toBe(true);
  await idle(b.id);
  // the 1.0.3 record: a session cursor and no effortSent
  await fixture.stop();
  const file = join(fixture.info.dataDir, "bots.json");
  const rows = JSON.parse(readFileSync(file, "utf8"));
  const row = rows.find((candidate: any) => candidate.id === b.id);
  for (const record of row.tasks) delete record.effortSent;
  expect(row.tasks.find((t: any) => t.threadId === b.threadId).resumeCursors.codex).toBeTruthy();
  writeFileSync(file, JSON.stringify(rows));
  await fixture.restart(); await proof();
  const starts = codexCalls("thread/start");
  expect((await api("PATCH", `/api/bots/${b.id}/tasks/${b.threadId}`, { modelSelection: { instanceId: "codex", model: "gpt-fake-default" } })).status).toBe(200);
  for (const text of ["pre-upgrade-default-one", "pre-upgrade-default-two"]) {
    expect((await api("POST", `/api/bots/${b.id}/messages`, { threadId: b.threadId, text })).status).toBe(202);
    await expect.poll(() => codexPrompts().includes(text), { timeout: 30000 }).toBe(true);
    await idle(b.id);
  }
  expect(codexCalls("thread/start")).toBe(starts + 1);
  expect((await lines(b.threadId)).filter(line => line === "Codex is back on Default for this chat")).toHaveLength(1);
}, 120000);

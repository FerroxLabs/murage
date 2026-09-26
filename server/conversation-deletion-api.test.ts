// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deleting a conversation through the real server leaves none of its
// content on disk: rows, memory, logs, working folder, skill bundles,
// pictures, and the engine's own transcript of it.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { rustUrlEncode } from "./conversation-deletion.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const MARKER = "zq-private-marker-5531";
let fixture: VerificationServer, headers: Record<string, string>, data: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const touch = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.fuigoFixture={driver:'fuigoAgent',displayName:'Fuigo fixture',config:{cli:${JSON.stringify(FAKE_ACP)}}};
    fs.writeFileSync(file,JSON.stringify(cfg));
    const {setMemoryMode}=await import(${JSON.stringify(new URL("./memory/repository.ts", import.meta.url).href)});
    setMemoryMode('capture');
  ` });
  data = realpathSync(fixture.info.dataDir);
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

/** Every file under `root` whose bytes contain the marker. */
function filesHolding(root: string, skip: (path: string) => boolean): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (skip(path)) continue;
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && readFileSync(path).includes(MARKER)) hits.push(path);
    }
  };
  walk(root);
  return hits;
}

it("removes a deleted conversation's content everywhere Murage and its engines put it", async () => {
  const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options;
  const created = await api("POST", "/api/bots", { name: "Delete fixture", modelSelection: { instanceId: "verification", model: models[0].id } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const keep = bot.threadId;
  const doomed = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Doomed" })).body.task.threadId as string;

  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: doomed, text: `remember ${MARKER}` })).status).toBe(202);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: keep, text: "the other conversation" })).status).toBe(202);
  const desk = join(data, "workspaces", bot.id, "threads", doomed);
  await expect.poll(() => existsSync(join(data, "events", `${doomed}.ndjson`)) && existsSync(desk), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((item: any) => item.id === bot.id).tasks.every((task: any) => !task.busy), { timeout: 20_000 }).toBe(true);

  // What the conversation and its engines leave behind on a real machine.
  touch(join(desk, "notes", "pipeline.md"), MARKER);
  touch(join(data, "skill-state", bot.id, "task-bundles", doomed, "bundle.json"), MARKER);
  touch(join(data, "native", `${doomed}.previous.ndjson`), MARKER);
  const claudeProject = join(data, ".claude", "projects", desk.replace(/[^a-zA-Z0-9]/g, "-"));
  touch(join(claudeProject, "session.jsonl"), `${JSON.stringify({ type: "user", cwd: desk, message: MARKER })}\n`);
  const fuigoSession = join(data, ".fuigo", "sessions", rustUrlEncode(desk));
  touch(join(fuigoSession, "01a0d905", "chat_history.jsonl"), MARKER);
  const otherDesk = join(data, "workspaces", bot.id, "threads", keep);
  touch(join(data, ".fuigo", "sessions", rustUrlEncode(otherDesk), "s", "chat_history.jsonl"), "other conversation");

  // A saved file (Files library) from this conversation: counted in the
  // confirmation, then removed with the conversation.
  touch(join(desk, "report.md"), `# Report ${MARKER}`);
  const saved = await api("POST", "/api/artifacts/register", { botId: bot.id, threadId: doomed, relativePath: "report.md" });
  expect(saved.status, JSON.stringify(saved.body)).toBeLessThan(300);
  expect((await api("GET", `/api/deletion-preview?botId=${bot.id}&threadId=${doomed}`)).body).toEqual({ savedFiles: 1 });
  expect((await api("GET", `/api/deletion-preview?botId=${bot.id}&threadId=${keep}`)).body).toEqual({ savedFiles: 0 });
  writeFileSync(join(data, "decisions.ndjson.1"), `${JSON.stringify({ at: new Date().toISOString(), threadId: doomed, botName: "Delete fixture", tool: "Bash", summary: MARKER, decision: "user-allowed", source: "user" })}\n`);
  const deleted = await api("DELETE", `/api/bots/${bot.id}/tasks/${doomed}`);
  expect(deleted.status).toBe(200);
  expect(Array.isArray(deleted.body.leftovers)).toBe(true);
  expect(deleted.body.failed).toBeUndefined();

  for (const path of [desk, join(data, "events", `${doomed}.ndjson`), join(data, "native", `${doomed}.ndjson`), join(data, "native", `${doomed}.previous.ndjson`),
    join(data, "skill-state", bot.id, "task-bundles", doomed), claudeProject, fuigoSession]) expect(existsSync(path), path).toBe(false);
  expect(existsSync(join(data, ".fuigo", "sessions", rustUrlEncode(otherDesk)))).toBe(true);
  expect((await api("GET", `/api/deletion-preview?botId=${bot.id}&threadId=${doomed}`)).status).toBe(404);
  expect(readdirSync(join(data, "artifact-files")).filter((name) => !name.startsWith("."))).toEqual([]);
  expect(existsSync(join(data, "workspaces", bot.id, "MEMORY.md"))).toBe(true);
  expect(existsSync(join(data, "pending-deletions.json")) ? JSON.parse(readFileSync(join(data, "pending-deletions.json"), "utf8")) : []).toEqual([]);

  const db = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
  try {
    expect(db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id=?").get(doomed)?.n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id=?").get(keep)?.n).not.toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM memory_sources WHERE thread_id=? AND state!='deleted'").get(doomed)?.n).toBe(0);
  } finally { db.close(); }
  // Nothing on disk still holds the conversation's words. The fake engine's
  // own prompt dump and the scratch folder belong to the fixture, not Murage.
  // Memory's search index drops the record in the background.
  await expect.poll(() => filesHolding(data, (path) => path.endsWith("fake-claude-dump.json") || path === join(data, "tmp")), { timeout: 20_000 }).toEqual([]);
}, 60_000);

it("removes a channel conversation's member folders and engine history, then a bot's with it", async () => {
  const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options;
  const bot = (await api("POST", "/api/bots", { name: "Channel member", modelSelection: { instanceId: "verification", model: models[0].id } })).body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  const group = (await api("POST", "/api/groups", { name: "Delete room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group;
  const keep = group.threadId as string;
  const doomed = (await api("POST", `/api/groups/${group.id}/tasks`, {})).body.group.threadId as string;
  expect(doomed).not.toBe(keep);
  expect((await api("POST", `/api/groups/${group.id}/messages`, { threadId: doomed, text: `channel ${MARKER}` })).status).toBeLessThan(300);
  const desk = join(data, "workspaces", bot.id, "threads", doomed);
  await expect.poll(() => existsSync(join(data, "events", `${doomed}.ndjson`)) && existsSync(desk), { timeout: 20_000 }).toBe(true);
  const fuigoSession = join(data, ".fuigo", "sessions", rustUrlEncode(desk));
  touch(join(fuigoSession, "s", "chat_history.jsonl"), MARKER);

  // refused (409) while the member's turn is still settling
  let deleted = await api("DELETE", `/api/groups/${group.id}/tasks/${doomed}`);
  await expect.poll(async () => deleted.status === 409 ? (deleted = await api("DELETE", `/api/groups/${group.id}/tasks/${doomed}`)).status : deleted.status, { timeout: 20_000 }).toBe(200);
  expect(Array.isArray(deleted.body.leftovers)).toBe(true);
  for (const path of [desk, fuigoSession, join(data, "events", `${doomed}.ndjson`), join(data, "native", `${doomed}.ndjson`)]) expect(existsSync(path), path).toBe(false);

  // Deleting the bot takes every conversation's engine history, not only its folder.
  const botDesk = join(data, "workspaces", bot.id, "threads", bot.threadId);
  mkdirSync(botDesk, { recursive: true });
  const botSession = join(data, ".fuigo", "sessions", rustUrlEncode(botDesk));
  touch(join(botSession, "s", "chat_history.jsonl"), MARKER);
  const rootSession = join(data, ".fuigo", "sessions", rustUrlEncode(join(data, "workspaces", bot.id)));
  touch(join(rootSession, "s", "chat_history.jsonl"), MARKER);
  const removed = await api("DELETE", `/api/bots/${bot.id}`);
  expect(removed.status).toBe(200);
  expect(Array.isArray(removed.body.leftovers)).toBe(true);
  expect(existsSync(join(data, "workspaces", bot.id))).toBe(false);
  expect(existsSync(botSession)).toBe(false);
  expect(existsSync(rootSession)).toBe(false);
}, 60_000);

it("deletes a bot's only conversation and leaves a fresh one, like a channel's", async () => {
  const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options;
  const bot = (await api("POST", "/api/bots", { name: "Only one", modelSelection: { instanceId: "verification", model: models[0].id } })).body.bot;
  const only = bot.threadId as string;
  expect((await api("GET", "/api/bots?messages=0")).body.bots.find((item: any) => item.id === bot.id).tasks).toHaveLength(1);
  // The owner was offered Delete, confirmed it, and got "a bot keeps at least one task".
  const deleted = await api("DELETE", `/api/bots/${bot.id}/tasks/${only}`);
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  expect(deleted.body.bot.threadId).not.toBe(only);
  expect(deleted.body.bot.tasks).toHaveLength(1);
  expect(deleted.body.bot.tasks[0]).toMatchObject({ threadId: deleted.body.bot.threadId, title: "New task" });
  expect(deleted.body.bot.messages).toEqual([]);
  // Any failure left is a plain sentence, never internal wording.
  const again = await api("DELETE", `/api/bots/${bot.id}/tasks/${only}`);
  expect(again.status).toBe(404);
  expect(again.body.error).toBe("That conversation is already gone.");
}, 30_000);

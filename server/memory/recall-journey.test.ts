// B30 through the actual server, dispatched requests and the engine's own
// memory capability: an owner statement from an earlier task is recalled in a
// new task without the query containing the answer, stays out of another bot
// and a room, is found by an explicit old-episode lookup, and an owner
// correction or forget changes what the next lookup and dispatch receive.
// Synthetic fixture text only; fake engine, keyword index, no network.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";

const ORIGINAL = "My weekly report colour is B30_CHARCOAL_CANARY.";
const CORRECTED = "My weekly report colour is B30_TEAL_CANARY.";
const QUESTION = "Which colour did I choose for the weekly report?";
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, model: string;
let recaller: { id: string; threadId: string }, other: { id: string; threadId: string }, task: string, corrected: { id: string; version: number };
let sequence = 0;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json() as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
  return value;
};
const readJson = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; } };
const idle = async () => { const state = await api("GET", "/api/bots?messages=0"); return !state.bots.some((bot: any) => bot.busy) && !state.groups.some((group: any) => group.busyBotId || group.working); };
const query = <T>(sql: string, ...values: string[]) => { const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true }); try { return db.prepare(sql).all(...values) as T[]; } finally { db.close(); } };
// A turn marker must not look like an opaque reference (word_word, ABC-1, paths):
// relevance.ts admits only candidates containing every such reference verbatim.
const marker = () => `(turn number ${++sequence} end)`;
/** Remembered-context frame lines ("- mN (attribution; kind) ...") that mention a canary. */
const rememberedLines = (prompt: string, canary: string) => prompt.split(/\\n(?=- m\d+ \()/).filter(line => line.includes(canary));
const workingEvidence = (text: string) => text.startsWith("Working evidence");

async function turn(botId: string, threadId: string, text: string) {
  const tag = marker();
  await api("POST", `/api/bots/${botId}/messages`, { threadId, text: `${text} ${tag}` });
  let dump: any;
  await expect.poll(() => { dump = readJson(fixture.fixtureDumpPath); return JSON.stringify(dump?.prompt ?? null).includes(tag); }, { timeout: 20000 }).toBe(true);
  await expect.poll(idle, { timeout: 20000 }).toBe(true);
  return JSON.stringify(dump.prompt);
}
/** Run work while the fake engine holds a turn open, using the memory capability the harness mounted for it. */
async function withHeldTurn(threadId: string, text: string, work: (search: (body: unknown) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const tag = marker();
  await api("POST", `/api/bots/${recaller.id}/messages`, { threadId, text: `${text} ${tag}\n__fixture_hold_authority__` });
  let dump: any;
  await expect.poll(() => { dump = readJson(fixture.fixtureDumpPath); return JSON.stringify(dump?.prompt ?? null).includes(tag); }, { timeout: 20000 }).toBe(true);
  try {
    const find = (value: any): Record<string, string> | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (typeof value.env?.MURAGE_MEMORY_TOKEN === "string") return value.env;
      for (const child of Object.values(value)) { const found = find(child); if (found) return found; }
      return undefined;
    };
    const env = find(dump.mcpConfig);
    expect(env, "memory capability mounted for the held turn").toBeTruthy();
    await work(async body => {
      const response = await fetch(new URL("/api/internal/memory/search", env!.MURAGE_HARNESS_URL), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env!.MURAGE_MEMORY_TOKEN}` }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    });
  } finally {
    writeFileSync(join(fixture.fixtureFinishGateDir, String(dump.pid)), "");
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
  }
}

posixOnly("B30 fresh, deep and corrected recall through actual dispatch", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';" });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret };
    model = (await api("GET", "/api/instances")).instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
    expect((await api("GET", "/api/memory/status")).mode).toBe("active");
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("recalls an earlier task's owner statement in a new task, but not for another bot or a room", async () => {
    const create = async (name: string) => {
      const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).bot;
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
      return bot as { id: string; threadId: string };
    };
    recaller = await create("Recall fixture"); other = await create("Other fixture");
    await turn(recaller.id, recaller.threadId, ORIGINAL);
    await expect.poll(() => query("SELECT id FROM memory_records WHERE kind='source' AND state='active' AND text LIKE ?", `%B30_CHARCOAL_CANARY%`).length, { timeout: 15000 }).toBeGreaterThan(0);
    task = (await api("POST", `/api/bots/${recaller.id}/tasks`, { title: "Report follow-up" })).task.threadId;
    const fresh = await turn(recaller.id, task, QUESTION);
    expect(rememberedLines(fresh, "B30_CHARCOAL_CANARY").some(line => line.includes("(the owner said; source)")), fresh.slice(0, 4000)).toBe(true);
    expect(await turn(other.id, other.threadId, QUESTION)).not.toContain("B30_CHARCOAL_CANARY");
    const room = (await api("POST", "/api/groups", { name: "Report room", memberIds: [recaller.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: recaller.id } } })).group;
    const tag = marker();
    await api("POST", `/api/groups/${room.id}/messages`, { text: `${QUESTION} ${tag}` });
    let dump: any;
    await expect.poll(() => { dump = readJson(fixture.fixtureDumpPath); return JSON.stringify(dump?.prompt ?? null).includes(tag); }, { timeout: 20000 }).toBe(true);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    expect(JSON.stringify(dump.prompt) + String(dump.systemPrompt ?? "")).not.toContain("B30_CHARCOAL_CANARY");
  }, 90000);

  it("finds the old episode through the engine's memory capability, and serves the owner's correction to the same live capability", async () => {
    await withHeldTurn(task, "Look up the colour I picked earlier.", async search => {
      const found = await search({ query: "weekly report colour" });
      expect(found.status).toBe(200);
      const hit = found.body.hits.find((item: any) => String(item.text).includes("B30_CHARCOAL_CANARY") && !workingEvidence(String(item.text)));
      expect(hit, JSON.stringify(found.body).slice(0, 2000)).toBeTruthy(); expect(hit.evidence.length).toBeGreaterThan(0);
      const [source] = query<{ id: string; version: number }>("SELECT id,version FROM memory_records WHERE kind='source' AND state='active' AND text LIKE ?", `%B30_CHARCOAL_CANARY%`);
      const result = await api("POST", "/api/memory/action", { action: "correct", id: source.id, version: source.version, text: CORRECTED });
      corrected = { id: result.record.id, version: result.record.version };
      expect(corrected.version).toBe(source.version + 1);
      // Authority is re-read per request: the same capability now receives the correction, never the superseded version.
      const after = await search({ query: "weekly report colour" });
      expect(after.status).toBe(200);
      expect(after.body.hits.some((item: any) => String(item.text).includes("B30_TEAL_CANARY"))).toBe(true);
      for (const item of after.body.hits) if (String(item.text).includes("B30_CHARCOAL_CANARY")) expect(workingEvidence(String(item.text))).toBe(true);
    });
    const next = await turn(recaller.id, task, QUESTION);
    expect(rememberedLines(next, "B30_TEAL_CANARY").some(line => line.includes("(the owner said; source)")), next.slice(0, 4000)).toBe(true);
    // The superseded record is not current; the unchanged transcript may remain only as attributed working evidence.
    for (const line of rememberedLines(next, "B30_CHARCOAL_CANARY")) expect(line).toContain("; checkpoint)");
  }, 90000);

  it("keeps the superseded version for historical lookup with its end time", async () => {
    await withHeldTurn(task, "Show the history of my report colour choice.", async search => {
      let past: any;
      await expect.poll(async () => {
        const response = await search({ query: "weekly report colour", historical: true });
        past = response.body.hits?.find((item: any) => item.id === corrected.id && item.version === corrected.version - 1);
        return Boolean(past);
      }, { timeout: 15000 }).toBe(true);
      expect(past).toMatchObject({ state: "superseded" }); expect(String(past.text)).toContain("B30_CHARCOAL_CANARY"); expect(past.validTo).not.toBeNull();
    });
  }, 90000);

  it("forgetting the corrected memory withholds it from the live capability and the next dispatch", async () => {
    await withHeldTurn(task, "Check my report colour before I forget it.", async search => {
      expect((await search({ query: "weekly report colour" })).body.hits.some((item: any) => String(item.text).includes("B30_TEAL_CANARY"))).toBe(true);
      await api("POST", "/api/memory/action", { action: "forget", kind: "record", id: corrected.id, revision: corrected.version });
      const after = await search({ query: "weekly report colour" });
      // Either the forgotten receipt retired the turn's capability or the lookup no longer contains the record.
      if (after.status < 400) expect(after.body.hits.some((item: any) => String(item.text).includes("B30_TEAL_CANARY"))).toBe(false);
    });
    expect(await turn(recaller.id, task, QUESTION)).not.toContain("B30_TEAL_CANARY");
  }, 90000);
});

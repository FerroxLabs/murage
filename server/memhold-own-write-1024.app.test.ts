// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.24 memhold witness (MAIN-RULING memory, LINUXMEM-1023): a bot writing ITS OWN memory is never an edge. On a bot at Ask (the
// default) in the owner's own turn, memory_save and memory_propose_correction reached server/index.ts ownWriteHolds.wait and sat on a
// "Review this change" card until the owner answered; the proxy gave up at 65 s and the save was lost. Each row is one hold site
// (SITES.md), entered through the real internal route on a booted server with the turn's own memory capability.
import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const instrumentation = `
await import(${JSON.stringify(new URL("./testing/idle-load-preload.mjs", import.meta.url).href)});
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
process.env.FAKE_CLAUDE_MODE='hang';
`;
// Longer than any direct answer, far shorter than an owner reading a card: a held write answers nothing inside it.
const ANSWER_MS = 20_000;
const FACT = "Mh7 fixture fact the cat is called Pepper";
let fixture: VerificationServer, desktop: Record<string, string>, bot: { id: string; threadId: string };

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = desktop, deadlineMs?: number): Promise<{ status: number; body: any; text: string }> {
  let response: Response;
  try {
    response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(deadlineMs ? { signal: AbortSignal.timeout(deadlineMs) } : {}) });
  } catch (error) {
    // held on the owner's card instead of answered: status 0, so the row fails at its own assertion
    if (deadlineMs && (error as Error)?.name === "TimeoutError") return { status: 0, body: { error: "held past the deadline" }, text: "" };
    throw error;
  }
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* plain text answer */ }
  return { status: response.status, body: parsed, text };
}

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout=10000"); return fn(db); } finally { db.close(); }
}
/** Every own-write card the thread shows, and every own-write hold row of a memory tool. */
function cardsAndHolds(threadId: string): { cards: number; holds: number } {
  return withDb(db => {
    const cards = db.prepare("SELECT json FROM messages WHERE thread_id=?").all(threadId)
      .filter(row => { try { return JSON.parse(String(row.json))?.card?.kind === "own-write"; } catch { return false; } }).length;
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='own_write_holds'").get();
    const holds = table ? Number((db.prepare("SELECT count(*) AS n FROM own_write_holds WHERE thread_id=? AND tool LIKE 'memory_%'").get(threadId) as { n: number }).n) : 0;
    return { cards, holds };
  });
}

async function memoryToken(marker: string): Promise<{ dump: any; memory: Record<string, string> }> {
  let dump: any;
  await expect.poll(() => {
    try {
      if (!existsSync(fixture.fixtureDumpLogPath)) return false;
      const line = readFileSync(fixture.fixtureDumpLogPath, "utf8").trim().split("\n").find(row => row.includes(marker));
      if (!line) return false;
      dump = withTurnSecrets(JSON.parse(line));
      return Object.values(dump.mcpConfig?.mcpServers ?? {}).some((server: any) => server?.env?.MURAGE_MEMORY_TOKEN);
    } catch { return false; }
  }, { timeout: 30000 }).toBe(true);
  const token = Object.values(dump.mcpConfig.mcpServers as Record<string, { env?: Record<string, string> }>).map(server => server.env?.MURAGE_MEMORY_TOKEN).find(Boolean)!;
  return { dump, memory: { authorization: "Bearer " + token } };
}

async function duringOwnerTurn(marker: string, run: (memory: Record<string, string>) => Promise<void>) {
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `${marker} ${FACT} __fixture_hold_authority__` })).status).toBe(202);
  let dump: any;
  try {
    const tokens = await memoryToken(marker);
    dump = tokens.dump;
    await run(tokens.memory);
  } finally {
    if (dump?.pid) writeFileSync(join(fixture.fixtureFinishGateDir, String(dump.pid)), "");
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    await expect.poll(async () => !(await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 30000 }).toBe(true);
  }
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: instrumentation, dumpLog: true });
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret", undefined, {})).body.secret };
  const instances = (await api("GET", "/api/instances")).body.instances, model = instances.find((x: any) => x.instanceId === "verification").models.options[0].id;
  bot = (await api("POST", "/api/bots", { name: "Memhold fixture", modelSelection: { instanceId: "verification", model } })).body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, autoReview: "off" })).status).toBe(200);
  // the default level: Ask (neither auto-approve nor full access), where the hold applied
  const settings = (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id);
  expect([settings?.autoApprove === true, settings?.fullAccess === true], "the bot is at Ask").toEqual([false, false]);
}, 120000);

afterAll(async () => { await fixture?.close(); });

// One row per hold site: the tool, its internal route and a body the route itself answers (a refusal of its own is an answer too).
const SITES = [
  // the owner's own words, saved as they said them: the route keeps it active at once (no grounding, no review), so the row also shows it landed
  { tool: "memory_save", path: "/api/internal/memory/save", body: { text: FACT, evidence: [{ quote: FACT }], idempotencyKey: "memhold-save-1", claimType: "owner-statement" }, landed: true },
  { tool: "memory_propose_correction", path: "/api/internal/memory/propose-correction", body: { id: "fixture-no-such-memory", version: 1, replacement: FACT, evidence: [{ quote: FACT }], idempotencyKey: "memhold-fix-1" }, landed: false },
] as const;

for (const site of SITES) {
  it(`${site.tool} in the owner's own turn at Ask is answered by the memory route, with no owner card and no hold`, async () => {
    await duringOwnerTurn(`MH-${site.tool}`, async memory => {
      const answer = await api("POST", site.path, site.body, memory, ANSWER_MS);
      console.log(`[memhold] ${site.tool} status=${answer.status} body=${answer.text.slice(0, 300)}`);
      expect(answer.status, `${site.tool} is answered, not held on the owner's card`).not.toBe(0);
      expect(cardsAndHolds(bot.threadId), `${site.tool} put no own-write card and no hold in the conversation`).toEqual({ cards: 0, holds: 0 });
      if (site.landed) {
        expect([answer.status, answer.body?.state], "the save is kept and active").toEqual([200, "active"]);
        const kept = withDb(db => db.prepare("SELECT state FROM memory_records WHERE id=? AND version=1").get(String(answer.body.candidateId))?.state);
        expect(kept, "the saved memory is in the store").toBe("active");
      }
    });
  }, 120000);
}

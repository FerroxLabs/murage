// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The pre-dispatch memory cost of a real turn on the 60k store, measured through a real server with the fake
// engine, exactly where the target is defined (PROPOSAL-v2 10.7: "memory before engine send", from the start of
// memory.assemble to dispatch.send). Off unless MEMORY_PERF_E2E=1. The same file runs on an older checkout for
// the "before" figures: it reads the turn trace, which both have, and the `[memory] turn` line where there is one.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlMurage, type VerificationServer } from "../../scripts/control-murage.ts";
import { buildPerfFixture, perfShape } from "./testing/perf-fixture.ts";

const enabled = process.env.MEMORY_PERF_E2E === "1";
const enforce = process.env.MEMORY_PERF_ASSERT === "1";
const label = process.env.MEMORY_PERF_LABEL ?? "run";
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : 0; };
const summary = (values: number[]) => ({ n: values.length, p50: Math.round(percentile(values, 0.5)), p95: Math.round(percentile(values, 0.95)), max: Math.round(Math.max(0, ...values)) });
function report(name: string, values: Record<string, unknown>) {
  const line = JSON.stringify({ label, name, ...values });
  console.log(`PERF ${line}`);
  if (process.env.MEMORY_PERF_OUT) appendFileSync(process.env.MEMORY_PERF_OUT, `${line}\n`);
}

const suite = enabled ? describe : describe.skip;
suite("memory before the engine send, through a real server", () => {
  let fixture: VerificationServer, desktop: Record<string, string>, bot: { id: string; threadId: string }, database: DatabaseSync;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...desktop, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const result = await response.json();
    expect(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`).toBe(true);
    return result as any;
  };
  const logLines = () => { try { return readFileSync(fixture.info.logPath, "utf8").split("\n"); } catch { return [] as string[]; } };

  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      instrumentationSource: `process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1"; process.env.MURAGE_TURN_TRACE = "1";
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (input, init) => String(input).startsWith("https://api.fluxrouter.ai/")
          ? Promise.resolve(new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:"[]"}}]})))
          : originalFetch(input, init);`,
    });
    const proof = await api("GET", "/api/desktop-secret");
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    bot = (await api("POST", "/api/bots", { name: "Sable", title: "Chief of Staff", section: "Memory timing" })).bot;
    database = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=60000");
    const started = Date.now();
    buildPerfFixture({ ...perfShape(), pendingJobs: 0 }, { db: database, threadId: bot.threadId, indexPath: join(fixture.info.dataDir, "memory-index.db"), ownConnection: false });
    console.log(`fixture built in ${Math.round((Date.now() - started) / 1000)} s`);
    await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
  }, 30 * 60_000);
  afterAll(async () => { try { database?.close(); } catch { /* closed */ } await fixture?.close(); });

  /** One turn through the real server. The trace gives the spans; pre-dispatch is memory.assemble's start to dispatch.send. */
  async function turn(text: string) {
    const mark = logLines().length;
    await api("POST", `/api/bots/${bot.id}/messages`, { text });
    await runControlMurage(["wait", "--bot", bot.id, "--timeout", "90", "--url", fixture.info.url]);
    await sleep(250);
    const lines = logLines().slice(mark);
    const trace = lines.filter(line => line.includes("[turn-trace]"));
    const field = (line: string, key: string) => Number(new RegExp(`${key}=(\\d+)`).exec(line)?.[1]);
    const assemble = trace.find(line => line.includes("phase=memory.assemble"));
    const send = trace.find(line => line.includes("phase=dispatch.send"));
    const memoryLine = lines.find(line => line.includes("[memory] turn "));
    if (!assemble || !send) return null;
    const pre = field(send, "at") - (field(assemble, "at") - field(assemble, "ms"));
    return { pre, assembleMs: field(assemble, "ms"), memoryLine, sendAt: field(send, "at") };
  }

  async function series(name: string, count: number) {
    const pres: number[] = [], others: number[] = [];
    let skipped = 0;
    const lines: string[] = [];
    for (let n = 0; n < count + 3; n++) {
      const result = await turn(`MEMACTIVE fact ${name} ${n} weekly client report timing`);
      if (!result) { skipped++; continue; }
      if (n < 3) continue;
      pres.push(result.pre);
      if (result.memoryLine) { lines.push(result.memoryLine.slice(result.memoryLine.indexOf("[memory]"))); const other = /other=(\d+)/.exec(result.memoryLine)?.[1]; if (other) others.push(Number(other)); }
    }
    report(`e2e.${name}`, { preDispatch: summary(pres), unattributed: others.length ? summary(others) : null, skipped, sampleLines: lines.slice(0, 3) });
    return { pres, others };
  }

  it("idle worker (the 600 held-back jobs are in the store throughout)", async () => {
    const idle = await series("idle", 30);
    if (enforce) {
      expect(percentile(idle.pres, 0.95)).toBeLessThanOrEqual(250);
      if (idle.others.length) expect(percentile(idle.others, 0.95)).toBeLessThanOrEqual(30);
    }
  }, 30 * 60_000);

  it("worker indexing 4,000 new records", async () => {
    database.exec("BEGIN IMMEDIATE");
    const insert = database.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,?)");
    const receipt = database.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)");
    const scope = String(database.prepare("SELECT id FROM memory_scopes WHERE kind='conversation' AND owner_key=?").get(bot.threadId)!.id);
    for (let n = 0; n < 4000; n++) { insert.run(`turnproj-${n}`, scope, `MEMPROJ ${n}: a fact the index has not seen yet about the work.`, Date.now(), Date.now()); receipt.run(`turnproj-${n}`); }
    database.exec("UPDATE memory_meta SET data_revision=data_revision+1; COMMIT");
    const busy = await series("indexing", 20);
    if (enforce) expect(percentile(busy.pres, 0.95)).toBeLessThanOrEqual(400);
  }, 30 * 60_000);
});

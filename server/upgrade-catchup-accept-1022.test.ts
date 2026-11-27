// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1022-upgradecatchup acceptance (MAIN-RULING 2026-11-25T15:24:30Z). Owner of the fix and of this witness: q1022-upgradecatchup
// (recall-view-schema.ts dropLeftoverRecallViews, recall-view.ts build pace); owner of the minute ledger it reads beside the
// OS counters: io-budget.ts (scperf-p1). The real server (server/index.ts, fake engines, real timers) is started on a home whose
// messages.db an earlier release left full of recall views (128 views at the cap, LEFTOVER_ROWS term rows, close to the storage
// ceiling, no 1.0.22 mark), and used for ten minutes: an owner turn every other minute. Judged from the server's own minute ledger (the `io-minute`
// facts of .murage/health/server.current.ndjson: the bytes the watchdog charged, the number its `[io-budget] writing` line prints; a
// container does not let a test read /proc/<pid>/io) and from the OS's CPU counter of the server process (/proc/<pid>/stat), every minute:
//   - at most 50 MiB written;   - under 50% of one CPU;   - no AdmissionLockTimeout line;   - every turn gets its reply;
// and the leftover views are gone. Linux only (the counters); extended tier (13 minutes).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeEngineImportArgs, powerBlockTestEnv } from "./testing/power-block-test.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 18000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const MINUTE = 60_000;
const MINUTES = Number(process.env.UPCATCH_MINUTES ?? 10);
const LEFTOVER_ROWS = Number(process.env.UPCATCH_ROWS ?? 850_000);
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const DESKTOP_PROOF = "ab".repeat(32);
const DESKTOP_HEADERS = { "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_PROOF };
const linux = process.platform === "linux";

function findDb(dir: string, depth = 0): string | undefined {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "messages.db") return path;
    if (depth < 6 && statSync(path).isDirectory()) { const found = findDb(path, depth + 1); if (found) return found; }
  }
  return undefined;
}

describe.skipIf(!linux)("q1022-upgradecatchup: the first ten minutes on a store an earlier release left full of recall views", () => {
  let child: ChildProcess | undefined;
  let home: string;
  let output = "";

  async function boot(): Promise<number> {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_PORT: String(PORT), MURAGE_DEV_DESKTOP_SECRET: DESKTOP_PROOF };
    if (process.env.PATH) env.PATH = process.env.PATH;
    const started = Date.now();
    child = spawn(process.execPath, [...fakeEngineImportArgs(), join(SERVER_DIR, "index.ts")], {
      windowsHide: true, cwd: join(SERVER_DIR, ".."), env: { ...env, ...powerBlockTestEnv() }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", chunk => { output += chunk; });
    child.stdout!.on("data", chunk => { output += chunk; });
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) return Date.now() - started; } catch { /* not up yet */ }
      if (Date.now() - started > 240_000) throw new Error(`server never came up:\n${output.slice(-4000)}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${output.slice(-4000)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...DESKTOP_HEADERS }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const replies = async (botId: string): Promise<number> => {
    const bot = (await api("GET", "/api/bots")).body.bots.find((item: { id: string }) => item.id === botId);
    return bot && !bot.busy ? bot.messages.filter((m: { role: string; kind: string }) => m.role === "bot" && m.kind === "text").length : -1;
  };
  /** One owner turn; resolves with the milliseconds until its reply stood, or -1 when none came in `within`. */
  async function turn(botId: string, text: string, within: number): Promise<number> {
    const before = Math.max(0, await replies(botId)), started = Date.now();
    if ((await api("POST", `/api/bots/${botId}/messages`, { text })).status !== 202) return -1;
    while (Date.now() - started < within) {
      if (await replies(botId) > before) return Date.now() - started;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return -1;
  }
  const cpuMs = () => {
    const stat = readFileSync(`/proc/${child!.pid!}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[11]) + Number(fields[12])) * 10;
  };
  /** The watchdog's judged minutes as the server published them (one io-minute fact per judged tick). */
  const judged = (): Array<{ idle: boolean; intervalMs: number; chargedBytes: number; budgetBytes: number; osBytes?: number; applicationBytes?: number }> => {
    let text = "";
    try { text = readFileSync(join(home, ".murage", "health", "server.current.ndjson"), "utf8"); } catch { return []; }
    const facts: Array<{ idle: boolean; intervalMs: number; chargedBytes: number; budgetBytes: number; osBytes?: number; applicationBytes?: number }> = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { for (const fact of JSON.parse(line).facts ?? []) if (fact.kind === "io-minute") facts.push(fact); } catch { /* a line still being appended */ }
    }
    return facts;
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "upcatch-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    chmodSync(FAKE_CLI, 0o755);
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: {
      happy: { driver: "grokAgent", environment: { FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" }, config: { cli: FAKE_CLI, fullAuto: true } },
    } }));
  }, 30_000);
  afterAll(async () => {
    if (child && child.exitCode === null) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it(`writes at most 50 MiB a minute, stays under half a CPU, never times out an admission and answers every turn for ${MINUTES} minutes`, async () => {
    // The store before the upgrade: real conversations, then the recall views as the earlier release left them.
    await boot();
    const bots: string[] = [];
    for (let b = 0; b < 4; b++) {
      const created = (await api("POST", "/api/bots")).body.bot;
      bots.push(created.id);
      for (let n = 1; n <= 2; n++) {
        const words = Array.from({ length: 2000 }, (_, at) => `w${b}${n}x${(at * 2654435761 % 1_000_003).toString(36)}`).join(" ");
        expect(await turn(created.id, `before the upgrade ${b}.${n}: ${words}`, 90_000), `fixture turn ${b}.${n}`).toBeGreaterThanOrEqual(0);
      }
    }
    await waitForExit(child!, { signal: "SIGTERM" });
    const file = findDb(home)!;
    expect(existsSync(file)).toBe(true);
    const older = new DatabaseSync(file);
    let size = 0, liveRecords = 0;
    try {
      older.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=OFF");
      older.exec("CREATE TABLE IF NOT EXISTS transcript_index_state(name TEXT PRIMARY KEY, done INTEGER NOT NULL, cursor INTEGER NOT NULL, skipped INTEGER NOT NULL) WITHOUT ROWID");
      older.exec("DELETE FROM transcript_index_state WHERE name LIKE 'recall_%_1022%'");
      older.exec("BEGIN");
      const view = older.prepare("INSERT INTO memory_recall_views(view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader) VALUES(?,?,0,0,'ready',0,'',0)");
      for (let n = 0; n < 128; n++) view.run(`leftover-${String(n).padStart(4, "0")}`, "g");
      const term = older.prepare("INSERT INTO memory_recall_view_terms(view_id,generation,term,sequence,record_id,version) VALUES(?,?,?,?,?,1)");
      // The leftover words are copies of records that still exist (MAIN-RULING UPCATCH-1022 D1: only an already-forgotten record's
      // words are purged before the drop): the store's own records, or archived fixture records when the fixture turns left none.
      let records = (older.prepare("SELECT id,version FROM memory_records WHERE state<>'deleted' LIMIT 5000").all() as { id: string; version: number }[]).filter(row => Number(row.version) === 1).map(row => String(row.id));
      if (!records.length) {
        const top = Number(older.prepare("SELECT coalesce(max(sequence),0) AS n FROM memory_recall_changes").get()!.n);
        older.exec("PRAGMA foreign_keys=OFF");
        const record = older.prepare("INSERT INTO memory_records VALUES(?,1,'leftover-scope','constraint','still here','owner-statement','archived',0,1,NULL,NULL,1)");
        records = Array.from({ length: 200 }, (_, n) => `leftover-record-${n}`);
        for (const id of records) record.run(id);
        older.prepare("DELETE FROM memory_recall_changes WHERE sequence>?").run(top);
      }
      liveRecords = records.length;
      for (let n = 0; n < LEFTOVER_ROWS; n++) term.run(`leftover-${String(n % 128).padStart(4, "0")}`, "g", `t${(n * 2654435761 % 1_000_003).toString(36)}x${n}`, n, records[n % records.length]);
      older.exec("COMMIT");
      older.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { older.close(); }
    size = statSync(file).size;

    // The upgrade start.
    output = "";
    const bootMs = await boot();
    // The open itself (the purge and the drop run inside it, before the watchdog's first minute): what the process wrote, by the OS
    // counter, from its start to its first health reply, and the CPU it used for that.
    // (the OS counter of another process is readable only where the runner may trace it; the test container refuses it with EACCES:
    // there the bytes are reported as null and only the time is judged)
    let bootWritten: number | null = null;
    try { bootWritten = Math.round(Number(/^write_bytes: (\d+)/m.exec(readFileSync(`/proc/${child!.pid!}/io`, "utf8"))?.[1] ?? Number.NaN) / 1048576 * 10) / 10; } catch { /* not readable here */ }
    const bootCpuMs = cpuMs();
    const before = judged().length;
    const cpus: number[] = [], turns: number[] = [];
    let last = cpuMs();
    for (let minute = 1; minute <= MINUTES; minute++) {
      const started = Date.now();
      if (minute % 2 === 1) turns.push(await turn(bots[(minute >> 1) % bots.length], `after the upgrade, minute ${minute}: what did we say before?`, 50_000));
      await new Promise(resolve => setTimeout(resolve, Math.max(0, MINUTE - (Date.now() - started))));
      expect(child!.exitCode, `the server stopped in minute ${minute}: ${output.slice(-2000)}`).toBeNull();
      const now = cpuMs(), ms = Date.now() - started;
      cpus.push(Math.round((now - last) / ms * 1000) / 10);
      last = now;
    }
    const timeoutLines = output.split("\n").filter(line => line.includes("AdmissionLockTimeout")).map(line => line.slice(0, 200));
    const timeouts = timeoutLines.length;
    // q1022-jam (owner copy 2026-11-26: a 29 s loop stall while the views were reclaimed and rebuilt): the server's own loop monitor
    const stalls = [...output.matchAll(/\[loop\] stall blocked=(\d+)ms/g)].map(match => Number(match[1]));
    const health = (await api("GET", "/api/health")).body;
    const over = output.split("\n").filter(line => /\[io-budget\] writing .*\(budget \d+/.test(line)).map(line => line.slice(0, 300));
    // the last minute's fact is published with the next health line
    await new Promise(resolve => setTimeout(resolve, 20_000));
    const facts = judged().slice(before);
    const mib = facts.map(fact => Math.round(fact.chargedBytes / 1048576 * 10) / 10);
    // what the process really wrote in the minute, planned writes included (the reclaim bucket's allowance is not subtracted here)
    const written = facts.map(fact => Math.round(Math.max(Number(fact.osBytes ?? 0), Number(fact.applicationBytes ?? 0)) / 1048576 * 10) / 10);
    await waitForExit(child!, { signal: "SIGTERM" });
    const check = new DatabaseSync(file, { readOnly: true });
    let left = -1, state: unknown;
    try {
      left = Number(check.prepare("SELECT count(*) AS n FROM memory_recall_views WHERE view_id LIKE 'leftover-%'").get()!.n);
      state = check.prepare("SELECT done,cursor,skipped FROM transcript_index_state WHERE name='recall_views_1022'").get();
    } finally { check.close(); }
    console.info(`[upcatch-accept] ${JSON.stringify({ fileMiB: Math.round(size / 1048576), leftoverRows: LEFTOVER_ROWS, liveRecords, bootMs, bootWrittenMiB: bootWritten, bootCpuMs, chargedMiBPerJudgedMinute: mib, writtenMiBPerJudgedMinute: written, idle: facts.map(fact => fact.idle), cpuPercentPerMinute: cpus, turns, timeouts, stallsMs: stalls, leftoverViews: left, mark: state })}\n[upcatch-accept] over-budget lines: ${over.length}\n${over.join("\n")}\n[upcatch-accept] AdmissionLockTimeout lines: ${timeouts}\n${timeoutLines.join("\n")}\n[upcatch-accept] health admission: ${JSON.stringify(health?.admission ?? health?.admissionHealth ?? Object.keys(health ?? {})).slice(0, 600)}`);
    expect(mib.filter(value => value > 50), `MiB charged per judged minute: ${JSON.stringify(mib)}`).toEqual([]);
    if (bootWritten !== null) expect(bootWritten, "MiB written from the process start to the first health reply (the open: purge and drop)").toBeLessThanOrEqual(50);
    expect(bootMs, "ms from the process start to the first health reply").toBeLessThan(30_000);
    expect(bootCpuMs, "CPU ms the process used from its start to the first health reply").toBeLessThan(30_000);
    expect(written.filter(value => value > 50), `MiB written per judged minute (planned writes included): ${JSON.stringify(written)}`).toEqual([]);
    // liveness: the watchdog judged these minutes (a ledger that published nothing proves nothing)
    expect(facts.length, `judged minutes of ${MINUTES}`).toBeGreaterThanOrEqual(MINUTES - 2);
    expect(Math.max(0, ...mib), "the ledger saw the server's writes").toBeGreaterThan(0);
    expect(cpus.filter(cpu => cpu >= 50), `CPU % per minute: ${JSON.stringify(cpus)}`).toEqual([]);
    expect(timeouts).toBe(0);
    expect(stalls.filter(ms => ms > 2000), `loop stalls over 2 s: ${JSON.stringify(stalls)}`).toEqual([]);
    expect(turns.filter(ms => ms < 0), `reply times: ${JSON.stringify(turns)}`).toEqual([]);
    expect(left).toBe(0);
    // no scrub is owed (MAIN-RULING UPCATCH-1022 D1): the mark reads done, on a file a drop ran on
    expect(state, `mark ${JSON.stringify(state)}`).toMatchObject({ done: 1, skipped: 1 });
  }, (MINUTES + 12) * MINUTE);
});

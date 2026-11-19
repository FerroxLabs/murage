// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance (docs/designs/boot-tolerance/ACCEPTANCE.md), rows A3, A4, A5, B2 on a real small filesystem (`--tmpfs /strict`, it-remote IT_DOCKER_EXTRA).
// A3: the shell's own classifier calls a read-only start ready. A4: writes return only through a fresh start. A5: a read-only start with the required index
// missing writes nothing and stops before it listens. B2: a disk that fills during the open path's index build stops the start with the data untouched.
// Runs only where /strict is a real mount; elsewhere it is skipped because there is no small filesystem to fill.
// HEADLESS ONLY: throwaway HOME under /strict and a probed port.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { launchOf, pollServerIdentity } from "../electron/server-boot-probe.mjs";
import { waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { seedRemainingBootRecoveries } from "./testing/boot-fixture-recoveries.ts";
import { GH18_OPERATIONS_SCHEMA } from "./memory/schema.ts";
import { MiB, OWNER_COPY, STRICT, type Run, desktopHeaders, fillTo, freeBytes, healthOk, onStrictMount, snapshot, startServer, waitExited } from "./testing/strict-fs.ts";

describe.skipIf(!onStrictMount)("boot tolerance: the start on a real small filesystem", () => {
  const runs: Run[] = [];
  /** Every server of an earlier leg stopped and its directory (ballast included) gone, so each leg starts with the filesystem's whole space. */
  const clear = async () => {
    for (const run of runs) if (run.exited() === undefined) await waitForExit(run.child, { signal: "SIGTERM" });
    for (const leg of ["a3", "a3-static", "a4", "a5", "a5b", "b2"]) rmSync(join(STRICT, leg), { recursive: true, force: true });
  };
  afterAll(clear);
  const begin = (home: string, port: number, env: Record<string, string> = {}) => { const run = startServer(home, port, env); runs.push(run); return run; };
  const botsOf = async (port: number) => ((await (await fetch(`http://127.0.0.1:${port}/api/bots?messages=0`, { headers: await desktopHeaders(port) })).json()) as { bots: Array<{ id: string; name: string }> }).bots.map(bot => bot.name);
  const health = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { diskLow?: { mode: string } };

  /** Fixture F: a normal start with ample space, two bots through the API, a clean stop. */
  async function fixture(leg: string, port: number, env: Record<string, string> = {}) {
    await clear();
    const home = join(STRICT, leg, "home"); const data = join(home, ".murage"); mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {} }));
    const first = begin(home, port, env);
    expect(await healthOk(port, first), first.out().slice(-4000)).toBe(true);
    const headers = await desktopHeaders(port);
    for (const name of ["Fixture One", "Fixture Two"]) expect((await fetch(`http://127.0.0.1:${port}/api/bots`, { method: "POST", headers, body: JSON.stringify({ name }) })).status).toBe(201);
    const roster = await (await fetch(`http://127.0.0.1:${port}/api/bots?messages=0`, { headers })).json() as { bots: Array<{ id: string }> };
    expect((await fetch(`http://127.0.0.1:${port}/api/groups`, { method: "POST", headers, body: JSON.stringify({ name: "Fixture Room", memberIds: roster.bots.map(bot => bot.id) }) })).status).toBe(201);
    expect((await fetch(`http://127.0.0.1:${port}/api/bots`, { method: "POST", headers, body: JSON.stringify({ name: "Fixture Packed", section: "Fixture Pack · General (1a2b3c4d)" }) })).status).toBe(201);
    await waitForExit(first.child, { signal: "SIGTERM" });
    return { home, data, ballast: join(STRICT, leg, "ballast") };
  }

  /** The boot recoveries' inputs of fixture F that this file seeds: a legacy queue file, a venue post cut short (`posting`), an own-write hold cut short (`applying`), an owner send cut short
   * (`sending`, not dispatched), two file-watch runs (`changed`, `failed`) whose card is not yet in the bot's conversation, and a fresh-start operation
   * whose cursor save is pending. A read-only start and a start that dies before listen leave all of them; the next normal start settles them (A4). */
  function seedRecoveries(data: string) {
    const queueFile = join(data, "queued-messages.json"); writeFileSync(queueFile, "[]");
    const bot = (JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as Array<{ id: string; threadId: string }>)[0]!;
    const journal = join(data, "events", "routine-runs"); mkdirSync(journal, { recursive: true });
    const watchRun = (id: string, status: string, outcome: string) => JSON.stringify({ id, routineId: "watch-fixture-1", routineName: "Fixture watch", target: "bot", botId: bot.id, runOn: "ember", status,
      ...(status === "failed" ? { error: "x" } : {}), manual: false, scheduledFor: 1, createdAt: 1, sourceThreadId: bot.threadId, output: "done",
      watch: { watchId: "watch-fixture-1", ownerBotId: bot.id, source: { adapterId: "file", sourceId: "notes.txt", scopeId: "a".repeat(64) }, outcome } });
    writeFileSync(join(journal, "watch-fixture-1.jsonl"), `${watchRun("run-watch-changed", "completed", "changed")}\n${watchRun("run-watch-failed", "failed", "failed")}\n`);
    const seed = new DatabaseSync(join(data, "messages.db"));
    seed.exec(GH18_OPERATIONS_SCHEMA); // the exact text: the start checks this table's schema rows against it
    seed.prepare(`INSERT INTO gh18_operations(operation_id,installation,owner,bot_id,idempotency_key,request_digest,policy_version,snapshot_digest,created_at,completed_at,state,reason,cleared_blocks,cursor_clears_json,cursors_applied,visibility_changed,outcome_json)
      SELECT 'op-fixture',installation_id,'owner-fixture',?,'idem-fixture-0000000','rd','gh18-fresh-start-v2','sd',1,1,'applying','cursor-save-pending',1,?,0,0,? FROM memory_meta WHERE id=1`)
      .run(bot.id, JSON.stringify([{ botId: bot.id, threadId: bot.threadId, instanceId: "inst-fixture", cursorJson: JSON.stringify("x") }]),
        JSON.stringify({ policyVersion: "gh18-fresh-start-v2", botId: bot.id, retainedBlocks: 0, retainedCapped: false, operationId: "op-fixture", clearedBlocks: 1, freshSessions: 0, visibilityChanged: false, state: "applying", reason: "cursor-save-pending" }));
    seed.exec(`INSERT INTO venue_posts (id,bot_id,thread_id,origin,request_message_id,request_hash,venue_id,target_thread_id,text,stable_id,lineage,state,created_at,updated_at)
      VALUES ('vp-fixture','bot-fixture','thread-fixture','owner','req-fixture','hash-fixture','venue-fixture','target-fixture','text','stable-fixture','[]','posting',1,1)`);
    seed.exec(`INSERT INTO owner_sends (kind, owner_id, thread_id, send_id, queue_id, fingerprint, text, status, created_at, updated_at) VALUES ('bot','bot-fixture','thread-fixture','send-fixture','queue-fixture','fp-fixture','text','sending',1,1)`);
    // FIXTURE-F-MAP class 5: an own-write hold cut short while `applying` (own-write-holds.ts recover, bootStepAsync writer.ownWriteHolds)
    seed.exec(`INSERT INTO own_write_holds(hold_id,bot_id,thread_id,generation,tool,body,body_hash,frozen,dedupe_key,ref,state,revision,created_at,updated_at)
      VALUES('hold-fixture','bot-fixture','thread-fixture','gen-fixture','update_bot','{}','44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a','{"principal":{"kind":"owner"},"writeKeys":[]}','dedupe-fixture','ref-fixture','applying',1,1,1)`);
    const remaining = seedRemainingBootRecoveries(data, seed);
    seed.exec("PRAGMA wal_checkpoint(TRUNCATE)"); seed.close();
    const stateOf = (table: string, id: string, column = "state") => {
      const check = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
      try { return (check.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${table === "venue_posts" ? "id" : "queue_id"}=?`).get(id) as { v: string } | undefined)?.v; } finally { check.close(); }
    };
    const read = <T,>(sql: string, ...args: string[]): T | undefined => {
      const check = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
      try { return check.prepare(sql).get(...args) as T | undefined; } finally { check.close(); }
    };
    const watchCards = (runId: string) => read<{ n: number }>("SELECT count(*) AS n FROM messages WHERE thread_id=? AND kind='routine.run' AND json_extract(json,'$.routineRun.runId')=?", bot.threadId, runId)!.n;
    const freshStart = () => read<{ cursors_applied: number; state: string }>("SELECT cursors_applied, state FROM gh18_operations WHERE operation_id='op-fixture'");
    const hold = () => read<{ state: string; revision: number; result: string | null }>("SELECT state, revision, result FROM own_write_holds WHERE hold_id='hold-fixture'");
    /** One assertion per class: each recovery input is exactly as seeded. */
    const untouched = (when: string) => {
      remaining.untouched();
      expect(existsSync(queueFile), `${when}: the legacy queue file is left alone`).toBe(true);
      expect(stateOf("venue_posts", "vp-fixture"), `${when}: the cut-short venue post is left alone`).toBe("posting");
      expect(stateOf("owner_sends", "queue-fixture", "status"), `${when}: the cut-short owner send is left alone`).toBe("sending");
      expect([watchCards("run-watch-changed"), watchCards("run-watch-failed")], `${when}: the two file-watch runs have no card yet`).toEqual([0, 0]);
      expect(freshStart(), `${when}: the fresh-start operation's cursor save is still pending`).toEqual({ cursors_applied: 0, state: "applying" });
      expect(hold(), `${when}: the own-write hold cut short is still applying`).toEqual({ state: "applying", revision: 1, result: null });
    };
    return { queueFile, stateOf, untouched, watchCards, freshStart, hold, settled: remaining.settled, recovered: remaining.ready };
  }

  it("A3 a read-only start is an ordinary start to the shell", { timeout: 300_000 }, async () => {
    const port = await freePortBlock([0, 1], 19_931, 200);
    const nonce = "a3-fixture-nonce";
    const staticDir = join(STRICT, "a3-static");
    try {
      const { home, ballast } = await fixture("a3", port);
      mkdirSync(staticDir, { recursive: true }); writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>fixture</title>");
      fillTo(ballast, 100 * MiB);
      const run = begin(home, port, { MURAGE_BOOT_NONCE: nonce, MURAGE_STATIC_DIR: staticDir });
      const verdict = await pollServerIdentity({ port, nonce: () => nonce, bootTimeoutMs: 60_000, isExited: () => run.exited() !== undefined });
      expect(verdict.outcome, run.out().slice(-4000)).toBe("ready");
      expect((await health(port)).diskLow?.mode).toBe("read-only");
      expect(launchOf(nonce)).toHaveLength(64);
    } finally { rmSync(staticDir, { recursive: true, force: true }); }
  });

  it("A4 writes return only through a fresh start", { timeout: 300_000 }, async () => {
    const port = await freePortBlock([0, 1], 19_951, 200);
    const { home, data, ballast } = await fixture("a4", port);
    const { queueFile, stateOf, untouched, watchCards, freshStart, hold, settled, recovered } = seedRecoveries(data);
    fillTo(ballast, 100 * MiB);
    const run = begin(home, port);
    expect(await healthOk(port, run), run.out().slice(-4000)).toBe(true);
    expect((await health(port)).diskLow?.mode).toBe("read-only");
    untouched("the read-only start");

    rmSync(ballast, { force: true });
    expect(freeBytes()).toBeGreaterThan(200 * MiB);
    const headers = await desktopHeaders(port);
    const refused = await fetch(`http://127.0.0.1:${port}/api/bots`, { method: "POST", headers, body: JSON.stringify({ name: "Refused" }) });
    expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 503, body: { error: OWNER_COPY, code: "DATABASE_BUSY", reason: "read-only-start", retryable: false } });
    expect((await health(port)).diskLow?.mode, "the mode does not change when space returns").toBe("read-only");
    await waitForExit(run.child, { signal: "SIGTERM" });

    const again = begin(home, port);
    expect(await healthOk(port, again), again.out().slice(-4000)).toBe(true);
    expect((await health(port)).diskLow).toBeUndefined();
    const created = await fetch(`http://127.0.0.1:${port}/api/bots`, { method: "POST", headers: await desktopHeaders(port), body: JSON.stringify({ name: "Fixture Three" }) });
    expect(created.status).toBe(201);
    expect(existsSync(queueFile), "class: the legacy queue file is settled by the fresh start").toBe(false);
    expect(stateOf("venue_posts", "vp-fixture"), "class: the cut-short venue post is settled by the fresh start").toBe("held");
    expect(stateOf("owner_sends", "queue-fixture", "status"), "class: the cut-short owner send is settled by the fresh start").not.toBe("sending");
    expect([watchCards("run-watch-changed"), watchCards("run-watch-failed")], "class: each file-watch run gets its one card from the fresh start").toEqual([1, 1]);
    expect(freshStart(), "class: the fresh-start operation's cursors are settled by the fresh start").toEqual({ cursors_applied: 1, state: "done" });
    expect(hold(), "class: the own-write hold cut short is settled by the fresh start as unknown after a restart").toEqual({ state: "unknown", revision: 2, result: "restart" });
    // These two recoveries run after the first health answer; wait for their rows, then assert every class once.
    for (let i=0; i<100 && !recovered(); i++) await new Promise(resolve=>setTimeout(resolve,100));
    settled();
    expect(await botsOf(port), "class: bots survive").toEqual(expect.arrayContaining(["Fixture One", "Fixture Two", "Fixture Three"]));
  });

  it("A5 a read-only start with the required index missing writes nothing", { timeout: 300_000 }, async () => {
    const port = await freePortBlock([0, 1], 19_971, 200);
    const { home, data, ballast } = await fixture("a5", port);
    const { untouched } = seedRecoveries(data);
    const db = new DatabaseSync(join(data, "messages.db")); db.exec("DROP INDEX messages_turn; PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
    fillTo(ballast, 100 * MiB);
    const before = snapshot(data);
    const run = begin(home, port);
    expect(await waitExited(run), run.out().slice(-4000)).toBe(true);
    expect(run.exited()).not.toBe(0);
    expect(run.out()).toContain("TurnIndexNotReadyError");
    expect(run.out()).toContain("[startup] read-only start: required index missing");
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
    const after = snapshot(data);
    expect(after).toEqual(before);
    untouched("the start that stopped before listen");
    const check = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
    expect(check.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages_turn'").get()).toBeUndefined(); check.close();

    rmSync(ballast, { force: true });
    const again = begin(home, port);
    expect(await healthOk(port, again), again.out().slice(-4000)).toBe(true);
    await waitForExit(again.child, { signal: "SIGTERM" });
    const ok = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
    expect(ok.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages_turn'").get()).toBeDefined();
    expect(ok.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" }); ok.close();
  });

  it("A5b a read-only start with another pre-listen index missing runs no upgrade heartbeat", { timeout: 300_000 }, async () => {
    const port = await freePortBlock([0, 1], 19_981, 200);
    const { home, data, ballast } = await fixture("a5b", port);
    // the turn index is present; a different pre-listen index is missing, so the start finds something it would build in a normal start
    const { untouched } = seedRecoveries(data);
    const db = new DatabaseSync(join(data, "messages.db")); db.exec("DROP INDEX memory_revoke_jobs_state_kind_phase; PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
    fillTo(ballast, 100 * MiB);
    const before = snapshot(data);
    const run = begin(home, port);
    expect(await healthOk(port, run), run.out().slice(-4000)).toBe(true);
    expect((await health(port)).diskLow?.mode).toBe("read-only");
    await new Promise(resolve => setTimeout(resolve, 7000));   // the heartbeat of a build rewrites its note every two seconds
    await waitForExit(run.child, { signal: "SIGTERM" });
    expect(snapshot(data), "no heartbeat note and no index: nothing written").toEqual(before);
    untouched("the read-only start");
    const check = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
    expect(check.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_revoke_jobs_state_kind_phase'").get()).toBeUndefined(); check.close();
  });

  it("B2 the disk fills during the open path's index build", { timeout: 900_000 }, async () => {
    const port = await freePortBlock([0, 1], 19_991, 200);
    const { home, data, ballast } = await fixture("b2", port);
    // one more ordinary start and stop, so the boot-time files are in their steady state before the first snapshot
    const warm = begin(home, port); expect(await healthOk(port, warm), warm.out().slice(-4000)).toBe(true); await waitForExit(warm.child, { signal: "SIGTERM" });
    const { untouched } = seedRecoveries(data);
    const rows = 1_500_000;
    const db = new DatabaseSync(join(data, "messages.db"));
    db.exec("DROP INDEX messages_turn");
    // The rows are loaded raw, in commits of 100k so the log stays small: the write triggers (search and summary side tables) are set aside for the load and put back
    // exactly as they were, so the file is the file of a long history whose side tables a later pass fills, and 1.5 M rows fit the 1 GiB filesystem.
    console.log(`[B2] free before load=${(freeBytes() / MiB).toFixed(1)} MiB`);
    const triggers = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='messages'").all() as Array<{ name: string; sql: string }>);
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
    for (let low = 1; low <= rows; low += 100_000) {
      db.exec(`INSERT INTO messages(thread_id,id,at,role,kind,text,json)
        WITH RECURSIVE n(i) AS (SELECT ${low} UNION ALL SELECT i+1 FROM n WHERE i<${Math.min(rows, low + 99_999)})
        SELECT printf('thread-%032d', i % 5000), printf('msg-%032d', i), i, 'user', 'text', 'x', json_object('turnId', printf('turn-%090d', i)) FROM n`);
      console.log(`[B2] loaded to ${Math.min(rows, low + 99_999)} free=${(freeBytes() / MiB).toFixed(1)} MiB`);
    }
    for (const trigger of triggers) db.exec(trigger.sql);
    // the build's size, measured on this data: build, count the pages it added, drop it and give the pages back
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const pages = () => Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count) * Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
    const withoutIndex = pages();
    db.exec("CREATE INDEX messages_turn ON messages(thread_id, json_extract(json,'$.turnId')) WHERE json_valid(json)");
    const indexBytes = pages() - withoutIndex;
    db.exec("DROP INDEX messages_turn; PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
    console.log(`[B2] rows=${rows} index bytes=${indexBytes} (${(indexBytes / MiB).toFixed(1)} MiB) free after fixture=${(freeBytes() / MiB).toFixed(1)} MiB`);
    // above the start floor (128 MiB), below what the build needs
    fillTo(ballast, 134 * MiB);
    expect(indexBytes, "sizing: the build must need more than the free space left").toBeGreaterThan(freeBytes() + 2 * MiB);
    const before = snapshot(data);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const run = begin(home, port);
      expect(await waitExited(run, 180_000), `start ${attempt}: ${run.out().slice(-4000)}`).toBe(true);
      expect(run.exited()).not.toBe(0);
      expect(run.out()).not.toContain("[startup] read-only start");
      expect(run.out()).toContain("[startup] low disk during start");
      expect(run.out(), "the failure is the index build's").toMatch(/\[turn-index\] index build ms=\d+ ok=0/);
      await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
      expect(snapshot(data), `start ${attempt}`).toEqual(before);
      untouched(`start ${attempt}`);
    }
  });
});

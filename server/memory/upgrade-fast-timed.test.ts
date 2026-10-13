// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The timed upgrade: a synthetic 1.0.1 history (memory v6) of any size is opened by a child process that behaves like the server's start
// (testing/upgrade-fast-child.ts), and the parent measures what a person and a launcher would see:
//   - the port answers /api/health within a second of the upgrade starting (503 with progress, from the pre-listen responder), and never
//     answers with anything but our own pid;
//   - the port is handed to the server and answers 200 inside a budget that scales with the size of the file;
//   - the start-up note's `updatedAt` never goes stale for more than 3 seconds while the server thread is blocked;
//   - replay of earlier outputs is withheld until the background work finishes, which it does, and the fields the screen reads are there.
// Size: UPGFAST_THREADS x UPGFAST_PER_THREAD messages of UPGFAST_PAYLOAD bytes (defaults make a file of a few MB; the qualification run
// uses several GB). The timings are printed as one JSON line, UPGFAST_RESULT.
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildSyntheticV6 } from "./testing/upgrade-fast-fixture.ts";

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const freePort = () => new Promise<number>(resolve => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const get = async (port: number, path: string): Promise<{ status: number; body: Record<string, any> } | null> => {
  try { const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2_000) }); return { status: res.status, body: await res.json() as Record<string, any> }; } catch { return null; }
};
const TIMED_MS = 3_600_000;

it("a heavy v6 history is usable within the budget, with a health answer from the first second and a note that never goes stale", { timeout: TIMED_MS }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-upgfast-"));
  try {
    const threads = env("UPGFAST_THREADS", 300), perThread = env("UPGFAST_PER_THREAD", 40), payload = env("UPGFAST_PAYLOAD", 400);
    const built = buildSyntheticV6(join(dir, "messages.db"), {
      threads, perThread, payloadBytes: payload, receiptsPerThread: env("UPGFAST_RECEIPTS", 4),
      setThreads: Math.min(threads, env("UPGFAST_SET_THREADS", 6)), repliesPerSetThread: env("UPGFAST_SET_REPLIES", 12), batch: env("UPGFAST_BATCH", 500),
    });
    const gigabytes = statSync(join(dir, "messages.db")).size / 1e9;
    const port = await freePort();
    const spawnedAt = performance.now();
    const child = spawn(process.execPath, [join(import.meta.dirname, "testing", "upgrade-fast-child.ts")], {
      env: { ...process.env, MURAGE_DATA_DIR: dir, PORT: String(port), HOME: dir, MURAGE_TURN_TRACE: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const events: Array<{ event: string; ms: number; at: number }> = [];
    let buffer = "";
    const marks: Record<string, number> = {};
    child.stdout.on("data", chunk => { buffer += String(chunk); for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) { const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); const mark = /phase=startup\.(\S+) ms=(\d+)/.exec(line); if (mark) marks[mark[1]!] = Number(mark[2]); try { events.push({ ...JSON.parse(line), at: performance.now() }); } catch { /* not ours */ } } });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
    const at = (event: string) => events.find(item => item.event === event)?.at;

    let firstAnswerAt: number | null = null, first503At: number | null = null, t200: number | null = null, maxStale = 0, notes = 0, saw503Progress: Record<string, any> | null = null;
    const overalls: number[] = [];
    const phaseDoneMs: Record<string, number> = {}; let finalRates: Record<string, number> = {};
    let releasedAt: number | null = null, withheldWhilePending = true, sawPending = false, backgroundMs: number | null = null, lastPending: Record<string, any> | null = null;
    const budgetMs = Math.max(20_000, 120_000 * Math.min(1, gigabytes / 48));
    const deadline = performance.now() + TIMED_MS - 60_000;
    for (let tick = 0; performance.now() < deadline; tick++) {
      const answer = await get(port, "/api/health");
      const now = performance.now();
      if (answer && firstAnswerAt === null) firstAnswerAt = now;
      if (answer?.status === 503) {
        first503At ??= now;
        expect(answer.body.app).toBe("murage"); expect(answer.body.pid).toBe(child.pid); expect(answer.body.upgrading).toBe(true);
        // the launch identity is a hash of the nonce, never the nonce
        expect(answer.body.launch).toMatch(/^[0-9a-f]{64}$/); expect(answer.body.nonce).toBeUndefined();
        if (typeof answer.body.overall === "number") overalls.push(answer.body.overall);
        if (answer.body.phaseId) saw503Progress = answer.body;
      }
      if (answer?.status === 200) {
        t200 ??= now;
        const integrity = answer.body.memoryIntegrity;
        expect(answer.body.launch).toMatch(/^[0-9a-f]{64}$/);
        if (typeof integrity.overall === "number") overalls.push(integrity.overall);
        for (const phase of integrity.progress?.phases ?? []) if (phase.state === "done" && phaseDoneMs[phase.id] === undefined) phaseDoneMs[phase.id] = Math.round(now - t200!);
        if (integrity.progress?.rates) finalRates = integrity.progress.rates;
        if (integrity.replayHeld) {
          sawPending = true; lastPending = integrity;
          // while the integrity pass has not finished, no conversation's earlier outputs are replayed
          if (integrity.integrityPending) {
            const probe = await get(port, "/probe/withheld?thread=t0");
            if (probe && !probe.body.withheld) withheldWhilePending = false;
          }
          if (releasedAt !== null) withheldWhilePending = false; // once released it must stay released
        } else if (integrity.pending) {
          releasedAt ??= now;
        } else if (sawPending || at("background-done")) {
          // finished: replay is released
          const probe = await get(port, "/probe/withheld?thread=t0");
          expect(probe?.body.withheld).toBe(false);
          backgroundMs = now - t200;
          break;
        }
      }
      // the start-up note: how long since it was last rewritten
      try {
        const note = JSON.parse(readFileSync(join(dir, "memory-upgrade-status.json"), "utf8"));
        notes++; maxStale = Math.max(maxStale, Date.now() - note.updatedAt);
      } catch { /* absent before and after the upgrade */ }
      if (child.exitCode !== null) throw new Error(`child exited ${child.exitCode}: ${stderr.slice(-2000)}`);
      await sleep(150);
    }
    await get(port, "/exit"); await sleep(1_000); child.kill();
    // An ordinary start on the already upgraded file: the same child again. Nothing is left to upgrade, so nothing blocks and nothing is pending.
    const port2 = await freePort(), spawned2 = performance.now();
    const second = spawn(process.execPath, [join(import.meta.dirname, "testing", "upgrade-fast-child.ts")], { env: { ...process.env, MURAGE_DATA_DIR: dir, PORT: String(port2), HOME: dir, MURAGE_TURN_TRACE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let secondOpenMs: number | null = null; let secondOut = "";
    second.stdout.on("data", chunk => { secondOut += String(chunk); const m = /"event":"database-open","ms":(\d+)/.exec(secondOut); if (m) secondOpenMs = Number(m[1]); });
    let secondAnswer: Record<string, any> | null = null, secondAt: number | null = null;
    for (let tries = 0; tries < 600 && secondAt === null; tries++) { const a2 = await get(port2, "/api/health"); if (a2?.status === 200) { secondAt = performance.now(); secondAnswer = a2.body; } else await sleep(100); }
    await get(port2, "/exit"); await sleep(500); second.kill();
    const ordinary = { listenMs: secondAt === null ? null : Math.round(secondAt - spawned2), databaseOpenMs: secondOpenMs };
    const startAt = at("start")!, blockingMs = (at("database-open")! - at("start")!);
    const result = {
      messages: built.messages, receipts: built.receipts, memberRows: built.memberRows, fileGB: Number(gigabytes.toFixed(3)),
      blockingMs: Math.round(blockingMs), healthFirstMs: Math.round((firstAnswerAt ?? NaN) - startAt), first503Ms: first503At === null ? null : Math.round(first503At - startAt),
      t200Ms: Math.round((t200 ?? NaN) - spawnedAt), budgetMs: Math.round(budgetMs), maxNoteStaleMs: maxStale, ordinaryStart: ordinary, phaseDoneMs, rates: finalRates, notesSeen: notes, dropIndexMs: marks["migrate.dropIndex.end"] !== undefined ? marks["migrate.dropIndex.end"]! - marks["migrate.dropIndex.begin"]! : null, commitMs: marks["migrate.commit.end"] !== undefined ? marks["migrate.commit.end"]! - marks["migrate.commit.begin"]! : null, migrateMs: marks["migrate.commit.end"] !== undefined ? marks["migrate.commit.end"]! - marks["migrate.begin"]! : null, backgroundMs: backgroundMs === null ? null : Math.round(backgroundMs),
    };
    console.log(`UPGFAST_RESULT ${JSON.stringify(result)}`);
    expect(firstAnswerAt, "something answered on the port").not.toBeNull();
    expect(firstAnswerAt! - startAt, "health within a second of the upgrade starting").toBeLessThan(1_000);
    expect(t200, "the server answered 200").not.toBeNull();
    expect(t200! - spawnedAt, "200 within the budget").toBeLessThan(budgetMs);
    expect(maxStale, "the note never stale for more than 3 s").toBeLessThanOrEqual(3_000);
    expect(backgroundMs, "the background work finished").not.toBeNull();
    expect(withheldWhilePending, "replay withheld at every look while the work was pending").toBe(true);
    if (saw503Progress) {
      expect(saw503Progress).toMatchObject({ stage: "starting", keepOpen: true });
      expect(saw503Progress.counts).toMatchObject({ exact: true, messages: built.messages, receipts: built.receipts });
      const checking = saw503Progress.phases.find((phase: { id: string }) => phase.id === "checking");
      // the checking phase reports no count (the old estimate of messages read was not exact); the exact totals are the counts above
      expect(checking).toBeDefined();
      expect(checking.unit).not.toBe("messages");
      if (saw503Progress.upgrade) expect(saw503Progress.upgrade).toMatchObject({ v: 2, stage: "starting", step: { unit: "none" } });
      expect(saw503Progress.overall).toBeLessThanOrEqual(0.2);
      expect(typeof saw503Progress.fraction).toBe("number");
      expect(saw503Progress.phases.length).toBeGreaterThan(0);
    }
    expect(overalls.length).toBeGreaterThan(0);
    expect(overalls.every((value, i) => i === 0 || value >= overalls[i - 1]!), "one launch-wide overall value, never backwards").toBe(true);
    expect(marks["migrate.dropIndex.begin"], "the upgrade drops no index").toBeUndefined();
    expect(secondAt, "the second start answered 200").not.toBeNull();
    expect(secondAnswer!.memoryIntegrity.pending, "nothing is left to do on the second start").toBe(false);
    expect(secondOpenMs!, "the second start opens the database in seconds, reading no shaped column in full").toBeLessThan(5_000);
    if (lastPending) expect(lastPending.progress).toMatchObject({ stage: "background" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

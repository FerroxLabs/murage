// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The upgrade backfill (U1 + U2, lineage-backfill.ts) scales with the history, never with its square: a 1.0.1 file keeps one root-set
// chain per thread, each reply's set the one before it plus a few roots, so a walk that re-reads the chain per reply (or per slice)
// costs the chain length every time. The rate (lines per second) on a history 5x larger stays within 2x of the smaller one.
// WRITETIME_PROFILE=1 prints the functions that took the most time on the larger history.
import { mkdirSync } from "node:fs";
import { Session } from "node:inspector";
import { expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { lineageBackfillSlice, lineageCertProgress, resetLineageBackfillForTest } from "./lineage-backfill.ts";
import { buildLegacyHistory, markUpgraded } from "./testing/legacy-history-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }

function post<T>(session: Session, method: string, params?: object): Promise<T> {
  return new Promise((resolve, reject) => session.post(method, params ?? {}, (error, result) => error ? reject(error) : resolve(result as T)));
}

async function backfillRate(lines: number, longThread: number, profile: boolean): Promise<{ messages: number; seconds: number; rate: number }> {
  closeDatabase(); resetLineageBackfillForTest();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const db = database();
  buildLegacyHistory(db, { seed: 7, threads: 12, lines, longThread });
  const messages = Number(db.prepare("SELECT count(*) AS n FROM messages").get()!.n);
  markUpgraded(db);
  const session = profile ? new Session() : null;
  if (session) { session.connect(); await post(session, "Profiler.enable"); await post(session, "Profiler.start"); }
  const started = performance.now();
  for (let slices = 0; lineageBackfillSlice(db, { budgetMs: 500 }).more; slices++) if (slices > 1_000_000) throw new Error("backfill without end");
  const seconds = (performance.now() - started) / 1000;
  if (session) {
    const { profile: result } = await post<{ profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] } }>(session, "Profiler.stop");
    session.disconnect();
    const self = new Map<number, number>();
    result.samples.forEach((id, index) => self.set(id, (self.get(id) ?? 0) + (result.timeDeltas[index] ?? 0)));
    const byFunction = new Map<string, number>();
    for (const node of result.nodes) {
      const key = `${node.callFrame.functionName || "(anonymous)"} ${node.callFrame.url.split("/").slice(-1)[0]}:${node.callFrame.lineNumber + 1}`;
      byFunction.set(key, (byFunction.get(key) ?? 0) + (self.get(node.id) ?? 0));
    }
    const top = [...byFunction].sort((a, b) => b[1] - a[1]).slice(0, 25);
    console.log(`BACKFILL-PROFILE self ms\n${top.map(([name, us]) => `${(us / 1000).toFixed(0).padStart(8)} ${name}`).join("\n")}`);
  }
  expect(lineageCertProgress(db).ready).toBe(true);
  return { messages, seconds, rate: messages / seconds };
}

it("the backfill rate on a history 5x larger stays within 2x of the smaller one (no per-reply walk of a root-set chain)", async () => {
  const small = await backfillRate(1_000, 4_000, false);
  const large = await backfillRate(5_000, 20_000, process.env.WRITETIME_PROFILE === "1");
  console.log(`BACKFILL-SCALE small ${small.messages} messages ${small.seconds.toFixed(1)} s (${small.rate.toFixed(0)}/s), large ${large.messages} messages ${large.seconds.toFixed(1)} s (${large.rate.toFixed(0)}/s)`);
  expect(large.rate).toBeGreaterThan(small.rate / 2);
}, 1_800_000);

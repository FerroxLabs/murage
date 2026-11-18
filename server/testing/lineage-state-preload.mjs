// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-process-only preload for server/testing/index-harness.ts. The fixture-turn harness must not send a turn while the memory send fence
// would still refuse it ("checking"/"pending" lineage on a slow machine), and that state lives only in this process. This file READS it:
// every 25 ms it looks up the threads the harness listed in <dir>/threads.json and writes <dir>/lineage-state.json when the request or a state changes
// (history in <dir>/lineage-history.jsonl). The timer is unref-ed. Nothing is imported until the server has opened its own database
// (MURAGE_TEST_LINEAGE_STATE_DB exists AND the handle is open), so module init order and the first database open are the server's own, and the
// dynamic imports then resolve to the instances index.ts already loaded. Production never loads this file; only the harness passes it.
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";

const dir = process.env.MURAGE_TEST_LINEAGE_STATE_DIR;
const dbFile = process.env.MURAGE_TEST_LINEAGE_STATE_DB;

if (isMainThread && dir && dbFile) {
  const here = new URL(".", import.meta.url);
  let api = null;
  let loading = false;
  let wantMtime = 0;
  let threads = [];
  let revision = 0;
  const last = new Map();
  let seq = 0;
  const states = {};
  const tick = () => {
    try {
      if (!api) {
        if (loading || !existsSync(dbFile)) return;
        loading = true;
        Promise.all([import(new URL("../database.ts", here).href), import(new URL("../memory/lineage-warm.ts", here).href)])
          .then(([database, warm]) => { api = { stamp: database.databaseSharedRowsStamp, state: warm.lineageThreadState }; })
          .catch(() => { loading = false; });
        return;
      }
      if (api.stamp() === undefined) return;
      let changed = false;
      const want = join(dir, "threads.json");
      if (existsSync(want)) {
        const m = statSync(want).mtimeMs;
        if (m !== wantMtime) {
          const request = JSON.parse(readFileSync(want, "utf8"));
          threads = request.threads;
          revision = request.revision;
          wantMtime = m;
          changed = true;
          const active = new Set(threads);
          for (const thread of last.keys()) if (!active.has(thread)) { last.delete(thread); delete states[thread]; }
        }
      }
      for (const thread of threads) {
        let state;
        try { state = api.state(thread); } catch (error) { state = `error: ${String(error?.message ?? error).slice(0, 60)}`; }
        if (last.get(thread) !== state) {
          last.set(thread, state); changed = true; seq++;
          states[thread] = { state, seq, at: Date.now() };
          appendFileSync(join(dir, "lineage-history.jsonl"), `${JSON.stringify({ thread, state, at: Date.now() })}\n`);
        }
      }
      if (changed) {
        writeFileSync(join(dir, "lineage-state.tmp"), JSON.stringify({ revision, states, at: Date.now() }));
        renameSync(join(dir, "lineage-state.tmp"), join(dir, "lineage-state.json"));
      }
    } catch { /* a read failure must never reach the server */ }
  };
  setInterval(tick, 25).unref();
}

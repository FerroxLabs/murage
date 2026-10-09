// Root-set storage benchmark (1.0.2). Off by default: RS_BENCH=1
// runs it (RS_THREADS, RS_REPLIES="250,500,..."). Prints one BENCH line per
// size: rows, megabytes, the upgrade, a turn's lineage check and a replay
// filter over the last 200 replies. Runs unchanged on 1.0.1 (v6) for the
// "before" column, and on 1.0.2 adds the v6 -> v7 conversion.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { outputRootsFor, recordOutputRoots, replayExclusions } from "./replay-lineage.ts";
import { downgradeMemorySchema, migrateMemorySchema, MEMORY_SCHEMA_VERSION } from "./schema.ts";
import { fixtureReply, fixtureThread, longThreadsV5 } from "./testing/root-set-fixture.ts";

const enabled = Boolean(process.env.RS_BENCH);
const THREADS = Number(process.env.RS_THREADS ?? 20);
const SIZES = (process.env.RS_REPLIES ?? "250,500,1000,1500").split(",").map(Number);
const ms = (start: number) => Math.round((performance.now() - start) * 10) / 10;
const rows = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) AS n FROM memory_root_set_members").get()?.n);
function compactMb(db: DatabaseSync, dir: string): number {
  const target = join(dir, `size-${Date.now()}.db`);
  db.prepare("VACUUM INTO ?").run(target);
  const bytes = statSync(target).size; rmSync(target, { force: true });
  return Math.round(bytes / 1048576 * 10) / 10;
}
function lineageMb(db: DatabaseSync): number | null {
  try { return Math.round(Number(db.prepare("SELECT sum(pgsize) AS b FROM dbstat WHERE name IN ('memory_root_set_members','memory_root_set_members_root','memory_root_sets','memory_root_set_parents')").get()?.b ?? 0) / 1048576 * 10) / 10; }
  catch { return null; }
}

it.skipIf(!enabled)("root-set storage benchmark", async () => {
  for (const replies of SIZES) {
    closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "murage-rsbench-"));
    try {
      const fixture = await longThreadsV5(join(dir, "v5.db"), THREADS, replies);
      const live = join(DATA_DIR, "messages.db");
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${live}${suffix}`)) rmSync(`${live}${suffix}`);
      copyFileSync(fixture, live);
      let start = performance.now();
      const db = database();
      const upgradeMs = ms(start);
      db.exec("PRAGMA synchronous=OFF");
      const out: Record<string, unknown> = { schema: MEMORY_SCHEMA_VERSION, threads: THREADS, replies, upgradeMs,
        sets: Number(db.prepare("SELECT count(*) AS n FROM memory_root_sets").get()?.n), memberRows: rows(db), lineageMb: lineageMb(db), dbMb: compactMb(db, dir) };
      // a turn's lineage: the roots of what its context carries, then the reply's set
      const thread = fixtureThread(0);
      let last = fixtureReply(0, replies - 1);
      const turns: number[] = [];
      for (let turn = 0; turn < 10; turn++) {
        const id = `turn-${turn}`;
        db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,'text',?,?)").run(thread, id, 100000 + turn, "bot", "next", JSON.stringify({ id, at: 100000 + turn, role: "bot", kind: "text", text: "next" }));
        start = performance.now();
        recordOutputRoots(thread, id, outputRootsFor([{ threadId: thread, id: last, role: "bot" }]));
        turns.push(ms(start));
        last = id;
      }
      out.turnLineageMs = Math.round(turns.reduce((a, b) => a + b, 0) / turns.length * 10) / 10;
      const window = Array.from({ length: Math.min(200, replies) }, (_, index) => ({ id: fixtureReply(0, replies - 1 - index), role: "bot" }));
      start = performance.now();
      expect(replayExclusions(thread, window, null, { failClosed: true }).size).toBe(0);
      out.replayFilterMs = ms(start);
      closeDatabase();
      // 1.0.2 only: an install already on v6 (full sets) upgrading, then converting
      const module = join(import.meta.dirname, "root-set-compaction.ts");
      const compaction: typeof import("./root-set-compaction.ts") | null = existsSync(module) ? await import(/* @vite-ignore */ module) : null;
      if (compaction && MEMORY_SCHEMA_VERSION >= 7) {
        const raw = new DatabaseSync(live);
        try {
          raw.exec("PRAGMA synchronous=OFF");
          start = performance.now(); downgradeMemorySchema(raw, 6); out.v6WriteOutMs = ms(start);
          out.v6MemberRows = rows(raw); out.v6DbMb = compactMb(raw, dir);
          start = performance.now(); migrateMemorySchema(raw); out.v6toV7UpgradeMs = ms(start);
          start = performance.now();
          let slices = 0, longest = 0;
          for (;;) { const at = performance.now(); const step = compaction.compactRootSetsStep(raw, { maxMs: 120 }); slices++; longest = Math.max(longest, performance.now() - at); if (!step.remaining) break; }
          out.conversionMs = ms(start); out.conversionSlices = slices; out.longestSliceMs = Math.round(longest);
          out.convertedMemberRows = rows(raw);
          start = performance.now(); raw.exec("VACUUM"); out.vacuumMs = ms(start);
          out.convertedDbMb = Math.round(statSync(live).size / 1048576 * 10) / 10;
        } finally { raw.close(); }
      }
      console.log(`BENCH ${JSON.stringify(out)}`);
    } finally { closeDatabase(); rmSync(dir, { recursive: true, force: true }); }
  }
}, 4 * 3600_000);

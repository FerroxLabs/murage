import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { validateCorpus, requireMeasuredHit } from "../server/memory/testing/contracts.ts";

const argv = process.argv.slice(2);
function arg(name: string, fallback: string) { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; }
function bounded(name: string, fallback: string, maximum: number) {
  const n = Number(arg(name, fallback));
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new Error(`invalid ${name}`);
  return n;
}
function percentile(values: number[], fraction: number) { const sorted = [...values].sort((a,b) => a-b); return sorted[Math.ceil(sorted.length * fraction) - 1]; }

async function main() {
  const raw = readFileSync(resolve(arg("--fixture", "server/memory/testing/corpus.json")), "utf8");
  const corpus = validateCorpus(JSON.parse(raw));
  const history = bounded("--history-records", "100000", 100000);
  const active = bounded("--active-chunks", "10000", 10000);
  const concurrency = bounded("--concurrency", "8", 8);
  const dir = mkdtempSync(join(tmpdir(), "murage-memory-baseline-"));
  process.env.MURAGE_DATA_DIR = dir;
  // Dynamic import occurs only AFTER isolated profile selection.
  const mdb = await import("../server/message-db.ts");
  const workspace = await import("../server/workspace.ts");
  try {
    mdb.searchMessages("initialise fixture");
    const db = new DatabaseSync(join(dir, "messages.db"));
    try {
      const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
      db.exec("BEGIN IMMEDIATE");
      for (let i = 0; i < history; i++) {
        const source = corpus.sources[(i % 40) * 3];
        const message = {id: `baseline-${i}`, at: i, role: "user", kind: "text", text: source.text};
        insert.run(source.threadId, message.id, i, message.role, message.kind, message.text, JSON.stringify(message));
      }
      db.exec("COMMIT");
    } finally { db.close(); }
    workspace.writeMemoryFile("baseline", Array.from({length: active}, (_, i) => corpus.sources[(i % 40) * 3].text).join("\n"));
    const expected = `baseline-${Math.floor((history - 1) / 40) * 40}`;
    const latencies: number[] = [];
    let calls = 0;
    for (let batch = 0; batch < 20; batch++) {
      await Promise.all(Array.from({length: concurrency}, async () => {
        const before = performance.now();
        const hits = mdb.searchMessages("reviewers", 40, "thread-00");
        requireMeasuredHit({backend: "private.7-sqlite-LIKE", visited: history, ids: hits.map(h => h.messageId)}, expected);
        const notebook = workspace.loadMemory("baseline");
        if (!notebook?.text.includes("reviewers")) throw new Error("notebook fixture did not load");
        latencies.push(performance.now() - before); calls++;
      }));
    }
    const result = {version: 1, phase: "P00-baseline", backend: "actual-private.7-message-db-LIKE-and-loadMemory", calls,
      historyRecords: history, notebookLines: active, requestedConcurrentCalls: concurrency,
      execution: "current synchronous baseline; no new service/semantic quality claim", fixtureHash: createHash("sha256").update(raw).digest("hex"),
      node: process.version, platform: process.platform, arch: process.arch,
      latencyMs: {p95: percentile(latencies, .95), p99: percentile(latencies, .99)}, rssBytes: process.memoryUsage().rss};
    const out = resolve(arg("--out", ".planning/memory-evidence/bench.json"));
    mkdirSync(dirname(out), {recursive: true}); writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } finally { mdb.closeMessageDb(); rmSync(dir, {recursive: true, force: true}); }
}
if(arg("--backend","memory")==="baseline") {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
} else {
  await import("./bench-memory-service.ts");
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs each fault in a private source copy. Production sources and retained evidence are never rewritten.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
const source = process.cwd(), out = join(source, "s4-B-mutants"); mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "murage-bounded-mutants-"));
const journal = "server/routine-runs-journal.ts", probe = "server/testing/collection-work-probe.ts", privateFields = "server/turn-dispatch-guard.ts";
const bounds = "server/routine-journal-bounds.test.ts", crash = "server/routine-journal-crash.test.ts", probes = "server/testing/collection-work-probe.test.ts";
const replace = (text, from, to) => { if (!text.includes(from)) throw new Error(`Mutant anchor missing: ${from}`); return text.replace(from, to); };
const baseline = () => readFileSync(join(source, "s4-B-baseline-journal.txt"), "utf8");
const cases = [
  ["RED-ESTABLISHED-C9A", journal, baseline, bounds, "established mixed run/state baseline", "short-write established recovery publication"],
  ["RED-LEGACY-C9B-MISSING", journal, baseline, bounds, "legacy undefined pins", "legacy marker exact projection"],
  ["RED-LEGACY-C9B-INVALID", journal, baseline, bounds, "legacy invalid pins", "legacy marker exact projection"],
  ["RED-LEGACY-FIRST-TAG", journal, baseline, crash, "first-new-tag observer", "first-tag durable marker barrier"],
  ["RED-SHORT-APPEND", journal, baseline, bounds, "append: short successful", "short-write raw replay"],
  ["RED-SHORT-SYNC", journal, baseline, bounds, "sync: short successful", "short-write raw replay"],
  ["RED-FIRSTFILE", journal, baseline, bounds, "first-file failure", "registered before open"],
  ["RED-COMPACT-SCAN", journal, baseline, bounds, "compaction never traverses", "global history visits"],
  ["M-JOURNAL-COMPACT-SCAN", journal, s => replace(s, "    const file = this.file(name);\n    if (!this.safeToCompact", "    for (const value of this.persisted.values()) void value;\n    const file = this.file(name);\n    if (!this.safeToCompact"), bounds, "P3 compaction never", "global history visits"],
  ["M-COMPACT-WHOLE", journal, s => replace(s, "const COPY_SLICE = 64", "const COPY_SLICE = 1_000_000"), crash, "P3 each of 200", "less than or equal to 64"],
  ["M-UNCERTAIN", journal, s => replace(replace(s, "this.uncertainTargets.set(id, uncertain);", "// omitted attempted-target invalidation"), "if (value) this.setPersisted(id, { routineId: value.routineId, line: UNCERTAIN });", "// omitted comparison invalidation"), crash, "P18 fsync reconciliation raw", "raw reconciliation pre-state/no resurrection"],
  ["M-APPEND-NOTOMBSTONE", journal, s => replace(s, "return this.persist(input.runs, input.routines, input.removed);", "return this.persist(input.runs, input.routines, []);"), crash, "P18 fsync reconciliation raw", "raw reconciliation pre-state/no resurrection"],
  ["M-TORN", journal, s => replace(s, "file.clean = false; file.linesKnown = false;", "file.clean = true; file.linesKnown = false;"), crash, "P18 torn reconciliation raw", "raw reconciliation pre-state/no resurrection"],
  ["M-WRITE-ONCE", journal, s => replace(s, "offset += written;", "offset = buffer.length;"), bounds, "short successful UTF-8", "short-write raw replay"],
  ["M-WRITE-ZERO", journal, s => replace(s, "if (!Number.isInteger(written)", "if (written === 0) break;\n        if (!Number.isInteger(written)"), crash, "append zero:", "named write-progress/file error"],
  ["M-FIRSTFILE-UNREGISTERED", journal, s => replace(replace(s, "for (const name of appends.keys()) this.file(name);", "// registration delayed until after IO"), 'const state = this.file(name), body =', 'const state = this.files.get(name) ?? { lines: 0, live: 0, clean: true, linesKnown: true }, body ='), bounds, "first-file failure", "registered before open"],
  ["M-LIVE-MOVE", journal, s => replace(s, "this.runBucket(before).delete(id); this.file(before).live--;", "this.runBucket(before).delete(id);"), crash, "exact live/count", "deeply equal"],
  ["M-LIVE-STATE", journal, s => replace(s, "this.stateBucket(name).delete(id); file.live--;", "this.stateBucket(name).delete(id);"), crash, "exact live/count", "deeply equal"],
  ["M-C9-UNTAGGED", journal, s => replace(s, 'const stamped = tag === undefined ? line : `${line.slice(0, -1)},"$c":${tag}}`;', "const stamped = line;"), crash, "C9a established", "established pre-publication rejection"],
  ["M-LEGACY-PIN-LATE", journal, s => replace(s, 'writeFileAtomic(this.document, JSON.stringify({ ...original, runsCommit: baseline }, null, 2), { mode: 0o600, syncDir: true });', "void original; /* pin delayed beyond first tagged sync */"), crash, "first-new-tag observer", "first-tag durable marker barrier"],
  ["M-LEGACY-PIN-LOW", journal, s => replace(s, "const baseline = committed ?? Math.max(existing ?? 0, this.highestTag);", "const baseline = 0;"), crash, "every legacy-accepted old tagged", "accepted legacy tags survive pin"],
  ["M-LEGACY-PIN-PROJECTION", journal, s => replace(s, "JSON.stringify({ ...original, runsCommit: baseline }, null, 2)", "JSON.stringify({ routines: original.routines, runs: [], runsCommit: baseline }, null, 2)"), bounds, "legacy undefined", "legacy marker exact projection"],
  ["M-ITERATOR-PROBE", probe, s => replace(s, 'charge(this, "next");', "// pre-existing iterator next not counted"), probes, "iterator made before install", "expected"],
  ["M-CLEAR-PROBE", probe, s => replace(s, 'key === "clear" ? this.size : 1', 'key === "clear" ? 0 : 1'), probes, "recursive nested holder", "expected"],
  ["M-FOREACH-PROBE", probe, s => replace(s, 'charge(collection, "forEachVisit");', "/* callback visits omitted */"), probes, "forEach counts callbacks", "exact callback visits"],
  ["M-COUNTER", probe, s => replace(s, 'for (const [key, child] of value) {\n        const next = discover(child, `${path}.value`);\n        if (next !== child) value.set(key, next);\n      }', "// nested map discovery omitted"), probes, "recursive nested holder", "expected"],
  ["M-PRIVATE-LABEL", privateFields, s => replace(s, 'labelWorkCollection("RetiredTurnRegistry.turnIds", new Set<string>())', 'new Set<string>()'), probes, "registers real private", "private registration label"],
  ["M-HISTORY-FOREACH", "server/routines.ts", s => replace(s, 'for (const runId of [...this.openDispatch]) {\n      const run = this.lookupRun(runId);\n      if (!run || !isLive(run.status)) this.endDispatch(runId);\n    }', 'this.liveDispatch.forEach((_entry, runId) => {\n      const run = this.lookupRun(runId);\n      if (!run || !isLive(run.status)) this.endDispatch(runId);\n    });'), "server/routines-work-gate.test.ts", "100 reachable", "retained dispatch forEach visits"],
];
const selection = new Set(process.argv.slice(2));
const results = [];
try {
  cpSync(source, scratch, { recursive: true, filter: path => { const name = basename(path); return !["node_modules", ".git", "dist", "dist-server", "dist-native", "s4-B-mutants"].includes(name) && !name.endsWith(".log"); } });
  symlinkSync(join(source, "node_modules"), join(scratch, "node_modules"), "dir");
  for (const [name, file, mutate, test, pattern, assertion] of cases) {
    if (selection.size && !selection.has(name) && !(selection.has("--baseline") && name.startsWith("RED-"))) continue;
    if (!selection.size && name.startsWith("RED-")) continue;
    const path = join(scratch, file), original = readFileSync(path, "utf8");
    try {
      writeFileSync(path, mutate(original));
      const run = spawnSync("pnpm", ["exec", "vitest", "run", test, "-t", pattern], { cwd: scratch, encoding: "utf8", timeout: 240_000, maxBuffer: 8_000_000 });
      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      writeFileSync(join(out, `${name}.log`), output);
      const killed = run.status === 1 && output.includes("AssertionError") && output.includes(assertion);
      results.push({ name, kind: name.startsWith("RED-") ? "baseline" : "mutant", baselineRevision: name.startsWith("RED-") ? "4d9e2f97cbc02b65d788b0e7db30a9b841984fa7" : undefined, sourceRevision: process.env.S4_REVISION ?? "snapshot", sourceHash: createHash("sha256").update(original).digest("hex"), mutantHash: createHash("sha256").update(readFileSync(path)).digest("hex"), testHash: createHash("sha256").update(readFileSync(join(scratch, test))).digest("hex"), command: ["pnpm", "exec", "vitest", "run", test, "-t", pattern], killed, status: run.status, test, pattern, requiredAssertion: assertion, firstAssertion: output.match(/AssertionError[^\n]*/)?.[0] ?? null });
      console.log(`${killed ? (name.startsWith("RED-") ? "RED" : "KILLED") : "OPEN"} ${name}: ${results.at(-1).firstAssertion ?? run.error?.message ?? "no assertion"}`);
    } finally { writeFileSync(path, original); }
  }
} finally {
  let previous = [];
  try { previous = JSON.parse(readFileSync(join(out, "results.json"), "utf8")); } catch { /* initial run */ }
  const names = new Set(results.map(row => row.name));
  writeFileSync(join(out, "results.json"), JSON.stringify([...previous.filter(row => !names.has(row.name)), ...results], null, 2));
  if (!scratch.startsWith(join(tmpdir(), "murage-bounded-mutants-"))) throw new Error("Unsafe cleanup target");
  rmSync(scratch, { recursive: true, force: true });
}
if (results.some(row => !row.killed)) process.exitCode = 1;

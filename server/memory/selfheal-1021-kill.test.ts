// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: ctxrev-selfheal (selfheal-1021.ts, and the kill points in testing/selfheal-kill-point-preload.mjs). The real server this starts:
// index.ts (after-listen step selfheal1021). The names a backup classifies: data-dir-inventory.ts (backup owners).
// Astra H4 (a20024828e): the witness in selfheal-1021.test.ts ("a start stopped inside the note's rename") throws inside the process, so
// its error handling runs and the process lives on. Here the REAL server (index.ts, a child process) is killed with SIGKILL, three times,
// at the three points a kill can find the repair's durable writes: a slice's transaction written and not committed; half of the progress
// temp's bytes on disk; the whole temp on disk with the rename onto the note still to come. Nothing of a killed process runs after its
// kill, and each start is a new process on the same data folder. Fixture helpers as in selfheal-1021.test.ts (own file: that one's
// imports already fill import.ts's preview table, and this test starts four servers).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { classifyDataDirEntry } from "../data-dir-inventory.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureWorkspace } from "../workspace.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { commitMemoryImport, IMPORT_CHUNK_DIFF, previewMemoryImport, syncTrackedMemoryImports } from "./import.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { freePortBlock } from "../testing/ports.ts";
import { healthOk, type Run, startServer, waitExited } from "../testing/strict-fs.ts";
import { INLINE_REVOCATION, REVOCATION_JOB_SUBJECT } from "./memory-revocation.ts";
import { MEMORY_REPAIRS_FILE } from "./keepall-unwedge.ts";
import { SELFHEAL_1021, selfHealed1021, startSelfHeal1021, type SelfHealDeps } from "./selfheal-1021.ts";

const roster = { bots: [{ id: "a", threadId: "thread-a" }, { id: "b", threadId: "thread-b" }], groups: [] };
const quiet: SelfHealDeps = { log: () => {}, warn: () => {} };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster);
  database().exec("UPDATE memory_meta SET mode='active'");
});
const line = (i: number) => `Line ${String(i).padStart(4, "0")}: durable owner context that a routine keeps.`;
const lines = Array.from({ length: 600 }, (_, i) => line(i));
let notebook = "";
function seed(text: string) {
  const root = ensureWorkspace("a"), ticket = ownerMemoryTicket();
  notebook = join(root, "MEMORY.md");
  writeFileSync(notebook, text);
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
}
/** The tracked sync a running 1.0.20 did every 10 s (import.ts syncTrackedMemoryImports), on new notebook text; its receipt flips are
 * left to the durable job, as in the field: the receipts stay live, still citing the old chunk versions and notebook revision. */
function reimport(text: string) {
  writeFileSync(notebook, text);
  database().exec("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.checkedAt',0) WHERE subject_id='notebook-link'");
  const inline = { ...INLINE_REVOCATION };
  Object.assign(INLINE_REVOCATION, { rows: 0, ms: 0 });
  // 1.0.21 cause10: 1.0.20 superseded and rewrote every chunk of a changed notebook, its unchanged words included (the chains this heal
  // repairs). Today's import keeps an unchanged chunk (import.ts chunk-diff), so the 1.0.20 importer here runs with that off.
  IMPORT_CHUNK_DIFF.keep = false;
  try { syncTrackedMemoryImports(roster); } finally { IMPORT_CHUNK_DIFF.keep = true; Object.assign(INLINE_REVOCATION, inline); }
}
const evidenceOf = (records: Array<{ id: string; version: number }>) => [...new Map(records.flatMap(r => database()
  .prepare("SELECT source_id AS id,source_revision AS revision FROM memory_evidence WHERE record_id=? AND record_version=?").all(r.id, r.version) as Array<{ id: string; revision: number }>)
  .map(e => [`${e.id}\u0000${e.revision}`, { id: String(e.id), revision: Number(e.revision) }])).values()];
/** A receipt as production writes it (bundle.ts recordVersions + sourceVersions, disclosures.ts): the chunks and their notebook revision. */
function receipt(id: string, thread: string, records: Array<{ id: string; version: number }>) {
  database().prepare("INSERT INTO memory_disclosures SELECT ?,?,'fixture','session-x',?,?,'[]',policy_revision,deletion_epoch,0,'delivered',? FROM memory_meta WHERE id=1")
    .run(id, thread, JSON.stringify(records), JSON.stringify(evidenceOf(records)), Date.now());
}
const chunks = () => database().prepare("SELECT id,version FROM memory_records WHERE id LIKE '%:chunk:%' AND state='active' ORDER BY CAST(substr(id, instr(id, ':chunk:') + 7) AS INTEGER)").all() as Array<{ id: string; version: number }>;
const cites = (id: string) => JSON.parse(String((database().prepare("SELECT record_versions FROM memory_disclosures WHERE bundle_id=?").get(id) as { record_versions: string }).record_versions));
const receiptState = (id: string) => (database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(id) as { state: string }).state;
const repairsFile = () => join(DATA_DIR, MEMORY_REPAIRS_FILE);
/** The pass is recorded complete in the note. */
const flagged = () => { try { return JSON.parse(readFileSync(repairsFile(), "utf8"))[SELFHEAL_1021]?.done === true; } catch { return false; } };
/** Every name the repairs left in the data folder (the note, its side file, temps) that a backup does not classify. */
const unclassifiedRepairNames = () => readdirSync(DATA_DIR).filter(name => name.startsWith("memory-repairs") && !classifyDataDirEntry(name));
/** What the kills left beside the note. */
const leftovers = () => readdirSync(DATA_DIR).filter(name => name.startsWith("memory-repairs") && name !== MEMORY_REPAIRS_FILE).sort();
/** Receipts still live while citing a chunk version that is not the active one: what refuses every turn holding them. */
const stuckReceipts = () => (database().prepare("SELECT bundle_id FROM memory_disclosures d WHERE state IN ('prepared','delivered') AND EXISTS (SELECT 1 FROM json_each(d.record_versions) j "
  + "JOIN memory_records m ON m.id=json_extract(j.value,'$.id') AND m.version=json_extract(j.value,'$.version') WHERE m.state<>'active') ORDER BY bundle_id").all() as Array<{ bundle_id: string }>).map(row => row.bundle_id);

const KILL_PRELOAD = pathToFileURL(join(import.meta.dirname, "..", "testing", "selfheal-kill-point-preload.mjs")).href;
type KillPoint = "before-commit" | "half-written" | "before-rename";
/** The real server started with one kill point armed, and SIGKILL from here once it reports standing there. Returns what it was writing. */
async function killServerAt(point: KillPoint, home: string, env: Record<string, string>): Promise<{ file: string; run: Run }> {
  const run = startServer(home, await freePortBlock([0, 1], 19_871, 200), {
    ...env, NODE_OPTIONS: `--import=${KILL_PRELOAD}`, SELFHEAL_KILL_AT: point, SELFHEAL_KILL_NOTE: repairsFile(), SELFHEAL_KILL_KEY: SELFHEAL_1021,
    // the self-heal's compare-and-set of one receipt's lists (selfheal-1021.ts healReceiptsSlice)
    SELFHEAL_KILL_WRITE: "UPDATE memory_disclosures SET record_versions=?,source_versions=? WHERE rowid=?",
  });
  const stood = () => run.out().match(new RegExp(`^SELFHEAL-KILL-POINT ${point} (.+)$`, "m"))?.[1];
  let file: string | undefined;
  try {
    // ends early when the server recorded its pass complete without ever standing at the point (its write went another way): a failure below
    for (const deadline = Date.now() + 150_000; !(file = stood()) && run.exited() === undefined && !flagged() && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 50));
  } finally { run.child.kill("SIGKILL"); }
  expect(await waitExited(run), run.out().slice(-4000)).toBe(true);
  expect(file, `the server never stood at ${point}\n${run.out().slice(-4000)}`).toBeDefined();
  // killed, not exited: no handler of the server ran (Windows reports a TerminateProcess end as exit code 1, with no signal)
  expect(run.child.signalCode === "SIGKILL" || (process.platform === "win32" && run.exited() === 1), run.out().slice(-4000)).toBe(true);
  return { file: file!, run };
}

it("H4 kill -9 of the real server inside a slice's transaction, then mid-write of its progress (temp half written), then before the temp's rename: the note keeps every byte, the leftovers stop no backup, the restart after the lost transaction un-sticks the install, and a plain restart records the pass complete", { timeout: 480_000 }, async () => {
  seed(lines.join("\n"));
  const cited = chunks();
  const names = ["r0", "r1", "r2", "r3"];
  names.forEach((name, i) => receipt(name, "thread-a", [cited[i]!]));
  reimport([...lines, line(600)].join("\n"));
  // the stuck install: every receipt delivered, citing a superseded version of unchanged words
  expect(stuckReceipts()).toEqual(names);
  // In the field the re-import's own receipt job (import.ts T5: it ends every receipt citing the notebook, PARKED H2) sat hours behind a
  // paced backlog, which is why the receipts stayed stuck. A fixture has no backlog: the real server's runner reaches that job within a
  // second of its start and, when it gets there before the repair, ends all four receipts, so no kill could land on a repair write at all.
  // The queued job is therefore taken out here (it existed: one row): this is 1.0.20's stuck state with that job not yet reached, and
  // what recovers the install below is the repair alone. What that
  // job does to a repaired receipt when it does run is witnessed in selfheal-1021.test.ts (W1: "the heal never cancels an end 1.0.20 queued").
  expect(Number(database().prepare("DELETE FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=?").run(REVOCATION_JOB_SUBJECT).changes)).toBe(1);
  // the other repair's flag names this memory file, so its own start step leaves the note alone: every byte of the note is this repair's
  const installationId = (database().prepare("SELECT installation_id FROM memory_meta WHERE id=1").get() as { installation_id: string }).installation_id;
  writeFileSync(repairsFile(), JSON.stringify({ keepallUnwedge103: { installationId } }));
  // a pass in progress, as a start that reached its bound left it: r0 re-pointed, the cursor after it in the note, the rest still stuck
  expect(await startSelfHeal1021(database(), DATA_DIR, { ...quiet, limits: { receipts: 1, sliceRows: 1 } })).toBe("bounded");
  expect(stuckReceipts()).toEqual(names.slice(1));
  const kept = readFileSync(repairsFile());
  const keptState = JSON.parse(kept.toString("utf8"))[SELFHEAL_1021] as { receipts: number; receiptsEnd: number; done: boolean };
  expect(keptState.done).toBe(false);
  expect(keptState.receipts).toBeGreaterThan(0);
  expect(keptState.receiptsEnd - keptState.receipts).toBe(names.length - 1);
  closeDatabase();
  const home = dirname(DATA_DIR), env = { MURAGE_DATA_DIR: DATA_DIR };
  // the real server's roster is the fixture's (bots a and b on their threads): a start with no bots would end their receipts as removed
  if (!existsSync(join(DATA_DIR, "config.json"))) writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ instances: {} }));
  writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(roster.bots.map(bot => ({ ...bot, name: `Fixture bot ${bot.id}`, tasks: [] }))));
  /** After every kill: the note is byte for byte the last whole one, every name beside it is a classified one no backup takes, the pass
   * is not recorded complete, the memory file opens whole, and the receipts still stuck are exactly `stuck`. */
  const afterKill = (stuck: string[]) => {
    expect(readFileSync(repairsFile())).toEqual(kept);
    expect(unclassifiedRepairNames()).toEqual([]);
    for (const name of leftovers()) expect(classifyDataDirEntry(name)?.backup, name).toBe("excluded");
    expect((database().prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check).toBe("ok");
    expect(selfHealed1021(database(), DATA_DIR)).toBe(false);
    expect(stuckReceipts()).toEqual(stuck);
    closeDatabase();
  };

  // kill 1: the slice re-pointed receipts inside its transaction and the process is gone at the COMMIT. Nothing of it is kept: the install
  // is as stuck as before, and no progress was written for work that did not last
  await killServerAt("before-commit", home, env);
  expect(leftovers()).toEqual([]);
  afterKill(names.slice(1));

  // kill 2, a restart: this start un-sticks the install (its slices committed: the receipts are re-pointed and stay so through the kill),
  // and the kill lands with half of the progress temp's bytes on disk, a torn file that is no JSON
  const torn = await killServerAt("half-written", home, env);
  expect(torn.file).not.toBe(repairsFile());
  const tornText = readFileSync(torn.file, "utf8");
  expect(tornText.length).toBeGreaterThan(0);
  expect(() => JSON.parse(tornText)).toThrow();
  expect(leftovers()).toEqual([basename(torn.file)]);
  afterKill([]);

  // kill 3, a restart: the torn leftover is not read as progress and stops nothing; this start's temp is whole and holds the finished
  // pass, and the process is gone before its rename onto the note
  const whole = await killServerAt("before-rename", home, env);
  expect(whole.file).not.toBe(torn.file);
  expect(JSON.parse(readFileSync(whole.file, "utf8"))[SELFHEAL_1021]).toMatchObject({ done: true, receipts: keptState.receiptsEnd, installationId });
  expect(readFileSync(torn.file, "utf8")).toBe(tornText);
  expect(leftovers()).toEqual([basename(torn.file), basename(whole.file)].sort());
  afterKill([]);

  // a plain restart (no kill point, nothing but the server): the pass carries on from the note's cursor and is recorded complete
  const port = await freePortBlock([0, 1], 19_871, 200), restarted = startServer(home, port, env);
  try {
    expect(await healthOk(port, restarted, 150_000), restarted.out().slice(-4000)).toBe(true);
    for (const deadline = Date.now() + 120_000; !flagged() && restarted.exited() === undefined && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 50));
    expect(flagged(), restarted.out().slice(-4000)).toBe(true);
  } finally { restarted.child.kill("SIGTERM"); }
  expect(await waitExited(restarted), restarted.out().slice(-4000)).toBe(true);
  // from the note's cursor, not from zero and not from a leftover: exactly the receipts after the cursor were walked again, and none
  // needed a second re-point (the start killed at its progress write had already repaired them; walking them again changed nothing)
  expect(restarted.out()).toMatch(new RegExp(`\\[memory\\] 1\\.0\\.21 self-heal: receipts re-pointed=0 refs=0 scanned=${names.length - 1} `));
  // the install is not stuck, by the repair: every receipt is still delivered and cites the active version of its words
  expect(stuckReceipts()).toEqual([]);
  names.forEach((name, i) => { expect(receiptState(name), name).toBe("delivered"); expect(cites(name), name).toEqual([{ id: cited[i]!.id, version: 2 }]); });
  expect(selfHealed1021(database(), DATA_DIR)).toBe(true);
  const note = JSON.parse(readFileSync(repairsFile(), "utf8"));
  expect(note.keepallUnwedge103).toEqual({ installationId });
  expect(note[SELFHEAL_1021]).toMatchObject({ done: true, receipts: keptState.receiptsEnd });
  // the leftovers of the killed starts are still there, still classified: nothing of them was taken for the note
  expect(leftovers()).toEqual([basename(torn.file), basename(whole.file)].sort());
  expect(unclassifiedRepairNames()).toEqual([]);
});

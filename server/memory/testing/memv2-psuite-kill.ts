// Test helper for lane I (MEMORY-V2-DESIGN section 5: "the P-suite GREEN at every kill point"). Owner: lane I. Neutral names only.
// The P-suite judge the migration kill harness runs at EVERY kill point, on the database exactly as the kill left it. Every check goes
// through the production entry point of the privacy invariant it guards (design section 2) and returns its own verdict; nothing here
// asserts, so no check can stop another from being reached (the harness asserts each verdict on its own line).
//   P1-W   recall at once: the live judge every recalled or looked-up record is read through (readable.ts readableMemoryRecord), on the
//          forgotten record, on the forgotten file's records and on every other live record (the control)
//   P1-W2  derived copies: the forgotten words are in no record text (every kill point) and in no view term row (every kill point once
//          M4 is done; before that the read filter hides a dead version's terms, which P1-W exercises). Not in this fixture: helper
//          postings (the search helper has no index file here) and checkpoint member text (a notebook chunk is in no checkpoint).
//   P2-W   running turns: the frame receipt and the lookup receipt of a turn that was shown the record before the forget
//          (bundle.ts buildMemoryBundle, disclosures.ts prepare/deliver/noteMemoryLookup; judged by assertMemoryDisclosureCurrent)
//   P3-W   notebook import: the forgotten file is not re-admitted, unchanged or appended (import.ts commitMemoryImport)
//   P4     a window is closed only when its walk is proven: no window row and no started_lsn moves across a migration slice
//   P5-W   no job is skipped that could reach something shown: no open revoke job or queued job changes or disappears across a slice
//   V5-OWN a hold is released exactly when its own revoke finishes (lane C, memv2-c-inherit-1021.test.ts): at the kill point no hold
//          (memory_deny_pending / _scope) stands under a revoke that is done, and (P4) none of an unfinished revoke was released
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { database, transaction } from "../../database.ts";
import { InternalCapabilities } from "../../internal-capabilities.ts";
import { ensureWorkspace } from "../../workspace.ts";
import { buildMemoryBundle } from "../bundle.ts";
import { assertMemoryDisclosureCurrent, deliverMemoryDisclosure, noteMemoryLookup, prepareMemoryDisclosure, revokedReason } from "../disclosures.ts";
import { LineageAllowance } from "../lineage-allowance.ts";
import { REVOCATION_JOB_SUBJECT } from "../memory-revocation.ts";
import { type MemoryAccess, memoryAccess, type MemoryRoster } from "../policy.ts";
import { readableMemoryRecord } from "../readable.ts";
import { prepareRecallContextSync } from "../recall-view.ts";
import type { MemorySearchBridge } from "../search.ts";
import { FIXTURE_BOT, fixtureRoster, importTopicText } from "./memv2-retention-fixture.ts";

export const viewRoster = { ...fixtureRoster, memoryRosterRevision: 1 } as unknown as MemoryRoster;
export const RETIRED_TOPIC = "retired.md", CONTROL_TOPIC = "control.md", PROBE_TOPIC = "probe.md";
export const RETIRED_LINES = ["A retired note the owner later forgets as a whole file."];
export type Ref = { id: string; version: number };
export interface PSubjects { forgotten: Ref; retired: Ref[]; receipt: string }
/** What the harness hands the committed judge child, and the one line the child answers with (then it exits). */
export interface JudgeSpec { now: number; seed: number; subjects: PSubjects }
/** P5-shown (evidence plan row 3; design 2, P5 "no job is skipped that could reach something shown"), as the committed judge takes it. */
export interface PShown {
  /** null = the probe ran; otherwise the refusal the new chunk's read met before anything was shown (the forget's window is still walked) */
  skipped: string | null;
  /** the two imports that made the chunks and the two edits: "admitted" or the refusal code */
  imports: string[];
  /** the shown chunk's two receipts (frame, lookup) before the owner's edit, and after it */
  before: string[]; after: string[];
  /** whether the turn's FRAME receipt cites the chunk (the recall put it in the frame); the lookup receipt always does */
  frameCites: boolean;
  /** whether the edit's import made a revoke job rooted at the shown chunk's record, and at the unshown control's */
  jobs: { shown: boolean; unshown: boolean };
  /** every new revoke job root (diagnostic) */
  roots: string[];
  /** the "checking" window rows (memory_deny_pending, memory_deny_pending_scope) that STAND after the edits under a job the edits made:
   * those of a job rooted at the shown chunk, and any other. A re-import's revoke walks inline (revoke-commit.ts markInline, 1.0.21
   * cause5): with nothing to mark it leaves no all-threads window behind, so both are 0 while the job itself stays open for the runner
   * (`jobStates`: state:phase of each new job). `standing` = the window rows that stood before the probe began (the forget's, while
   * it is still walked; any job's window rows are counted). */
  holds: { shown: number; other: number }; jobStates: string[]; standing: number;
}
export interface JudgeReport { pid: number; dataDir: string; cold: PTurn; warm: PTurn; shown: PShown;
  /** branch evidence: no transaction was open at either turn's entry or exit; the stamps a live turn keys its caches on were readable
   * (undefined inside a transaction: audience-cache.ts audienceStamp, authority-epoch.ts authorityStamp); the recall fleet of the
   * connection has the turn's view as a member after turn 1 (recall-view.ts applier, run by the wake bus between the two turns) */
  evidence: { inTransaction: boolean[]; audienceStamp: boolean[]; authorityStamp: boolean[]; views: number[];
    /** per turn: the ready views (id:generation) after it; the stored audience answers it read back (hits) and computed (misses):
     * measured 0/0, the owner turn's entry points never reach audience-cache.ts cachedEligible (only policy.ts backgroundMemoryScopes
     * does), reported so a change of that is seen; the fleet between the two turns: whether the applier holds an applied mark and
     * how many views it keeps current */
    viewIds: string[][]; cache: Array<{ hits: number; misses: number }>;
    /** `made`: active records the cold turn's commits made; of those, how many stood in a recall view's rows right after the turn
     * (`projectedBefore`) and after the applier ran (`projected`) */
    fleet: { applied: boolean; members: number; made: number; projectedBefore: number; projected: number } } }
export const JUDGED = "MEMV2-JUDGED ";
export interface PBaseline { jobs: string; started: string; pending: string; queued: string }
export interface PVerdict {
  p1: { forgotten: string; retired: string[]; served: string[] };
  p1w2: string[]; p1w2terms: number; p2: { refused: string[]; reasons: string[] }; p3: { same: string; appended: string; control: string }; p4: string[]; p5: string[]; v5own: string[];
}
/** How many times each check ran to its end (the harness holds every one to the number of kill points). */
export const P_REACHED = { "P1-W": 0, "P1-W2": 0, "P2-W": 0, "P3-W": 0, P4: 0, "P5-W": 0, "V5-OWN": 0 };
export function resetPReached(): void { for (const key of Object.keys(P_REACHED) as Array<keyof typeof P_REACHED>) P_REACHED[key] = 0; }

const noSearch: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
/** A refusal thrown as its code is an outcome like a returned one; anything else is a fault. */
const refusal = (error: unknown): string => { if (error instanceof Error && /^MEMORY_[A-Z_]+$/.test(error.message)) return error.message; throw error; };
/** The fixture bot's own turn: a fresh capability, as every turn mints. */
export function turnAccess(): MemoryAccess {
  const registry = new InternalCapabilities(); registry.begin(FIXTURE_BOT, "thread-a", "generation");
  const token = registry.mint({ botId: FIXTURE_BOT, threadId: "thread-a", generation: "generation", depth: 99, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => viewRoster);
}
/** The live judge for the fixture bot's turn: "served" or the refusal code. */
export function judge(ref: Ref): string {
  try { const out = readableMemoryRecord(ref.id, ref.version, turnAccess(), { allowance: LineageAllowance.tool() }); return typeof out === "string" ? out : "served"; }
  catch (error) { return refusal(error); }
}
/** The receipts of a turn that is shown `ref` now: its frame is built by the real recall, prepared and delivered as a dispatch does,
 * then the turn reads the record with the memory tool and the lookup is noted on its companion receipt (which cites the record). */
export async function shownReceipt(words: string, ref: Ref): Promise<{ bundleId: string; records: string[] }> {
  const access = turnAccess(), bundle = await buildMemoryBundle(words, access, noSearch, { allowance: LineageAllowance.tool() });
  prepareMemoryDisclosure(bundle, access, "driver"); deliverMemoryDisclosure(bundle.bundleId, access);
  if (typeof readableMemoryRecord(ref.id, ref.version, access, { allowance: LineageAllowance.tool() }) === "string") throw new Error("fixture: the record is not readable");
  const evidence = database().prepare("SELECT source_id,source_revision FROM memory_evidence WHERE record_id=? AND record_version=?").all(ref.id, ref.version)
    .map(row => ({ sourceId: String(row.source_id), revision: Number(row.source_revision) }));
  noteMemoryLookup(bundle.bundleId, `${bundle.bundleId}:lookup`, [{ ...ref, evidence }], []);
  const cited = JSON.parse(String(database().prepare("SELECT record_versions FROM memory_disclosures WHERE bundle_id=?").get(`${bundle.bundleId}:lookup`)?.record_versions ?? "[]")) as Array<{ id: string }>;
  return { bundleId: bundle.bundleId, records: cited.map(row => String(row.id)) };
}
export function receiptNow(bundleId: string): string {
  try { assertMemoryDisclosureCurrent(bundleId, turnAccess()); return "current"; } catch (error) { return refusal(error); }
}
/** Why the receipt is refused now (disclosures.ts revokedReason, the verdict the assert above acts on): "current" when it is not. */
export function receiptReason(bundleId: string): string {
  const access = turnAccess(), row = database().prepare("SELECT * FROM memory_disclosures WHERE bundle_id=? AND thread_id=?").get(bundleId, access.threadId);
  return row ? revokedReason(LineageAllowance.tool(), row as never, access) ?? "current" : "no receipt";
}
const ROLLBACK = new Error("rolled back");
/** Runs `work` inside the production transaction helper and rolls it back: the check leaves no row behind. */
function rolledBack<T>(work: () => T): T {
  let out: T | undefined;
  try { transaction(() => { out = work(); throw ROLLBACK; }); } catch (error) { if (error !== ROLLBACK) throw error; }
  return out as T;
}
let previewClock = 0;
/** The clock the import previews are aged with: the harness sets it to its fake timer (vi.setSystemTime), the committed judge child
 * (memv2-judge-child.ts, a plain process with no test runner) to its own fixture clock. */
export const PCLOCK = { set: (_ms: number): void => { throw new Error("memv2-psuite-kill: no clock was set"); } };
/** The owner imports this topic file with these lines now, through the real preview and commit: "admitted" or the refusal code. The
 * file comes back as it was and an admitted import is rolled back. (Import previews are process state kept ten minutes, at most 20:
 * each one here is taken 11 minutes after the last, so the earlier ones have expired, and the clock comes back.) */
export function importNow(topic: string, lines: readonly string[], committed = false): string {
  const file = join(ensureWorkspace(FIXTURE_BOT), "memory", topic), before = existsSync(file) ? readFileSync(file) : null, now = Date.now();
  previewClock += 11 * 60_000; PCLOCK.set(now + previewClock);
  // committed = the judge child on its own copy of the cut: the import commits as the owner's would (nothing is rolled back there)
  try { if (committed) { importTopicText(topic, lines); return "admitted"; } return rolledBack(() => { importTopicText(topic, lines); return "admitted"; }); }
  catch (error) { return refusal(error); }
  finally { PCLOCK.set(now); if (before) writeFileSync(file, before); else rmSync(file, { force: true }); }
}
export function resetPreviewClock(): void { previewClock = 0; }

/** What P4 and P5 hold a migration slice to: taken before the slice, compared at the kill point after it. */
export function pBaseline(): PBaseline {
  const db = database(), all = (sql: string) => JSON.stringify(db.prepare(sql).all());
  return {
    jobs: all("SELECT revoke_id,kind,root,root_lsn,phase,cursor,state FROM memory_revoke_jobs WHERE state IN ('active','undoing') ORDER BY 1"),
    started: all("SELECT revoke_id,started_lsn FROM memory_revoke_jobs ORDER BY 1"),
    pending: all(`SELECT 'thread' AS k,thread_id AS id,since_lsn,revoke_id FROM memory_deny_pending UNION ALL
      SELECT 'scope',scope_id,since_lsn,revoke_id FROM memory_deny_pending_scope ORDER BY 1,2,3,4`),
    queued: all(`SELECT id,state FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='${REVOCATION_JOB_SUBJECT}' AND state IN ('granted','revoked') ORDER BY 1`),
  };
}
const moved = (name: string, before: string, after: string): string[] => before === after ? [] : [`${name} ${before} -> ${after}`];

/** The whole P-suite at this kill point. `before` = the baseline taken before the migration slice that was just killed. */
export async function pSuiteAt(s: PSubjects, before: PBaseline): Promise<PVerdict> { return pSuiteNow(s, before); }
/** The same whole P-suite as an ISOLATED probe (KILLSUITE "Required judge rows at each cut": the continuation used for the equality
 * oracle receives zero probe writes): it runs inside the production transaction helper on the committed prefix the kill left and is
 * rolled back, so the owner turn it takes (view prepare, receipt refusals, import attempts) leaves no row behind. Every check enters
 * through the same production function as before and reads the same committed prefix.
 * Because a transaction is open, the code under those entry points takes its in-transaction branches (recall-view.ts maintains the
 * view alone instead of through the fleet applier; audience-cache.ts and authority-epoch.ts neither read nor store their stamps), which
 * a live owner turn does not. So this probe is an EXTRA check at the random-walk boundaries and is credited with no design row: the
 * judge a row is credited with is the COMMITTED one (pTurnCommitted, run by testing/memv2-judge-child.ts in a fresh process on a
 * backup copy of the cut), at every cut made by a real crash and at the end of every seed. */
export function pSuiteIsolated(s: PSubjects, before: PBaseline): PVerdict { return rolledBack(() => pSuiteNow(s, before)); }
/** The owner-turn checks of the P-suite (P1-W, P1-W2, P2-W, P3-W): every one enters a production function a live turn enters. */
export type PTurn = Pick<PVerdict, "p1" | "p1w2" | "p1w2terms" | "p2" | "p3">;
/** The COMMITTED owner turn (plan row 5, FABLE/OPUS H2a): the same owner-turn checks with NO transaction open around them, so the code
 * under them takes the branches a live turn takes (recall-view.ts fleet applier, audience-cache.ts and authority-epoch.ts stamps) and
 * whatever the turn writes (its view, its import) commits. Only the judge child calls this, on its own copy of the cut. */
export function pTurnCommitted(s: PSubjects, at: () => void): PTurn { return pTurn(s, true, at); }
function pSuiteNow(s: PSubjects, before: PBaseline): PVerdict { return { ...pTurn(s, false), ...pCut(before) }; }
function pTurn(s: PSubjects, committed: boolean, at: () => void = () => {}): PTurn {
  const db = database();
  // (the committed judge's branch evidence is taken HERE, where the production entry points are called from, and again at the end)
  at();
  // an owner turn at this kill point: it prepares its recall view first, as a turn's start does (this writes, as a turn between two batches would)
  prepareRecallContextSync(FIXTURE_BOT, "thread-a", viewRoster);
  // P1-W: the judge on the forgotten record, on every record of the forgotten file, and on every other live record (the control)
  const live = db.prepare("SELECT id,version FROM memory_records WHERE state='active' AND id<>? ORDER BY rowid").all(s.forgotten.id)
    .map(row => ({ id: String(row.id), version: Number(row.version) })).filter(row => !s.retired.some(r => r.id === row.id));
  const p1 = { forgotten: judge(s.forgotten), retired: [...new Set(s.retired.map(judge))], served: [...new Set(live.map(judge))] };
  P_REACHED["P1-W"]++;
  // P1-W2: the forgotten words are in no record text (every version of the forgotten record and of the forgotten file's records)
  const p1w2 = db.prepare(`SELECT id,version FROM memory_records WHERE text<>'' AND (id=? OR id IN (SELECT value FROM json_each(?)))`)
    .all(s.forgotten.id, JSON.stringify(s.retired.map(r => r.id))).map(row => `${String(row.id)}:${Number(row.version)}`);
  // ... and, read here and asserted once M4 is done (until then the stored terms of a dead version are hidden by the read filter, which
  // P1-W exercises): in no view term row of any view or generation
  const ids = JSON.stringify([s.forgotten.id, ...s.retired.map(r => r.id)]);
  const p1w2terms = Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_terms WHERE record_id IN (SELECT value FROM json_each(?))").get(ids)!.n);
  P_REACHED["P1-W2"]++;
  // P2-W: the turn that was shown the record before the forget may not go on with it
  const receipts = [s.receipt, `${s.receipt}:lookup`];
  const p2 = { refused: [...new Set(receipts.map(receiptNow))], reasons: [...new Set(receipts.map(receiptReason))].sort() };
  P_REACHED["P2-W"]++;
  // P3-W: the forgotten file is not re-admitted as it was, nor with a line appended; a file never forgotten is (the control)
  const p3 = { same: importNow(RETIRED_TOPIC, RETIRED_LINES, committed), appended: importNow(RETIRED_TOPIC, [...RETIRED_LINES, "One more line the owner added later."], committed),
    control: importNow(PROBE_TOPIC, ["A probe note in a file nobody forgot."], committed) };
  P_REACHED["P3-W"]++;
  at();
  return { p1, p1w2, p1w2terms, p2, p3 };
}
/** The checks that hold the cut itself (P4, P5-W, V5-OWN): plain reads of the file against the baseline taken before the slice. */
function pCut(before: PBaseline): Pick<PVerdict, "p4" | "p5" | "v5own"> {
  const db = database(), now = pBaseline();
  // P4: the slice closed no window and moved no started_lsn (lane I proves no walk)
  const startedNow = new Map((JSON.parse(now.started) as Array<{ revoke_id: number; started_lsn: number }>).map(row => [row.revoke_id, row.started_lsn]));
  const p4 = [...moved("windows", before.pending, now.pending), ...(JSON.parse(before.started) as Array<{ revoke_id: number; started_lsn: number }>)
    .filter(row => startedNow.has(row.revoke_id) && startedNow.get(row.revoke_id) !== row.started_lsn).map(row => `started_lsn of revoke ${row.revoke_id} ${row.started_lsn} -> ${startedNow.get(row.revoke_id)}`)];
  P_REACHED.P4++;
  // P5-W: every revoke job that was open before the slice is open after it, unchanged, and so is every queued job
  const p5 = [...moved("revoke jobs", before.jobs, now.jobs), ...moved("queued jobs", before.queued, now.queued)];
  P_REACHED["P5-W"]++;
  // V5-OWN: no hold outlives its own revoke (a finished revoke whose hold still stands withholds forever)
  const v5own = db.prepare(`SELECT 'thread '||p.thread_id||' revoke '||p.revoke_id AS h FROM memory_deny_pending p JOIN memory_revoke_jobs j ON j.revoke_id=p.revoke_id WHERE j.state='done'
    UNION ALL SELECT 'scope '||p.scope_id||' revoke '||p.revoke_id FROM memory_deny_pending_scope p JOIN memory_revoke_jobs j ON j.revoke_id=p.revoke_id WHERE j.state='done' ORDER BY 1`).all().map(row => String(row.h));
  P_REACHED["V5-OWN"]++;
  return { p4, p5, v5own };
}

export const SHOWN_TOPIC = "shown-chunk.md", UNSHOWN_TOPIC = "unshown-chunk.md";
/** P5-shown at this kill point, COMMITTED (only the judge child calls this, on its copy of the cut, after its two owner turns). The
 * owner adds two notebook files through the real import (import.ts previewMemoryImport/commitMemoryImport); a turn is shown the first
 * one's chunk (the real recall frame, delivered, and the memory tool's lookup: shownReceipt); then the owner EDITS both files and
 * imports them again. The import's shown probe (revocation.ts importShownProbe, reached through revokeRecordDisclosures cause
 * "import") must withdraw the shown chunk: a revoke job rooted at its record, and every receipt that cites it refused (the lookup
 * receipt always cites it; the frame receipt only when the recall put the chunk in the frame, which is reported). The edited chunk that
 * nothing was shown is the control: no job is made for it. The hold: the shown chunk's job stays open (active) and its inline walk
 * leaves no all-threads "checking" window standing (the receipt refusal is what holds the turn that was shown it). Nothing here asserts; the harness holds the answer on its own line. */
export async function pShownCommitted(): Promise<PShown> {
  const db = database();
  const out: PShown = { skipped: null, imports: [], before: [], after: [], frameCites: false, jobs: { shown: false, unshown: false }, roots: [], holds: { shown: 0, other: 0 }, jobStates: [], standing: 0 };
  const HOLDS = "SELECT revoke_id FROM memory_deny_pending WHERE revoke_id>? UNION ALL SELECT revoke_id FROM memory_deny_pending_scope WHERE revoke_id>?";
  out.standing = db.prepare(HOLDS).all(0, 0).length;
  const sourceIds = () => db.prepare("SELECT id FROM memory_sources").all().map(row => String(row.id));
  const imported = (topic: string, line: string): Ref[] => {
    const known = new Set(sourceIds());
    try { importTopicText(topic, [line]); out.imports.push("admitted"); } catch (error) { out.imports.push(refusal(error)); return []; }
    const fresh = sourceIds().filter(id => !known.has(id));
    return fresh.flatMap(source => db.prepare("SELECT DISTINCT r.id,r.version FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE e.source_id=? AND r.state='active'")
      .all(source).map(row => ({ id: String(row.id), version: Number(row.version) })));
  };
  const shown = imported(SHOWN_TOPIC, "Shown probe chunk alpha: a note a turn is shown before the owner edits it.");
  const unshown = imported(UNSHOWN_TOPIC, "Unshown probe chunk beta: a note no turn is ever shown before the owner edits it.");
  if (shown.length !== 1 || unshown.length !== 1) throw new Error(`fixture: the probe files made ${shown.length}/${unshown.length} records ${JSON.stringify(out.imports)}`);
  // while the forget's window is still walked another record may be withheld from the turn (replay limit, evidence unavailable): then
  // nothing can be shown here, and the probe reports that instead of a verdict
  const readable = judge(shown[0]!);
  if (readable !== "served") { out.skipped = readable; return out; }
  const receipt = await shownReceipt("Shown probe chunk alpha", shown[0]!);
  if (!receipt.records.includes(shown[0]!.id)) throw new Error("fixture: the lookup receipt does not cite the shown chunk");
  const receipts = [receipt.bundleId, `${receipt.bundleId}:lookup`];
  out.before = receipts.map(receiptNow);
  out.frameCites = (JSON.parse(String(db.prepare("SELECT record_versions FROM memory_disclosures WHERE bundle_id=?").get(receipt.bundleId)?.record_versions ?? "[]")) as Array<{ id: string }>).some(row => String(row.id) === shown[0]!.id);
  const jobsBefore = Number(db.prepare("SELECT coalesce(max(revoke_id),0) AS n FROM memory_revoke_jobs").get()!.n);
  const edit = (topic: string, line: string) => { try { importTopicText(topic, [line]); out.imports.push("admitted"); } catch (error) { out.imports.push(refusal(error)); } };
  edit(SHOWN_TOPIC, "Shown probe chunk alpha: the owner changed this note after a turn was shown it.");
  edit(UNSHOWN_TOPIC, "Unshown probe chunk beta: the owner changed this note, which no turn was shown.");
  out.roots = db.prepare("SELECT root FROM memory_revoke_jobs WHERE revoke_id>? ORDER BY revoke_id").all(jobsBefore).map(row => String(row.root));
  const rooted = (ref: Ref) => out.roots.some(root => { try { return String((JSON.parse(root) as { ref?: { id?: unknown } }).ref?.id) === ref.id; } catch { return false; } });
  out.jobs = { shown: rooted(shown[0]!), unshown: rooted(unshown[0]!) };
  const shownJobs = new Set(db.prepare("SELECT revoke_id,root FROM memory_revoke_jobs WHERE revoke_id>?").all(jobsBefore)
    .filter(row => { try { return String((JSON.parse(String(row.root)) as { ref?: { id?: unknown } }).ref?.id) === shown[0]!.id; } catch { return false; } }).map(row => Number(row.revoke_id)));
  const opened = db.prepare(HOLDS).all(jobsBefore, jobsBefore).map(row => Number(row.revoke_id));
  out.jobStates = db.prepare("SELECT state||':'||phase AS s FROM memory_revoke_jobs WHERE revoke_id>? ORDER BY revoke_id").all(jobsBefore).map(row => String(row.s));
  out.holds = { shown: opened.filter(id => shownJobs.has(id)).length, other: opened.filter(id => !shownJobs.has(id)).length };
  out.after = receipts.map(receiptNow);
  return out;
}

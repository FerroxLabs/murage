// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The write-time differential (DESIGN-WRITETIME 5): the gate for deleting the read-time judge. On generated histories (receipts, captured
// replies, root sets across threads, copies, retained sessions, one long thread), each of the owner actions below is applied in the form
// 1.0.1 and the RC kept it, the file is upgraded (U1 + U2, lineage-backfill.ts), and then, for every line of every thread and every retained
// session, and for each reader (content only, and an audience reader), the frozen RC judge (testing/legacy-lineage, unmetered) and the new
// lookup (deny-read.ts) are compared:
//   - new shows, old withholds: always zero;
//   - new withholds, old shows: only in a class OVERWITHHOLD.md lists (classOf maps the new verdict to its class).
// Each action is compared twice: in the pending window right after U2's commits, and after the marker drained (memory-revocation.ts
// drainRevokeMarker). After the drain no "pending" verdict is accepted.
// Shapes added with Astra's audit (int102-gate/audit-astra/REPORT.md): receipts that cite a record whose evidence is a document (so a source
// that moves on or retires reaches the receipt only through the record), root sets that share a hot pool of parents (several threads' sessions
// rest on the same line), a live forget committed after the upgrade whose marker is left to drain ("forget-live": until-bounded or not), and
// clean fresh turns written between the commit and the drain (an answer, a copy of it elsewhere): those must read shown once the marker
// drained, whatever mark a range or a capture might have put on them (writetime-live-differential.test.ts covers the shapes the frozen
// judge has no word for: objects, cards, prompts).
// Scale: WRITETIME_DIFF_SCALE=extreme runs the design's shape (60 bots, a 200k-message thread); the default is small enough for every run.
import { mkdirSync, readFileSync } from "node:fs";
import { Session } from "node:inspector";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, closeMessageDb } from "../message-db.ts";
import type { Message } from "../store.ts";
import { denyLookup, sessionLookup } from "./deny-read.ts";
import { closeTurnLineage, openTurnLineage } from "./lineage-write.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { lineageBackfillSlice, lineageCertProgress, resetLineageBackfillForTest } from "./lineage-backfill.ts";
import type { LineageReader, LineageVerdict } from "./lineage-types.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { setScopeFlowEdgesRecorded } from "./revoke-marker.ts";
import { buildLegacyHistory, markUpgraded, messageSource, prng, type LegacyHistory, type LegacyLine, type LegacyOptions } from "./testing/legacy-history-fixture.ts";
import { LineageAllowance } from "./testing/legacy-lineage/lineage-allowance.ts";
import { rangeProof } from "./testing/range-proof.ts";
import { forgetKeptLineageForTest, messageSourceForgotten, replayExclusions, sessionLineageBad, setReplayNodeBudgetForTest, type ReplayAudience } from "./testing/legacy-lineage/replay-lineage.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const EXTREME = process.env.WRITETIME_DIFF_SCALE === "extreme";
/** WRITETIME_DIFF_SHAPE="threads,lines,longThread" overrides the shape (profiling a middle scale). */
const SHAPE_ENV = process.env.WRITETIME_DIFF_SHAPE?.split(",").map(Number);
const SHAPE: Omit<LegacyOptions, "seed"> = SHAPE_ENV?.length === 3 && SHAPE_ENV.every(Number.isSafeInteger) ? { threads: SHAPE_ENV[0]!, lines: SHAPE_ENV[1]!, longThread: SHAPE_ENV[2]! }
  : EXTREME ? { threads: 60, lines: 46_000, longThread: 200_000 } : { threads: 6, lines: 60, longThread: 600 };
/** Histories per action: 5 at the default scale; at the extreme scale (3M messages each) WRITETIME_DIFF_SEEDS, default 1. */
const SEEDS = EXTREME ? Math.max(1, Number(process.env.WRITETIME_DIFF_SEEDS ?? 1)) : 5;

/** WRITETIME_DIFF_SHAPES (comma-separated, default all): which of the added shapes the histories carry: `records` (receipts citing a record whose
 * evidence is a document), `hot` (a hot pool of parents shared by several threads' root sets), `fresh` (clean fresh turns written in the
 * delayed-marker window). Naming a subset bisects a finding. */
const SHAPES = new Set((process.env.WRITETIME_DIFF_SHAPES ?? "records,hot,fresh").split(",").filter(Boolean));
/** WRITETIME_DIFF_NO_ORACLE=1: the write-time side alone (upgrade, marker drain, every line looked up for both readers), timed, with its
 * storage; no comparison. The frozen RC judge walks each reply's whole root-set chain (root-set-handles.ts meteredHandle), so at the extreme
 * shape the oracle itself runs for days; this mode measures what the extreme shape costs the new side. */
const NO_ORACLE = process.env.WRITETIME_DIFF_NO_ORACLE === "1";
/** WRITETIME_PROFILE=1: a CPU profile of the first WRITETIME_PROFILE_S seconds (default 120) of judging, its top functions printed. */
const profiler = process.env.WRITETIME_PROFILE === "1" ? { session: new Session(), started: 0, done: false } : null;
function profileStart(): void {
  if (!profiler || profiler.started) return;
  profiler.session.connect();
  profiler.session.post("Profiler.enable", () => {});
  profiler.session.post("Profiler.start", () => {});
  profiler.started = performance.now();
}
function profileDumpIfDue(): void {
  if (!profiler || profiler.done || !profiler.started || performance.now() - profiler.started < 1000 * Number(process.env.WRITETIME_PROFILE_S ?? 120)) return;
  profiler.done = true;
  profiler.session.post("Profiler.stop", (error, result) => {
    if (error) return;
    const prof = (result as { profile: { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>; samples: number[]; timeDeltas: number[] } }).profile;
    const self = new Map<number, number>();
    prof.samples.forEach((id, k) => self.set(id, (self.get(id) ?? 0) + (prof.timeDeltas[k] ?? 0)));
    const by = new Map<string, number>();
    for (const node of prof.nodes) { const key = `${node.callFrame.functionName || "(anon)"} ${node.callFrame.url.split("/").pop()}:${node.callFrame.lineNumber + 1}`; by.set(key, (by.get(key) ?? 0) + (self.get(node.id) ?? 0)); }
    console.log(`WRITETIME-PROFILE self ms\n${[...by].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, us]) => `${(us / 1000).toFixed(0).padStart(8)} ${k}`).join("\n")}`);
  });
}

const ACTIONS = ["forget-early", "forget-late", "forget-copied", "hide", "unhide", "delete-conversation", "delete-bot", "record-archive", "source-revise", "receipt-revoke", "policy-bump", "receipt-revoke-after", "forget-live"] as const;
type Action = (typeof ACTIONS)[number];
/** WRITETIME_DIFF_ACTIONS (comma-separated) runs a subset, so the extreme scale can be split over several runs; every action is run by default. */
const RUN_ACTIONS: readonly Action[] = process.env.WRITETIME_DIFF_ACTIONS
  ? process.env.WRITETIME_DIFF_ACTIONS.split(",").map(name => { if (!(ACTIONS as readonly string[]).includes(name)) throw new Error(`unknown action ${name}`); return name as Action; })
  : ACTIONS;

/** The class ids OVERWITHHOLD.md lists (its table's first column). */
function listedClasses(): Set<string> {
  const text = readFileSync(fileURLToPath(new URL("./OVERWITHHOLD.md", import.meta.url)), "utf8");
  return new Set([...text.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map(match => match[1]!));
}
/** The class a new-only withhold belongs to, or null when it belongs to none (blocking). After the marker drained, no revoke is pending:
 * a "pending" verdict then belongs to no class. No S0 stub is left (writetime-schema.test.ts): "not-built" belongs to none. */
function classOf(verdict: LineageVerdict, drained: boolean, positionalMark: () => string | null = () => null, rangeProof: () => string | null = () => null): string | null {
  if (verdict.state === "checking") {
    if (verdict.reason === "pending") return drained ? null : "pending-window";
    if (verdict.reason === "no-lineage") return "u1-unprovable";
    if (verdict.reason === "footprint-wide") return "footprint-star";
    return null; // thread-not-ready after the backfill finished, a lookup error: never accepted
  }
  if (verdict.state === "withheld") {
    // a range-based withhold of a line the RC shows is a class only when the caller PROVED it (rangeProof: positional, positional-branch or
    // range-coalesced); a range it cannot prove is unproven, and blocks
    if (verdict.reason === "deny-range") return rangeProof();
    // a line mark that only follows from the positional rule (proven per line by the caller): the line is under a positional range of the
    // same revoke (its capture's forgotten source marked it by line as well), or the mark came along a point carry from a parent that is
    if (verdict.reason === "deny-line" || verdict.reason === "deny-session") return positionalMark();
    if (verdict.reason === "footprint") return "footprint-star";
    if (verdict.reason === "watermark") return "watermark-positional";
  }
  return null;
}

const freshMessage = (id: string, role: "user" | "bot", extra: Partial<Message> = {}): Message => ({ id, role, kind: "text", text: id, at: Date.now(), ...extra });
/** Clean fresh turns on a history already upgraded: in up to three threads an owner line, then an answer written by a running turn with no
 * parents, and in the next thread a copy of that answer. They are added to the history's lines, and the keys returned: nothing a revoke
 * committed before them can legitimately withhold them once the marker drained (they were written after it and rest on nothing it denied). */
function writeFresh(db: ReturnType<typeof database>, history: LegacyHistory, avoid: ReadonlySet<string>, seed: number): Set<string> {
  const out = new Set<string>();
  const threads = history.threads.filter(thread => !avoid.has(thread)).slice(0, 3);
  const tail = new Map<string, string>();
  const write = (thread: string, message: Message, line: Omit<LegacyLine, "id" | "role">, turn: boolean) => {
    // (the first line of a thread names no parent: a legacy thread has no active leaf, and a different parent would be a branch switch)
    const parentId = tail.get(thread);
    const withParent = parentId ? { ...message, parentId } : message;
    if (turn) { const open = openTurnLineage(db, { threadId: thread, turnId: `fresh-${seed}-${message.id}` }); try { appendMessage(thread, withParent); } finally { closeTurnLineage(open); } }
    else appendMessage(thread, withParent);
    tail.set(thread, message.id);
    history.lines.get(thread)!.push({ id: message.id, role: message.role === "user" ? "user" : "bot", ...line });
    out.add(`${thread}/${message.id}`);
  };
  threads.forEach((thread, k) => {
    write(thread, freshMessage(`fresh-o-${k}`, "user"), { captured: false, receipt: null }, false);
    write(thread, freshMessage(`fresh-r-${k}`, "bot"), { captured: true, receipt: null }, true);
  });
  threads.forEach((thread, k) => {
    const into = threads[(k + 1) % threads.length]!;
    if (into === thread) return;
    write(into, freshMessage(`fresh-c-${k}`, "bot", { copyOf: { threadId: thread, messageIds: [`fresh-r-${k}`] } }), { captured: false, receipt: null, copyOf: { threadId: thread, messageIds: [`fresh-r-${k}`] } }, true);
  });
  for (const key of [...out]) if (key.includes("fresh-o-")) out.delete(key); // (an owner line is judged by the direct facts alone: the generic loop covers it)
  return out;
}

function apply(action: Action, history: LegacyHistory, seed: number): string {
  const db = database(), random = prng(seed * 977 + ACTIONS.indexOf(action)), pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const bots = [...history.lines].flatMap(([thread, lines]) => lines.filter(line => line.role === "bot").map(line => ({ thread, line })));
  const captured = bots.filter(entry => entry.line.captured);
  const forget = (thread: string, id: string) => {
    const source = messageSource(thread, id);
    db.prepare("INSERT OR IGNORE INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot','settled',NULL,'active')").run(source, history.scopeOf.get(thread)!, thread, id);
    db.prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(source);
    // the forget happens some time after the line (within the next ~40 steps of the history), so lines written after it exist
    const written = Number(db.prepare("SELECT at FROM messages WHERE thread_id=? AND id=?").get(thread, id)?.at ?? 0);
    const when = written + 0.5 + Math.floor(random() * 40 * (SHAPE.threads + 1));
    db.prepare("INSERT OR IGNORE INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?,?,?,1,NULL,0,'owner-forget',?)").run(`tomb-${source}`, "source", source, when);
    return `${thread}/${id}`;
  };
  const scopeThread = pick(history.threads);
  switch (action) {
    case "forget-early": { const at = captured[Math.floor(random() * Math.max(1, captured.length / 5))] ?? captured[0]!; return forget(at.thread, at.line.id); }
    case "forget-late": { const at = captured[captured.length - 1 - Math.floor(random() * Math.max(1, captured.length / 5))] ?? captured[0]!; return forget(at.thread, at.line.id); }
    case "forget-copied": {
      const copy = bots.find(entry => entry.line.copyOf) ?? captured[0]!;
      return copy.line.copyOf ? forget(copy.line.copyOf.threadId, copy.line.copyOf.messageIds[0]!) : forget(copy.thread, copy.line.id);
    }
    case "hide": case "unhide": {
      const at = pick(bots);
      db.prepare("UPDATE messages SET json=json_set(json,'$.withheldFromBots',json('true')) WHERE thread_id=? AND id=?").run(at.thread, at.line.id);
      if (action === "unhide") db.prepare("UPDATE messages SET json=json_remove(json,'$.withheldFromBots') WHERE thread_id=? AND id=?").run(at.thread, at.line.id);
      return `${at.thread}/${at.line.id}`;
    }
    case "delete-conversation":
      // as the RC deletes a conversation: its lines go, its sources are deleted, and the thread is denied
      db.prepare("UPDATE memory_sources SET state='deleted' WHERE thread_id=?").run(scopeThread);
      db.prepare("INSERT OR IGNORE INTO memory_deny(kind,id,epoch,created_at) VALUES('thread',?,0,1)").run(scopeThread);
      db.prepare("DELETE FROM messages WHERE thread_id=?").run(scopeThread);
      return scopeThread;
    case "delete-bot": {
      const scope = history.scopeOf.get(scopeThread)!;
      db.prepare("UPDATE memory_sources SET state='deleted' WHERE scope_id=?").run(scope);
      db.prepare("INSERT OR IGNORE INTO memory_deny(kind,id,epoch,created_at) VALUES('scope',?,0,1)").run(scope);
      return scope;
    }
    case "record-archive": { const doc = pick(history.docs); db.prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(doc); return doc; }
    case "source-revise": { const doc = pick(history.docs); db.prepare("UPDATE memory_sources SET revision=revision+1 WHERE id=?").run(doc); return doc; }
    case "receipt-revoke": { const bundle = pick(history.receipts); db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(bundle); return bundle; }
    case "policy-bump": db.prepare("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1").run(); return "policy";
    // after the upgrade (afterUpgrade below): a receipt revoked by a path that knows nothing of write-time (plain SQL, as settings,
    // restore and the bookkeeping job do): the v10 flip trigger, the flip queue and the marker carry it
    case "receipt-revoke-after": return pick(history.receipts);
    // a forget the owner makes after the upgrade (forget.ts): the facts at once, the marker committed and left to drain (afterUpgrade below)
    case "forget-live": { const at = captured[Math.floor(random() * Math.max(1, captured.length / 2))] ?? captured[0]!; return `${at.thread}/${at.line.id}`; }
  }
}

// as index.ts sets it at start: every writer records its flow edges, so a revoke's flow phase closes its '*' window once the certificate is ready
setScopeFlowEdgesRecorded(true);

it(`${RUN_ACTIONS.length} owner actions x ${SEEDS} histories: the new lookup never shows what the RC judge withheld, and withholds more only in a listed class`, { tags: ["nightly"], timeout: EXTREME ? 86_400_000 : 900_000 }, () => {
  const listed = listedClasses();
  expect(listed.has("positional")).toBe(true);
  const newSide = new Map<string, number>();
  const tally = { pairs: 0, fresh: 0, unsafe: [] as string[], unproven: [] as string[], unlisted: [] as string[], byClass: new Map<string, number>(), oldWithheld: 0, oldShown: 0, storage: { messages: 0, receiptBytes: 0, receiptRows: 0, lineageBytes: 0, carryBytes: 0 } };
  /** bytes of the named tables and their indexes (dbstat) */
  const bytesOf = (db: ReturnType<typeof database>, tables: readonly string[]): number => Number(db.prepare(`SELECT coalesce(sum(s.pgsize),0) AS b FROM dbstat s JOIN sqlite_schema m ON m.name=s.name WHERE m.tbl_name IN (${tables.map(() => "?").join(",")})`).get(...tables)!.b);
  for (let seed = 1; seed <= SEEDS; seed++) {
    for (const action of RUN_ACTIONS) {
      closeMessageDb(); closeDatabase(); forgetKeptLineageForTest(); resetLineageBackfillForTest();
      removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
      const db = database();
      (globalThis as { __diffT0?: number }).__diffT0 = performance.now();
      const history = buildLegacyHistory(db, { seed, branches: 0.08, ...(SHAPES.has("records") ? { records: 0.3 } : {}), ...(SHAPES.has("hot") ? { hot: 3 } : {}), ...SHAPE });
      const started = performance.now();
      const t = { build: started - (globalThis as { __diffT0?: number }).__diffT0!, backfill: 0, rc: 0, now: 0, classify: 0, drain: 0 };
      const target = apply(action, history, seed);
      // the upgrade: U1 + U2 to their end; the certificate must be ready (no stub is left to block U2)
      markUpgraded(db);
      for (let slices = 0; lineageBackfillSlice(db, { budgetMs: 500 }).more; slices++) if (slices > 1_000_000) throw new Error("backfill without end");
      expect(lineageCertProgress(db).ready, `seed ${seed} ${action}: certificate`).toBe(true);
      t.backfill = performance.now() - started;
      // storage after the upgrade: the receipt range table (start position + session number per receipt), lineage and carries, per message
      tally.storage.messages += Number(db.prepare("SELECT count(*) AS n FROM messages").get()!.n);
      tally.storage.receiptBytes += bytesOf(db, ["memory_receipt_lines", "memory_session_no"]);
      tally.storage.receiptRows += Number(db.prepare("SELECT count(*) AS n FROM memory_receipt_lines").get()!.n);
      tally.storage.lineageBytes += bytesOf(db, ["memory_line_lineage", "memory_thread_no"]);
      tally.storage.carryBytes += bytesOf(db, ["memory_lineage_carry"]);
      if (action === "receipt-revoke-after") db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(target);
      if (action === "forget-live") {
        const [thread, id] = target.split("/") as [string, string];
        const source = messageSource(thread, id);
        db.prepare("INSERT OR IGNORE INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot','settled',NULL,'active')").run(source, history.scopeOf.get(thread)!, thread, id);
        db.prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(source);
        db.prepare("INSERT OR IGNORE INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?,?,?,1,NULL,0,'owner-forget',?)").run(`tomb-${source}`, "source", source, Date.now());
        commitRevoke(db, { kind: "line", threadId: thread, messageIds: [id], cause: "forget" }, { inline: false });
      }
      // delayed marker: clean fresh turns written after the commit and before the marker drains, in threads the action leaves alone
      const fresh = !SHAPES.has("fresh") ? new Set<string>() : writeFresh(db, history, new Set([target.split("/")[0]!, ...(action === "delete-bot" ? history.threads.filter(thread => history.scopeOf.get(thread) === target) : [])]), seed);
      const meta = db.prepare("SELECT policy_revision AS p,deletion_epoch AS e FROM memory_meta WHERE id=1").get()!;
      const allScopes = [...history.scopeOf.values()];
      const readers: Array<{ name: string; old: ReplayAudience | null; now: LineageReader }> = [
        { name: "content", old: null, now: { audience: null } },
        { name: "audience", old: { policyRevision: Number(meta.p), deletionEpoch: Number(meta.e), revoked: () => false, cacheKey: `diff-${seed}-${action}` }, now: { audience: { owner: false, scopeIds: allScopes } } },
      ];
      let drained = false;
      const where = () => `seed ${seed} ${action} (${target}) ${drained ? "drained" : "pending"}`;
      const proof = rangeProof(db);
      const { proveRange, diagnose, RANGE_RANK } = proof;
      /** "positional" when each of the line's deny_line marks is matched by a positional deny_range of the same revoke (or the thread's
       * coalesced one) over the line itself; "positional-carried" when instead some mark came along a point carry from a generated parent
       * line that such a range covers (DESIGN-WRITETIME 2.3: inheritance passes a positional over-withhold on); null otherwise. */
      const positionalMark = (threadId: string, messageId: string) => (): string | null => {
        const no = (thread: string) => db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?").get(thread)?.no as number | undefined;
        const covered = (thread: string, lsn: number, revoke: number): boolean => {
          const at = db.prepare("SELECT turn_lsn AS tl FROM memory_line_lineage WHERE thread_no=? AND lsn=?").get(no(thread) ?? -1, lsn);
          if (!at || at.tl === null) return false;
          return Boolean(db.prepare("SELECT 1 AS x FROM memory_deny_range WHERE thread_id=? AND revoke_id IN (?,-1) AND from_lsn<? AND ?<until_turn_lsn LIMIT 1").get(thread, revoke, lsn, Number(at.tl)));
        };
        const line = db.prepare("SELECT lsn,turn_lsn AS tl FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(no(threadId) ?? -1, messageId);
        if (!line) return null;
        const lsn = Number(line.lsn);
        const marks = db.prepare("SELECT revoke_id AS r FROM memory_deny_line WHERE thread_id=? AND lsn=?").all(threadId, lsn).map(mark => Number(mark.r));
        if (!marks.length) return null;
        // every mark follows from a range of its revoke over the line, and the line is PROVEN under each (the weakest proof decides)
        const proofs = marks.map(revoke => proveRange(threadId, messageId, [revoke]));
        if (proofs.every(proof => proof !== null)) return proofs.reduce((weakest, proof) => RANGE_RANK[proof!]! < RANGE_RANK[weakest!]! ? proof : weakest)!;
        // parents carried onto the line itself, or onto its turn
        const parents = db.prepare("SELECT p.thread_id AS t,c.from_lsn AS f,c.to_lsn AS u FROM memory_lineage_carry c JOIN memory_thread_no p ON p.no=c.parent_thread_no WHERE c.child_thread_no=? AND ((c.child_kind=0 AND c.child_ref=?) OR (c.child_kind=1 AND c.child_ref=?))")
          .all(no(threadId) ?? -1, String(lsn), String(line.tl));
        const rangeCovered = (thread: string, from: number, to: number, revoke: number) => {
          const rows = db.prepare("SELECT lsn FROM memory_line_lineage WHERE thread_no=? AND lsn>=? AND lsn<=? AND turn_lsn IS NOT NULL").all(no(thread) ?? -1, from, to);
          return rows.some(row => covered(thread, Number(row.lsn), revoke));
        };
        if (marks.every(revoke => covered(threadId, lsn, revoke) || parents.some(parent => rangeCovered(String(parent.t), Number(parent.f), Number(parent.u), revoke)))) return "positional-carried";
        // every mark came from a revoke whose walk crossed a positional over-withhold: one of its ranges withholds a generated line the RC
        // shows, and the marker walks on from such a line (its capture, its session, the receipts citing it)
        return marks.every(revoke => crossedPositional(revoke)) ? "positional-propagated" : null;
      };
      /** A session's deny_session marks: "positional" when each came from a revoke that walked its thread (a range of that revoke in the
       * session's thread: the marker resets every session used after the line), or "positional-propagated" when each came from a revoke that
       * crossed a positional over-withhold. */
      const sessionMark = (session: { threadId: string; driverInstance: string; nativeSession: string }) => (): string | null => {
        const marks = db.prepare("SELECT revoke_id AS r FROM memory_deny_session WHERE thread_id=? AND driver_instance=? AND native_session=?").all(session.threadId, session.driverInstance, session.nativeSession).map(row => Number(row.r));
        if (!marks.length) return null;
        if (marks.every(revoke => Boolean(db.prepare("SELECT 1 AS x FROM memory_deny_range WHERE thread_id=? AND revoke_id IN (?,-1) LIMIT 1").get(session.threadId, revoke)))) return "positional";
        return marks.every(revoke => crossedPositional(revoke)) ? "positional-propagated" : null;
      };
      const crossedMemo = new Map<number, boolean>();
      const crossedPositional = (revoke: number): boolean => {
        const held = crossedMemo.get(revoke);
        if (held !== undefined) return held;
        let crossed = false;
        for (const range of db.prepare("SELECT thread_id AS t,from_lsn AS f,until_turn_lsn AS u FROM memory_deny_range WHERE revoke_id IN (?,-1)").all(revoke)) {
          const tno = db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?").get(String(range.t))?.no;
          const shownHere = oldShownContent.get(String(range.t));
          if (tno === undefined || !shownHere) continue;
          for (const row of db.prepare("SELECT message_id AS m,turn_lsn AS tl FROM memory_line_lineage WHERE thread_no=? AND lsn>? AND turn_lsn IS NOT NULL").iterate(tno, Number(range.f)))
            if (Number(row.tl) < Number(range.u) && shownHere.has(String(row.m))) { crossed = true; break; }
          if (crossed) break;
        }
        crossedMemo.set(revoke, crossed);
        return crossed;
      };
      /** The RC's content verdicts, thread by thread (the lines it shows), for the propagation proof; filled per phase before judging. */
      const oldShownContent = new Map<string, Set<string>>();
      const judge = (oldWithholds: boolean, verdict: LineageVerdict, what: string, positional: () => string | null = () => null, rangeProof: () => string | null = () => null) => {
        tally.pairs++;
        if (oldWithholds) tally.oldWithheld++; else tally.oldShown++;
        const shows = verdict.state === "shown";
        if (shows && oldWithholds) tally.unsafe.push(`${where()}: ${what}`);
        if (!shows && !oldWithholds) {
          const c0 = performance.now();
          const cls = classOf(verdict, drained, positional, rangeProof);
          t.classify += performance.now() - c0;
          if (cls === null || !listed.has(cls)) {
            tally.unlisted.push(`${where()}: ${what} ${JSON.stringify(verdict)}`);
            // a withhold by a range, or by a mark that follows from one, that no proof covers
            if (verdict.state === "withheld" && (verdict.reason === "deny-range" || verdict.reason === "deny-line" || verdict.reason === "deny-session")) tally.unproven.push(`${where()}: ${what} ${JSON.stringify(verdict)} ${(() => { const m = /^\S+ (.+)\/([^/]+)$/.exec(what); return m ? diagnose(m[1]!, m[2]!) : ""; })()}`);
          }
          else tally.byClass.set(cls, (tally.byClass.get(cls) ?? 0) + 1);
        }
      };
      /** A clean fresh line (writeFresh): the RC shows it, and the new lookup must show it once the marker drained: there is no class for it. While
       * the marker runs it may read "checking" (the pending window). */
      const freshJudge = (old: boolean, verdict: LineageVerdict, what: string) => {
        if (old) return judge(old, verdict, what);
        tally.pairs++; tally.oldShown++; tally.fresh++;
        if (verdict.state === "shown") return;
        if (!drained && verdict.state === "checking" && verdict.reason === "pending") { tally.byClass.set("pending-window", (tally.byClass.get("pending-window") ?? 0) + 1); return; }
        // the reader-relative rules (not marks): an audience reader loses a line whose thread's running oldest receipt predates the last policy or
        // epoch bump, or whose running footprint holds scopes the reader lacks (design risk 4; the clean line inherits its thread's running values)
        const rule = classOf(verdict, drained);
        if (rule === "watermark-positional" || rule === "footprint-star") { tally.byClass.set(rule, (tally.byClass.get(rule) ?? 0) + 1); return; }
        // a receipt some path turned 'revoked' is committed by the marker, not when the path ran: its range ends at the commit, so a line written
        // between the flip and the commit lies inside it, for an audience reader (a state flip binds audience readers only)
        if (action === "receipt-revoke-after" && what.startsWith("audience") && verdict.state === "withheld" && (verdict.reason === "deny-line" || verdict.reason === "deny-range")) { tally.byClass.set("flip-window", (tally.byClass.get("flip-window") ?? 0) + 1); return; }
        tally.unlisted.push(`${where()}: a clean fresh line, ${what}, reads ${JSON.stringify(verdict)}`);
      };
      if (NO_ORACLE) {
        const d0 = performance.now();
        expect(drainRevokeMarker(db).pending, `seed ${seed} ${action}: marker drained`).toBe(false);
        t.drain = performance.now() - d0;
        const n0 = performance.now();
        for (const reader of readers) for (const [thread, lines] of history.lines) {
          const verdicts = denyLookup(db, { threadId: thread, lines: lines.map(line => ({ messageId: line.id, author: line.role === "user" ? "owner" as const : "generated" as const })) }, reader.now);
          for (const verdict of verdicts.values()) newSide.set(verdict.state, (newSide.get(verdict.state) ?? 0) + 1);
        }
        t.now = performance.now() - n0;
        console.log(`WRITETIME-DIFFERENTIAL-NEWSIDE seed ${seed} ${action}: ${JSON.stringify(Object.fromEntries(newSide))}; s: ${Object.entries(t).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(", ")}`);
        continue;
      }
      setReplayNodeBudgetForTest(Number.MAX_SAFE_INTEGER);
      // compared twice: in the pending window right after U2's commits (new may read "checking" where old shows, never shown where old
      // withholds), and after the marker drained every revoke (DESIGN-WRITETIME 5)
      profileStart();
      try { for (const phase of ["pending", "drained"] as const) {
        if (phase === "drained") {
          const d0 = performance.now();
          const drain = drainRevokeMarker(db);
          t.drain += performance.now() - d0;
          expect(drain.pending, `seed ${seed} ${action}: marker drained`).toBe(false);
          drained = true;
        }
        oldShownContent.clear(); crossedMemo.clear();
        for (const [thread, lines] of history.lines) {
          const flags = new Map(db.prepare("SELECT id,json_extract(json,'$.withheldFromBots') AS w FROM messages WHERE thread_id=?").all(thread).map(row => [String(row.id), row.w]));
          const own = (id: string) => { if (!flags.has(id)) return true; const flag = flags.get(id); return flag !== null && flag !== undefined && flag !== 0 && flag !== "checking"; };
          const excluded = replayExclusions(LineageAllowance.tool(Number.MAX_SAFE_INTEGER), thread, lines.map(line => ({ id: line.id, role: line.role, ...(line.copyOf ? { copyOf: line.copyOf } : {}) })), null, { failClosed: true });
          oldShownContent.set(thread, new Set(lines.filter(line => !(own(line.id) || messageSourceForgotten(thread, line.id) || excluded.has(line.id))).map(line => line.id)));
        }
        for (const reader of readers) {
          for (const [thread, lines] of history.lines) {
            const flags = new Map(db.prepare("SELECT id,json_extract(json,'$.withheldFromBots') AS w FROM messages WHERE thread_id=?").all(thread).map(row => [String(row.id), row.w]));
            // the direct facts the RC's callers applied: the line's own flag, and a line that is gone (its conversation deleted) is shown to no one
            const own = (id: string) => { if (!flags.has(id)) return true; const flag = flags.get(id); return flag !== null && flag !== undefined && flag !== 0 && flag !== "checking"; };
            // the RC judge, unmetered: receipts and root sets, plus the direct facts its callers applied (own flag, the line's forgotten source)
            profileDumpIfDue();
            const r0 = performance.now();
            const excluded = replayExclusions(LineageAllowance.tool(Number.MAX_SAFE_INTEGER), thread, lines.map(line => ({ id: line.id, role: line.role, ...(line.copyOf ? { copyOf: line.copyOf } : {}) })), reader.old, { failClosed: true });
            const n0 = performance.now(); t.rc += n0 - r0;
            const verdicts = denyLookup(db, { threadId: thread, lines: lines.map(line => ({ messageId: line.id, author: line.role === "user" ? "owner" as const : "generated" as const, withheldFromBots: own(line.id) })) }, reader.now);
            t.now += performance.now() - n0;
            for (const line of lines) {
              const old = own(line.id) || messageSourceForgotten(thread, line.id) || excluded.has(line.id);
              const verdict = verdicts.get(line.id) ?? { state: "checking" as const, reason: "lookup-error" as const };
              if (fresh.has(`${thread}/${line.id}`)) freshJudge(old, verdict, `${reader.name} ${thread}/${line.id}`);
              else judge(old, verdict, `${reader.name} ${thread}/${line.id}`, positionalMark(thread, line.id), () => proveRange(thread, line.id));
            }
          }
          for (const session of history.sessions) {
            // the RC's direct fact: a deleted conversation's sessions go with it (never resumed)
            const deleted = Boolean(db.prepare("SELECT 1 FROM memory_deny WHERE kind='thread' AND id=?").get(session.threadId));
            const old = deleted || sessionLineageBad(LineageAllowance.tool(Number.MAX_SAFE_INTEGER), session.threadId, session.driverInstance, session.nativeSession, reader.old);
            judge(old, sessionLookup(db, session, reader.now), `${reader.name} session ${session.threadId}/${session.nativeSession}`, sessionMark(session));
          }
        }
      } } finally { setReplayNodeBudgetForTest(null); }
      if (EXTREME || SHAPE_ENV) console.log(`WRITETIME-DIFFERENTIAL-PROGRESS seed ${seed} ${action}: ${((performance.now() - started) / 1000).toFixed(0)} s, pairs so far ${tally.pairs}, unsafe ${tally.unsafe.length}, unlisted ${tally.unlisted.length}; s: ${Object.entries(t).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(", ")}`);
    }
  }
  console.log(`WRITETIME-DIFFERENTIAL scale=${EXTREME ? "extreme" : "default"} ${tally.pairs} pairs (${tally.fresh} clean fresh), RC withheld ${tally.oldWithheld}, RC shown ${tally.oldShown}, unsafe ${tally.unsafe.length}, unproven ${tally.unproven.length}, unlisted ${tally.unlisted.length}, new-only by class ${JSON.stringify(Object.fromEntries(tally.byClass))}`);
  const perMessage = (bytes: number) => (bytes / Math.max(1, tally.storage.messages)).toFixed(1);
  console.log(`WRITETIME-DIFFERENTIAL-STORAGE scale=${EXTREME ? "extreme" : "default"} messages ${tally.storage.messages}, receipt rows ${tally.storage.receiptRows}, bytes per message: receipts ${perMessage(tally.storage.receiptBytes)}, lineage ${perMessage(tally.storage.lineageBytes)}, carries ${perMessage(tally.storage.carryBytes)}`);
  if (NO_ORACLE) return;
  expect(tally.unsafe.slice(0, 20), "new shows what the RC judge withheld").toEqual([]);
  expect(tally.unproven.slice(0, 20), "a range-based withhold of a line the RC shows that is neither proven positional nor a counted over-withhold").toEqual([]);
  expect(tally.unlisted.slice(0, 20), "new withholds more in a case OVERWITHHOLD.md does not list").toEqual([]);
  // the histories exercise the judge: it withholds after the actions and shows a good part of the rest
  expect(tally.oldWithheld).toBeGreaterThan(0);
  expect(tally.oldShown).toBeGreaterThan(tally.oldWithheld);
});

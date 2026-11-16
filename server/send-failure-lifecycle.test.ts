import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SendStore, initializeOwnerSends } from "./send-store.ts";
import { TurnSubmissionBoundary } from "./turn-dispatch-guard.ts";
import { IndependentThreadRuns } from "./independent-thread-runs.ts";
import { drainBatch } from "./steer-queue.ts";
import { giveBackAdmitted } from "./admitted-turn.ts";

const handles: DatabaseSync[] = [];
function fixture() {
  const db = new DatabaseSync(":memory:"); handles.push(db); initializeOwnerSends(db);
  return { db, sends: new SendStore(() => db) };
}
afterEach(() => { for (const db of handles.splice(0)) db.close(); });
const input = { kind: "bot" as const, ownerId: "bot", threadId: "thread", sendId: "send", fingerprint: "words", text: "words" };
describe("A1 base behavioral REDs", () => {
  it("F7-RETRY: failed-with-line same-ID retry returns the original receipt", () => {
    const { sends } = fixture(); const first = sends.accept(input).row;
    sends.settle(first.seq, "failed", "line");
    const retry = sends.accept(input);
    expect(retry.kind).toBe("existing"); expect(retry.row.seq).toBe(first.seq);
  });
  it("F7-ML1-GROUP-SAMEID: group same-ID failure cannot retire a linked receipt", () => {
    const { sends } = fixture(); const first = sends.accept({ ...input, kind: "group" }).row;
    sends.settle(first.seq, "failed", "line"); sends.retire(first.seq);
    expect(sends.bySeq(first.seq)?.messageId).toBe("line");
    expect(sends.accept({ ...input, kind: "group" }).kind).toBe("existing");
  });
  it("F7-ML5-ANON-RETURNS-ID: acceptance returns a durable server send identity", () => {
    const { sends } = fixture(); const row = sends.accept({ ...input, sendId: undefined }).row;
    expect(row.sendId).toMatch(/^srv-/); expect(sends.bySeq(row.seq)?.sendId).toBe(row.sendId);
  });
  it("ISO-14: isolation survives rebuild and clears on the unrelated generation", () => {
    const runs = new IndependentThreadRuns();
    const first = runs.admit("bot", "thread", {}, [], { isolated: true } as never);
    runs.holdForRebuild(first);
    const next = runs.admit("bot", "thread", {}, [], { takeOver: first.generation });
    expect((next as any).isolated).toBe(true); runs.release(next);
    expect((runs.admit("bot", "thread", {}) as any).isolated).toBe(false);
  });
  it("ISO-14: isolated queued rows form a complete batch boundary", () => {
    const { sends } = fixture();
    const rows = [false, true, false].map((isolated, i) => sends.accept({ ...input, sendId: `s${i}`, isolated } as never).row);
    expect(drainBatch(rows).map(r => r.sendId)).toEqual(["s0"]);
    expect(drainBatch(rows.slice(1)).map(r => r.sendId)).toEqual(["s1"]);
  });
  it("F7-MULTIWRITE: a later refused write never makes an earlier release retryable", () => {
    const boundary = new TurnSubmissionBoundary(); boundary.started(); boundary.beforeSubmit(() => {});
    expect(() => boundary.beforeSubmit(() => { throw new Error("refused"); })).toThrow("refused");
    boundary.notWritten(); expect(boundary.canRetry).toBe(false);
  });
  it("F7-DB-GATE: failed persistence prevents the adapter write", () => {
    const boundary = new TurnSubmissionBoundary(); let writes = 0;
    // The separate throwing gate is not the best-effort attribution observer.
    (boundary as any).setPersistenceGate?.({ invocation() {}, write() { throw new Error("disk full"); } });
    boundary.started();
    expect(() => { boundary.beforeSubmit(() => {}); writes++; }).toThrow("disk full");
    expect(writes).toBe(0);
  });
  it("F7-INVOKE: unfenced invocation must persist before evaluating the adapter", () => {
    const boundary = new TurnSubmissionBoundary(); const events: string[] = [];
    (boundary as any).setPersistenceGate?.({ invocation() { events.push("durable"); }, write() {} });
    boundary.started(); events.push("adapter"); expect(events).toEqual(["durable", "adapter"]);
  });
  it("F7-DB-TERMINAL: failed receipt commit cannot release or drain an admitted turn", () => {
    const events: string[] = [];
    giveBackAdmitted({ keepThread: false, reported: false }, "setup", new Error("setup"), {
      current: () => true, threadHeld: () => false, endMarks: () => { events.push("marks"); },
      release: () => { events.push("release"); }, markIdle: () => { events.push("idle"); },
      report: () => { events.push("report"); }, drain: () => { events.push("drain"); },
      commitTerminal: () => { throw new Error("disk full"); },
    } as never, () => {});
    expect(events).toEqual([]);
  });
});

// Registered I0 tables let this isolated harness exercise the production F1
// lifecycle without editing I's database/index.ts registration on this branch.
import { initializeSendAttempts, SendAttemptStore, resendAttempt, type AttemptResendRequest } from "./send-attempt-state.ts";
import { existingAttemptResponse } from "./send-store.ts";
function durable() {
  const f = fixture(); initializeSendAttempts(f.db);
  return { ...f, attempts: new SendAttemptStore(f.db) };
}
function failed(isolated = false) {
  const f = durable(); const row = f.sends.accept({ ...input, isolated }).row;
  f.sends.settle(row.seq, "failed", "line"); const receipt = f.sends.attemptFor(row)!;
  const request: AttemptResendRequest = { contract: 1, kind: "resend", actionId: "press", replacementSendId: "replacement", threadId: "thread", sendId: "send", attemptId: receipt.attemptId, receiptRevision: receipt.revision, bindingEpoch: receipt.bindingEpoch, confirmDuplicate: false };
  const replace = (old: typeof receipt, sendId: string) => f.attempts.create({ ownerId: old.ownerId, botId: old.botId, threadId: old.threadId, fingerprint: old.fingerprint, isolated: old.isolated, queueOnly: old.queueOnly, sendId, queueId: "new-queue" });
  return { ...f, receipt, request, replace };
}
it("F7-ACTION / F7-ML1-GROUP-RESEND: one press returns exactly one replacement", () => {
  const f = failed(true);
  const first = resendAttempt(f.attempts, f.receipt, f.request, f.replace);
  const retry = resendAttempt(f.attempts, f.receipt, f.request, f.replace);
  expect(retry.existing).toBe(true); expect(retry.replacementAttemptId).toBe(first.replacementAttemptId);
  expect(first.receipt.isolated).toBe(true);
  expect(f.db.prepare("SELECT count(*) AS n FROM send_attempts").get()).toEqual({ n: 2 });
  for (const change of [{ replacementSendId: "another" }, { stopGen: "old" }, { attemptId: "other" }]) {
    expect(() => resendAttempt(f.attempts, f.receipt, { ...f.request, ...change }, f.replace)).toThrow("stale_action");
  }
});
it("F7-ACTION: resend works against I0's non-null replacement contract", () => {
  const f = failed();
  // Enforce the frozen I0 invariant independently of the local initializer.
  f.db.exec(`CREATE TRIGGER require_resend_ids BEFORE INSERT ON send_actions
    WHEN NEW.kind='resend' AND (NEW.replacement_attempt_id IS NULL OR NEW.replacement_send_id IS NULL)
    BEGIN SELECT RAISE(ABORT,'replacement identities required'); END`);
  expect(() => resendAttempt(f.attempts, f.receipt, f.request, f.replace)).not.toThrow();
  expect(f.db.prepare("SELECT replacement_attempt_id, replacement_send_id, status FROM send_actions").get())
    .toMatchObject({ replacement_attempt_id: expect.any(String), replacement_send_id: "replacement", status: "done" });
});
it("F7-ACTION: failed action persistence rolls its replacement back", () => {
  const f = failed();
  f.db.exec("CREATE TRIGGER fail_action BEFORE INSERT ON send_actions BEGIN SELECT RAISE(ABORT,'disk full'); END");
  expect(() => resendAttempt(f.attempts, f.receipt, f.request, f.replace)).toThrow("disk full");
  expect(f.db.prepare("SELECT count(*) AS n FROM send_attempts").get()).toEqual({ n: 1 });
  expect(f.db.prepare("SELECT count(*) AS n FROM send_actions").get()).toEqual({ n: 0 });
});
it("F7-LEGACY-RESEND-ONE-REPLACEMENT: old-shape action retries return deterministic replacement", () => {
  const { sends } = fixture(); const row = sends.accept(input).row; sends.settle(row.seq, "refused", undefined, "refused");
  const first = sends.accept({ ...input, resend: true, actionId: "press" });
  const repeat = sends.accept({ ...input, resend: true, actionId: "press" });
  expect(first.row.sendId).toBe("r-press"); expect(repeat.row.seq).toBe(first.row.seq);
  expect(sends.bySendId("thread", "send")?.status).toBe("refused");
});
it("F7-LEGACY-RESEND-NO-ACTIONID: a legacy flag cannot rerun the receipt", () => {
  const { sends } = fixture(); const row = sends.accept(input).row; sends.settle(row.seq, "failed", "line");
  expect(sends.accept({ ...input, resend: true }).kind).toBe("existing");
});
it("F7-ML3 server: lost acknowledgement returns a definitive failed receipt", () => {
  const f = failed();
  expect(existingAttemptResponse(f.receipt)).toEqual({ ok: false, existing: true, threadId: "thread", receipt: { state: "failed", attemptId: f.receipt.attemptId, receiptRevision: f.receipt.revision } });
  expect(existingAttemptResponse({ ...f.receipt, terminalOutcome: "completed", delivery: "submitted" }).ok).toBe(true);
});
it("F7-ML5-ANON-BATCH: batch failure settles captured identities including anonymous send", () => {
  const f = durable(); const rows = [f.sends.accept(input).row, f.sends.accept({ ...input, sendId: undefined }).row];
  rows.forEach((row, i) => f.sends.settle(row.seq, "started", `line-${i}`));
  const keys = f.sends.bindBatch(rows.map(row => row.seq), "batch", "provider");
  f.attempts.settleBatch(keys.map(key => ({ key, revision: f.attempts.byId(key.attemptId)!.revision })), "failed", "not_submitted");
  expect(rows.map(row => f.sends.attemptFor(row)?.phase)).toEqual(["terminal", "terminal"]);
  expect([...f.attempts.replayEligibility("thread", ["line-0", "line-1"]).excludedIds]).toEqual(["line-0", "line-1"]);
});
it("F7-REBUILD / F7-STOP-GAP: sealed old callbacks never settle or write the replacement", () => {
  const f = durable(); const row = f.sends.accept(input).row;
  const first = f.sends.bindBatch([row.seq], "first", "provider")[0]!;
  f.attempts.seal(first, f.attempts.byId(first.attemptId)!.revision);
  const replacement = f.attempts.bind([first.attemptId], { generation: "next", providerInstanceId: "provider" })[0]!;
  expect(f.attempts.settleAttempt(first, f.attempts.byId(first.attemptId)!.revision, "failed", { binding: first, delivery: "not_submitted" }).kind).toBe("stale");
  expect(() => f.attempts.releaseWrite(first, f.attempts.byId(first.attemptId)!.revision, 1)).toThrow("stale_action");
  const stopped = f.attempts.seal(replacement, f.attempts.byId(first.attemptId)!.revision, "stop");
  expect(() => f.attempts.releaseWrite(stopped, f.attempts.byId(first.attemptId)!.revision, 1)).toThrow("stale_action");
});
it.each(["F7-ML2-GIVEBACK-LINE", "F7-ML2-LINE-THROWS", "F7-ML2-NO-DUPLICATE"])("%s: owed explanation is committed once before release", name => {
  const f = failed(); const key = f.sends.bindingFor(f.sends.bySendId("thread", "send")!)!;
  f.db.exec("CREATE TABLE explanations(attempt_id TEXT PRIMARY KEY, revision INTEGER)");
  if (name === "F7-ML2-NO-DUPLICATE") f.db.prepare("INSERT INTO explanations VALUES (?,?)").run(f.receipt.attemptId, f.receipt.revision);
  let throws = name === "F7-ML2-LINE-THROWS"; let releases = 0;
  const run = (effect: { kind: string }) => {
    if (effect.kind === "publication") {
      if (throws) { throws = false; throw new Error("disk full"); }
      f.db.prepare("INSERT OR IGNORE INTO explanations VALUES (?,?)").run(f.receipt.attemptId, f.receipt.revision);
    }
    if (effect.kind === "release") releases++;
  };
  f.attempts.flushEffects("thread", key.generation, run);
  expect(f.attempts.byId(f.receipt.attemptId)?.phase).toBe("terminal");
  f.attempts.flushEffects("thread", key.generation, run);
  f.attempts.flushEffects("thread", key.generation, run);
  expect(f.db.prepare("SELECT count(*) AS n FROM explanations").get()).toEqual({ n: 1 }); expect(releases).toBe(1);
});

import { createAttemptTerminalizer, startAdmittedTurn } from "./admitted-turn.ts";
it.each(["synchronous", "ACP accepted setup", "background after start", "rebuild exhausted"])("F7-SETUP / F7-REBUILD: %s failure uses the shared terminalizer", async phase => {
  const f = durable(); const row = f.sends.accept(input).row;
  const binding = f.sends.bindBatch([row.seq], "gen", "provider")[0]!;
  f.db.exec("CREATE TABLE activity(attempt_id TEXT PRIMARY KEY, explanation_key TEXT)");
  let released = false;
  const terminal = createAttemptTerminalizer(f.attempts, [binding], {
    current: () => !released, seal: () => {}, requestStop: () => {},
    explanationExists: id => Boolean(f.db.prepare("SELECT 1 FROM activity WHERE attempt_id=?").get(id)),
    explain: (receipt, key) => { f.db.prepare("INSERT INTO activity VALUES (?,?)").run(receipt.attemptId, key); },
    effect: effect => { if (effect.kind === "release") released = true; },
  });
  try {
    if (phase === "synchronous") {
      expect(() => startAdmittedTurn(() => { throw new Error("setup"); }, () => { terminal.settle("failed", "not_submitted"); }, () => {})).toThrow("setup");
    } else {
      if (phase === "ACP accepted setup") f.attempts.allocateProvider(binding, f.attempts.byId(binding.attemptId)!.revision, "allocated-id");
      await startAdmittedTurn(() => Promise.reject(new Error(phase)), () => { terminal.settle("failed", "not_submitted"); }, () => {});
    }
    expect(released).toBe(true);
    expect(f.attempts.byId(binding.attemptId)).toMatchObject({ phase: "terminal", delivery: "not_submitted" });
    expect(f.db.prepare("SELECT count(*) AS n FROM activity").get()).toEqual({ n: 1 });
  } finally { terminal.dispose(); }
});

it("F7-DB-TERMINAL recovery: shared terminalizer holds all effects until a failed commit can retry", () => {
  const f = durable(); const row = f.sends.accept(input).row; const key = f.sends.bindBatch([row.seq], "gen", "provider")[0]!;
  const seen: string[] = [];
  const terminal = createAttemptTerminalizer(f.attempts, [key], { current: () => true, seal: () => {}, requestStop: () => {}, explanationExists: () => seen.includes("explanation"), explain: () => { seen.push("explanation"); }, effect: effect => { seen.push(effect.kind); } });
  try {
    f.db.exec("CREATE TRIGGER broken BEFORE UPDATE OF terminal_outcome ON send_attempts BEGIN SELECT RAISE(ABORT,'disk full'); END");
    expect(terminal.settle("failed", "not_submitted")).toBe(false);
    expect(seen).toEqual([]); expect(f.db.isTransaction).toBe(false);
    f.db.exec("DROP TRIGGER broken"); expect(terminal.retry()).toBe(true);
    expect(seen.at(-1)).toBe("release"); expect(seen.filter(s => s === "explanation")).toHaveLength(1);
    terminal.retry(); expect(seen.filter(s => s === "release")).toHaveLength(1);
  } finally { terminal.dispose(); }
});
it("F7-ACTION: uncertain sends need closure and confirmation; dismissed targets cannot resend", () => {
  const f = durable(); const row = f.sends.accept(input).row; const key = f.sends.bindBatch([row.seq], "gen", "provider")[0]!;
  f.attempts.releaseWrite(key, f.attempts.byId(key.attemptId)!.revision, 1);
  const stopped = f.attempts.seal(key, f.attempts.byId(key.attemptId)!.revision, "stop-token");
  const receipt = f.attempts.settleAttempt(stopped, f.attempts.byId(key.attemptId)!.revision, "stopped", { binding: stopped, delivery: "uncertain" }).receipt;
  const req: AttemptResendRequest = { contract: 1, actionId: "press", threadId: "thread", sendId: "send", attemptId: receipt.attemptId, receiptRevision: receipt.revision, bindingEpoch: receipt.bindingEpoch, kind: "resend", replacementSendId: "new", confirmDuplicate: false, stopGen: "stop-token" };
  const replace = () => f.attempts.create({ ownerId: "bot", botId: "bot", threadId: "thread", sendId: "new", fingerprint: "hash" });
  expect(() => resendAttempt(f.attempts, receipt, { ...req, stopGen: "stale" }, replace)).toThrow("stale_action");
  expect(() => resendAttempt(f.attempts, receipt, req, replace)).toThrow("duplicate_confirmation_required");
  expect(resendAttempt(f.attempts, receipt, { ...req, confirmDuplicate: true }, replace).receipt.sendId).toBe("new");
  const dismissed = failed(); dismissed.sends.settle(dismissed.sends.bySendId("thread", "send")!.seq, "cancelled");
  expect(() => resendAttempt(dismissed.attempts, dismissed.receipt, dismissed.request, dismissed.replace)).toThrow("target_dismissed");
});

it("F7-STOP-GAP: sibling queue stays held until committed release effects finish", () => {
  const f = failed(); const sibling = f.sends.accept({ ...input, sendId: "sibling", status: "queued" }).row;
  expect(f.sends.drainable("thread", "bot")).toEqual([]);
  const binding = f.sends.bindingFor(f.sends.bySendId("thread", "send")!)!;
  f.attempts.flushEffects("thread", binding.generation, () => {});
  expect(f.sends.drainable("thread", "bot").map(row => row.seq)).toEqual([sibling.seq]);
});

it("F7-RECEIPT: authorized account scope is preserved through the queue projection", () => {
  const f = durable(); const scope = { ownerId: "account", botId: "bot", threadId: "thread" };
  const row = f.sends.accept({ ...input, attemptScope: scope }).row;
  expect(f.sends.attemptFor(row)).toMatchObject(scope);
  expect(f.attempts.readAttempt({ ...scope, ownerId: "foreign" }, "send")).toEqual({ kind: "missing" });
  expect(f.sends.accept({ ...input, attemptScope: { ...scope, ownerId: "foreign" } }).kind).toBe("conflict");
});

it("legacy late refusal retains unsent words and can retry while linked terminal receipts cannot", () => {
  const { sends } = fixture(); const first = sends.accept(input).row;
  sends.settle(first.seq, "unconfirmed", "line");
  sends.settle(first.seq, "failed");
  expect(sends.bySeq(first.seq)).toMatchObject({ status: "failed", messageId: "line", text: "words" });
  const retry = sends.accept(input);
  expect(retry.kind).toBe("new"); expect(retry.row.seq).toBeGreaterThan(first.seq);
});

it("legacy late refusal stays retryable after turn-end scrubbing and a store restart", () => {
  const { db, sends } = fixture(); const first = sends.accept(input).row;
  sends.settle(first.seq, "unconfirmed", "line");
  sends.holdForLateAnswer(first.seq); sends.releaseThreadLate(input.threadId);
  expect(sends.bySeq(first.seq)?.text).toBe("");
  sends.settle(first.seq, "failed");
  const restarted = new SendStore(() => db);
  const retry = restarted.accept(input);
  expect(retry.kind).toBe("new"); expect(retry.row.seq).toBeGreaterThan(first.seq);
});

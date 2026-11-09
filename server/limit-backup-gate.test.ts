// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U22 G20: the one limit-backup gate, and the place each of the 13 call sites asks it (designs/U22-HIDDEN-BACKUP-CHOKEPOINT.md).
// Each site test names the hole it closes: a hidden or removed engine offered, saved, restored or started.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { assertBackupAtDispatch, backupGate, backupRefusalLine, backupRefusalMessage, BackupRefusedError, keptAfter, postKept, stillOffered, type BackupGateDeps, type BackupRefusal } from "./limit-backup-gate.ts";
import { bootRecovery, dropFailover, LimitFailoverStore, refuseFailover, runBootRecovery, settleCarriedRefusal, type FailoverRefusalSteps } from "./limit-failovers.ts";
import { TurnSubmissionBoundary } from "./turn-dispatch-guard.ts";
import { mappedInstanceScan } from "./mapped-instance-scan.ts";
import { resolveTurnSelection, type TurnSelectionDeps } from "./turn-selection.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// The row store's atomic write, real unless a test turns it off to prove a read needs no write.
const writes = vi.hoisted(() => ({ fail: false }));
vi.mock("./atomic.ts", async (original) => {
  const actual = await original<typeof import("./atomic.ts")>();
  return { ...actual, writeFileAtomic: (...args: Parameters<typeof actual.writeFileAtomic>) => {
    if (writes.fail) throw new Error("disk full");
    return actual.writeFileAtomic(...args);
  } };
});

const from = { instanceId: "claude", model: "m" };
const kimi = { instanceId: "kimi", model: "k" };
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) removeTempDirSync(dir); });
const pass: BackupGateDeps = { hidden: () => false, registered: () => true, routes: () => ({ ok: true }), billingAllowed: () => true, atLimit: () => false };

describe("backupGate", () => {
  it("refuses a hidden engine even when every other step passes", () => {
    expect(backupGate({ ...pass, hidden: (id) => id === "kimi" })(from, kimi, 1)).toEqual({ ok: false, reason: "hidden" });
  });
  it("names removed, route and billing in that order", () => {
    expect(backupGate({ ...pass, registered: () => false, routes: () => ({ ok: false, code: "unavailable" }) })(from, kimi)).toEqual({ ok: false, reason: "removed" });
    expect(backupGate({ ...pass, routes: () => ({ ok: false, code: "needs-sign-in" }), billingAllowed: () => false })(from, kimi)).toEqual({ ok: false, reason: "route" });
    expect(backupGate({ ...pass, billingAllowed: () => false })(from, kimi)).toEqual({ ok: false, reason: "billing" });
  });
  it("checks the backup's own limit only when it must answer now", () => {
    const gate = backupGate({ ...pass, atLimit: () => true });
    expect(gate(from, kimi, 5)).toEqual({ ok: false, reason: "limit" });
    expect(gate(from, kimi)).toEqual({ ok: true });
  });
  it("passes when every step passes", () => { expect(backupGate(pass)(from, kimi, 1)).toEqual({ ok: true }); });
  it("reads live state on every call: a hide between two calls is seen", () => {
    let hidden = false;
    const gate = backupGate({ ...pass, hidden: () => hidden });
    expect(gate(from, kimi, 1).ok).toBe(true);
    hidden = true;
    expect(gate(from, kimi, 1)).toEqual({ ok: false, reason: "hidden" });
  });
  it("says each refusal plainly, with the engine's name", () => {
    for (const reason of ["hidden", "removed", "route", "billing", "limit"] as BackupRefusal[]) {
      const line = backupRefusalLine(reason, "Kimi", "Claude");
      expect(line).toContain("Kimi");
      expect(line).not.toMatch(/—|\bsafe\b|\bfree\b|\bplan\b/i);
    }
    expect(backupRefusalLine("billing", "Kimi", "Claude")).toContain("Claude");
  });
});

// The call sites live in index.ts (one module the server boots from); each is asked at its moment of use.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
const between = (start: string, end: string) => {
  const at = source.indexOf(start);
  expect(at, start).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at + start.length);
  expect(stop, end).toBeGreaterThan(at);
  return source.slice(at, stop);
};

describe("every limit-backup site asks the one gate", () => {
  it("backupUsable is the gate's body, with live deps (no second rule)", () => {
    const body = between("const backupVerdict = backupGate({", "function resolveTurnFor(");
    expect(body).toContain("isHiddenEngine(instanceConfigs(cfg), id)");
    expect(body).toContain("registered: (id) => Boolean(registry.get(id))");
    expect(body).toMatch(/function backupUsable\([^)]*\): boolean \{\s*return backupVerdict\(from, backup, now\)\.ok;/);
  });
  it("#1 the PUT refuses with the gate's reason and code, after its read", () => {
    const put = between("/limit-backup$/", "const visible = wireBot(store.bot(record.id)!");
    const read = put.indexOf("await readBody(req)");
    const gate = put.indexOf("backupVerdict(record.modelSelection, selection)");
    expect(read).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(read);
    expect(put).toContain("code: verdict.reason");
    expect(put).not.toContain("another plan");
  });
  it("#2 the card answer starts first and keeps nothing on a refusal", () => {
    const card = between("function answerLimitCard(", "\n}\n");
    const start = card.indexOf("failOverThread(");
    expect(card.indexOf("backupVerdict(offer.from, answer.choice.selection, now)")).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    expect(card.indexOf("answered: answer.choice.label")).toBeGreaterThan(start);
    expect(card.indexOf("limitBackup: { selection")).toBeGreaterThan(start);
    expect(card).toContain("This conversation is gone.");
  });
  it("#3 the automatic failover says why a saved backup did not take over", () => {
    const direct = between("function onDirectLimitTurnCompleted(", "bus.subscribe(");
    expect(direct).toContain("backupVerdict(turn.selection, backup, now)");
    // presence first: a missing call (-1) must never pass an ordering check
    const why = direct.indexOf("backupRefusalOf(verdict.reason, turn.selection, backup)");
    const plain = direct.indexOf("plainLimitLine(");
    expect(why).toBeGreaterThan(-1);
    expect(plain).toBeGreaterThan(-1);
    expect(why).toBeLessThan(plain);
  });
  it("#4 r5: the card's choices are checked in the same synchronous step that posts it", () => {
    // postKept filters inside the continuation that calls appendMessage: no continuation sits between the check and the post
    const direct = between("void postKept(limitChoicesFor(turn.selection, now), (c) => backupUsable(turn.selection, c.selection, Date.now()), (choices) => {", "}).catch(");
    expect(direct.indexOf("store.appendMessage")).toBeGreaterThan(-1);
    expect(direct).not.toMatch(/\bawait\b|\.then\(/);
    expect(source).not.toContain("keptAfter(limitChoicesFor(");
  });
  it("#13 r5: the picker's reply is cut again after its last await, right before it is sent", () => {
    const route = between("if (method === \"GET\" && path === \"/api/instances\") {", "\n    }\n");
    const last = route.lastIndexOf("await ");
    const cut = route.indexOf("const instances = stillOffered(discovered, (id) => registry.has(id) && !isHiddenEngine(instanceConfigs(cfg), id));");
    const reply = route.indexOf("return json(res, 200, { instances,");
    expect(last).toBeGreaterThan(-1);
    expect(cut).toBeGreaterThan(last);
    expect(reply).toBeGreaterThan(cut);
    expect(route.slice(cut, reply)).not.toMatch(/\bawait\b/);
  });
  it("r5 Low: a room goal keeps the backup's own refusal line in its result", () => {
    expect(source).toContain("orchestration.result.stopReason = (e.stopReason === \"submission_refused\" && lateBackupLine) || (e.stopReason ?? null);");
    expect(source).not.toContain("orchestration.result.stopReason = e.stopReason ?? null;");
  });
  it("#5 the listing cuts a hidden engine before its snapshot", () => {
    const list = between("async function limitChoicesFor(", "function failOverThread(");
    expect(list.indexOf("backupUsable(from, selection, now)")).toBeGreaterThan(-1);
    expect(list.indexOf("backupUsable(from, selection, now)")).toBeLessThan(list.indexOf("await instance.snapshot()"));
  });
  it("#6/#7 routines resolve through the gate and say why a saved backup was refused", () => {
    expect(between("function resolveTurnFor(", "function applyTurnRestore(")).toContain("backupUsable(owner.modelSelection, backup!.selection, now)");
    const routine = between("function routineLimitRefusal(", "function channelLimitNotice(");
    expect(routine).toContain("backupVerdict(owner.modelSelection, owner.limitBackup.selection, now)");
    expect(routine).toMatch(/putLimitLine\(run\.threadId, undefined, backupRefusalOf\(/);
  });
  it("#8 every failover start passes the gate first", () => {
    const start = between("function failOverThread(", "function resendFailover(");
    expect(start.indexOf("backupVerdict(turn.selection, to, now)")).toBeGreaterThan(-1);
    expect(start.indexOf("backupVerdict(turn.selection, to, now)")).toBeLessThan(start.indexOf("limitFailovers.startFrom("));
    expect(start).toContain("return null;");
  });
  it("#9 restart recovery gates apply and resend, and writes the chat before the row", () => {
    const boot = between("function recoverLimitFailovers(", "function onDirectLimitTurnCompleted(");
    // the order of the steps is runBootRecovery's, run below; this names the wiring it runs with
    expect(boot).toContain("runBootRecovery(limitFailovers.list(), {");
    expect(boot).toContain("verdict: (row, at) => backupVerdict(row.from, row.to, at)");
    expect(boot).toContain("refuseFailover(row, reason, failoverRefusalSteps(row))");
    expect(boot).toContain("resend: resendFailover");
    // a new failover settles a carried refusal before it reads what the chat "was"
    const start = between("function failOverThread(", "function resendFailover(");
    expect(start.indexOf("settleCarriedRefusal(carriedRow, failoverRefusalSteps(carriedRow))")).toBeGreaterThan(-1);
    expect(start.indexOf("settleCarriedRefusal(carriedRow, failoverRefusalSteps(carriedRow))")).toBeLessThan(start.indexOf("const task = store.taskByThread("));
    expect(start.indexOf("const task = store.taskByThread(")).toBeLessThan(start.indexOf("limitFailovers.startFrom("));
    // a marked row whose chat could not go back never runs a turn on the backup, whatever the gate says
    const allowed = between("targetAllowed: (rowId) => {", "backupRefusalOf(verdict.reason");
    expect(allowed.indexOf("if (row.refusing) return { ok: false")).toBeGreaterThan(-1);
    expect(allowed.indexOf("if (row.refusing) return { ok: false")).toBeLessThan(allowed.indexOf("backupVerdict(row.from, row.to)"));
  });
  describe("#9 a crash at each step of a refusal (real row store; U22-REFUSAL-CRASH-NOTE)", () => {
    class Crash extends Error {}
    type Point = "after-line" | "after-mark" | "before-chat" | "after-chat" | "none";
    const spare = { instanceId: "spare", model: "m" };
    const was = { instanceId: "old", model: "o" };
    function world(state: "pending" | "applied", carried: boolean, previous: "following" | typeof was) {
      const dir = mkdtempSync(join(tmpdir(), "limit-refusal-"));
      dirs.push(dir);
      const rows = new LimitFailoverStore(() => dir);
      const created = rows.create({ botId: "b", threadId: "t", from, was: previous, to: spare, resetsAt: Date.now() + 3_600_000, at: Date.now(), sourceMessageId: "m" });
      if (state === "applied") rows.setState(created.rowId, "applied");
      const onWas = previous === "following" ? undefined : previous;
      const chat: { modelSelection?: typeof was; limitFailover?: string } = carried ? { modelSelection: spare, limitFailover: created.rowId } : { modelSelection: onWas };
      const lines: string[] = [];
      const steps = (crash: Point): FailoverRefusalSteps => ({
        line: (reason) => { lines.push(reason); if (crash === "after-line") throw new Crash(); },
        chatCarries: (row) => chat.limitFailover === row.rowId,
        chatBack: () => { if (crash === "before-chat") throw new Crash(); chat.modelSelection = onWas; chat.limitFailover = undefined; if (crash === "after-chat") throw new Crash(); return true; },
        markRefusing: (rowId, reason, carries) => { rows.markRefusing(rowId, reason, carries); if (crash === "after-mark") throw new Crash(); },
        cancel: (rowId) => rows.cancel(rowId),
      });
      const calls = { gate: 0, resend: 0 };
      let recorded = false;
      // a real boot: the row store read from disk, the real step order, the gate and the resend counted
      const recover = (gate: "allows" | "refuses") => runBootRecovery(rows.list(), {
        taskOf: () => chat,
        resendRecorded: () => recorded,
        verdict: () => { calls.gate += 1; return gate === "allows" ? { ok: true } : { ok: false, reason: "hidden" }; },
        refuse: (row, reason) => refuseFailover(row, reason, steps("none")),
        cancel: (rowId) => rows.cancel(rowId),
        markApplied: (rowId) => rows.setState(rowId, "applied"),
        apply: (row) => { chat.modelSelection = row.to as typeof was; chat.limitFailover = row.rowId; return true; },
        resend: () => { calls.resend += 1; recorded = true; },
        failed: (error) => { throw error; },
      }, Date.now());
      return { dir, rows, id: created.rowId, chat, lines, onWas, steps, calls, recover, boot: () => bootRecovery(rows.list(), () => chat, () => false, Date.now()) };
    }
    const cases = [
      { name: "applied, chat on the backup", state: "applied", carried: true },
      { name: "pending, chat on the backup", state: "pending", carried: true },
      { name: "pending, chat still on its old pick", state: "pending", carried: false },
    ] as const;
    for (const { name, state, carried } of cases) for (const previous of ["following", was] as const) for (const point of ["after-mark", "after-chat"] as const) {
      if (!carried && point === "after-chat") continue;
      it(`${name}, was ${previous === "following" ? "following" : "a pick"}, crash ${point}: boot finishes it with no gate, line or resend, the gate now allowing`, () => {
        const w = world(state, carried, previous);
        expect(() => refuseFailover(w.rows.get(w.id)!, "hidden", w.steps(point))).toThrow(Crash);
        // the mark is on disk: the next boot reads a new copy of the row
        expect(w.boot().map((action) => action.kind)).toEqual(["finish-refusal"]);
        w.recover("allows");
        expect(w.calls).toEqual({ gate: 0, resend: 0 });
        expect(w.rows.get(w.id)?.state).toBe("cancelled");
        expect(w.chat.limitFailover).toBeUndefined();
        expect(w.chat.modelSelection).toEqual(w.onWas);
        expect(w.lines).toEqual(["hidden"]);
        expect(w.boot()).toEqual([]);
      });
    }
    it("a crash after the line and before the mark commits no refusal: the gate decides again, with at most one resend", () => {
      const allowed = world("applied", true, "following");
      expect(() => refuseFailover(allowed.rows.get(allowed.id)!, "hidden", allowed.steps("after-line"))).toThrow(Crash);
      expect(allowed.rows.get(allowed.id)?.refusing).toBeUndefined();
      // the gate allows now: one resend under the one stale line, and a later boot sends no other
      allowed.recover("allows");
      expect(allowed.calls).toEqual({ gate: 1, resend: 1 });
      expect(allowed.lines).toEqual(["hidden"]);
      allowed.recover("allows");
      expect(allowed.calls.resend).toBe(1);
      // the gate still refuses: the line again, then finished, and no turn
      const refused = world("applied", true, "following");
      expect(() => refuseFailover(refused.rows.get(refused.id)!, "hidden", refused.steps("after-line"))).toThrow(Crash);
      refused.recover("refuses");
      expect(refused.calls.resend).toBe(0);
      expect(refused.lines).toEqual(["hidden", "hidden"]);
      expect(refused.rows.get(refused.id)?.state).toBe("cancelled");
      expect(refused.boot()).toEqual([]);
      // repeated crashes in this window add a line each, and still no turn
      const repeated = world("applied", true, "following");
      expect(() => refuseFailover(repeated.rows.get(repeated.id)!, "hidden", repeated.steps("after-line"))).toThrow(Crash);
      expect(() => refuseFailover(repeated.rows.get(repeated.id)!, "hidden", repeated.steps("after-line"))).toThrow(Crash);
      repeated.recover("refuses");
      expect(repeated.lines).toEqual(["hidden", "hidden", "hidden"]);
      expect(repeated.calls.resend).toBe(0);
    });
    it("a pending row refused in one pass takes no further step, and an unmarked row refused in a pass runs no resend", () => {
      const w = world("pending", true, "following");
      w.recover("refuses");
      // mark-applied and resend are both planned for this row: the first is refused and the second never reaches the gate
      expect(w.calls).toEqual({ gate: 1, resend: 0 });
      expect(w.rows.get(w.id)?.state).toBe("cancelled");
      expect(w.lines).toEqual(["hidden"]);
    });
    it("a chat that went back and whose row could not be cancelled still fails over; a chat still on the backup does not", () => {
      const back = world("applied", true, was);
      back.rows.markRefusing(back.id, "hidden", true);
      const failing = () => { throw new Crash(); };
      expect(settleCarriedRefusal(back.rows.get(back.id), { ...back.steps("none"), cancel: failing })).toBe(true);
      expect(back.chat).toEqual({ modelSelection: was, limitFailover: undefined });
      // the mark stays, so the next boot finishes the row
      expect(back.rows.get(back.id)?.refusing).toBe("hidden");
      expect(back.boot().map(action => action.kind)).toEqual(["finish-refusal"]);
      const stuck = world("applied", true, was);
      stuck.rows.markRefusing(stuck.id, "hidden", true);
      expect(settleCarriedRefusal(stuck.rows.get(stuck.id), stuck.steps("before-chat"))).toBe(false);
      expect(stuck.chat.limitFailover).toBe(stuck.id);
    });
    it("a new failover settles a carried refusal first, so the refused backup never becomes what the chat was", () => {
      const w = world("applied", true, was);
      const steps = { ...w.steps("none"), chatBack: () => false };
      expect(() => refuseFailover(w.rows.get(w.id)!, "hidden", steps)).toThrow(/could not go back/);
      // the chat could not go back: no failover starts, the mark stays
      expect(settleCarriedRefusal(w.rows.get(w.id), steps)).toBe(false);
      expect(w.chat.modelSelection).toEqual(spare);
      expect(w.rows.get(w.id)?.refusing).toBe("hidden");
      // it can now: the chat is on its own pick before the new row reads it, with no second line
      expect(settleCarriedRefusal(w.rows.get(w.id), w.steps("none"))).toBe(true);
      expect(w.chat).toEqual({ modelSelection: was, limitFailover: undefined });
      expect(w.rows.get(w.id)?.state).toBe("cancelled");
      expect(w.lines).toEqual(["hidden"]);
      // an ordinary carried row is untouched, and a finished one too
      const ordinary = world("applied", true, was);
      expect(settleCarriedRefusal(ordinary.rows.get(ordinary.id), ordinary.steps("none"))).toBe(true);
      expect(ordinary.chat.limitFailover).toBe(ordinary.id);
      expect(settleCarriedRefusal(undefined, ordinary.steps("none"))).toBe(true);
    });
    describe("a refused backup is never a restore point, in any order of events", () => {
      const third = { instanceId: "third", model: "t" };
      const noGate: TurnSelectionDeps = { routes: () => ({ ok: true }), failoverRow: () => undefined, atLimit: () => false, routineBackupAllowed: () => false };
      const later = () => Date.now() + 7_200_000;
      /** Two hops: the chat is on backup `spare` under row 1, that backup hits its limit, and row 2 moves the chat to `third`. */
      function twoHops(previous: "following" | typeof was) {
        const w = world("applied", true, previous);
        const second = w.rows.startFrom(w.chat, { botId: "b", threadId: "t", from: spare, to: third, resetsAt: later() + 60_000, at: Date.now(), sourceMessageId: "m2" });
        w.chat.modelSelection = third; w.chat.limitFailover = second.rowId;
        w.rows.setState(second.rowId, "applied");
        return { ...w, first: w.id, second: second.rowId, previous };
      }
      for (const previous of ["following", was] as const) {
        const label = previous === "following" ? "following" : "a pick";
        it(`the backup a new failover leaves is not what the chat was (was ${label})`, () => {
          const w = twoHops(previous);
          expect(w.rows.get(w.second)?.was).toEqual(previous);
          expect(w.rows.get(w.second)?.wasChecked).toBe(true);
        });
        it(`a refusal of that backup arriving after the new row exists changes nothing it can restore (was ${label})`, () => {
          const w = twoHops(previous);
          w.rows.markRefusing(w.first, "hidden", false);
          w.recover("allows");
          expect(w.rows.get(w.first)?.state).toBe("cancelled");
          expect(w.chat).toEqual({ modelSelection: third, limitFailover: w.second });
          expect(w.rows.get(w.second)?.was).toEqual(previous);
        });
        it(`the restore at the reset goes to the chat's own pick, never the old backup (was ${label})`, () => {
          const w = twoHops(previous);
          const deps = { ...noGate, failoverRow: (id: string) => w.rows.get(id) };
          const resolved = resolveTurnSelection(w.chat, { name: "Ember", modelSelection: from }, { routine: false }, later() + 120_000, deps);
          expect(resolved.restore?.to).toEqual(previous);
          expect(resolved.selection).toEqual(previous === "following" ? from : previous);
        });
        it(`the new row's backup refused goes back to the chat's own pick (was ${label})`, () => {
          const w = twoHops(previous);
          const deps = { ...noGate, failoverRow: (id: string) => w.rows.get(id), targetAllowed: () => ({ ok: false as const, line: "no" }) };
          const resolved = resolveTurnSelection(w.chat, { name: "Ember", modelSelection: from }, { routine: false }, Date.now(), deps);
          expect(resolved.restore?.to).toEqual(previous);
          const marked = w.rows.get(w.second)!;
          refuseFailover(marked, "hidden", { ...w.steps("none"), chatBack: () => { w.chat.modelSelection = marked.was === "following" ? undefined : marked.was as typeof was; w.chat.limitFailover = undefined; return true; } });
          expect(w.chat.modelSelection).toEqual(previous === "following" ? undefined : previous);
        });
        it(`a crash before the chat moves leaves the old backup out of every restore (was ${label})`, () => {
          const w = world("applied", true, previous);
          const second = w.rows.startFrom(w.chat, { botId: "b", threadId: "t", from: spare, to: third, resetsAt: later(), at: Date.now(), sourceMessageId: "m2" });
          // the chat still carries row 1: the new pending row is dropped at boot, and row 1 keeps its own restore point
          w.recover("allows");
          expect(w.rows.get(second.rowId)?.state).toBe("cancelled");
          expect(w.chat.limitFailover).toBe(w.id);
          expect(w.rows.get(w.id)?.was).toEqual(previous);
        });
      }
      it("the new row ends when the chat's own pick is back, not when the backup's limit ends", () => {
        const w = world("applied", true, was);
        const first = w.rows.get(w.id)!;
        const second = w.rows.startFrom(w.chat, { botId: "b", threadId: "t", from: spare, to: third, resetsAt: first.resetsAt! + 3_600_000, at: Date.now(), sourceMessageId: "m2" });
        expect(second.resetsAt).toBe(first.resetsAt);
      });
      it("a pick the owner made is kept: a chat that carries no marker", () => {
        const w = world("applied", true, was);
        const ownReset = later();
        const free = w.rows.startFrom({ modelSelection: spare }, { botId: "b", threadId: "t", from: spare, to: third, resetsAt: ownReset, at: Date.now(), sourceMessageId: "m3" });
        expect(free.was).toEqual(spare);
        expect(free.resetsAt).toBe(ownReset);
        const following = w.rows.startFrom({}, { botId: "b", threadId: "t", from, to: third, resetsAt: ownReset, at: Date.now(), sourceMessageId: "m4" });
        expect(following.was).toBe("following");
      });
      it("a stale-model repair on the backup does not turn it into a pick: the marker says what the chat is on", () => {
        const w = world("applied", true, was);
        const first = w.rows.get(w.id)!;
        const repaired = { ...spare, model: "m-new" };
        const second = w.rows.startFrom({ modelSelection: repaired, limitFailover: w.id }, { botId: "b", threadId: "t", from: repaired, to: third, resetsAt: later(), at: Date.now(), sourceMessageId: "m5" });
        expect(second.was).toEqual(was);
        expect(second.resetsAt).toBe(first.resetsAt);
      });
      it("a marker whose row is gone holds no restore point: the new row follows the bot, never the backup", () => {
        const w = world("applied", true, was);
        const second = w.rows.startFrom({ modelSelection: spare, limitFailover: "gone" }, { botId: "b", threadId: "t", from: spare, to: third, resetsAt: later(), at: Date.now(), sourceMessageId: "m6" });
        expect(second.was).toBe("following");
      });
      describe("a chat on a backup with no open row goes back on its next turn", () => {
        const bot = { name: "Ember", modelSelection: from };
        it("no row at all", () => {
          const resolved = resolveTurnSelection({ modelSelection: spare, limitFailover: "gone" }, bot, { routine: false }, Date.now(), noGate);
          expect(resolved.selection).toEqual(from);
          expect(resolved.restore).toEqual({ rowId: "gone", to: "following" });
        });
        it("a cancelled row, with the reset still ahead", () => {
          const w = world("applied", true, was);
          w.rows.cancel(w.id);
          const resolved = resolveTurnSelection(w.chat, bot, { routine: false }, Date.now(), { ...noGate, failoverRow: (id) => w.rows.get(id) });
          expect(resolved.selection).toEqual(was);
          expect(resolved.restore).toEqual({ rowId: w.id, to: was });
        });
        describe("a row file that can't be read proves nothing: this turn runs on the bot, and the marker and the chat's model stay", () => {
          for (const [name, text] of [["not JSON", "{ cut off"], ["not a list", "{\"rows\":[]}"]] as const) {
            it(name, () => {
              const w = world("applied", true, was);
              const file = join(w.dir, "limit-failovers.json");
              const good = readFileSync(file, "utf8");
              writeFileSync(file, text);
              const deps = { ...noGate, failoverRow: (id: string) => w.rows.get(id), rowsUnreadable: () => w.rows.unreadable() };
              const resolved = resolveTurnSelection(w.chat, bot, { routine: false }, Date.now(), deps);
              expect(resolved.selection).toEqual(from);
              expect(resolved.restore).toBeUndefined();
              expect(resolved.backupFrom).toBeUndefined();
              // the file reads again: the row is back, with its gate
              writeFileSync(file, good);
              const next = resolveTurnSelection(w.chat, bot, { routine: false }, Date.now(), deps);
              expect(next.selection).toEqual(spare);
              expect(next.backupFrom).toEqual(from);
            });
          }
          it("a file that isn't there is readable: no rows, so the chat goes back", () => {
            const dir = mkdtempSync(join(tmpdir(), "limit-refusal-"));
            dirs.push(dir);
            const rows = new LimitFailoverStore(() => dir);
            expect(rows.unreadable()).toBe(false);
            const resolved = resolveTurnSelection({ modelSelection: spare, limitFailover: "gone" }, bot, { routine: false }, Date.now(), { ...noGate, failoverRow: (id) => rows.get(id), rowsUnreadable: () => rows.unreadable() });
            expect(resolved.restore).toEqual({ rowId: "gone", to: "following" });
          });
          it("the index asks", () => {
            expect(between("function resolveTurnFor(", "function applyTurnRestore(")).toContain("rowsUnreadable: () => limitFailovers.unreadable()");
          });
        });
      });
      describe("a failover that will not resend (a via line)", () => {
        it("takes the chat back before it cancels the row, so no backup stays as a pick", () => {
          const w = world("applied", true, was);
          dropFailover(w.rows.get(w.id)!, w.steps("none"));
          expect(w.chat).toEqual({ modelSelection: was, limitFailover: undefined });
          expect(w.rows.get(w.id)?.state).toBe("cancelled");
        });
        const stillGated = (w: ReturnType<typeof world>) => {
          expect(w.chat).toEqual({ modelSelection: spare, limitFailover: w.id });
          expect(w.rows.get(w.id)?.state).toBe("applied");
          const next = resolveTurnSelection(w.chat, { name: "Ember", modelSelection: from }, { routine: false }, Date.now(), { ...noGate, failoverRow: (id) => w.rows.get(id) });
          expect(next.selection).toEqual(spare);
          expect(next.backupFrom).toEqual(from);
        };
        it("a chat whose save threw is still on the backup under its row, so its next turn is gated", () => {
          const w = world("applied", true, was);
          expect(() => dropFailover(w.rows.get(w.id)!, w.steps("before-chat"))).toThrow(Crash);
          stillGated(w);
        });
        it("a chat that answers false is the same: the row is not cancelled under its marker", () => {
          const w = world("applied", true, was);
          expect(() => dropFailover(w.rows.get(w.id)!, { ...w.steps("none"), chatBack: () => false })).toThrow(/could not go back/);
          stillGated(w);
        });
        it("the index takes that path", () => {
          const via = between("function resendFailover(", "function resendRecorded(");
          expect(via).toContain("dropFailover(row, failoverRefusalSteps(row))");
          expect(via).not.toContain("limitFailovers.cancel(");
        });
      });
      it("an open row outlives the 30 days, however long its chat sits idle; a finished one ages out", () => {
        const dir = mkdtempSync(join(tmpdir(), "limit-refusal-"));
        dirs.push(dir);
        let clock = Date.now();
        const rows = new LimitFailoverStore(() => dir, () => clock);
        const open = rows.startFrom({}, { botId: "b", threadId: "open", from, to: spare, resetsAt: clock + 1000, at: clock, sourceMessageId: "m" });
        rows.setState(open.rowId, "applied");
        const finished = rows.startFrom({}, { botId: "b", threadId: "done", from, to: spare, resetsAt: clock + 1000, at: clock, sourceMessageId: "m" });
        rows.cancel(finished.rowId);
        clock += 31 * 24 * 60 * 60_000;
        rows.startFrom({}, { botId: "b", threadId: "new", from, to: spare, resetsAt: clock + 1000, at: clock, sourceMessageId: "m" });
        expect(rows.get(open.rowId)?.state).toBe("applied");
        expect(rows.get(finished.rowId)).toBeUndefined();
      });
      describe("rows from before this check", () => {
        const bot = { name: "Ember", modelSelection: from };
        const at = Date.now();
        /** Only row 2 of a chain on disk, written by an old build: row 1 has aged out, so nothing says `spare` was ever a backup. */
        const agedOut = { rowId: "r2", state: "applied", botId: "b", threadId: "t", from: spare, was: spare, to: third, resetsAt: at + 9000, at, sourceMessageId: "m", resendSendId: "s2", hop: 1, updatedAt: at };
        function onDisk(...saved: object[]) {
          const dir = mkdtempSync(join(tmpdir(), "limit-refusal-"));
          dirs.push(dir);
          const file = join(dir, "limit-failovers.json");
          writeFileSync(file, JSON.stringify(saved));
          return { file, rows: new LimitFailoverStore(() => dir) };
        }
        const carrying = { modelSelection: third, limitFailover: "r2" };
        describe("a row whose earlier row has aged out never brings its backup back", () => {
          it("at its reset", () => {
            const { rows } = onDisk(agedOut);
            const resolved = resolveTurnSelection(carrying, bot, { routine: false }, at + 10_000, { ...noGate, failoverRow: (id) => rows.get(id) });
            expect(resolved.selection).toEqual(from);
            expect(resolved.restore).toEqual({ rowId: "r2", to: "following" });
            expect(resolved.backupFrom).toBeUndefined();
          });
          it("when its backup is refused on a turn", () => {
            const { rows } = onDisk(agedOut);
            const resolved = resolveTurnSelection(carrying, bot, { routine: false }, at + 1000, { ...noGate, failoverRow: (id) => rows.get(id), targetAllowed: () => ({ ok: false, line: "no" }) });
            expect(resolved.selection).toEqual(from);
            expect(resolved.restore).toEqual({ rowId: "r2", to: "following" });
          });
          it("when it is refused at boot", () => {
            const { rows } = onDisk(agedOut);
            const chat: { modelSelection?: typeof third; limitFailover?: string } = { ...carrying };
            refuseFailover(rows.get("r2")!, "hidden", {
              line: () => {},
              chatCarries: (row) => chat.limitFailover === row.rowId,
              chatBack: (row) => { chat.modelSelection = row.was === "following" ? undefined : row.was; chat.limitFailover = undefined; return true; },
              markRefusing: (rowId, reason, carries) => rows.markRefusing(rowId, reason, carries),
              cancel: (rowId) => rows.cancel(rowId),
            });
            expect(chat).toEqual({ modelSelection: undefined, limitFailover: undefined });
          });
          it("through a new row started on top of it", () => {
            const { rows } = onDisk(agedOut);
            const next = rows.startFrom(carrying, { botId: "b", threadId: "t", from: third, to: kimi, resetsAt: at + 50_000, at: at + 1, sourceMessageId: "m" });
            expect(next.was).toBe("following");
            expect(next.resetsAt).toBe(at + 9000);
          });
        });
        it("the first row of a chain cannot prove itself either: every old pin goes, the row keeps its reset, and a chat already following is unchanged", () => {
          const first = { ...agedOut, rowId: "r1", from, was, to: spare, resetsAt: at + 5000 };
          const following = { ...agedOut, rowId: "r3", threadId: "other", from, was: "following", to: spare, resetsAt: at + 3000 };
          const { rows } = onDisk(first, agedOut, following);
          expect(rows.get("r1")).toMatchObject({ was: "following", resetsAt: at + 5000, wasChecked: true });
          expect(rows.get("r2")).toMatchObject({ was: "following", resetsAt: at + 9000, wasChecked: true });
          expect(rows.get("r3")).toMatchObject({ was: "following", resetsAt: at + 3000, wasChecked: true });
        });
        it("no write has to succeed: with writes failing, a turn still gets the right answer from the read", () => {
          const { file, rows } = onDisk(agedOut);
          const before = readFileSync(file, "utf8");
          writes.fail = true;
          try {
            expect(() => rows.setState("r2", "applied")).toThrow("disk full");
            expect(rows.get("r2")?.was).toBe("following");
            const resolved = resolveTurnSelection(carrying, bot, { routine: false }, at + 10_000, { ...noGate, failoverRow: (id) => rows.get(id) });
            expect(resolved.selection).toEqual(from);
          } finally { writes.fail = false; }
          expect(readFileSync(file, "utf8")).toBe(before);
        });
        it("the next write that succeeds saves the correction", () => {
          const { file, rows } = onDisk(agedOut);
          rows.cancel("r2");
          expect(JSON.parse(readFileSync(file, "utf8"))[0]).toMatchObject({ rowId: "r2", was: "following", wasChecked: true });
        });
        it("no row this build writes is ever old: a pinned `was` survives every read, beside an old row, whatever `create` is passed", () => {
          const { file, rows } = onDisk(agedOut);
          const owned = rows.startFrom({ modelSelection: spare }, { botId: "b", threadId: "owned", from: spare, to: third, resetsAt: at + 9000, at, sourceMessageId: "m" });
          const made = rows.create({ botId: "b", threadId: "made", from, was, to: spare, resetsAt: at + 9000, at, sourceMessageId: "m", wasChecked: undefined } as Parameters<typeof rows.create>[0]);
          rows.setState(owned.rowId, "applied");
          expect(rows.get(owned.rowId)).toMatchObject({ was: spare, resetsAt: at + 9000 });
          expect(rows.get(made.rowId)?.was).toEqual(was);
          const saved = JSON.parse(readFileSync(file, "utf8")) as Array<{ rowId: string; was: unknown; wasChecked?: true }>;
          expect(saved.find(row => row.rowId === owned.rowId)).toMatchObject({ was: spare, wasChecked: true });
          expect(saved.find(row => row.rowId === made.rowId)).toMatchObject({ was, wasChecked: true });
          expect(rows.get("r2")?.was).toBe("following");
        });
        it("an old pending row its chat never carried: boot cancels it and the chat keeps its pin, with no resend", () => {
          const { rows } = onDisk({ ...agedOut, state: "pending", from, was, to: spare, resetsAt: Date.now() + 60_000 });
          const pinned = { modelSelection: was };
          expect(bootRecovery(rows.list(), () => pinned, () => false, Date.now()).map(action => action.kind)).toEqual(["cancel"]);
          expect(pinned.modelSelection).toEqual(was);
        });
      });
      it("there is one way to start a row", () => {
        expect(between("function failOverThread(", "function resendFailover(")).toContain("limitFailovers.startFrom(task, {");
        expect(source.includes("limitFailovers.create(")).toBe(false);
      });
    });
    it("a chat that could not go back keeps the row marked for the next boot", () => {
      const w = world("applied", true, "following");
      const steps = { ...w.steps("none"), chatBack: () => false };
      expect(() => refuseFailover(w.rows.get(w.id)!, "hidden", steps)).toThrow(/could not go back/);
      expect(w.rows.get(w.id)).toMatchObject({ state: "applied", refusing: "hidden" });
      expect(w.boot().map((action) => action.kind)).toEqual(["finish-refusal"]);
    });
    it("the mark moves a carried pending row to applied in one write, and a finished row is never marked again", () => {
      const carried = world("pending", true, "following");
      expect(carried.rows.markRefusing(carried.id, "removed", true)).toMatchObject({ state: "applied", refusing: "removed" });
      const uncarried = world("pending", false, "following");
      expect(uncarried.rows.markRefusing(uncarried.id, "removed", false)).toMatchObject({ state: "pending", refusing: "removed" });
      carried.rows.cancel(carried.id);
      expect(carried.boot()).toEqual([]);
      const ended = world("applied", true, "following");
      ended.rows.cancel(ended.id);
      expect(ended.rows.markRefusing(ended.id, "removed", true)?.refusing).toBeUndefined();
    });
  });
  it("#10 a later turn on an applied failover asks the gate (turn-selection targetAllowed)", () => {
    const resolver = between("function resolveTurnFor(", "function applyTurnRestore(");
    expect(resolver).toMatch(/targetAllowed: \(rowId\) =>/);
    expect(resolver).toContain("backupVerdict(row.from, row.to)");
  });
  it("#11/#12 the direct and room dispatch boundaries ask the gate after setup", () => {
    const boundaries = source.split("beforeSubmit: () => submissionBoundary.beforeSubmit(() => {");
    expect(boundaries.length).toBe(3);
    for (const after of boundaries.slice(1)) expect(after.slice(0, 600)).toContain("assertBackupStillUsable(");
    // r4 M1: the provenance the resolver carried, never the chat re-read at dispatch
    expect(boundaries[1].slice(0, 900)).toContain("assertBackupStillUsable(turnSelection.backupFrom, turnSelection.selection, Date.now())");
    expect(boundaries[2].slice(0, 900)).toContain("assertBackupStillUsable(roomTurnSelection.backupFrom, roomTurnSelection.selection, Date.now())");
    const boundary = between("function assertBackupStillUsable(", "\n}\n");
    expect(boundary).toContain("assertBackupAtDispatch(backupVerdict, backupFrom, selection, now, backupRefusalOf)");
    expect(boundary).not.toMatch(/store\.|limitFailovers\./);
  });
  it("#13 the picker reads the hidden list after the snapshot await", async () => {
    // int1018 b8 1651c2e9e ported U22 G20/#13 onto the mapped instance scan (1d800ddbc): the registration and the hidden list are read
    // inside the map, and the map runs only after the scan's await, so an engine removed or hidden meanwhile is not listed.
    const at = source.indexOf("const describedInstances = mappedInstanceScan(registry, rows => {");
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, source.indexOf("\n});", at));
    expect(body).toContain("const configured = instanceConfigs(cfg);");
    expect(body).toContain("withoutHiddenEngines(mapClaudeAccountInstances(rows, configured), configured).filter(entry => registry.has(entry.instanceId))");
    // the scan's map runs after the flight resolves, once per flight, for every caller that joined it
    const snapshot = held<Array<{ instanceId: string }>>();
    const flight = Object.freeze({ epoch: 0, seq: 1, run: snapshot.promise });
    const publishScan = vi.fn();
    const registered = new Set(["claude", "kimi", "spare"]);
    const hiddenIds = new Set<string>();
    const scan = mappedInstanceScan({ describeFlight: () => flight, publishScan } as unknown as Parameters<typeof mappedInstanceScan>[0],
      (rows) => rows.filter((entry) => registered.has(entry.instanceId) && !hiddenIds.has(entry.instanceId)) as typeof rows);
    const first = scan({ catalogs: "due" });
    await Promise.resolve();
    registered.delete("kimi"); hiddenIds.add("spare");
    const joined = scan({ catalogs: "due" });
    snapshot.release([{ instanceId: "claude" }, { instanceId: "kimi" }, { instanceId: "spare" }]);
    expect((await first).map((entry) => entry.instanceId)).toEqual(["claude"]);
    expect(await joined).toBe(await first);
    expect(publishScan).toHaveBeenCalledTimes(1);
  });
  it("r4 Low: a late backup refusal keeps its own line on the direct and room settlements", () => {
    expect(source).toContain("(kind === \"not-started\" ? backupRefusalMessage(submissionBoundary.refusedWith) : undefined) ?? turnRefusedLine(engineNameOf(instance), kind)");
    expect(source).toContain("lateBackupLine = backupRefusalMessage(refusal) ?? lateBackupLine;");
    expect(source).toMatch(/e\.stopReason === "submission_refused" && lateBackupLine\) turnFailure = lateBackupLine;/);
  });
});

// r4: the races hold a REAL await (the previous tests only read code order)
const held = <T,>() => { let release!: (value: T) => void; const promise = new Promise<T>((resolve) => { release = resolve; }); return { promise, release }; };
const line = (reason: BackupRefusal, _from: { instanceId: string }, to: { instanceId: string }) => backupRefusalLine(reason, to.instanceId, "Claude");

describe("limit-backup races, with the await held open", () => {
  it("M1: a /use-fuigo and a hide during dispatch setup cannot skip the gate (the resolved provenance is gated)", async () => {
    let hidden = false;
    const gate = backupGate({ ...pass, hidden: (id) => hidden && id === "kimi" });
    const chat: { modelSelection?: typeof kimi; limitFailover?: string } = { modelSelection: kimi, limitFailover: "r1" };
    const row = { rowId: "r1", state: "applied" as const, was: "following" as const, resetsAt: Date.now() + 3_600_000, at: Date.now(), from, to: kimi };
    const deps: TurnSelectionDeps = { routes: () => ({ ok: true }), failoverRow: (id) => (id === "r1" ? row : undefined), atLimit: () => false, routineBackupAllowed: () => false, targetAllowed: () => ({ ok: true }) };
    const setup = held<void>();
    const dispatch = (async () => {
      const resolved = resolveTurnSelection(chat, { name: "Ember", modelSelection: from }, { routine: false }, Date.now(), deps);
      await setup.promise; // the setup awaits (memory, images, session)
      assertBackupAtDispatch(gate, resolved.backupFrom, resolved.selection, Date.now(), line);
      return resolved.selection;
    })();
    await Promise.resolve();
    // during setup: /use-fuigo clears the chat's failover, then the backup is hidden
    delete chat.limitFailover; chat.modelSelection = undefined; hidden = true;
    setup.release();
    await expect(dispatch).rejects.toBeInstanceOf(BackupRefusedError);
    await expect(dispatch).rejects.toThrow("kimi is hidden in Settings");
  });
  it("M1 regression: a usable backup still dispatches, and a turn on the bot's own engine is never gated", async () => {
    const gate = backupGate(pass);
    const setup = held<void>();
    const run = (async () => { await setup.promise; assertBackupAtDispatch(gate, from, kimi, 1, line); assertBackupAtDispatch(backupGate({ ...pass, hidden: () => true }), undefined, from, 1, line); return "sent"; })();
    setup.release();
    await expect(run).resolves.toBe("sent");
  });
  it("M2/#13: an engine removed or hidden while the picker's snapshot await is held open is not listed", async () => {
    const snapshot = held<Array<{ instanceId: string }>>();
    const registered = new Set(["claude", "kimi", "spare"]);
    const hiddenIds = new Set<string>();
    const listing = keptAfter(snapshot.promise, (entry) => registered.has(entry.instanceId) && !hiddenIds.has(entry.instanceId));
    await Promise.resolve();
    registered.delete("kimi"); hiddenIds.add("spare");
    snapshot.release([{ instanceId: "claude" }, { instanceId: "kimi" }, { instanceId: "spare" }]);
    expect((await listing).map((entry) => entry.instanceId)).toEqual(["claude"]);
  });
  it("#4: the card's choices pass the gate when the card is posted, after the held listing", async () => {
    const registered = new Set(["kimi", "spare"]);
    const gate = backupGate({ ...pass, registered: (id) => registered.has(id) });
    const listed = held<Array<{ selection: { instanceId: string; model: string } }>>();
    const posted = keptAfter(listed.promise, (choice) => gate(from, choice.selection, 1).ok);
    await Promise.resolve();
    registered.delete("spare");
    listed.release([{ selection: kimi }, { selection: { instanceId: "spare", model: "s" } }]);
    expect((await posted).map((choice) => choice.selection.instanceId)).toEqual(["kimi"]);
  });
  it("r5 card: a hide that lands AFTER the listing is released and before the post is seen; the engine is not on the card", async () => {
    const hiddenIds = new Set<string>();
    const gate = backupGate({ ...pass, hidden: (id) => hiddenIds.has(id) });
    const listed = held<Array<{ selection: { instanceId: string; model: string } }>>();
    // a hide route continuation already queued on the same release (it resumes after its body await, then mutates config)
    const hideQueued = listed.promise.then(() => { hiddenIds.add("spare"); });
    const posts: string[][] = [];
    const posted = postKept(listed.promise, (choice) => gate(from, choice.selection, 1).ok, (choices) => {
      // the invariant at the moment of posting: every offered engine passes the gate NOW
      expect(choices.every((choice) => gate(from, choice.selection, 1).ok)).toBe(true);
      posts.push(choices.map((choice) => choice.selection.instanceId));
    });
    listed.release([{ selection: kimi }, { selection: { instanceId: "spare", model: "s" } }]);
    await hideQueued; await posted;
    expect(hiddenIds.has("spare")).toBe(true);
    expect(posts).toEqual([["kimi"]]);
  });
  it("r5 card: whatever order a queued hide lands in, the posted card never holds an engine hidden at the moment of posting", async () => {
    // the r5 ordering: the filter accepts, a queued hide runs, then the post. keptAfter + a later .then posted the stale list here.
    const hiddenIds = new Set<string>();
    const gate = backupGate({ ...pass, hidden: (id) => hiddenIds.has(id) });
    const listed = held<Array<{ selection: { instanceId: string; model: string } }>>();
    const violations: string[] = [];
    const posted = postKept(listed.promise, (choice) => gate(from, choice.selection, 1).ok, (choices) => {
      for (const choice of choices) if (!gate(from, choice.selection, 1).ok) violations.push(choice.selection.instanceId);
    });
    const hideAfter = listed.promise.then(() => { hiddenIds.add("spare"); });
    listed.release([{ selection: kimi }, { selection: { instanceId: "spare", model: "s" } }]);
    await posted; await hideAfter;
    expect(violations).toEqual([]);
    // the old shape fails this same ordering (the proof the test bites)
    const oldHidden = new Set<string>();
    const oldGate = backupGate({ ...pass, hidden: (id) => oldHidden.has(id) });
    const oldListed = held<Array<{ selection: { instanceId: string; model: string } }>>();
    const oldViolations: string[] = [];
    const oldPosted = keptAfter(oldListed.promise, (choice) => oldGate(from, choice.selection, 1).ok).then((choices) => {
      for (const choice of choices) if (!oldGate(from, choice.selection, 1).ok) oldViolations.push(choice.selection.instanceId);
    });
    const oldHide = oldListed.promise.then(() => { oldHidden.add("spare"); });
    oldListed.release([{ selection: kimi }, { selection: { instanceId: "spare", model: "s" } }]);
    await oldPosted; await oldHide;
    expect(oldViolations).toEqual(["spare"]);
  });
  it("r5 picker: an engine hidden and one removed after the listing is released are absent from the reply", async () => {
    const snapshot = held<Array<{ instanceId: string }>>();
    const registered = new Set(["claude", "kimi", "spare"]);
    const hiddenIds = new Set<string>();
    const live = (id: string) => registered.has(id) && !hiddenIds.has(id);
    // describedInstances (keptAfter on the snapshot), then the route's own awaits, then the reply
    const described = (async () => keptAfter(snapshot.promise, (entry) => live(entry.instanceId)))();
    const reply = (async () => { const discovered = await described; await Promise.resolve(); return stillOffered(discovered, live); })();
    snapshot.release([{ instanceId: "claude" }, { instanceId: "kimi" }, { instanceId: "spare" }]);
    // after the release: the listing filter already ran, then a hide and a removal land before the reply
    await described;
    registered.delete("kimi"); hiddenIds.add("spare");
    expect((await reply).map((entry) => entry.instanceId)).toEqual(["claude"]);
  });
  it("Low 3: a refusal at a write after the turn id was handed back keeps the backup's own line", () => {
    const boundary = new TurnSubmissionBoundary();
    boundary.started();
    let late: unknown;
    boundary.acceptedBy((refusal) => { late = refusal; });
    expect(() => boundary.beforeSubmit(() => assertBackupAtDispatch(backupGate({ ...pass, registered: () => false }), from, kimi, 1, line))).toThrow(BackupRefusedError);
    expect(backupRefusalMessage(late)).toBe(backupRefusalLine("removed", "kimi", "Claude"));
    expect(backupRefusalMessage(boundary.refusedWith)).toBe(backupRefusalLine("removed", "kimi", "Claude"));
    expect(backupRefusalMessage(new Error("the engine refused"))).toBeUndefined();
    expect(new TurnSubmissionBoundary().refusedWith).toBeUndefined();
  });
});

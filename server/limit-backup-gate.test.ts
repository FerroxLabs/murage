// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U22 G20: the one limit-backup gate, and the place each of the 13 call sites asks it (designs/U22-HIDDEN-BACKUP-CHOKEPOINT.md).
// Each site test names the hole it closes: a hidden or removed engine offered, saved, restored or started.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertBackupAtDispatch, backupGate, backupRefusalLine, backupRefusalMessage, BackupRefusedError, keptAfter, type BackupGateDeps, type BackupRefusal } from "./limit-backup-gate.ts";
import { TurnSubmissionBoundary } from "./turn-dispatch-guard.ts";
import { resolveTurnSelection, type TurnSelectionDeps } from "./turn-selection.ts";

const from = { instanceId: "claude", model: "m" };
const kimi = { instanceId: "kimi", model: "k" };
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
  it("#4 the card's choices are checked again when it is posted, after the snapshot await", () => {
    const direct = between("void keptAfter(limitChoicesFor(turn.selection, now), (c) => backupUsable(turn.selection, c.selection, Date.now())).then(", "}).catch(");
    expect(direct.indexOf("store.appendMessage")).toBeGreaterThan(-1);
    expect(direct).not.toMatch(/\bawait\b/);
  });
  it("#5 the listing cuts a hidden engine before its snapshot", () => {
    const list = between("async function limitChoicesFor(", "function failOverThread(");
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
    expect(start.indexOf("backupVerdict(turn.selection, to, now)")).toBeLessThan(start.indexOf("limitFailovers.create("));
    expect(start).toContain("return null;");
  });
  it("#9 restart recovery gates apply and resend, and writes the chat before the row", () => {
    const boot = between("function recoverLimitFailovers(", "function onDirectLimitTurnCompleted(");
    const gate = boot.indexOf("backupVerdict(action.row.from, action.row.to, now)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(boot.indexOf("action.kind === \"apply\""));
    const refuse = between("function refuseRecoveredFailover(", "function recoverLimitFailovers(");
    expect(refuse.indexOf("store.patchTask(")).toBeLessThan(refuse.indexOf("limitFailovers.cancel("));
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
  it("#13 the picker reads the hidden list after the snapshot await", () => {
    const listing = between("async function describedInstances(", "return instances.map(");
    // r4 M2: registration (removed) and the hidden list are both read after the snapshot await
    const live = listing.indexOf("await keptAfter(registry.describe(options), (entry) => registry.has(entry.instanceId))");
    expect(live).toBeGreaterThan(-1);
    expect(live).toBeLessThan(listing.indexOf("const configured = instanceConfigs(cfg)"));
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

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { appendMessage, closeMessageDb, readMessage, readActiveLeafOrNewest, setActiveLeaf } from "./message-db.ts";
import { branchRows } from "./branch-store.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { memoryAccess, packLoan, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { setExecutionStore } from "./execution-audience.ts";
import { closeTurnLineage, currentTurnLineage, openTurnLineage, writeSessionLineage } from "./memory/lineage-write.ts";
import { beginTurnLineage } from "./steer-lineage.ts";
import { readDelegationPack, releaseDelegationPacks, type PackReleaseHost } from "./thread-recall.ts";
import { buildPrompt, promptPart, noneRef } from "./memory/prompt-parts.ts";
import { EngineInputRevoked, fencedTurnInput } from "./drivers/engine-input.ts";
import { TurnSubmissionBoundary } from "./turn-dispatch-guard.ts";
import { IndependentThreadRuns } from "./independent-thread-runs.ts";
import { MemoryRefusalCauses, nextMemoryRebuild, turnRefusedLine, submissionRefusalKind, MEMORY_REDISPATCH_ATTEMPTS } from "./memory/dispatch.ts";
import { once } from "./fold-steps.ts";
import { commitRevoke } from "./memory/revoke-commit.ts";
import { drainRevokeMarker } from "./memory/memory-revocation.ts";
import { beginOutsideTurn, markTurnOutside, turnOutsideRead } from "./email/external-marks.ts";
import { denyLookup } from "./memory/deny-read.ts";
import { threadRecallRoute } from "./thread-recall.ts";
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import type { Store, BotRecord } from "./store.ts";

// Execute the shipped index functions and callback expressions without booting its listener or engines.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
function nodes(predicate: (n: ts.Node) => boolean) {
  const found: ts.Node[] = [];
  const walk = (n: ts.Node) => { if (predicate(n)) found.push(n); ts.forEachChild(n, walk); }; walk(ast); return found;
}
function evaluate(code: string, env: Record<string, unknown>) {
  return new Function(...Object.keys(env), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(env));
}
function shippedFunction(name: string, env: Record<string, unknown>) {
  const node = nodes(n => ts.isFunctionDeclaration(n) && n.name?.text === name)[0];
  expect(node, `index must define ${name}`).toBeDefined();
  return evaluate(`${node!.getText(ast)}; return ${name};`, env);
}
const put = (thread: string, id: string, text: string, parentId: string | null = null, extra = {}) =>
  appendMessage(thread, { id, role: "bot", kind: "text", text, parentId, at: 1000, ...extra });
let roster: MemoryRoster;
beforeEach(() => {
  vi.restoreAllMocks();
  let turn; while ((turn = currentTurnLineage("destination"))) closeTurnLineage(turn);
  closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  roster = { bots: [{ id: "sable", name: "Sable", threadId: "source", tasks: [{ threadId: "source" }] },
    { id: "ember", name: "Ember", threadId: "destination", tasks: [{ threadId: "destination" }] }], groups: [] };
  setExecutionStore({ bots: roster.bots, groups: [], bot: (id: string) => roster.bots.find(b => b.id === id) } as unknown as Store);
  reconcileMemoryRoster(roster); setMemoryMode("active");
  put("source", "lent", "Juniper is the restaurant."); put("source", "leaf", "Newest line", "lent");
  put("destination", "own", "Owner note");
  database().prepare("INSERT INTO pending_delegations(id,source_thread_id,to_bot_id,from_bot_id,phase,item,origin,target_thread_id,started_at) VALUES('job','source','ember','sable','started','{}','owner','destination',1)").run();
  database().prepare("INSERT INTO delegation_packs VALUES('pack','job','source','sable','ember','destination','[\"lent\"]','[]',1000,1000)").run();
});
afterAll(() => { closeMessageDb(); closeDatabase(); setExecutionStore({ bots: [], groups: [], bot: () => undefined } as unknown as Store); });
useOutsideStoreFixture();

function rig(opts: { packSuppressed?: true } = {}, lend = true) {
  const registry = new InternalCapabilities(); registry.begin("ember", "destination", "g");
  const token = registry.mint({ botId: "ember", threadId: "destination", generation: "g", depth: 0, kind: "memory", skillAuthoring: false });
  const claim = registry.resolve(`Bearer ${token}`)!;
  const turn = openTurnLineage(database(), { threadId: "destination", turnId: "turn" });
  const lineage = beginTurnLineage({ threadId: "destination", botId: "ember", roots: { roots: new Set(), over: false }, instanceId: "codex", generation: "g", turn, startGeneration: 0, shown: [], withheldNow: () => false });
  const state = { calls: 0, released: new Map<string, string>(), sealed: false };
  beginOutsideTurn("destination", "codex", "g", false);
  const host: PackReleaseHost = { claim, access: () => memoryAccess(registry, claim, () => roster), lineage: () => lineage,
    active: () => registry.isActive(claim), ownerGeneration: () => "g", state: () => state, seal: vi.fn(), ...opts,
    turn: () => ({ generation: "g", driverKind: "codex", delegationId: "job", isUnattended: () => false }) };
  let refused = false;
  const counts: string[] = [];
  const makeGuard = shippedFunction("delegationPackGuard", { internalCapabilities: registry, database, transaction, readDelegationPack, packLoan,
    readActiveLeafOrNewest, branchRows, readMessage, EngineInputRevoked, console: { warn: (line: string) => counts.push(line) } });
  const released = lend ? releaseDelegationPacks(["pack"], host) : null;
  const guard = makeGuard(released?.bindings ?? [], host, () => { refused = true; });
  const prompt = buildPrompt(turn, [promptPart("note", [noneRef("murage")]), ...(released?.parts ?? [])]);
  const boundary = new TurnSubmissionBoundary(), submitted = vi.fn(), bytes: string[] = [];
  // Extract the actual direct-turn closure, including its ordering relative to submitted().
  const before = nodes(n => ts.isPropertyAssignment(n) && n.name.getText(ast) === "beforeSubmit")[0] as ts.PropertyAssignment;
  const validation = nodes(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === "validateDirectSubmission")[0] as ts.VariableDeclaration;
  const validationEnv = { submissionBoundary: boundary, packGuard: guard, limitTurns: { assertCanSubmit: () => {} },
    assertCursorNotSealed: () => {}, store: { taskByThread: () => ({}) }, bot: { id: "ember" }, threadId: "destination", instanceId: "codex", resumeCursor: undefined,
    providerRouteIsCurrent: () => true, providerRoute: undefined, assertBackupStillUsable: () => {}, turnSelection: {}, opts: { delegationRun: { submitted } },
    trace: { mark: () => {} }, memoryReceipt: undefined };
  const validateDirectSubmission = evaluate(`return (${validation.initializer!.getText(ast)});`, validationEnv);
  const beforeSubmit = evaluate(`return (${before.initializer.getText(ast)});`, { ...validationEnv, validateDirectSubmission });
  const input = fencedTurnInput({ threadId: "destination", prompt, beforeSubmit } as any, { reader: { audience: null }, onRefused: e => boundary.refuse(e) });
  const write = () => { input.beforeSubmit!(); bytes.push(input.text); };
  return { host, registry, turn, lineage, released, guard, boundary, write, bytes, submitted, counts, refused: () => refused };
}

describe("direct pack write boundary", () => {
  // Policy also checks binding/anchor facts. Independent live oracles isolate each guard so deleting a redundant guard is caught too.
  it.each(["G1", "G2", "G3", "G4", "G5"])("T-WRITE guard mutant: removing %s permits its refused fixture", changed => {
    let changedNow = false, refused = false;
    const messages: string[] = [], prepared = vi.fn();
    const binding = { packId: "pack", destinationThreadId: "destination", sourceThreadId: "source", generation: "g", driverKind: "codex",
      sourceLeafId: "old", refs: [{ id: "lent", mrow: 1 }], anchor: { messageId: "anchor", mrow: 2 } };
    const make = shippedFunction("delegationPackGuard", {
      internalCapabilities: { activeGeneration: () => changedNow && changed === "G1" ? "new" : "g" },
      readDelegationPack: () => ({ destination_thread_id: "destination", refs: changedNow && changed === "G3" ? [] : ["lent"], prepared: [] }),
      packLoan: () => changedNow && changed === "G2" ? null : { sourceThreadId: "source" },
      readActiveLeafOrNewest: () => "new", branchRows: (thread: string) => ({ contains: () => !(changedNow && (changed === "G4" ? thread === "source" : changed === "G5" && thread === "destination")) }),
      readMessage: () => ({ packId: "pack", automation: { kind: "delegation" } }),
      transaction: (go: (db: unknown) => void) => go({ prepare: () => ({ run: prepared }) }),
      EngineInputRevoked, console: { warn: (line: string) => messages.push(line) },
    });
    const guard = make([binding], { access: () => ({ threadId: "destination", generation: "g" }), turn: () => ({ generation: "g", driverKind: "codex" }) }, () => { refused = true; });
    guard.assertCurrent(); expect(prepared).toHaveBeenCalledOnce(); prepared.mockClear();
    changedNow = true;
    expect(() => guard.assertCurrent()).toThrow("MEMORY_CONTEXT_REVOKED"); expect(refused).toBe(true);
    expect(prepared).not.toHaveBeenCalled(); expect(messages).toEqual([`[deleg.pack.withdrawn] reason=${changed}`]);
  });

  it.each(["G1", "G2", "G3", "G4", "G5"])("T-WRITE: %s alone blocks provider bytes and submission", guard => {
    const r = rig();
    if (guard === "G5") {
      put("destination", "anchor", "Delegated note", "own", { automation: { kind: "delegation" }, packId: "pack" });
      const mrow = Number(database().prepare("SELECT rowid AS n FROM messages WHERE thread_id='destination' AND id='anchor'").get()!.n);
      r.host.turn = () => ({ generation: "g", driverKind: "codex", anchor: { messageId: "anchor", mrow }, isUnattended: () => false });
      // The guard receives the replay binding, not a fabricated first-turn shortcut.
      const replay = releaseDelegationPacks(["pack"], r.host)!;
      const make = shippedFunction("delegationPackGuard", { internalCapabilities: r.registry, database, transaction, readDelegationPack, packLoan, readActiveLeafOrNewest, branchRows, readMessage, EngineInputRevoked, console });
      r.guard.assertCurrent = make(replay.bindings, r.host, () => {}).assertCurrent;
    }
    r.write(); expect(r.bytes[0]).toContain("Juniper"); expect(r.submitted).toHaveBeenCalledOnce();
    r.bytes.length = 0; r.submitted.mockClear();
    if (guard === "G1") r.registry.begin("ember", "destination", "new");
    if (guard === "G2") database().prepare("UPDATE pending_delegations SET phase='fresh'").run();
    if (guard === "G3") database().prepare("UPDATE delegation_packs SET refs='[]',prepared='[]'").run();
    if (guard === "G4") { put("source", "fork", "Other branch"); setActiveLeaf("source", "fork"); }
    if (guard === "G5") { put("destination", "fork", "Other branch"); setActiveLeaf("destination", "fork"); }
    expect(r.write).toThrow("MEMORY_CONTEXT_REVOKED"); expect(r.bytes).toEqual([]); expect(r.submitted).not.toHaveBeenCalled();
  });

  it("T-WRITE-APPEND: a new leaf that keeps every retained row passes", () => {
    const r = rig(); put("source", "append", "More context", "leaf"); r.write(); expect(r.bytes[0]).toContain("Juniper");
  });

  it("T-PREPARED: guard pass records ids even when a later check refuses; a storage error permits the write", () => {
    const r = rig(); expect(readDelegationPack("pack")!.prepared).toEqual([]);
    r.boundary.alsoCheck(() => { throw new Error("later check"); });
    expect(r.write).toThrow("later check"); expect(readDelegationPack("pack")!.prepared).toEqual(["lent"]);
    database().exec("CREATE TRIGGER fail_prepared BEFORE UPDATE OF prepared ON delegation_packs BEGIN SELECT RAISE(FAIL,'fixture'); END");
    expect(() => r.guard.assertCurrent()).not.toThrow(); expect(r.counts.join(" ")).toContain("deleg.pack.prepared_unrecorded");
  });

  it("T-FENCE: exact pack refs reach the direct buildPrompt; dropping only those refs fails this assertion", () => {
    const r = rig();
    const direct = nodes(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === "directPrompt")[0] as ts.VariableDeclaration;
    const captured: any[] = [];
    evaluate(`${direct.getText(ast)};`, { buildPrompt: (_turn: unknown, parts: any[]) => { captured.push(...parts); }, turnLineage: r.turn,
      promptPart, noneRef, packRelease: r.released, memoryLastResort: false, ownShownIds: [], directOwnerAudience: true, resumeCursor: undefined, sessionReset: true, sessionLastLsn: null,
      threadId: "destination", turnShownRefs: [], workingBlock: "", learnedText: "", engineCommand: false, speakerCorrection: () => "", bot: { id: "ember" },
      turnText: "note", withWorkingContext: (x: string) => x, withLearned: (x: string) => x, withVenues: (x: string) => x, withNowLine: (x: string) => x, venueBlock: "", nowLine: "" });
    expect(captured).toHaveLength(2); expect(captured[1].lineageOf).toEqual([{ kind: "line", threadId: "source", messageId: "lent" }]);
  });

  it("T-FENCE: forgetting a rendered ref refuses at the provider fence, without suppressing eligible future packs", () => {
    const r = rig(); r.write(); expect(r.bytes[0]).toContain("Juniper"); r.bytes.length = 0; r.submitted.mockClear();
    commitRevoke(database(), { kind: "line", threadId: "source", messageIds: ["lent"], cause: "forget" });
    expect(r.write).toThrow("MEMORY_CONTEXT_REVOKED"); expect(r.bytes).toEqual([]); expect(r.submitted).not.toHaveBeenCalled();
    expect(r.refused()).toBe(false); // the lineage fence precedes the pack guard
    drainRevokeMarker(database()); expect(releaseDelegationPacks(["pack"], r.host)).toBeNull();
  });

  it.each(["pack", "recall"])("T-PARITY: %s records the same ancestry, outside mark, durable carry and blocked descendant after forget", async mode => {
    beginOutsideTurn("source", "codex", "source-turn", false, 1000); markTurnOutside("source", "web page");
    const r = rig({}, mode === "pack");
    if (mode === "recall") {
      // Identical rows and marks, but in Ember's own thread: ordinary recall needs no cross-bot loan.
      roster.bots[1].tasks!.push({ threadId: "source" }); roster.bots.splice(0, 1); reconcileMemoryRoster(roster);
      r.host.state()!.released.set("lent", "source");
      let response: any;
      await threadRecallRoute("thread_read", { message_id: "lent", direction: "around", limit: 1 }, r.host.access()!, { ...r.host,
        yield: async () => {}, respond: (status, body) => { response = { status, body }; } });
      expect(response.status).toBe(200); expect(JSON.stringify(response.body)).toContain("Juniper");
    }
    const key = { threadId: "destination", driverInstance: "codex", nativeSession: "session" };
    expect(transaction(db => writeSessionLineage(db, key, r.turn))).toBe(true);
    expect(r.turn.parents.filter(ref => ref.kind === "line")).toEqual([{ kind: "line", threadId: "source", messageId: "lent" }]);
    expect(r.lineage.sources).toEqual([{ threadId: "source", id: "lent", role: "bot" }]);
    expect(turnOutsideRead("destination")).toBe("memory");
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_lineage_carry WHERE child_kind=2").get()!.n)).toBe(1);
    expect(r.host.state()!.released.has("lent")).toBe(mode === "recall");
    put("destination", "reply", "Juniper booked", "own");
    expect(denyLookup(database(), { threadId: "destination", lines: [{ messageId: "reply", author: "generated" }] }, { audience: null }).get("reply")?.state).toBe("shown");
    // Compare both paths at the same deterministic point: the committed forget, before the asynchronous marker advances.
    commitRevoke(database(), { kind: "line", threadId: "source", messageIds: ["lent"], cause: "forget" }, { inline: false });
    expect(denyLookup(database(), { threadId: "destination", lines: [{ messageId: "reply", author: "generated" }] }, { audience: null }).get("reply")?.state).not.toBe("shown");
  });
});

function redispatchLiterals() {
  return nodes(n => ts.isCallExpression(n) && n.expression.getText(ast) === "startTurn" && n.arguments[2]?.getText(ast).includes("memoryRedispatch: attempt")) as ts.CallExpression[];
}
function directRelease(r: ReturnType<typeof rig>, opts: any, branchMessages: any[] = [], memoryLastResort = false, selectiveDropped = false) {
  const from = source.indexOf("      const packAnchors =");
  const to = source.indexOf("      const directHumanInput =", from);
  expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
  return evaluate(`let packRefusedHere = false; ${source.slice(from, to)}; return { packRelease, packGuard, refused: () => packRefusedHere };`, {
    opts, memoryLastResort, selectiveDropped, engineCommand: false, resumeCursor: undefined, sessionReset: true, branchMessages, userMessage: { id: "input" },
    database, threadId: "destination", bot: { id: "ember" }, dispatchClaimId: "g", instance: { driverKind: "codex" },
    internalCapabilities: r.registry, internalToken: () => r.registry.mint({ ...r.host.claim, depth: 0, skillAuthoring: false, kind: "memory" }), turnMemoryAccess: r.host.access,
    turnOutputRoots: new Map([["destination", r.lineage]]), internalTurnOwners: new Map([["destination", { generation: "g", threadRecall: r.host.state() }]]),
    store: { sealThread: () => {} }, isUnattended: () => false, releaseDelegationPacks,
    delegationPackGuard: (bindings: any, host: any, refused: any) => shippedFunction("delegationPackGuard", {
      internalCapabilities: r.registry, database, transaction, readDelegationPack, packLoan, readActiveLeafOrNewest, branchRows, readMessage, EngineInputRevoked, console,
    })(bindings, host, refused),
  });
}
it.each([0, 1])("T-WRITE-CHAIN / Codex setup + late refusal: site %s retains suppression through real takeover", async site => {
  const r = rig(); const runs = new IndependentThreadRuns<BotRecord>(); const bot = { id: "ember" } as BotRecord;
  let held = runs.admit("ember", "destination", bot, []);
  const marked: string[] = [];
  const rebuild = shippedFunction("rebuildRefusedDirectTurn", { settleRevokesForTurn: async () => true, database, directRuns: runs,
    memoryRefusalCauses: new MemoryRefusalCauses(), markLastResort: (id: string) => marked.push(id), lastResortMessages: new Set(), freeThreadAfterRebuild: () => {}, DirectRebuildCancelled: Error });
  const literal = redispatchLiterals()[site].arguments[2].getText(ast);
  const next = (opts: any, packRefusedHere: boolean, attempt: number) => evaluate(`return (${literal});`, { opts, packRefusedHere, attempt, threadId: "destination", userMessage: { id: "input" }, rebuildOf: held.generation });
  put("source", "fork", "Off branch"); setActiveLeaf("source", "fork");
  // Codex swallows the closure's throw; assertNotRefused rethrows it during handback.
  try { r.write(); } catch { /* the adapter reports submission_refused */ }
  expect(() => r.boundary.assertNotRefused()).toThrow("MEMORY_CONTEXT_REVOKED");
  let opts = next({}, r.refused(), 1); expect(opts.packSuppressed).toBe(true);
  runs.holdForRebuild(held);
  await rebuild(held, "input", nextMemoryRebuild(0), async (takeOver: string) => { held = runs.admit("ember", "destination", bot, [], { takeOver }); });
  setActiveLeaf("source", "leaf"); r.host.packSuppressed = opts.packSuppressed;
  expect(releaseDelegationPacks(["pack"], r.host)).toBeNull();
  opts = next(opts, false, 2); // an unrelated memory refusal after a pack-free write
  expect(opts.packSuppressed).toBe(true); expect(marked).toEqual([]);
});

it("T-WRITE-THREE / T-WRITE-CAP: every replay pack stays suppressed across 600 settled inputs; fresh inputs stay eligible", () => {
  const r = rig(); const literal = redispatchLiterals()[0].arguments[2].getText(ast);
  const next = evaluate(`return (opts, packRefusedHere) => (${literal});`, { threadId: "destination", userMessage: { id: "input" }, attempt: 3, rebuildOf: "g" });
  const original = next({}, true);
  const runs = new IndependentThreadRuns<BotRecord>(), bot = { id: "ember" } as BotRecord;
  const activeOriginal = runs.admit("ember", "destination", bot, []);
  let current = activeOriginal, eligible = true;
  const make = shippedFunction("delegationPackGuard", {
    internalCapabilities: { activeGeneration: () => current.generation },
    readDelegationPack: () => ({ destination_thread_id: current.threadId, refs: ["lent"], prepared: [] }),
    packLoan: () => eligible ? { sourceThreadId: "source" } : null,
    readActiveLeafOrNewest: () => "leaf", branchRows: () => ({ contains: () => true }),
    transaction: (go: (db: unknown) => void) => go({ prepare: () => ({ run: () => {} }) }), EngineInputRevoked, console: { warn: () => {} },
  });
  // Other inputs really refuse and settle through the shipped guard and submission boundary. Their independent live policy
  // oracles keep the test bounded without creating 600 source histories; the original below still uses the SQLite renderer.
  for (let i = 0; i < 600; i++) {
    const held = runs.admit("ember", `other-${i}`, bot, []);
    current = held; eligible = true;
    let refused = false;
    const binding = { ...r.released!.bindings[0], destinationThreadId: held.threadId, generation: held.generation };
    const guard = make([binding], { access: () => ({ threadId: held.threadId, generation: held.generation }),
      turn: () => ({ generation: held.generation, driverKind: "codex" }) }, () => { refused = true; });
    const boundary = new TurnSubmissionBoundary();
    boundary.beforeSubmit(() => guard.assertCurrent());
    eligible = false;
    expect(() => boundary.beforeSubmit(() => guard.assertCurrent())).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(next({}, refused).packSuppressed).toBe(true);
    runs.release(held);
  }
  expect(runs.current(activeOriginal)).toBe(true);
  expect(next(original, false).packSuppressed).toBe(true);
  for (const end of ["Stop", "settlement", "replacement"]) { expect(next({}, false).packSuppressed, end).toBeUndefined(); }
  const branch: any[] = [];
  let parent = "own";
  for (const id of ["p1", "p2", "p3"]) {
    database().prepare("INSERT INTO delegation_packs SELECT ?,?,source_thread_id,source_bot_id,target_bot_id,destination_thread_id,refs,prepared,cut_at,created_at FROM delegation_packs WHERE id='pack'").run(id, `job-${id}`);
    put("destination", `anchor-${id}`, "Delegated note", parent, { automation: { kind: "delegation" }, packId: id });
    branch.push(readMessage("destination", `anchor-${id}`)); parent = `anchor-${id}`;
  }
  const ready = directRelease(r, {}, branch);
  expect(ready.packRelease.bindings.map((b: any) => b.packId)).toEqual(["p3", "p2", "p1"]);
  expect(() => ready.packGuard.assertCurrent()).not.toThrow();
  put("source", "fork", "Other branch"); setActiveLeaf("source", "fork");
  expect(() => ready.packGuard.assertCurrent()).toThrow("MEMORY_CONTEXT_REVOKED"); expect(ready.refused()).toBe(true);
  setActiveLeaf("source", "leaf");
  expect(directRelease(r, original, branch).packRelease).toBeNull();
  expect(directRelease(r, {}, branch, true).packRelease).toBeNull();
  expect(directRelease(r, {}, branch, false, true).packRelease).toBeNull();
  expect(nextMemoryRebuild(1)).toMatchObject({ attempt: 2, lastResort: true });
  expect(nextMemoryRebuild(2)).toBeUndefined();
  delete r.host.packSuppressed; expect(releaseDelegationPacks(["pack"], r.host)?.lines).toBe(1);
});

it.each([["claude", false, false], ["claude", true, false], ["codex", false, false], ["claude", false, true], ["claude", true, true], ["codex", false, true]] as const)("T-POST-TOOL / Codex late refusal: %s tool=%s released=%s runs the shipped late-ticket settlement", async (driverKind, toolStarted, priorSubmissionReleased) => {
  const r = rig(); const runs = new IndependentThreadRuns<BotRecord>();
  const bot = { id: "ember" } as BotRecord; const held = runs.admit("ember", "destination", bot, []);
  const tickets = new Map(), cards: any[] = [], rebuilt: any[] = [];
  const causes = new MemoryRefusalCauses();
  const kind = nodes(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === "refusalKind")[0] as ts.VariableDeclaration;
  const refusalKind = evaluate(`return (${kind.initializer!.getText(ast)});`, { submissionBoundary: r.boundary, submissionRefusalKind });
  const late = nodes(n => ts.isCallExpression(n) && n.expression.getText(ast) === "submissionBoundary.acceptedBy")[0] as ts.CallExpression;
  const callback = evaluate(`return (${late.arguments[0].getText(ast)});`, {
    isMemoryContextRevoked: (e: Error) => e.message === "MEMORY_CONTEXT_REVOKED", turnRefused: () => {}, threadId: "destination", userMessage: { id: "input" },
    instance: { driverKind }, opts: {}, nextMemoryRebuild, engineNameOf: () => driverKind, lateMemoryRefusalLine: () => "Changed context",
    turnExhausted: () => {}, store: { appendMessage: (_thread: string, row: any) => cards.push(row) }, murageLine: (row: any) => row,
    accepted: { turnId: "provider" }, turnFailureBuzzes: () => false, routineToken: undefined, MEMORY_REDISPATCH_ATTEMPTS,
    once, turnRefusedLine, refusalKind, submissionBoundary: r.boundary, memoryRefusalCauses: causes,
    recordMemoryRefusal: (error: unknown) => causes.record("input", error, true),
    refusalCauseNote: () => "", lateMemoryRedispatches: tickets, console: { warn: () => {} },
    rebuildRefusedDirectTurn: async (_held: unknown, _id: string, _rebuild: unknown, start: (g: string) => unknown) => { await start(held.generation); return true; },
    startTurn: async (_bot: string, _text: string, opts: any) => { rebuilt.push(opts); }, botId: "ember", text: "note", packRefusedHere: true,
  });
  // An unwritten refusal may rebuild with the pack suppressed; a released submission must never replay.
  if (priorSubmissionReleased) r.write();
  r.bytes.length = 0;
  r.boundary.acceptedBy(callback);
  put("source", "fork", "Other branch"); setActiveLeaf("source", "fork");
  if (driverKind === "codex") { try { r.write(); } catch { /* Codex settles submission_refused instead of rethrowing. */ } }
  else expect(r.write).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => r.boundary.assertNotRefused()).toThrow("MEMORY_CONTEXT_REVOKED"); expect(r.bytes).toEqual([]);
  const release = nodes(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === "releaseDirect")[0] as ts.VariableDeclaration;
  const releaseDirect = evaluate(`return (${release.initializer!.getText(ast)});`, { replacementOwnsThread: false, decideOwedNone: () => {},
    directRun: held, directRuns: runs, lateRedispatch: tickets.get("provider"), toolStartedThisTurn: toolStarted,
    replySpeakerTurns: { ended: () => {} }, event: { threadId: "destination" }, releasedStop: false, bot,
    store: { taskByThread: () => ({ activity: "working" }), setTaskActivity: () => {} }, retryDelegationsWaitingOn: () => {}, drainQueuedSends: () => {} });
  releaseDirect(); await Promise.resolve();
  if (toolStarted || priorSubmissionReleased) { expect(rebuilt).toEqual([]); expect(cards).toHaveLength(1); }
  else { expect(rebuilt).toHaveLength(1); expect(rebuilt[0].packSuppressed).toBe(true); expect(cards).toEqual([]); }
});

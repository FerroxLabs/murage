// STOP-CARD W6-W10/W12: execute the shipped failure branches while the shipped Stop is held at browser release.
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { source } from "./decision-wiring/fixture.ts";
import { stopCardFixture } from "./testing/turn-card-fixture.ts";
import { emptyTurnLine, failedTurnLine, turnProducedSomething, turnWroteText, wantsEmptyTurnLine, wantsFailedTurnLine } from "./failed-turn-line.ts";
import { TurnWatchdog } from "./turn-watchdog.ts";

const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
function find(root: ts.Node, test: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => { if (test(n)) { found = n; return; } if (!found) ts.forEachChild(n, visit); };
  visit(root);
  if (!found) throw new Error("Missing production failure branch");
  return found;
}
function owner(name: string): ts.Node {
  return find(ast, n => ts.isFunctionDeclaration(n) && n.name?.text === name || ts.isVariableDeclaration(n) && n.name.getText(ast) === name);
}
function statement(name: string, text: string, occurrence = 0): string {
  let seen = 0;
  let node = find(owner(name), n => ts.isPropertyAssignment(n) && n.name.getText(ast) === "tool" && n.getText(ast).includes(text) && seen++ === occurrence);
  while (!ts.isStatement(node)) node = node.parent;
  return node.getText(ast);
}
const declaration = (name: string) => name === "limitCardScope" && !source.includes("function limitCardScope(") ? "" : owner(name).getText(ast);
const noop = () => {};
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function held(options: Parameters<typeof stopCardFixture>[0] & { room?: boolean; unowned?: boolean } = {}) {
  vi.spyOn(console, "info").mockImplementation(noop);
  const r = stopCardFixture({ ...options, ...(options.room ? { running: false } : {}) });
  let stopping: Promise<unknown>;
  if (options.room) {
    const branch = find(ast, n => ts.isIfStatement(n) && n.expression.getText(ast) === "busyGroup" && n.getText(ast).includes("noteOwnerStop(busyGroup.threadId, bot.id)"));
    stopping = r.evaluate(`(async () => { const instance = registry.get("I"); ${branch.getText(ast)} })()`, {
      internalTurnOwners: options.unowned ? new Map() : new Map([["T", { botId: "B", generation: "G" }]]), busyGroup: { threadId: "T", group: { id: "room" } },
      bot: { id: "B" }, req: {}, res: {}, expectedThreadId: undefined, grantOfRequest: new WeakMap(),
      cancelGroupTurnOperations: noop, markSendsStopped: noop, json: (_r: unknown, status: number, body: unknown) => ({ status, body }),
    });
  } else {
    r.built.noteOwnerStop!("T", "B");
    stopping = r.built.interruptDirectThread!("B", "T", "G");
  }
  await r.entered;
  return { ...r, async finish() { r.release(); await stopping; } };
}

const noticePaths = [
  { name: "D image attach", code: () => {
    const caught = find(owner("foldRuntimeEvent"), n => ts.isCatchClause(n) && n.getText(ast).includes("generated image could not be attached"));
    return `try { throw new Error("invalid image"); } ${caught.getText(ast)}`;
  }, extra: {} },
  { name: "E memory echo", code: () => find(owner("prepareTerminalEvent"), n => ts.isIfStatement(n) && n.expression.getText(ast) === "marker && echoOnly").getText(ast),
    extra: { marker: { text: "fixture echo" }, echoOnly: true, completedTurnId: "P", MEMORY_ECHO_NOTICE: "Fixture echo was removed.", redactSecretsInText: (x: string) => x } },
  { name: "E removed line", code: () => find(owner("foldRuntimeEvent"), n => ts.isIfStatement(n) && n.expression.getText(ast) === 'guarded && event.type === "item.completed" && event.itemType === "assistant_text"').getText(ast),
    extra: { guarded: { names: ["Other"], speaker: { id: "B", name: "Ada" } }, speechTurn: undefined, cutSpeaker: undefined,
      replySpeakerTurns: { item: () => ({ text: "", removedSpeaker: "Other", removedText: "fixture removed line" }), removalRow: noop }, turnEngineByThread: new Map() } },
] as const;

describe("W6 late image, echo and removed-line notices", () => {
  it.each(noticePaths)("$name: no card while Stop waits", async path => {
    const r = await held();
    const event = { type: "item.completed", itemType: "assistant_text", threadId: "T", turnId: "P", text: "fixture", provider: "acp" };
    r.evaluate(`(() => { ${path.code()} })()`, { ...path.extra, bot: { id: "B" }, speaker: undefined, event, executionEvent: event, eventLease: { lease: r.lease }, lease: r.lease,
      writer: { push: (m: unknown) => r.appended.push(m) }, store: { messageById: () => undefined, appendMessage: (_t: string, m: unknown) => { r.appended.push(m); return { id: "row" }; } } });
    expect({ cards: [...r.pushed, ...r.appended], frozen: r.lease.frozenEnd }).toEqual({ cards: [], frozen: undefined });
    await r.finish();
  });
  it("F repeat callback: no loop notice while Stop waits", async () => {
    const r = await held();
    const callback = find(ast, n => ts.isCallExpression(n) && n.expression.getText(ast) === "bus.subscribeExecution" && n.arguments[0]?.getText(ast).includes("loopNoticeName(")) as ts.CallExpression;
    r.evaluate(`(${callback.arguments[0]!.getText(ast)})(event)`, { event: { type: "item.started", itemType: "tool", title: "echo fixture", threadId: "T", turnId: "P" },
      shouldIgnoreProviderEvent: () => false, loopNudge: { observe: noop }, repeats: { record: () => ({ threshold: 3 }) }, toolTitleKey: () => "repeat", askCallLabel: () => "echo fixture", loopNoticeName: () => "Fixture repeated tool." });
    expect([...r.pushed, ...r.appended]).toEqual([]);
    await r.finish();
  });
});

it("W7 watchdog fires on the fake clock while Stop waits: no stall card, settlement still runs", async () => {
  vi.useFakeTimers();
  const r = await held();
  const onStall = find(owner("watchdog"), n => ts.isPropertyAssignment(n) && n.name.getText(ast) === "onStall") as ts.PropertyAssignment;
  const settlements: string[] = [];
  const callback = r.evaluate(`(${onStall.initializer.getText(ast)})`, { roomStallCompletions: { stall: () => false }, recordMemorySettlement: (_t: string, _key: string, outcome: string) => settlements.push(outcome), reportUnconfirmedDirectStop: noop, store: { activeLeaf: () => "leaf" } });
  const watchdog = new TurnWatchdog({ stallMs: 100, setupStallMs: 100, checkMs: 10, onStall: callback });
  watchdog.watch("T", "B", { generation: "G", setup: true });
  watchdog.start();
  await vi.advanceTimersByTimeAsync(100);
  expect([...r.pushed, ...r.appended]).toEqual([]);
  await r.finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(settlements).toEqual(["interrupted"]);
  expect([...r.pushed, ...r.appended]).toEqual([]);
  watchdog.stop();
});

it.each(["markGatewayBusy", "putLimitLine", "failOverThread", "failoverRefusalSteps", "onDirectLimitTurnCompleted"])("W8 %s after Stop: no limit or backup card", async name => {
  const r = await held();
  const turn = { botId: "B", threadId: "T", generation: "G", providerTurnId: "P", selection: {}, engineName: "Fixture", text: "", textActivity: false };
  const extra = { turn, row: { botId: "B", threadId: "T", from: {}, to: {} },
    gatewayBusyStreaks: { refused: () => ({ count: 1 }) }, setup: { firstJobPending: () => false }, gatewayBusyLogLine: () => "fixture busy", gatewayBusyFacts: () => ({}), gatewayBusyLine: () => "Fixture is busy.",
    isGatewayBusyRow: () => false, store: { scanNewest: noop, appendMessage: (_t: string, m: unknown) => r.appended.push(m) },
    backupVerdict: () => ({ ok: false, reason: "fixture" }), backupRefusalOf: () => "Fixture backup refused.",
    gatewayBusyReason: () => undefined, limitTurns: { complete: () => turn }, limitRefusalOfTurn: () => ({ until: 20, resetsAt: null }),
    applyLimit: () => ({ kind: "none" }), cfg: {}, limitState: { set: noop }, storeBackup: () => ({}), plainLimitLine: () => "Fixture limit.",
  };
  if (name === "onDirectLimitTurnCompleted") {
    // The real refused-backup branch and its following limit line; selection/cooldown policy is covered by limit-backup-gate.
    const branch = find(owner(name), n => ts.isIfStatement(n) && n.expression.getText(ast) === "backup && verdict && !verdict.ok");
    r.evaluate(`${declaration("limitCardScope")}\n(() => { ${branch.getText(ast)} })()`, { ...extra, backup: {}, verdict: { ok: false, reason: "fixture" } });
  } else {
    const helpers = ["putLimitLine", "markGatewayBusy", "failOverThread"].includes(name) ? declaration("limitCardScope") : "";
    const call = name === "markGatewayBusy" ? `${name}(turn,"busy",0)` : name === "putLimitLine" ? `${name}("T",turn,"Fixture limit.")` : name === "failoverRefusalSteps" ? `${name}(row).line("fixture")` : `${name}(turn,{},0)`;
    r.evaluate(`${helpers}\n${declaration(name)}\n${call}`, extra);
  }
  expect([...r.pushed, ...r.appended]).toEqual([]);
  await r.finish();
});

it.each([{ code: "submission_refused", occurrence: 0 }, { code: "submission_refused", occurrence: 1 }, { code: "MEMORY_CONTEXT_REVOKED (submission_refused)", occurrence: 0 }])("W9 late handshake refusal $code/$occurrence after Stop: no card", async ({ code, occurrence }) => {
  const r = await held();
  const branch = statement("startTurnAdmitting", `errorDetails: "${code}"`, occurrence);
  r.evaluate(`(() => { ${branch} })()`, { threadId: "T", bot: { id: "B" }, dispatchClaimId: "G", accepted: { turnId: "P" }, providerTurnId: "P", kind: "refused", line: "Fixture submission refused." });
  expect([...r.pushed, ...r.appended]).toEqual([]);
  await r.finish();
});

it("W10 dispatch preparation failure after Stop keeps onDispatchError and drains, without a card", async () => {
  const r = await held();
  const root = find(owner("startTurnAdmitting"), n => ts.isCatchClause(n) && n.variableDeclaration?.name.getText(ast) === "error" && n.getText(ast).includes("const resendOffer =")) as ts.CatchClause;
  const statements = root.block.statements;
  const begin = statements.findIndex(n => ts.isVariableStatement(n) && n.declarationList.declarations[0]?.name.getText(ast) === "resendOffer");
  const code = statements.slice(begin).map(n => n.getText(ast)).join("\n");
  const dispatched: string[] = [], drained: string[] = [];
  r.evaluate(`(() => { ${code} })()`, { failure: new Error("Fixture preparation failed."), threadId: "T", bot: { id: "B", name: "Ada", modelSelection: { instanceId: "I" } }, run: { generation: "G" },
    directOwnerAudience: true, submissionBoundary: { canRetry: false }, instance: { driverKind: "acp" }, isMemoryContextRevoked: () => false,
    pinnedMemoryFailure: () => undefined, preparationFailureText: () => "Fixture preparation failed.", localSetupFailureOf: () => undefined,
    SignInRequiredError: class extends Error {}, turnFailureDiagnostic: (message: string) => ({ name: `error: ${message}`, ok: false }),
    admitted: {}, rebuildFailed: false, turnFailureBuzzes: () => false, opts: { onDispatchError: (m: string) => dispatched.push(m) },
    drainQueuedSends: () => drained.push("queued"), drainConnectorResumes: noop, drainSecretResumes: noop, drainTeamIncidents: noop, browserSetup: undefined, browserExtension: undefined });
  expect({ cards: [...r.pushed, ...r.appended], dispatched, drained }).toEqual({ cards: [], dispatched: ["Fixture preparation failed."], drained: ["queued"] });
  await r.finish();
});

it.each(["project restore", "member dispatch", "member setup stall", "member runtime stall", "member summary", "missing engine", "connected apps"])("W12 room %s after member Stop: no card; another member still writes", async path => {
  const r = await held({ room: true });
  const markers = { "project restore": 'name: `error: ${message}`', "member dispatch": 'message.slice(0, 140)', "member setup stall": 'no activity while getting ready', "member runtime stall": 'roomTurnStallMessage(' };
  let code: string;
  if (path === "project restore") {
    const caught = find(owner("runGroupMemberTurnDispatch"), n => ts.isCatchClause(n) && n.getText(ast).includes("files are being restored")) as ts.CatchClause;
    code = caught.block.statements.slice(0, 2).map(n => n.getText(ast)).join("\n");
  } else if (path === "member summary") {
    const summary = find(owner("runGroupMemberTurnDispatch"), n => ts.isVariableStatement(n) && n.declarationList.declarations[0]?.name.getText(ast) === "murageFailureLine");
    code = `let failureLine = false; const orchestration = undefined; ${summary.getText(ast)}; murageFailureLine("Fixture member failed.");`;
  } else if (path === "missing engine") code = statement("runGroupMemberTurnDispatch", 'name: `error: ${message}`');
  else if (path === "connected apps") {
    const caught = find(owner("runGroupMemberTurnDispatch"), n => ts.isCatchClause(n) && n.getText(ast).includes("connected apps are unavailable")) as ts.CatchClause;
    code = caught.block.statements.slice(0, 2).map(n => n.getText(ast)).join("\n");
  } else code = statement("runGroupMemberTurnDispatch", markers[path as keyof typeof markers]);
  const base = { threadId: "T", bot: { id: "B", name: "Ada" }, internalGeneration: "G", error: new Error("Fixture connection failed."), redactSecretsInText: (v: string) => v, message: "Fixture member failed.", guardError: undefined, roomTurnStallMessage: () => "Fixture room stalled.", currentSilenceMinutes: () => 1 };
  r.evaluate(`(() => { ${code} })()`, base);
  expect([...r.pushed, ...r.appended]).toEqual([]);
  r.evaluate(`(() => { ${code} })()`, { ...base, bot: { id: "Y", name: "Other" }, internalGeneration: "GY" });
  expect(r.appended).toHaveLength(1);
  r.appended.length = 0;
  await r.finish();
});

it("W12 unowned room Stop is per member before handback", async () => {
  const r = await held({ room: true, unowned: true, attached: false });
  const code = statement("runGroupMemberTurnDispatch", "message.slice(0, 140)");
  const base = { threadId: "T", bot: { id: "B", name: "Ada" }, internalGeneration: "G", message: "Fixture member failed.", guardError: undefined };
  r.evaluate(`(() => { ${code} })()`, base);
  expect(r.appended).toEqual([]);
  r.evaluate(`(() => { ${code} })()`, { ...base, bot: { id: "Y", name: "Other" }, internalGeneration: "GY" });
  expect(r.appended).toHaveLength(1);
  r.appended.length = 0;
  // The provider has not returned yet; let the real lease's interrupt port rendezvous with that handback.
  r.lease.attach("P");
  await r.finish();
});

it.each([false, true])("W4/W5 terminal ok=%s lands while Stop waits: no line", async ok => {
  const r = await held();
  const context = find(owner("foldRuntimeEvent"), n => ts.isVariableStatement(n) && n.declarationList.declarations[0]?.name.getText(ast) === "lineContext");
  const branch = find(owner("foldRuntimeEvent"), n => ts.isIfStatement(n) && n.expression.getText(ast).startsWith("bot && wantsFailedTurnLine("));
  r.evaluate(`(() => { ${context.getText(ast)}; ${branch.getText(ast)} })()`, {
    event: { type: "turn.completed", threadId: "T", turnId: "P", ok, stopReason: ok ? "end_turn" : "error" },
    executionEvent: { threadId: "T", turnId: "P" }, eventLease: { lease: r.lease }, completedTurnId: "P", bot: { id: "B", name: "Ada", modelSelection: { instanceId: "I" } },
    directOwnerTurn: true, replacementOwnsThread: false, routineRun: undefined, stoppedRoutineTurn: false, lateRedispatch: undefined,
    errorShownForTurn: false, memoryEcho: undefined, echoOnlyReply: false, lineRows: [], delegationWatch: new Map(), lastReply: new Map(), engineNameOf: () => "Fixture",
    wantsFailedTurnLine, wantsEmptyTurnLine, failedTurnLine, emptyTurnLine, turnWroteText, turnProducedSomething,
  });
  expect([...r.pushed, ...r.appended]).toEqual([]);
  await r.finish();
});

it("W7 fallback watchdog without a direct run still holds the stopped turn's card", async () => {
  vi.useFakeTimers();
  const r = await held();
  const onStall = find(owner("watchdog"), n => ts.isPropertyAssignment(n) && n.name.getText(ast) === "onStall") as ts.PropertyAssignment;
  const settlements: string[] = [];
  r.evaluate("globalThis.fixtureDirectRuns = directRuns; directRuns = { ...directRuns, get: () => undefined };", {});
  const callback = r.evaluate(`(${onStall.initializer.getText(ast)})`, {
    roomStallCompletions: { stall: () => false }, revokeInternalThread: noop, repeats: { settle: noop },
    TURN_STALL_MS: 100, TURN_HEARTBEAT_ONLY_MS: 100, recordMemorySettlement: (_t: string, _key: string, outcome: string) => settlements.push(outcome),
    finalizeDelegationWatch: noop, status: () => "Fixture stalled.", turnUsage: new Map(), setTimeout, clearTimeout,
    store: { activeLeaf: () => "leaf" },
  });
  const watchdog = new TurnWatchdog({ stallMs: 100, setupStallMs: 100, checkMs: 10, onStall: callback });
  watchdog.watch("T", "B", { generation: "G", setup: true }); watchdog.start();
  await vi.advanceTimersByTimeAsync(100);
  expect({ cards: [...r.pushed, ...r.appended], settlements }).toEqual({ cards: [], settlements: ["interrupted"] });
  r.evaluate("directRuns = fixtureDirectRuns;", {});
  watchdog.stop();
  await r.finish();
});

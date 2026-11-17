// Production Stop and event branches over an isolated real ledger lease.
import ts from "typescript";
import vm from "node:vm";
import { source } from "../decision-wiring/fixture.ts";
import { createLedgerLease } from "../ledger-refusal.ts";
import { ownerEngineText } from "../turn-end.ts";
import { sendNoticeLine } from "../send-store.ts";
import { ERROR_MESSAGE_MAX } from "../../shared/provider-error.ts";
import { createTurnCardGate } from "../turn-card-gate.ts";
import { fencedRefusalRegistry, latchAfterCommit, releasingEngineInput, writeRefusalNote } from "../drivers/engine-input.ts";
import { PendingTurnKeys } from "../fold-steps.ts";
const verdict = { state: "checking", reason: "not-built" } as const;
const ENGINE_LINE = "The engine closed before it answered.";
type Lease = ReturnType<typeof createLedgerLease>;
/** The statements of foldRuntimeEvent's `case "runtime.error":` clause, with production syntax. */
function runtimeErrorClause(ast: ts.SourceFile): string {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "foldRuntimeEvent") {
      const inner = (n: ts.Node): void => {
        if (ts.isCaseClause(n) && n.expression.getText(ast) === '"runtime.error"') found = n.statements.map(s => s.getText(ast)).join("\n");
        if (!found) ts.forEachChild(n, inner);
      };
      inner(node);
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!found) throw new Error("Missing production branch: foldRuntimeEvent runtime.error");
  return found;
}

export function stopCardFixture(options: { attached?: boolean; running?: boolean; persistence?: "immediate" | "held" } = {}) {
  // Held: each refusal write waits, as under writer contention, until releasePersistence() runs it.
  const heldWrites: (() => void)[] = [], ops: unknown[] = [];
  const releasePersistence = () => { for (const write of heldWrites.splice(0)) write(); };
  const appended: unknown[] = [], pushed: { tool: { name: string } }[] = [], calls: string[] = [], order: string[] = [];
  const leases = new Map<string, Lease>();
  const shownErrors: unknown[][] = [];
  const attached = options.attached ?? true;
  const run: { botId: string; threadId: string; generation: string; phase: string; providerTurnId?: string } = attached
    ? { botId: "B", threadId: "T", generation: "G", phase: "running", providerTurnId: "P" } : { botId: "B", threadId: "T", generation: "G", phase: "dispatching" };
  let current: typeof run | undefined = options.running === false ? undefined : run;
  const admission = {}, attachment = {};
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const instance = { instanceId: "I", adapter: {
    // The adapter's interrupt reaches the shared revoke, which refuses whatever lease the thread holds.
    interruptTurn: async () => { order.push("adapter.interruptTurn"); for (const lease of leases.values()) lease.onLedgerRefused(verdict); return { status: "stopped" }; },
    awaitTurnTeardown: async () => ({ closeConfirmed: true }) } };
  const bot = { id: "B", name: "Ada", modelSelection: { instanceId: "I" } };
  const lateMemoryRedispatches = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    console, Date, Map, Set, Object, JSON, Promise, URL, Array, Number, Boolean, String, Error,
    bus: { admitNewTurn: () => ({ admission, attachment }), sourceForExecution: () => ({ admission, attachment }), refuseTurn: () => { calls.push("bus.refuseTurn"); return []; }, cancelTurn: () => { order.push("bus.cancelTurn"); } },
    database: () => ({}), createLedgerLease, createTurnCardGate,
    persistLedgerRefusal: (_db: unknown, work: () => void) => {
      if (options.persistence !== "held") { work(); return Promise.resolve(); }
      return new Promise<void>(resolve => { heldWrites.push(() => { work(); resolve(); }); });
    },
    transaction: (work: (db: unknown) => void, transactionOptions?: { op?: string }) => { ops.push(transactionOptions?.op); return work({}); },
    captureSource: () => {},
    store: { appendMessage: (_thread: string, message: unknown) => { appended.push(message); return { id: "row" }; }, markTurnToolsUnrecorded() {}, setTaskActivity() {}, bot: () => bot, botByThread: () => bot },
    murageLine: (line: unknown) => line, sendNoticeLine, randomUUID: () => "id",
    admittedLedgerLeases: leases, ledgerCompletionSources: new Map(), ledgerLeasesByAdmission: new Map(), ledgerProviderInstances: new WeakMap(),
    refusedLeases: new Map(), internalTurnOwners: new Map(), memoryDispatches: new Map(),
    projectTurnLeases: { abandon() {}, markStopRequested() {}, releaseClosed() {} },
    watchdog: { settle: () => { calls.push("watchdog.settle"); }, settleSetup() {} },
    revokeInternalGeneration() {}, retireProviderTurn() {}, closeTurnLineage() {}, retryDelegationsWaitingOn() {}, drainQueuedSends() {},
    replySpeakerTurns: { ended() {} }, broadcast: () => {}, windowRuntimeEvent: (e: unknown) => e,
    // interruptDirectThread's own collaborators
    sealDirectAttempts() {}, settleDirectAttempts() {}, finishDirectAttemptEffects() {},
    ownerLimitContinuations: { cancel() {} }, limitApplications: { cancel() {} }, ownWriteHolds: { stop() {} },
    directRuns: { get: () => current, current: (r: typeof run) => current?.generation === r.generation, release: () => { current = undefined; } },
    botForDirectThread: () => bot, callSpeech: { invalidate() {} }, replyState: { invalidate() {} },
    cancelDirectTurnDispatch: () => ({ phase: "running" }), stopEmailForTurn() {}, emailRuntime: {}, emailGeneration: () => "G",
    closeOpenApprovals() {}, registry: { get: () => instance }, stopCloseConfirmed: () => true,
    unconfirmedDirectStop: () => new Error("unconfirmed"), screenPollers: new Map(), finalScreenFrame: async () => {},
    rememberReleasedStoppedTurn() {}, takeReleasedStoppedTurn: () => false,
    // NC+MA LLS S1 / D7 / Q2: the Stop's refusal join (refusedTurnOf, joinRefusedStop are extracted below) and the refusal-row state
    fencedRefusalRegistry, releasingEngineInput, stopInterrupts: new Map(), refusalStopJoins: new PendingTurnKeys(), refusalStopGenerations: new PendingTurnKeys(),
    ledgerRefusalAwaitingHandback: new Set(), roomLedgerRefusalNotes: new Map(), turnRefusalNotes: new Map(), deferredRefusalNotes: new Map(),
    refusedTerminalDecisions: new Set(), lateMemoryRedispatches, noteRefusedLeaseTerminal() {},
    // the submission refusal callbacks' collaborators: the shipped row writer and commit latch, and the ticket registry
    latchAfterCommit, writeRefusalNote, registerLateTicket: (turnId: string, ticket: unknown) => { lateMemoryRedispatches.set(turnId, ticket); },
    // The browser release Stop waits on: the engine error lands inside this wait.
    releaseBrowserCapabilityForThread: async () => { order.push("browser.release"); enter(); await gate; },
    // the runtime.error branch's collaborators
    parseRuntimeErrorDiagnostic: () => undefined, stampService: (e: unknown) => e, clampProviderSaid: (e: unknown) => e,
    providerConnections: { resolve: () => undefined }, modelSignIns: new Set(), sanitizeDisplayTextUnit: (v: unknown) => v,
    redactSecretsForSink: (v: string) => v, redactSecretsInText: (v: string) => v, ownerEngineText, ERROR_MESSAGE_MAX,
    turnErrorShown: { noteError: (...args: unknown[]) => { shownErrors.push(args); } },
    pushMessage: (message: { tool: { name: string } }) => { pushed.push(message); },
  };
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = (name: string) => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node && name === "foldCardScope" && !gateStatement) return "";
    if (!node) throw new Error(`Missing production wiring: ${name}`);
    return node.getText(ast);
  };
  const names = ["admitLedgerLease", "noteOwnerStop", "interruptDirectThread", "refusedTurnOf", "joinRefusedStop", "admittedLeaseForEvent", "runtimeErrorCardName", "foldCardScope", "terminalDispatchFor"];
  const gateStatement = ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations[0]?.name.getText(ast) === "turnCardGate");
  // Absent on a parent commit (the base replay): the shipped code then runs without the gate and the witness shows its RED.
  // The fold's own order for this event: find the lease (a sealed one ends the fold), then the runtime.error branch.
  const text = `${gateStatement?.getText(ast) ?? ""}
    ${names.map(declaration).join("\n")}
    function foldRuntimeError(event, bot, speaker, audienceMasked) {
      const executionEvent = event;
      const displayField = field => event[field];
      const eventLease = admittedLeaseForEvent(event);
      if (eventLease.sealed) return;
      switch (event.type) { case "runtime.error": { ${runtimeErrorClause(ast)} } }
    }
    ;globalThis.result = { ${names.filter(name => declaration(name) !== "").join(", ")}, foldRuntimeError };`;
  const context = vm.createContext(globals);
  vm.runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText, context);
  const built = context.result as Record<string, (...args: any[]) => any>;
  const lease = built.admitLedgerLease!("B", "T", "G", { turnId: "L" }, instance, { seal() {} }) as Lease;
  if (attached) lease.attach("P");
  const engineError = (turnId = "P", message = ENGINE_LINE) => built.foldRuntimeError!({ type: "runtime.error", threadId: "T", turnId, eventId: "E", provider: "acp", providerInstanceId: "I", message }, bot, undefined, false);
  const admitNext = (generation: string, turnId: string) => {
    const next = built.admitLedgerLease!("B", "T", generation, { turnId: `L-${generation}` }, instance, { seal() {} }) as Lease;
    next.attach(turnId);
    return next;
  };
  const evaluate = (text: string, extra: Record<string, unknown> = {}) => {
    for (const name of ["store", "replySpeakerTurns", "watchdog"]) {
      if (extra[name]) extra = { ...extra, [name]: { ...(context[name] as object), ...(extra[name] as object) } };
    }
    Object.assign(context, extra);
    return vm.runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText, context);
  };
  const production = (code: string, dependencies: Record<string, unknown> = {}) => {
    const previous = Object.fromEntries(Object.keys(dependencies).map(key => [key, context[key]]));
    const restore = () => Object.assign(context, previous);
    Object.assign(context, dependencies);
    try {
      const result = vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText, context);
      if (result && typeof result.then === "function") return result.finally(restore);
      restore();
      return result;
    } catch (error) { restore(); throw error; }
  };
  return { built, lease, leases, appended, pushed, calls, order, entered, release, engineError, admitNext, evaluate, shownErrors, production, ast, ops, heldWrites, releasePersistence };
}

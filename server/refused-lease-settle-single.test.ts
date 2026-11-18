import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// SETTLE-1 (owners: refusal settle = fix/1019-nc-shared; lease-terminal semantics = fix/1019-ma-rebuild). A refused lease's late-memory ticket
// is decided by ONE settle, settleRefusedLeaseTerminal, reached from the host's refused terminal (noteRefusedLeaseTerminal) and from the ticket's
// registration (registerLateTicket), whichever comes second. The provider's own turn.completed of a refused turn settles nothing. The behaviour
// (one arm, one decision per ticket) is witnessed in c11-refused-resend-api.test.ts; this file pins the call path.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
const body = (name: string) => {
  const start = source.search(new RegExp(`\\nfunction ${name}\\(`));
  expect(start, `function ${name} exists`).toBeGreaterThan(0);
  return source.slice(start, source.indexOf("\n}\n", start));
};

it("SETTLE-1 there is exactly one refused-terminal settle function", () => {
  expect(source.match(/\nfunction settleRefused\w*\(/g)).toEqual(["\nfunction settleRefusedLeaseTerminal("]);
});

it("SETTLE-1 both meeting points reach settleRefusedLeaseTerminal, and the refused terminal notes the lease", () => {
  expect(body("noteRefusedLeaseTerminal")).toContain("settleRefusedLeaseTerminal(lease.providerTurnId)");
  expect(body("registerLateTicket")).toContain("settleRefusedLeaseTerminal(turnId)");
  const refuseTerminal = source.slice(source.indexOf("const refuseTerminal = () => {"));
  expect(refuseTerminal.slice(0, refuseTerminal.indexOf("\n  };\n"))).toContain("noteRefusedLeaseTerminal(lease);");
});

it("SETTLE-1 a settled lease never arms a second decision", () => {
  expect(body("noteRefusedLeaseTerminal")).toContain("settledRefusedLeases.has(lease)) return;");
  expect(body("settleRefusedLeaseTerminal")).toMatch(/if \(settledRefusedLeases\.has\(lease\)\) return;\n\s*settledRefusedLeases\.add\(lease\);/);
});

it("SETTLE-1 the provider's turn.completed of a refused turn settles nothing", () => {
  const fold = source.slice(source.indexOf("const foldRuntimeEvent = (executionEvent: RuntimeEvent) => {"));
  expect(fold.split("\n")[1].trim()).toBe(`if (executionEvent.type === "turn.completed" && !terminalDispatchFor(executionEvent)) return;`);
  expect(source.match(/settleRefusedLeaseTerminal\(/g)).toHaveLength(3); // the definition and the two meeting points
});

// SETTLE-1 behaviour (the production bodies, evaluated from index.ts): whatever the order of the two meeting points, and however often the
// refused terminal is noted (the handback and the host's terminal both note it), one ticket is armed once and decided once.
it("SETTLE-1 exactly one settle runs per ticket in every meeting order, a re-noted lease or re-offered ticket arms nothing", async () => {
  const { wiring } = await import("./decision-wiring/fixture.ts");
  const { PendingTurnKeys } = await import("./fold-steps.ts");
  const orders: ("note" | "register")[][] = [["note", "register", "note"], ["register", "note", "note"], ["note", "note", "register"], ["register", "note", "register", "note"]];
  for (const order of orders) {
    const trace: string[] = [], lateMemoryRedispatches = new Map<string, unknown>();
    const g = wiring(["noteRefusedLeaseTerminal", "registerLateTicket", "settleRefusedLeaseTerminal"], {
      traceRefusedSettle: (step: string, turnId: string) => { if (step === "arm" || step === "decide") trace.push(`${step}:${turnId}`); },
      settledRefusedLeases: new WeakSet(), refusedLeaseTerminals: new Map(), refusedTerminalDecisions: new Set(), lateMemoryRedispatches,
      registry: { get: () => undefined }, ledgerProviderInstances: new WeakMap(), takeReleasedStoppedTurn: () => false, toolStartedTurns: new Set(),
      refusalStopJoins: new PendingTurnKeys(), refusalStopGenerations: new PendingTurnKeys(), deferredRefusalNotes: new Map(), store: { botByThread: () => undefined }, directRuns: { get: () => undefined },
    });
    let closed!: () => void;
    const lease = { providerTurnId: "turn-1", verdict: { state: "checking" }, identity: { threadId: "thread-1", dispatchGeneration: "gen-1" },
      teardownConfirmed: new Promise<void>(resolve => { closed = resolve; }) };
    const takes: string[] = [];
    const ticket = () => ({ owed: true, redispatch: false, afterSubmission: true, take: (how: string) => { takes.push(how); } });
    for (const step of order) step === "note" ? g.noteRefusedLeaseTerminal(lease) : g.registerLateTicket("turn-1", ticket());
    expect(trace, `${order.join(">")}: armed once`).toEqual(["arm:turn-1"]);
    closed(); await new Promise(resolve => setImmediate(resolve));
    expect(trace, `${order.join(">")}: decided once`).toEqual(["arm:turn-1", "decide:turn-1"]);
    expect(takes, `${order.join(">")}: one ticket decision`).toEqual(["none"]);
    // after the decision: the lease noted again and a fresh ticket offered for the same turn never arm a second settle
    g.noteRefusedLeaseTerminal(lease); g.registerLateTicket("turn-1", ticket()); g.noteRefusedLeaseTerminal(lease);
    await new Promise(resolve => setImmediate(resolve));
    expect(trace, `${order.join(">")}: still one settle`).toEqual(["arm:turn-1", "decide:turn-1"]);
  }
});

// Final-attempt tickets have neither redispatch nor afterSubmission: the production lastTicket must still end with one card.
it.each(["note-first", "ticket-first"].flatMap(order => [false, true].map(stopped => ({ order, stopped }))))("SETTLE-1 final-attempt ticket settles once: $order stopped=$stopped", async ({ order, stopped }) => {
  const { wiring } = await import("./decision-wiring/fixture.ts");
  const { PendingTurnKeys } = await import("./fold-steps.ts");
  const trace: string[] = [];
  let cards = 0, closed!: () => void;
  const stopGenerations = new PendingTurnKeys();
  if (stopped) stopGenerations.add("thread-1\0gen-1");
  const g = wiring(["noteRefusedLeaseTerminal", "registerLateTicket", "settleRefusedLeaseTerminal"], {
    traceRefusedSettle: (step: string) => { if (step === "arm" || step === "decide") trace.push(step); },
    settledRefusedLeases: new WeakSet(), refusedLeaseTerminals: new Map(), refusedTerminalDecisions: new Set(), lateMemoryRedispatches: new Map(),
    registry: { get: () => undefined }, ledgerProviderInstances: new WeakMap(), takeReleasedStoppedTurn: () => false, toolStartedTurns: new Set(),
    refusalStopJoins: new PendingTurnKeys(), refusalStopGenerations: stopGenerations, deferredRefusalNotes: new Map(),
    store: { botByThread: () => ({ id: "bot-1" }), taskByThread: () => undefined, setTaskActivity: () => {} },
    directRuns: { get: () => undefined }, retryDelegationsWaitingOn: () => {}, drainQueuedSends: () => {},
  });
  const lease = { providerTurnId: "final-turn", verdict: { state: "checking" }, identity: { threadId: "thread-1", dispatchGeneration: "gen-1" },
    teardownConfirmed: new Promise<void>(resolve => { closed = resolve; }) };
  // Evaluate the production final-attempt ticket too, so its owed guard and owner card are part of the witness.
  const ts = await import("typescript"), vm = await import("node:vm");
  const start = source.indexOf("const lastTicket: LateMemoryTicket =");
  const declaration = source.slice(start, source.indexOf("registerLateTicket(accepted.turnId, lastTicket);", start));
  expect(start).toBeGreaterThan(0);
  const ticket = vm.runInNewContext(ts.transpileModule(declaration + "\nlastTicket;", { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, {
    routineToken: undefined, memoryRefusalCauses: new Map(), userMessage: { id: "message-1" }, settleWithCard: () => { cards++; },
  });
  if (order === "note-first") g.noteRefusedLeaseTerminal(lease);
  g.registerLateTicket("final-turn", ticket);
  g.noteRefusedLeaseTerminal(lease);
  expect(ticket.owed).toBe(true);
  expect(cards).toBe(0);
  closed(); await new Promise(resolve => setImmediate(resolve));
  g.noteRefusedLeaseTerminal(lease); g.settleRefusedLeaseTerminal("final-turn");
  await new Promise(resolve => setImmediate(resolve));
  expect(ticket.owed).toBe(false);
  expect(trace).toEqual(["arm", "decide"]);
  expect(cards).toBe(stopped ? 0 : 1);
});

// L1: the fold path agrees with the lease path. A Stop that won over a final-attempt ticket (no redispatch, no afterSubmission, no routine)
// decides it "none" before the fold's card line, so the production lastTicket gives no card on either path.
it.each([false, true])("SETTLE-1 fold path: a stopped final-attempt ticket gives no card, stopped=%s", async stopped => {
  const ts = await import("typescript"), vm = await import("node:vm");
  let cards = 0;
  const run = (text: string, context: Record<string, unknown>) =>
    vm.runInNewContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, context);
  const start = source.indexOf("const lastTicket: LateMemoryTicket =");
  expect(start).toBeGreaterThan(0);
  const lastTicket = run(source.slice(start, source.indexOf("registerLateTicket(accepted.turnId, lastTicket);", start)) + "\nlastTicket;", {
    routineToken: undefined, memoryRefusalCauses: new Map(), userMessage: { id: "message-1" }, settleWithCard: () => { cards++; },
  });
  const foldStart = source.indexOf("const stoppedTurn=releasedStop||");
  const foldEnd = source.indexOf(`if(lateRedispatch)lateRedispatch.take("card");`, foldStart);
  expect(foldStart).toBeGreaterThan(0);
  expect(foldEnd).toBeGreaterThan(foldStart);
  run(source.slice(foldStart, foldEnd + `if(lateRedispatch)lateRedispatch.take("card");`.length), {
    releasedStop: stopped, directRun: undefined, directRuns: { get: () => undefined }, lateRedispatch: lastTicket,
    store: { taskByThread: () => undefined, setTaskActivity: () => {} }, bot: { id: "bot-1" }, event: { threadId: "thread-1" },
  });
  expect(lastTicket.owed).toBe(false);
  expect(cards).toBe(stopped ? 0 : 1);
});

import { HighLevelCallLedger } from "./highlevel/call-ledger.ts";
import { appendFixtureMessage } from './testing/approval-card.ts';
import { BotOutsideWrites } from "./bot-outside-writes.ts";
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";
import { isRestoreHeld, releaseHeldContinuation, runnableContinuation } from "./restore-fence.ts";
import { heldScanYield } from "./held-scan.ts";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as decision from "./decision/index.ts";
import { database, transaction } from "./database.ts";
import { bindProviderTurn, checkedOpenTurns, closeTurnLineage, memberTurnId, openTurnLineage, runningTurnFor, turnOfProvider, writeSessionLineage } from "./memory/lineage-write.ts";
import { noteSessionFrame } from './memory/session-proof-schema.ts';
import { RecallReadiness } from './memory/recall-readiness.ts';
import { heldQueueWaiting } from "./external-context-delivery.ts";
import { Store, threadSealed, type Message } from "./store.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { cardAttention, type AttentionOpen } from "./approval-attention.ts";
import { ProjectTurnLeases } from "./project-turn-leases.ts";
import { checkReplyActions, completedToolAction, startedToolAction, toolAction } from "./reply-action-guard.ts";
import { renderDriverReplay, replayMetadata } from "./turn-context.ts";
import { plainConnectedAppText } from "../shared/connected-app-tools.ts";
import { engineStamp } from "./engine-profile.ts";
import { memberTurnProvenance, turnIsBackground } from "./message-automation.ts";
import { isLiveRoutineRunStatus } from "./routines.ts";
import { adoptStagedImages, replyForStagedImages, memoryEchoDecision, retainSession } from "./fold-steps.ts";
import { providerReplyOf } from "./provider-reply.ts";
import { murageLine } from "./murage-line.ts";
import { isEngineOutput } from "./message-db.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { allocateIncarnation, latestIncarnation, sessionKeyOf, startFreshSession } from "./memory/session-incarnation.ts";
import { handedPinsOf, noteStartupFileEvent, promptFactsOf } from "./engine-env.ts";
import { windowRuntimeEvent } from "./runtime-event-out.ts";
import { isCommandTool } from "./auto-approve.ts";
import { commandCwdFromToolInput, commandFromToolInput } from "../shared/exact-command.ts";
import { grantRequestFor, routineCardFields } from "./approval-grant-request.ts";
import { closedFences, WIDGET_FENCE } from "../shared/murage-fences.ts";
import { QUESTION_FENCE } from "../shared/ask-wording.ts";
import { fromQuestionFence } from "./question-normalize.ts";
import { showWidget } from "./chat-widgets.ts";
import { RetainedCloses } from "./reload-retain.ts";
import { IndependentThreadRuns } from "./independent-thread-runs.ts";
import { outsideAuthorityForExecution } from "./outside-wire.ts";
import { EventBus } from "./harness/bus.ts";
import { createReplySpeakerTurns } from "./reply-speaker-guard.ts";
import type { RuntimeEvent, SourceContext } from "./contracts.ts";
import { ShellSessionRegistry } from "./shell-session-state.ts";
import { TurnUsageRoutines } from "./turn-usage-routine.ts";

type FixtureRun = { id: string; threadId: string; status: string };
function fixtureRoutines(listRuns: () => FixtureRun[] = () => []) {
  return {
    listRuns,
    runById(id: string) { return this.listRuns().find(run => run.id === id); },
    newestLiveRunInThread(threadId: string) { return this.listRuns().find(run => run.threadId === threadId && ["running", "waiting"].includes(run.status)); },
    getEventBudget: () => ({ closed: false }),
  };
}

/** Every name index.ts imports (a value, not a type) that the fold reads, bound to the module index.ts imports it from: the fold runs
 * with the same helpers production hands it, so a new import in index.ts needs no edit here. The fixture's own scope entries below
 * (inert outside services, isolated storage) win over these. */
const INDEX_SOURCE = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
// Subscribe wrappers may change without changing the fold. Extract the actual
// declaration, so an absent trailing substring cannot pull server startup in.
const INDEX_AST = ts.createSourceFile("index.ts", INDEX_SOURCE, ts.ScriptTarget.Latest, true);
const FOLD_SOURCE = [...INDEX_AST.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && ["runtimeMessageWriter", "prepareTerminalEvent", "terminalDirectContext", "terminalDispatchFor"].includes(statement.name?.text ?? "")),
  INDEX_AST.statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "foldRuntimeEvent"))!
].map(statement => statement.getText(INDEX_AST)).join("\n");
const productionImports: Record<string, unknown> = await (async () => {
  const fold = FOLD_SOURCE;
  const out: Record<string, unknown> = {};
  for (const match of INDEX_SOURCE.matchAll(/^import\s+\{([^}]*)\}\s+from\s+"(\.{1,2}\/[^"]+)";/gm)) {
    const names = match[1]!.split(",").map((part) => part.trim()).filter((part) => part && !part.startsWith("type "))
      .map((part) => { const [imported, local = imported] = part.split(/\s+as\s+/).map((name) => name.trim()); return { imported: imported!, local: local! }; })
      .filter(({ local }) => new RegExp(`(?<![\\w$])${local.replace(/\$/g, "\\$")}\\b`).test(fold));
    if (!names.length) continue;
    const module = await import(new URL(match[2]!, new URL("./index.ts", import.meta.url)).href) as Record<string, unknown>;
    for (const { imported, local } of names) if (imported in module) out[local] = module[imported];
  }
  return out;
})();

/** Execute the production event fold with isolated storage and inert outside
 * services. This is a behavior test, not a census of source substrings. */
const decisionReleases: Array<() => void> = [];
afterEach(() => { for (const release of decisionReleases.splice(0).reverse()) release(); });

function foldFixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "one" }));
  const bot = store.createBot({}, { seedMessages: false });
  const instance = { instanceId: "fixture", driverKind: "fixture", adapter: { capabilities: {} }, models: { default: "one", options: [{ id: "one", contextWindow: 1000 }, { id: "reported", contextWindow: 5000 }] } } as any;
  const stamp = engineStamp(instance, "one");
  const stamps = new Map([[bot.threadId, stamp]]);
  const noop = () => undefined;
  const bus = new EventBus();
  bus.omitLog(() => true);
  bus.attach([{ ...instance, adapter: { ...instance.adapter, onEvent: () => noop } }]);
  let requestEvent: decision.RequestOpenedEvent | undefined;
  decisionReleases.push(decision.installDecisionHost({ store, view: () => ({ title: "Fixture request", subtitle: "Fixture" }) }));
  decision.installEngineApprovalBuilder(registration => ({ options: registration.snapshot?.event.choices ?? ["Allow", "Deny"] }));
  decision.installProvenanceReader({
    turnGenerationFor: threadId => requestEvent?.threadId === threadId ? requestEvent.turnId : undefined,
    provenance: () => requestEvent ? { generation: requestEvent.turnId!, threadId: bot.threadId, botId: bot.id, principal: "owner", roomOwnerOnly: true, at: 1, initiator: { k: "owner-typed" } } : undefined,
    live: threadId => requestEvent?.threadId === threadId ? { botId: bot.id, turnId: requestEvent.turnId!, providerInstanceId: "fixture", principal: "owner", owner: true, level: "ask" } : undefined,
  });
  decision.installDenySources({ revision: () => [], resolve: () => [] });
  decisionReleases.push(decision.installRequestIngress({ subscribe: listener => bus.subscribeExecution(event => {
    if (event.type === "request.opened") requestEvent = event;
    listener(event);
  }, { durable: false }) }));
  // design1019-approval-attention: handleDecisionRequest hands every card to the real attention module before it presents it.
  // The module is real; only its outside ports are fixture recorders (no board, one bot), so the fold sees production's
  // register -> present -> ask path and a test can read what reached the owner.
  const notices: AttentionOpen[] = [];
  const activity = new Map<string, string>();
  const approvalAttention = cardAttention({
    ownsActivity: () => true,
    activity: (botId, threadId) => activity.get(`${botId}:${threadId}`),
    setActivity: (botId, threadId, next) => { activity.set(`${botId}:${threadId}`, next); },
    boardRun: () => undefined, parkBoard: noop, resumeBoard: noop,
    notify: open => { notices.push({ ...open }); },
    wait: noop,
  });
  const scope: Record<string, unknown> = {
    ...productionImports, ...decision,
    approvalAttention,
    // The fold's shell-judgement maps (index.ts module declarations): empty, as before any shell permission was prepared.
    shellPrepared: new WeakMap(), shellPreparedRecord: new WeakMap(), shellPreparing: new WeakSet(),
    // the project card-run leases the terminal fold completes (index.ts module declaration): none held by this fixture
    projectTurnLeases: new ProjectTurnLeases(),
    baseEngineVerdict: () => ({ approve: null, source: "always-ask" }), shouldReview: () => false, autoAnsweredAsks: new Set(),
    shellSessions: new ShellSessionRegistry(),
    terminalPreparations: new WeakMap(), ledgerLeasesByAdmission: new WeakMap(), ledgerCompletionSources: new WeakMap(), ledgerProviderInstances: new WeakMap(),
    bus, queueMicrotask, replySpeakerTurns: createReplySpeakerTurns(), roomLiveTurns: new Map(), turnStartedAtMs: new Map(),
    highlevelCallLedger: new HighLevelCallLedger(threadId => store.threadHighLevelMarked(threadId) !== "unmarked"),
    turnUsageRoutines: new TurnUsageRoutines(() => undefined), projectRoutineRunOfRoomTurn: () => null,
    legacyToolNamesByThread: new Map(),
    releaseLocalVmThread: noop, retiredProviderTurns: new Set(), removeGroupGoalCoordinatorTurn: noop,
    turnUsage: new Map(), lateMemoryRedispatches: new Map(), turnRefusalNotes: new Map(),
    takeReleasedStoppedTurn: () => false, consumeReleasedStoppedTurn: noop, settleDirectAttempts: noop,
    recordReplyActionCheck: noop, desktopActionCaughtByStop: () => false, hostStopNotedSinceLastUserMessage: () => false,
    browserCheckTurns: { terminal: () => false }, callRunByTurn: new Map(), delegationWatch: new Map(),
    outputPublisher: { publishTerminalOutputs: async () => {} }, terminalPublications: new Map(), routinePublicationStarted: noop,
    activeVpsThreads: new Map(), activeProviderSelections: new Map(), askTurnDevices: new Map(),
    fluxSpend: { markStale: noop }, spendGate: { endTurn: noop, onSettled: noop },
    drainQueuedSends: noop, finishDirectAttemptEffects: noop, retryDelegationsWaitingOn: noop, finalizeDelegationWatch: noop,
    turnReplyCopy: () => undefined, refusedBeforeHandback: new Map(), TURN_REFUSAL_NOTES_MAX: 4096,
    randomUUID, screenPollers: new Map(), generatedImageTurnKey: (threadId: string, turnId?: string) => `${threadId}:${turnId ?? "active"}`,
    engineLabelOf: () => "Fixture", filesTouchedSince: () => [],
    pokeScreenPoller: noop, providerConnections: { resolve: noop }, modelSignIns: { has: () => false },
    turnAttribution: { attempt: noop }, serviceThreadNoLimits: () => false,
    // The isolated fold owns no admitted engine lease or dispatched run. Keep
    // the same registries production reads before it handles every event.
    admittedLedgerLeases: new Map(), internalTurnOwners: new Map(), directRuns: new IndependentThreadRuns(),
    // Match an installation that has not accepted No limits terms; the real terms guard still runs.
    cfg: {},
    // callSpeech: D24's call speech coordinator; no call is live, so no provider turn feeds call speech here
    callSpeech: { provider: () => undefined },
    botOutsideWrites: new BotOutsideWrites(store, () => null),
    store, toolAction, startedToolAction, completedToolAction, engineStamp, plainConnectedAppMessage: (row: unknown) => row,
    internalCapabilities: new InternalCapabilities(),
    // what index.ts imports for every permission event (engine-env.ts Rule 74a, shared/exact-command.ts): the real ones, as in production
    noteStartupFileEvent, handedPinsOf, promptFactsOf, commandCwdFromToolInput, commandFromToolInput, turnCwdByThread: new Map(), turnDriverByThread: new Map(), routineCardFields, grantRequestFor,
    // the window's copy of every runtime event (runtime-event-out.ts), the real one, as in production
    windowRuntimeEvent,
    // turns that started a tool (OPENAI-TOOLS-109 s5.2: never rebuilt after a late memory refusal)
    toolStartedTurns: new Set(), TOOL_STARTED_TURNS_MAX: 4096,
    // which tools are shell commands (auto-approve.ts), the real one, as in production
    isCommandTool,
    fluxMemoryCapture: { begin() {}, observe() {} },
    fluxFirstTokenProbe: { observe: noop, begin: noop },
    // fc43c2145c routes waiting through browser execution; this fixture owns neither a browser nor a watchdog.
    setWaitingOnHuman: noop,
    accountProjectEvent: noop, shouldIgnoreProviderEvent: () => false, replyGuardContext: () => null,
    accountPresentedProjectEvent: () => true, presentedRequests: { publish: noop },
    localVmThreadTargets: new Map(), groupGoalCoordinatorTurns: new Map(), groupGoalCoordinatorTurnForEvent: () => null,
    liveSubtasks: new Map(), broadcast: noop, routines: undefined, botForDirectThread: () => bot,
    groupSpeakers: new Map(), turnEngineByThread: stamps, memoryDispatches: new Map(),
    // the model Flux reported serving each thread's turn (usage-tags: stored on the reply), empty: these fixtures are no Flux turn
    turnServedModelByThread: new Map(),
    toolMessageByItem: new Map(), toolRowByItem: new Map(), narrateTool: () => "Sending", screenTouchingTool: () => false,
    turnOutputRoots: new Map(), freshReplayConfirmations: new WeakMap(), isMemoryProvenanceEcho: () => false, lastReply: new Map(), sessionAudienceByThread: new Map(), registry: { get: () => instance },
    isUnattended: () => false, exactAllowKeyFor: noop, routineRunLevel: () => null,
    routinePeerSources: new Map(), routinePeerApprover: (value: unknown) => value,
    questionFromChoices: (summary: string, choices: string[]) => ({ question: summary, options: choices }),
    lowRiskStamp: () => ({}), askMessageByRequest: new Map(), resolveAutoReviewMode: () => "off",
    createHash, retainSession, adoptStagedImages, memoryEchoDecision, generatedImagesByTurn: new Map(), memoryEchoReplies: new Map(),
    // MAIN RULING 1115-RECALL-GROK-Q1Q2: extracted native events use the actual frame marker and live-turn validation.
    noteSessionFrame, checkedOpenTurns,
    performance, providerReplyOf, murageLine, database, sessionKeyOf, latestIncarnation, allocateIncarnation, startFreshSession, threadSealed, appendDecision: noop, turnIsBackground, addSourcesToRunningTurn: noop, DATA_DIR: "fixture", workAdmission: { liveTurns: () => [] }, notify: noop, buildNotification: noop,
  };
  const source = INDEX_SOURCE;
  // This local production closure carries the driver and Cloud execution
  // authority into the tool-start fold; evaluate it with this fixture's maps.
  const authorityStart = source.indexOf("const outsideAuthorityOf =");
  scope.outsideAuthorityOf = runInNewContext(stripTypeScriptTypes(source.slice(authorityStart, source.indexOf("\n", authorityStart))) + "\noutsideAuthorityOf;",
    { ...scope, outsideAuthorityForExecution, process });
  const generationStart = source.indexOf("const turnGenerationFor =");
  scope.turnGenerationFor = runInNewContext(stripTypeScriptTypes(source.slice(generationStart, source.indexOf("\n", generationStart))) + "\nturnGenerationFor;", scope);
  const plainStart = source.indexOf("function plainConnectedAppMessage");
  scope.plainConnectedAppMessage = runInNewContext(stripTypeScriptTypes(source.slice(plainStart, source.indexOf('const SETUP_TASK_TITLE', plainStart))) + "\nplainConnectedAppMessage;", { plainConnectedAppText });
  // the memory session a session.started names (S6 rule 27), compiled in the same context so it reads the fixture's maps
  const sessionStartSource = INDEX_AST.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === "sessionStartOf")!.getText(INDEX_AST);
  scope.sessionStarts = new WeakMap();
  scope.sessionStartOf = runInNewContext(stripTypeScriptTypes(sessionStartSource) + "\nsessionStartOf;", scope);
  // QW Q2/Q4: the fold's fence step (index.ts), compiled from production with its real parsers; this fixture runs no internal turn,
  // so a fence here is refused and stays the bot's text (the fence cards themselves are pinned in ask-user-answer-api.test.ts)
  const fenceStart = source.indexOf("const fencedMessages = new Set<string>();");
  const fenceEnd = source.indexOf("\n}\n", source.indexOf("function materialiseQuestionFences", fenceStart)) + 2;
  scope.materialiseQuestionFences = runInNewContext(stripTypeScriptTypes(source.slice(fenceStart, fenceEnd)) + "\nmaterialiseQuestionFences;", {
    store, closedFences, QUESTION_FENCE, WIDGET_FENCE, fromQuestionFence, showWidget, isUnattended: () => false,
    internalTurnOwners: new Map(), turnAttribution: { attempt: () => undefined }, openAnswerAsSendCard: noop,
  });
  const decisionSource = INDEX_AST.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "handleDecisionRequest")!.getText(INDEX_AST);
  scope.handleDecisionRequest = runInNewContext(stripTypeScriptTypes(decisionSource) + "\nhandleDecisionRequest;", scope);
  // The card's project run and a provider event's attention scope, compiled from production in this scope (both are index.ts
  // module declarations, so productionImports cannot bind them).
  for (const name of ["liveProjectRun", "eventAttentionScope"]) {
    const declaration = INDEX_AST.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)!.getText(INDEX_AST);
    scope[name] = runInNewContext(stripTypeScriptTypes(declaration) + `\n${name};`, scope);
  }
  const code = stripTypeScriptTypes(FOLD_SOURCE) + "\n({ fold: foldRuntimeEvent, prepare: prepareTerminalEvent });";
  const production = runInNewContext(code, scope) as { fold(event: RuntimeEvent): void; prepare(event: RuntimeEvent): unknown };
  // Production events each carry their own eventId, and the fold derives a message's stable id from it (so a redelivery of the SAME
  // event adds nothing twice). These fixtures reuse one literal eventId across many distinct events, so every distinct event
  // object gets its own suffix here; passing the same object again is a redelivery and keeps its id.
  const issued = new WeakMap<object, string>();
  const executions = new WeakMap<object, RuntimeEvent>();
  const sources = new Map<string, SourceContext>();
  let issuedCount = 0;
  const fold = (event: Record<string, unknown>) => {
    let id = issued.get(event);
    if (!id) { id = `${String(event.eventId ?? "event")}#${++issuedCount}`; issued.set(event, id); }
    const key = `${event.threadId}\0${event.turnId ?? ""}`;
    if (!sources.has(key) || event.type === "turn.started") sources.set(key, bus.admitNewTurn("fixture", String(event.threadId)));
    let execution = executions.get(event);
    if (!execution) { execution = { ...event, eventId: id } as RuntimeEvent; executions.set(event, execution); }
    // Populate the real collector's separately projected display view before
    // folding the unchanged execution graph, just as subscribeExecution does.
    bus.publish(execution, sources.get(key));
    if (execution.type === "turn.completed" && !(scope.terminalPreparations as WeakMap<object, unknown>).has(execution)) {
      const registry = scope.internalCapabilities as InternalCapabilities;
      const generation = registry.begin(bot.id, String(execution.threadId));
      if (execution.turnId) registry.bindProviderTurn(execution.threadId, generation, execution.turnId);
      const lease = { identity: { threadId: execution.threadId, dispatchGeneration: generation }, providerTurnId: execution.turnId };
      const source = sources.get(key)!;
      (scope.ledgerLeasesByAdmission as WeakMap<object, unknown>).set(source.admission!, lease);
      (scope.ledgerCompletionSources as WeakMap<object, unknown>).set(lease, source);
      (scope.ledgerProviderInstances as WeakMap<object, string>).set(lease, "fixture");
      try {
        const prepared = production.prepare(execution);
        if (prepared) (scope.terminalPreparations as WeakMap<object, unknown>).set(execution, prepared);
      } finally { if (execution.turnId) registry.completeProviderTurn(execution.threadId, execution.turnId); }
    }
    production.fold(execution);
  };
  return { store, bot, fold, stamps, instance, scope, approvalAttention, notices, activity };
}

it("an unowned session event cannot bind a successor send attempt", () => {
  const { bot, fold, scope } = foldFixture();
  const attach = vi.fn();
  scope.directRuns = { get: () => ({ generation: "successor", phase: "dispatching" }) };
  scope.directAttemptProvider = attach;
  fold({ type: "session.started", threadId: bot.threadId, turnId: "older-turn", providerInstanceId: "fixture" });
  expect(attach).not.toHaveBeenCalled();
});

it("a delayed native session cannot allocate an incarnation under its successor", () => {
  const { bot, scope } = foldFixture();
  const replacement = { instanceId: "fixture", generation: "successor" };
  const allocate = vi.fn(() => 1);
  scope.turnOutputRoots = new Map([[bot.threadId, replacement]]);
  scope.terminalDispatchFor = () => ({ identity: { dispatchGeneration: "older" } });
  scope.allocateIncarnation = allocate;
  scope.turnOfProvider = () => undefined;
  scope.runningTurnFor = () => undefined;
  scope.noteSessionFrame = () => {};
  scope.recordSessionRoots = () => {};
  const start = scope.sessionStartOf as (event: Record<string, unknown>, instance: string) => { applies: boolean };
  const event = { type: "session.started", threadId: bot.threadId, turnId: "older-turn", providerInstanceId: "fixture", sessionId: "native-session" };
  expect(start(event, "fixture").applies).toBe(false);
  expect(allocate).not.toHaveBeenCalled();
  expect(replacement).not.toHaveProperty("session");
  scope.terminalDispatchFor = () => ({ identity: { dispatchGeneration: "successor" } });
  expect(start({ ...event, turnId: "current-turn" }, "fixture").applies).toBe(true);
  expect(allocate).toHaveBeenCalledOnce();
  expect(replacement).toHaveProperty("session", "native-session");
});


it.each(["marker", "coordinator"] as const)("terminal preparation failure at %s retains one public coordinator reply on presentation retry", failure => {
  const { store, bot, fold, scope } = foldFixture();
  const coordinator = { turnId: "fixture-turn", assistantItems: ["private-coordinator-envelope"] };
  scope.groupGoalCoordinatorTurnForEvent = () => coordinator;
  scope.parseGroupGoalDecision = () => ({ visibleText: "Public fixture reply." });
  const mark = vi.spyOn(store, "markTerminalAssistantMessage");
  const append = store.appendMessage.bind(store);
  const pushes = vi.spyOn(store, "appendMessage");
  if (failure === "marker") mark.mockImplementationOnce(() => { throw Error("fixture terminal write failed"); });
  else {
    pushes.mockImplementationOnce((...args) => {
      append(...args);
      throw Error("fixture terminal write failed");
    });
  }
  const event = { type: "turn.completed", eventId: "fixture-end", createdAt: "2026-01-01T00:00:00.000Z",
    providerInstanceId: "fixture", threadId: bot.threadId, turnId: "fixture-turn", ok: true };
  expect(() => fold(event)).toThrow("fixture terminal write failed");
  expect((scope.internalCapabilities as InternalCapabilities).activeGeneration(bot.threadId)).toBeUndefined();
  expect(() => fold(event)).not.toThrow();
  const replies = store.messagesFor(bot.threadId).filter(row => row.role === "bot" && row.kind === "text");
  expect(replies.map(row => row.text)).toEqual(["Public fixture reply."]);
  expect(JSON.stringify(store.messagesFor(bot.threadId))).not.toContain("private-coordinator-envelope");
  expect(mark).toHaveBeenCalledTimes(failure === "marker" ? 1 : 0);
  expect(pushes).toHaveBeenCalledTimes(failure === "marker" ? 1 : 2);
});

it("F3 production fold stamps tool start, completion and options rows for the guard", async () => {
  const { store, bot, fold, approvalAttention, notices, activity } = foldFixture();
  const base = { threadId: bot.threadId, turnId: "turn", providerInstanceId: "fixture", eventId: "event" };
  // The fixture's provenance names "turn" as the request's generation; admission gives that generation its attention scope.
  const attentionScope = approvalAttention.admit(bot.threadId, "turn");
  fold({ ...base, type: "item.started", itemType: "tool", itemId: "tool", title: "send_message" });
  const started = store.activePath(bot.threadId).at(-1)!;
  expect(started.turnId).toBe("turn"); expect(started.tool?.action?.outcome).toBe("pending");
  fold({ ...base, type: "item.completed", itemType: "tool", itemId: "tool", ok: true });
  expect(store.activePath(bot.threadId).at(-1)).toMatchObject({ turnId: "turn", tool: { ok: true, action: { classes: ["send"], outcome: "completed" } } });
  fold({ ...base, type: "request.opened", requestType: "question", requestId: "question", tool: "AskUserQuestion", summary: "Which format?", choices: ["Short", "Long"] });
  expect(store.activePath(bot.threadId).at(-1)).toMatchObject({ kind: "options", turnId: "turn" });
  expect(decision.openApprovals(bot.threadId)).toMatchObject([{ why: "base", state: "open", requestId: "question" }]);
  fold({ ...base, type: "request.opened", requestType: "permission", requestId: "permission", tool: "write_file", summary: "Save fixture", toolCall: { name: "write_file", input: { path: "fixture.txt" } } });
  expect(store.activePath(bot.threadId).at(-1)).toMatchObject({ kind: "options", turnId: "turn" });
  // Both cards reach WAITING in the admitted scope and the owner hears about each once, through the attention notify port,
  // each naming its request, its visible card, its record's bot and its frozen turn id (H1/H2 of the attniso-race review: the
  // notification left handleDecisionRequest for that port). This fixture's question is decided as a card ("base"), so it is
  // an approval notice, exactly as the train's `outcome.kind === 'card'` notifyApproval branch sent it.
  const cards = decision.openApprovals(bot.threadId);
  await vi.waitFor(() => expect(notices).toHaveLength(2));
  // The visible card each record presented: an options row on the thread under the record's chat message id.
  const cardOf = (requestId: string) => {
    const id = cards.find(card => card.requestId === requestId)?.chatMessageId;
    expect(store.activePath(bot.threadId).find(row => row.id === id)).toMatchObject({ kind: "options", turnId: "turn" });
    return id;
  };
  const botOf = (requestId: string) => cards.find(card => card.requestId === requestId)?.botId;
  expect(notices.map(open => ({ requestId: open.requestId, messageId: open.messageId, notice: open.notice, botId: open.botId }))).toEqual([
    { requestId: "question", messageId: cardOf("question"), notice: { kind: "approval", requestTurnId: "turn" }, botId: botOf("question") },
    { requestId: "permission", messageId: cardOf("permission"), notice: { kind: "approval", requestTurnId: "turn" }, botId: botOf("permission") },
  ]);
  expect(notices.every(open => typeof open.messageId === "string" && open.messageId !== "")).toBe(true);
  for (const card of cards) expect(approvalAttention.state(attentionScope, { kind: "engine", approvalId: card.ref.approvalId })).toBe("WAITING");
  expect(activity.get(`${botOf("permission")}:${bot.threadId}`)).toBe("waiting-on-you");
  fold({ ...base, type: "item.completed", itemType: "assistant_text", text: "I sent it." });
  fold({ ...base, type: "item.started", itemType: "tool", itemId: "ask", title: "mcp__team__ask_bot" });
  fold({ ...base, type: "item.completed", itemType: "tool", itemId: "ask", ok: true });
  expect(store.activePath(bot.threadId).at(-1)).toMatchObject({ turnId: "turn", tool: { action: { classes: ["send", "delegate"], outcome: "completed" } } });
  const reply = store.markTerminalAssistantMessage(bot.threadId, "turn")!;
  expect(checkReplyActions({ reply, path: store.activePath(bot.threadId) }).state).toBe("recorded");
});

it("F10 reported model updates the capability hash used by subsequent folded rows", () => {
  const { store, bot, fold, instance } = foldFixture();
  fold({ type: "session.started", threadId: bot.threadId, turnId: "turn", providerInstanceId: "fixture", model: "reported" });
  fold({ type: "item.started", itemType: "tool", threadId: bot.threadId, turnId: "turn", title: "write_file" });
  expect(store.activePath(bot.threadId).at(-1)?.engine).toEqual(engineStamp(instance, "reported"));
});

it("F10 a delayed final screen frame retains the settled turn's immutable provenance", async () => {
  const { store, bot, stamps } = foldFixture();
  const engine = stamps.get(bot.threadId)!;
  const last = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "done", turnId: "old" });
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const code = source.match(/void finalScreenFrame\(bot\.id, event.threadId\)\.then\([\s\S]*?\}\)\.finally\([^\n]+/u)![0];
  let release!: (frame: { png: string; mime: string }) => void;
  const promise = new Promise<{ png: string; mime: string }>(resolve => { release = resolve; });
  runInNewContext(stripTypeScriptTypes(code), { store, bot, event: { threadId: bot.threadId }, eventEngine: engine, completedTurnId: "old", settleLeafId: last.id, group: undefined, finalScreenFrame: () => promise, clearVpsTurn: () => {}, settleDirect: () => {} });
  stamps.set(bot.threadId, { ...engine, instanceId: "new" });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "next" });
  release({ png: "fixture", mime: "image/png" }); await promise; await new Promise<void>(resolve => setImmediate(resolve));
  expect(store.messagesFor(bot.threadId).find(row => row.kind === "screen")).toMatchObject({ engine, turnId: "old" });
});

it("F2 resumes held requests through their original dispatcher after authority revalidation", async () => {
  const { store, bot } = foldFixture();
  const principal = { kind: "owner", personId: "owner" };
  const options = { eventId: "original-budget", routineAuthority: { permissionMode: "ask", triggerSource: "schedule" }, unattended: true, notOwnerAudience: true, continuationPermissionMode: "ask" };
  store.holdTaskContinuation(bot.id, bot.threadId, "ROUTINE_REQUEST", { id: "request", dispatcher: "direct", principal: JSON.stringify(principal), runId: "original-run", options });
  store.setTaskAutomationEvent(bot.id, bot.threadId, "owner-budget");
  const calls: unknown[][] = [];
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("const heldDispatches =");
  const end = source.indexOf("\nstore.onChange(change =>", start);
  const scope = { store, roomEngine: { ready: true }, registry: { get: () => ({ adapter: { capabilities: { agentsMcp: true } } }) }, routeHasTools: () => true,
    threadHumanPrincipal: () => principal, routines: fixtureRoutines(() => [{ id: "original-run", threadId: bot.threadId, status: "waiting" }]),
    startTurn: async (...args: unknown[]) => { calls.push(args); }, startCardContinuation: async () => { throw new Error("wrong dispatcher"); }, noteHeldQueue: () => {}, heldScanYield, runnableContinuation, isRestoreHeld, releaseHeldContinuation, currentRestoreGeneration: () => null };
  const drain = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + "\ndrainHeldContinuations;", scope);
  await drain(bot.id);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual([bot.id, "ROUTINE_REQUEST", expect.objectContaining({ ...options, heldContinuationId: "request", cardContinuation: true })]);
  (scope.routines.listRuns as () => unknown[]) = () => [];
  await drain(bot.id);
  expect(calls).toHaveLength(1);
  expect(store.taskByThread(bot.id, bot.threadId)?.heldContinuations?.[0].error).toContain("original routine run");
});

it.each(["bot", "project"])("skips a held %s route with no model selection and can resume later", async route => {
  const { store, bot } = foldFixture();
  const principal = { kind: "owner", personId: "owner" };
  store.holdTaskContinuation(bot.id, bot.threadId, "HELD_REQUEST", {
    id: "held", dispatcher: "direct", principal: JSON.stringify(principal),
  });
  const selection = bot.modelSelection;
  const routeBot = route === "bot" ? bot : { ...bot };
  Reflect.deleteProperty(routeBot, "modelSelection");
  const projection = vi.spyOn(store, "projectBotForTask").mockReturnValue(route === "project" ? routeBot : null);
  const get = vi.fn(() => ({ adapter: { capabilities: { agentsMcp: true } } }));
  const startTurn = vi.fn(async () => {});
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("const heldDispatches =");
  const end = source.indexOf("\nstore.onChange(change =>", start);
  const drain = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + "\ndrainHeldContinuations;", {
    store, roomEngine: { ready: true }, registry: { get }, routeHasTools: () => true,
    threadHumanPrincipal: () => principal, startTurn, noteHeldQueue: () => {}, heldScanYield, runnableContinuation, isRestoreHeld, releaseHeldContinuation, currentRestoreGeneration: () => null,
  });
  try {
    await expect(drain(bot.id)).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
    expect(store.continuationHolder(bot.id, bot.threadId)?.heldContinuations).toEqual([
      expect.objectContaining({ id: "held", text: "HELD_REQUEST" }),
    ]);
    expect(store.continuationHolder(bot.id, bot.threadId)?.heldContinuations?.[0].error).toBeUndefined();
    routeBot.modelSelection = selection;
    await drain(bot.id);
    expect(startTurn).toHaveBeenCalledWith(bot.id, "HELD_REQUEST", expect.objectContaining({ heldContinuationId: "held" }));
  } finally { projection.mockRestore(); }
});

it("F7 production ACP recovery preserves headers, omissions and the continuity rule", () => {
  const source = readFileSync(new URL("./drivers/acp/core.ts", import.meta.url), "utf8");
  const start = source.indexOf("const replayTurn =");
  const end = source.indexOf("const replayGrokTurn", start);
  const turn = { text: "latest", transcript: [{ role: "assistant", text: "away", header: "[Written on Engine B.]" }], replayMetadata: replayMetadata(5) };
  const replay = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + "\nreplayTurn;", { turn, renderDriverReplay })("[Recovery]");
  expect(replay.text).toContain("5 earlier lines"); expect(replay.text).toContain("Written on Engine B"); expect(replay.text).toContain("do not restate");
});

it("F1 room card continuations stay in a visible durable queue before prompt construction", async () => {
  const { store, bot } = foldFixture();
  const group = store.createGroup("Room fixture", [bot.id]);
  const card = appendFixtureMessage(store, group.threadId, { role: "bot", kind: "options", card: { title: "Request", subtitle: "Continue this request", options: ["Continue"], requestId: "room-card" } });
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function startCardContinuation(");
  const end = source.indexOf("\n/** T22", start);
  const queueStart = source.indexOf("function noteHeldQueue(");
  const queueEnd = source.indexOf("\nconst heldDispatches", queueStart);
  const scope = { store, connectorThread: () => ({ bot, group }), registry: { get: () => ({ adapter: { capabilities: {} } }) },
    routeHasTools: () => false, threadHumanPrincipal: () => ({ kind: "owner" }), routines: fixtureRoutines(),
    botPermissionMode: () => "ask", routinePeerSource: () => undefined, turnSessionAudience: () => "original-room-audience", latestRoomUserMessage: () => ({ origin: "desktop" }),
    heldQueueText: (count: number) => `Waiting for a tool-capable engine: ${count} item(s). Open now`, heldQueueWaiting,
    runGroupMemberTurn: () => { throw new Error("A held request reached the room engine"); } };
  const run = runInNewContext(stripTypeScriptTypes(source.slice(queueStart, queueEnd) + source.slice(start, end)) + "\nstartCardContinuation;", scope);
  await run(bot.id, group.threadId, "ROOM_ACTION_CANARY", undefined, card.id);
  await run(bot.id, group.threadId, "ROOM_ACTION_CANARY", undefined, card.id);
  const held = store.continuationHolder(bot.id, group.threadId)?.heldContinuations!;
  expect(held).toHaveLength(1); expect(held[0]).toMatchObject({ dispatcher: "room", cardId: card.id, options: { roomAudience: "original-room-audience", continuationPermissionMode: "ask" } });
  const queued = store.activePath(group.threadId).find(row => row.murage?.held);
  expect(queued?.murage?.held).toMatchObject({ count: 1, items: [{ text: "ROOM_ACTION_CANARY", rowId: card.id }] });
  expect(store.activePath(group.threadId).find(row => row.id === card.id)?.card?.held).toContain("Waiting");
});

it("F11 room continuation admission preserves the originating connection card", async () => {
  const { store, bot } = foldFixture();
  const group = store.createGroup("Connection room", [bot.id]);
  const original = store.appendMessage(group.threadId, { role: "bot", kind: "activity", text: "Original connection" });
  appendFixtureMessage(store, group.threadId, { role: "bot", kind: "options", card: { title: "Other request", subtitle: "Unrelated", options: [], requestId: "other" } });
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function runGroupMemberTurnDispatch(");
  const end = source.indexOf("  // One admission arbiter", start);
  if (start < 0 || end <= start) throw new Error("Production room dispatch boundary moved");
  // the real provenance seam: a room turn is told its automation by memberTurnAutomation, so it is extracted, not stubbed
  const memberStart = source.indexOf("function memberTurnAutomation(");
  const memberEnd = source.indexOf("/** The message the owner pinned", memberStart);
  const scope = { RecallReadiness, LineageAllowance, store, homeExecutionGate: undefined, memberTurnProvenance, turnIsBackground, isLiveRoutineRunStatus, backupRestartAdmission: { held: () => false }, routineRunLevel: () => null, roomRounds: new Map(), cfg: {}, decisionServiceContext: { exit: (work: () => unknown) => work() },
    registry: { get: () => ({ adapter: { capabilities: {} } }) }, routeHasTools: () => false,
    threadHumanPrincipal: () => ({ kind: "owner" }), routines: fixtureRoutines(),
    botPermissionMode: () => "ask", resolveTurnFor: (_task: unknown, profile: { modelSelection: unknown }) => ({ selection: profile.modelSelection }), routinePeerSource: () => undefined, turnSessionAudience: () => "audience", latestRoomUserMessage: () => undefined, noteHeldQueue: () => {}, heldScanYield, runnableContinuation, isRestoreHeld, releaseHeldContinuation, currentRestoreGeneration: () => null,
    // CANCEL-TREE-104 R1: the setup reads its own room row before the claim; no room request is bound to this turn here
    roomTurnRequestKey: (thread: string, botId: string) => `${thread}:${botId}`, roomTurnRequests: new Map(), pendingRoomTurnRequests: new Map(),
    roomSetupRowEnded: () => { throw new Error("no room row is bound to this turn"); }, settleRoomTurnRequest: () => { throw new Error("no room row is bound to this turn"); } };
  const run = runInNewContext(stripTypeScriptTypes(source.slice(memberStart, memberEnd) + source.slice(start, end) + "\n}") + "\nrunGroupMemberTurnDispatch;", scope);
  // noMentionChain (mobile lane) precedes memoryRedispatch, heldContinuation and continuationCardId
  expect(await run(group.id, group.threadId, bot.id, 0, new Set(), "Continue", undefined, undefined, undefined, undefined, undefined, undefined, false, false, undefined, original.id)).toBe(false);
  expect(store.continuationHolder(bot.id, group.threadId)?.heldContinuations?.[0].cardId).toBe(original.id);
});

it.each(["GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE"])("N3 production fold records %s and wrapper outcomes", name => {
  const { store, bot, fold } = foldFixture();
  const base = { threadId: bot.threadId, turnId: "turn", providerInstanceId: "fixture", eventId: "event" };
  fold({ ...base, type: "item.started", itemType: "tool", itemId: "direct", title: name });
  fold({ ...base, type: "item.completed", itemType: "tool", itemId: "direct", ok: true });
  expect(store.activePath(bot.threadId).at(-1)?.tool?.action).toMatchObject({ classes: ["send"], outcome: "completed" });
  fold({ ...base, type: "item.started", itemType: "tool", itemId: "wrapper", title: readFileSync(new URL("./routine-brief-approval-diagnosis.test.ts", import.meta.url), "utf8").match(/\b[A-Z]+_MULTI_EXECUTE_TOOL\b/)![0], input: { tools: [{ tool_slug: name }] } });
  fold({ ...base, type: "item.completed", itemType: "tool", itemId: "wrapper", ok: true, result: { results: [{ tool_slug: name, response: { successful: true } }] } });
  expect(store.activePath(bot.threadId).at(-1)?.tool?.action).toMatchObject({ classes: ["send"], outcome: "completed", operations: [{ name, outcome: "completed" }] });
});

it.each(["pi", "codex", "acp"])("N9/N10 %s production events preserve action evidence through the fold", async (engine) => {
  const { PiDriver } = await import("./drivers/pi.ts");
  const { CodexDriver } = await import("./drivers/codex.ts");
  const { createAcpDriver } = await import("./drivers/acp/core.ts");
  const { recordEvents } = await import("./testing/events.ts");
  const { ensureDirs } = await import("./config.ts");
  ensureDirs();
  const acp = createAcpDriver({ driverKind: "guardFixture", fluxReach: () => "elsewhere" as const, displayName: "Guard fixture", defaultCli: "fixture",
    nativeSource: "fixture.acp", models: { default: "one", options: [{ id: "one", label: "One" }] },
    loginNote: "fixture", spawnArgs: () => [], pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true });
  const driver = engine === "pi" ? PiDriver : engine === "codex" ? CodexDriver : acp;
  // fileURLToPath, not URL.pathname: on Windows a pathname is "/D:/..." and the fake CLI never starts
  const cli = fileURLToPath(new URL(`./testing/fake-${engine === "codex" ? "codex-app-server" : engine + "-cli"}.ts`, import.meta.url));
  const instance = await driver.create({ instanceId: "fixture", displayName: "Fixture", enabled: true,
    environment: { [`FAKE_${engine.toUpperCase()}_MODE`]: "action-guard" }, config: { cli, fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  try {
    const { store, bot, fold } = foldFixture();
    const { turnId } = await instance.adapter.sendTurn({ threadId: bot.threadId, text: "fixture", cwd: process.env.HOME });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
    for (const event of recorder.events) if ((event.type === "item.started" || event.type === "item.completed") && event.itemType === "tool") fold(event as unknown as Record<string, unknown>);
    const action = store.activePath(bot.threadId).find(row => row.tool?.action?.name !== "web_search")?.tool?.action;
    if (engine === "pi") {
      expect(action?.operations).toMatchObject([{ name: "GMAIL_SEND_EMAIL", outcome: "completed" }, { name: "GMAIL_SEND_EMAIL", outcome: "failed" }]);
    } else {
      expect(action).toMatchObject({ name: "shell", outcome: "opaque", classes: ["save", "change", "run"] });
      expect(store.activePath(bot.threadId)[0]?.tool?.name).toBe("printf hello > notes.txt");
    }
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", turnId,
      text: "I saved the file. I changed it. I ran tests. I sent it. I paid it. I delegated it." });
    const claims = checkReplyActions({ reply, path: store.activePath(bot.threadId) }).claims;
    expect(claims.map(claim => claim.state)).toEqual(engine === "pi"
      ? ["flagged", "flagged", "flagged", "recorded", "flagged", "flagged"]
      : ["unverifiable", "unverifiable", "unverifiable", "flagged", "flagged", "flagged"]);
  } finally { recorder.stop(); await instance.dispose(); }
});

it("N11 the production fold retains wrapper call identities for reordered receipts", () => {
  const { store, bot, fold } = foldFixture();
  const base = { threadId: bot.threadId, turnId: "turn", itemType: "tool", itemId: "wrapper" };
  fold({ ...base, type: "item.started", title: "MULTI_EXECUTE_TOOL", input: { tools: [
    { tool_slug: "GMAIL_SEND_EMAIL", call_id: "first" }, { tool_slug: "GMAIL_SEND_EMAIL", call_id: "second" },
  ] } });
  fold({ ...base, type: "item.completed", ok: true, result: { results: [
    { tool_slug: "GMAIL_SEND_EMAIL", call_id: "second", response: { successful: false } },
    { tool_slug: "GMAIL_SEND_EMAIL", call_id: "first", response: { successful: true } },
  ] } });
  expect(store.activePath(bot.threadId).at(-1)?.tool?.action?.operations).toMatchObject([
    { callId: "first", outcome: "completed" }, { callId: "second", outcome: "failed" },
  ]);
});


it("N10 an ACP execute kind remains shell evidence with a stamped engine tool name", () => {
  const { store, bot, fold } = foldFixture();
  const base = { threadId: bot.threadId, turnId: "turn", itemType: "tool", itemId: "shell" };
  fold({ ...base, type: "item.started", title: "printf hello > notes.txt", toolKind: "execute", toolIdentity: { namespace: "engine", name: "run_shell_command" } });
  fold({ ...base, type: "item.completed", ok: true, result: { exitCode: 0 } });
  expect(store.activePath(bot.threadId).at(-1)?.tool?.action).toMatchObject({ name: "shell", outcome: "opaque", classes: ["save", "change", "run"] });
});

/** Fuigo hosted tools (web_search and the like) through the production fold:
 * what is saved, and what a reload reads, is text before the row, the row,
 * text after it. */
describe("Fuigo hosted tool rows in the saved transcript", () => {
  const transcript = async (variant: string, streamed = false) => {
    const { createAcpDriver } = await import("./drivers/acp/core.ts");
    const { recordEvents } = await import("./testing/events.ts");
    const { ensureDirs } = await import("./config.ts");
    ensureDirs();
    const driver = createAcpDriver({ driverKind: "hostedFixture", fluxReach: () => "elsewhere" as const, displayName: "Hosted fixture", defaultCli: "fixture",
      nativeSource: "fuigo.acp", models: { default: "one", options: [{ id: "one", label: "One" }] },
      loginNote: "fixture", spawnArgs: () => [], pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true });
    const instance = await driver.create({ instanceId: "fixture", displayName: "Fixture", enabled: true,
      environment: { FAKE_ACP_MODE: `fuigo-retry:disc-${variant}` },
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)), fullAuto: false } });
    const recorder = recordEvents(instance.adapter);
    try {
      const { store, bot, fold } = foldFixture();
      await instance.adapter.sendTurn({ threadId: bot.threadId, text: "fixture", cwd: process.env.HOME });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
      if (streamed) {
        const completed = recorder.events.filter(event => event.type === "item.completed" && event.itemType === "assistant_text");
        for (const event of completed) {
          expect(event.itemId).toEqual(expect.any(String));
          const deltas = recorder.events.flatMap(delta => delta.type === "content.delta" && delta.streamKind === "assistant_text" && delta.itemId === event.itemId ? [delta.delta] : []);
          expect(deltas.join("")).toBe(event.text);
        }
        expect(new Set(completed.map(event => event.itemId)).size).toBe(completed.length);
      }
      for (const event of recorder.events) {
        if (event.type === "item.started" || event.type === "item.completed" || (streamed && ["content.delta", "content.reset", "turn.completed"].includes(event.type))) {
          fold({ ...event, providerInstanceId: "fixture" } as unknown as Record<string, unknown>);
        }
      }
      const shape = (path: Message[]) => path.map(row => row.kind === "text" ? `text:${row.text}` : `row:${row.tool?.name}:${row.tool?.ok === false ? "interrupted" : "ok"}`);
      // a reload reads SQLite afresh: a new store, the same thread
      const reloaded = new Store(() => ({ instanceId: "fixture", model: "one" }));
      return { live: shape(store.activePath(bot.threadId)), reloaded: shape(reloaded.activePath(bot.threadId)) };
    } finally { recorder.stop(); await instance.dispose(); }
  };

  it.each([
    ["hosted-ok", ["text:Let me search.", "row:web_search:ok", "text:Here is what I found."]],
    ["hosted-local", ["text:Let me read.", "row:read:ok", "text:A", "row:web_search:ok", "text:B"]],
  ] as const)("full streamed ACP history survives completion and reload: %s", async (variant, expected) => {
    // Include every delta, reset and terminal event through the real audience
    // policy. A completion-only replay cannot detect a stranded stream.
    const { live, reloaded } = await transcript(variant, true);
    expect(live).toEqual(expected);
    expect(reloaded).toEqual(expected);
  });

  it("an ordinary hosted search saves and reloads as text, row, text", async () => {
    const { live, reloaded } = await transcript("hosted-ok");
    expect(live).toEqual(["text:Let me search.", "row:web_search:ok", "text:Here is what I found."]);
    expect(reloaded).toEqual(live);
  });

  it("two hosted rows in a row: the text reads before the first", async () => {
    const { live, reloaded } = await transcript("hosted-twin");
    expect(live).toEqual(["text:Let me search.", "row:web_search:ok", "row:web_search:ok", "text:Found."]);
    expect(reloaded).toEqual(live);
  });

  it("a discarded attempt: the resend's text shows once, before its row; both rows stay", async () => {
    const { live, reloaded } = await transcript("hosted");
    expect(live).toEqual(["row:web_search:ok", "text:A2", "row:web_search:ok", "text: Answer."]);
    expect(reloaded).toEqual(live);
  });

  it("a client-executed row or an untagged hosted row keeps text, row, text, committed at the row", async () => {
    const { live, reloaded } = await transcript("hosted-local");
    expect(live).toEqual(["text:Let me read.", "row:read:ok", "text:A", "row:web_search:ok", "text:B"]);
    expect(reloaded).toEqual(live);
  });

  it("a retry without discardEmitted keeps text, row, text", async () => {
    const { live, reloaded } = await transcript("hosted-nodiscard");
    expect(live).toEqual(["text:A", "row:web_search:ok", "text:B"]);
    expect(reloaded).toEqual(live);
  });

  it("a discard without streamStartMs ends a row-only attempt's running row interrupted", async () => {
    const { live, reloaded } = await transcript("hosted-rowonly");
    expect(live).toEqual(["row:web_search:interrupted", "row:web_search:ok", "text:A2"]);
    expect(reloaded).toEqual(live);
  });

  it("a discard without streamStartMs leaves a row of an earlier, completed response running", async () => {
    const { live } = await transcript("hosted-rowonly-done");
    expect(live).toEqual(["row:web_search:ok", "text:B"]);
  });

  it("a discard without streamStartMs drops the attempt's text and ends its row interrupted", async () => {
    const { live, reloaded } = await transcript("hosted-epoch");
    expect(live).toEqual(["row:web_search:interrupted", "text:A2"]);
    expect(reloaded).toEqual(live);
  });
});

// 600 rows (past the old 512 anchor cap) are 1,200 folded events, each saved
// in its own committed transaction (synchronous=FULL). That is about 1.5 s on
// Linux and a Windows desktop, but 26 s on a GitHub Windows runner, whose disk
// flushes slowly: the limit covers that runner; the test asserts no timing.
it("a hosted row's lead-in still lands before it after 600 earlier tool rows in the same turn", () => {
  const { store, bot, fold } = foldFixture();
  const base = { threadId: bot.threadId, turnId: "turn", providerInstanceId: "fixture", eventId: "event" };
  for (let index = 0; index < 600; index++) {
    fold({ ...base, type: "item.started", itemType: "tool", itemId: `read-${index}`, title: "read" });
    fold({ ...base, type: "item.completed", itemType: "tool", itemId: `read-${index}`, ok: true });
  }
  const lastRead = store.activePath(bot.threadId).at(-1)!.id;
  const earlier = store.activePath(bot.threadId);
  expect(earlier).toHaveLength(600);
  expect(new Set(earlier.map(row => row.id)).size).toBe(600);
  expect(earlier.every(row => row.kind === "activity" && row.tool?.ok === true)).toBe(true);
  fold({ ...base, type: "item.started", itemType: "tool", itemId: "hosted", title: "web_search" });
  const hosted = store.activePath(bot.threadId).at(-1)!.id;
  fold({ ...base, type: "item.completed", itemType: "tool", itemId: "hosted", ok: true });
  fold({ ...base, type: "item.completed", itemType: "assistant_text", text: "Let me search.", beforeItemId: "hosted" });
  const rows = store.activePath(bot.threadId).slice(-3);
  // MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5 f013bcef74: 600 execution anchors survive display exhaustion; assert their exact positions and keep exhausted provider words redacted.
  expect(rows.map(row => row.id)).toEqual([lastRead, expect.any(String), hosted]);
  expect(rows.map(row => row.kind === "text" ? `text:${row.text}` : `row:${row.tool?.name}`)).toEqual(["row:«redacted»", "text:«redacted»", "row:«redacted»"]);
  const path = store.activePath(bot.threadId), tail = path.slice(-3);
  // MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5 over f013bcef74: collector exhaustion redacts words; all 600 rows and hosted insertion order remain exact by durable id.
  expect(path.slice(0, 600).map(row => row.id)).toEqual(earlier.map(row => row.id));
  expect(path).toHaveLength(602);
  expect(tail.map(row => row.id)).toEqual([earlier.at(-1)!.id, path.find(row => row.kind === "text")!.id, hosted]);
  expect(tail.map(row => row.kind === "text" ? `text:${row.text}` : `row:${row.tool?.name}`)).toEqual(["row:«redacted»", "text:«redacted»", "row:«redacted»"]);
}, 120_000);

/** Hosted-row anchors held for a thread, whatever shape the map keeps. */
const heldAnchors = (map: Map<string, unknown>, threadId: string): number => {
  const entry = map.get(threadId) as { rows?: Map<string, string> } & Map<string, string> | undefined;
  return entry ? (entry.rows ?? entry).size : 0;
};

it("a turn that ended without turn.completed leaves no anchors once the thread's next turn starts", () => {
  const { store, bot, fold, scope } = foldFixture();
  const anchors = scope.toolRowByItem as Map<string, unknown>;
  const at = (turnId: string) => ({ threadId: bot.threadId, turnId, providerInstanceId: "fixture", eventId: "event" });
  // turn A: 600 rows, then its provider is reloaded away (no turn.completed)
  for (let index = 0; index < 600; index++) fold({ ...at("a"), type: "item.started", itemType: "tool", itemId: `read-${index}`, title: "read" });
  expect(heldAnchors(anchors, bot.threadId)).toBe(600);
  fold({ ...at("b"), type: "item.started", itemType: "tool", itemId: "hosted", title: "web_search" });
  expect(heldAnchors(anchors, bot.threadId)).toBe(1);
  // turn B's lead-in still anchors to its own row
  fold({ ...at("b"), type: "item.completed", itemType: "assistant_text", text: "Let me search.", beforeItemId: "hosted" });
  expect(store.activePath(bot.threadId).slice(-2).map(row => row.kind)).toEqual(["text", "activity"]);
});

describe("provider reload retires hosted-row anchors", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const slice = (from: string, to: string) => {
    const start = source.indexOf(from);
    return stripTypeScriptTypes(source.slice(start, source.indexOf(to, start)));
  };
  const code = [
    slice("function forgetToolRowAnchors(", "\n/** Every conversation the owner has"),
    slice("async function reloadProviders(", "\n/** The instance a direct run dispatched on"),
    slice("async function reloadScopedProviders(", "\n// Config writes rebuild the whole provider registry."),
  ].join("\n");
  /** Run the production reload with inert services: every name not given
   * here is a no-op function. */
  const reload = async (anchors: Map<string, unknown>, scope?: Set<string>, scopedReload: () => Promise<void> = async () => undefined) => {
    const run = { threadId: "scoped-thread", botId: "bot", snapshot: { modelSelection: { instanceId: "off" } } };
    const given: Record<string, unknown> = {
      shellSessions: new ShellSessionRegistry(),
      toolRowByItem: anchors, providerFleetReady: true, browserSetup: undefined, browserExtension: undefined, cfg: {},
      store: { bots: [{ id: "bot", threadId: "room-thread", busy: false }], retireFuigoResumeState: () => undefined }, // S5 site 26: a reload retires the Fuigo resume state of an instance it removed
      directRuns: { forBot: () => [run], current: () => false },
      directRunInstanceId: (entry: typeof run) => entry.snapshot.modelSelection.instanceId,
      projectTurnLeases: { generations: () => [], generationsForThreads: () => [], disposed: () => undefined, threadIds: () => [] },
      // rev 5, H2: no engine left a child open here, so nothing is retained
      unconfirmedCloses: async () => new Map(), reloadRetained: new RetainedCloses(), threadsWithWorkInFlight: () => new Map(), localVmThreadTargets: new Map(), Map,
      bus: { detachAll: () => undefined, detach: () => undefined, attach: () => undefined },
      registry: { disposeAll: async () => undefined, load: async () => undefined, reload: scopedReload, instances: () => [], get: () => undefined },
      scopedReloadUnsafe: () => false, Set, Promise,
    };
    const context = new Proxy(given, {
      has: () => true,
      get: (target, key) => key in target ? target[key as string] : key === Symbol.unscopables ? undefined : (globalThis as Record<PropertyKey, unknown>)[key] ?? (() => undefined),
    });
    const { reloadProviders } = runInNewContext(code + "\n({ reloadProviders });", context) as { reloadProviders: (scope?: Set<string>) => Promise<void> };
    await reloadProviders(scope);
  };
  const filled = () => new Map<string, unknown>([
    ["room-thread", { turnId: "room", rows: new Map([["ws-1", "row-1"]]) }],
    ["scoped-thread", { turnId: "direct", rows: new Map([["ws-2", "row-2"]]) }],
  ]);

  it("a full reload ends every turn, rooms included, and forgets every anchor", async () => {
    const anchors = filled();
    await reload(anchors);
    expect(anchors.size).toBe(0);
  });

  it("a scoped reload forgets the anchors of the turns it ends, and only those", async () => {
    const anchors = filled();
    await reload(anchors, new Set(["off"]));
    expect([...anchors.keys()]).toEqual(["room-thread"]);
  });

  it("a scoped reload whose disposal is rejected still forgets the anchors of the turns it retired", async () => {
    const anchors = filled();
    await expect(reload(anchors, new Set(["off"]), async () => { throw new Error("dispose failed"); })).rejects.toThrow("dispose failed");
    expect([...anchors.keys()]).toEqual(["room-thread"]);
  });
});

// ── what the production fold counts as the provider's reply to a hand-off (DESIGN-r26 §1) ──
describe("the production fold marks only the engine's own reply as the proof that a hand-off ran", () => {
  let handoffs = 0;
  function handoffThread() {
    const id = `h${++handoffs}`;
    const fixture = foldFixture();
    Object.assign(fixture.scope, { redactSecretsInText: (text: string) => text, parseRuntimeErrorDiagnostic: () => undefined, ERROR_MESSAGE_MAX: 200, RETRY_MAX_ATTEMPTS: 3 });
    const db = database();
    db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, target_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, "src", fixture.bot.id, null, "fresh", null, "{}", "owner", `dlg-${id}`, fixture.bot.threadId);
    // the prompt and the start commit together, as the dispatch writes them
    fixture.store.appendMessage(fixture.bot.threadId, { role: "user", kind: "text", text: "go" }, `dlg-${id}`, () => { db.prepare("UPDATE pending_delegations SET phase='started', started_at=1, submitted_at=1 WHERE id=?").run(id); });
    const evidence = () => (db.prepare("SELECT evidence_at FROM pending_delegations WHERE id=?").get(id) as { evidence_at: number | null }).evidence_at;
    const base = { threadId: fixture.bot.threadId, turnId: "turn-1", providerInstanceId: "fixture", provider: "claudeAgent" };
    return { ...fixture, evidence, base };
  }
  it("a spawn failure (Murage's own error line, stamped with the turn id) and every Murage-origin item prove nothing", () => {
    const { fold, evidence, base } = handoffThread();
    fold({ ...base, eventId: "e1", type: "runtime.error", message: "spawn failed" });
    fold({ ...base, eventId: "e2", type: "turn.retrying", attempt: 1, delayMs: 1000, reason: "x" });
    fold({ ...base, eventId: "e3", type: "item.started", itemType: "tool", itemId: "wake", origin: "murage", title: "Waking up" });
    fold({ ...base, eventId: "e4", type: "item.completed", itemType: "assistant_text", origin: "murage", text: "a cap note" });
    expect(evidence()).toBeNull();
  });
  it("the retry line is plain, counts the engine's own attempts, and keeps its reason out of the chat", () => {
    const { fold, store, bot, base } = handoffThread();
    fold({ ...base, eventId: "r1", type: "turn.retrying", attempt: 1, delayMs: 2000, reason: "server_error", maxAttempts: 4 });
    const names = store.activePath(bot.threadId).filter(row => row.role === "bot").map(row => row.tool?.name);
    expect(names).toEqual(["The model is busy. Trying again (attempt 2 of 4)."]);
  });
  it("every line the fold writes in Murage's voice carries the Murage marker and is no turn's engine output; the engine's own reply and tool start are (1.0.3 lifecycle card)", () => {
    const { fold, store, bot, base } = handoffThread();
    fold({ ...base, eventId: "m1", type: "runtime.error", message: "spawn failed" });
    fold({ ...base, eventId: "m2", type: "turn.retrying", attempt: 1, delayMs: 1000, reason: "x" });
    fold({ ...base, eventId: "m3", type: "item.started", itemType: "tool", itemId: "wake", origin: "murage", title: "Waking up" });
    fold({ ...base, eventId: "m4", type: "item.started", itemType: "tool", itemId: "read", origin: "engine", title: "Read" });
    fold({ ...base, eventId: "m5", type: "item.completed", itemType: "tool", itemId: "read", ok: true });
    fold({ ...base, eventId: "m6", type: "item.completed", itemType: "assistant_text", origin: "engine", text: "done" });
    const rows = store.activePath(bot.threadId).filter(row => row.role === "bot");
    const row = (match: (row: Message) => boolean) => { const found = rows.find(match); expect(found).toBeDefined(); return found!; };
    const murage = [row(r => r.tool?.name === "error: spawn failed"), row(r => r.tool?.name === "The model is busy. Trying again (attempt 2 of 3)."), row(r => r.tool?.name === "Waking up")];
    for (const line of murage) {
      expect(line.murageLine, line.tool?.name).toBe(true);
      expect(line.turnId, "the line still reads as the turn's (its chip group)").toBe("turn-1");
      expect(isEngineOutput(line), line.tool?.name).toBe(false);
    }
    const engine = [row(r => r.tool?.name === "Read"), row(r => r.kind === "text" && r.text === "done")];
    for (const line of engine) { expect(line.murageLine).toBeUndefined(); expect(isEngineOutput(line)).toBe(true); }
  });
  it("the engine's reply after Murage's own lines of the same turn is the proof (the walk goes on past Murage's lines)", () => {
    const { fold, evidence, base } = handoffThread();
    fold({ ...base, eventId: "e1", type: "item.started", itemType: "tool", itemId: "wait", origin: "murage", title: "Waiting for connected apps" });
    expect(evidence()).toBeNull();
    fold({ ...base, eventId: "e2", type: "item.completed", itemType: "assistant_text", origin: "engine", text: "on it" });
    expect(evidence()).not.toBeNull();
  });
  it("a tool the engine started is the proof too, and an engine item with no origin is not (a new emit that forgot to choose proves nothing)", () => {
    const none = handoffThread();
    none.fold({ ...none.base, eventId: "e1", type: "item.completed", itemType: "assistant_text", text: "no origin" });
    expect(none.evidence()).toBeNull();
    const tool = handoffThread();
    tool.fold({ ...tool.base, eventId: "e1", type: "item.started", itemType: "tool", itemId: "t1", origin: "engine", title: "Read" });
    expect(tool.evidence()).not.toBeNull();
  });
});

describe("a resume cursor is saved only once the session's lineage is committed", () => {
  const sessionFixture = () => {
    const fx = foldFixture();
    const turn = openTurnLineage(database(), { threadId: fx.bot.threadId, turnId: memberTurnId(fx.bot.id) });
    bindProviderTurn(turn, "turn");
    Object.assign(fx.scope, {
      transaction, writeSessionLineage, turnOfProvider, runningTurnFor, recordSessionRoots: () => undefined, legacyToolNamesByThread: new Map(),
      turnOutputRoots: new Map([[fx.bot.threadId, { instanceId: "fixture", roots: { roots: new Set(), over: false } }]]),
    });
    const start = (sessionId: string) => { try { fx.fold({ type: "session.started", threadId: fx.bot.threadId, turnId: "turn", providerInstanceId: "fixture", sessionId }); } catch { /* a commit failure propagates for redelivery */ } };
    const cursor = () => fx.store.bot(fx.bot.id)?.resumeCursors.fixture;
    const row = (sessionId: string) => database().prepare("SELECT 1 FROM memory_session_lineage WHERE thread_id=? AND native_session=?").get(fx.bot.threadId, sessionId);
    return { ...fx, turn, start, cursor, row };
  };
  it("S6 rule 27: fresh starts repeating one native id save the cursor with the next incarnation; the row is keyed and stamped", () => {
    const fx = sessionFixture();
    const stamp = (key: string) => database().prepare("SELECT door_epoch FROM memory_session_lineage WHERE thread_id=? AND native_session=?").get(fx.bot.threadId, key)?.door_epoch;
    const fresh = () => (fx.scope.turnOutputRoots as Map<string, unknown>).set(fx.bot.threadId, { instanceId: "fixture", roots: { roots: new Set(), over: false } });
    const task = () => fx.store.taskByThread(fx.bot.id, fx.bot.threadId)!;
    try {
      fx.start("s-rep");
      expect(fx.row("s-rep")).toBeTruthy();
      expect(task().resumeIncarnations?.fixture).toBeUndefined();
      fresh(); fx.start("s-rep");
      expect(fx.row("s-rep#2")).toBeTruthy();
      expect(stamp("s-rep#2")).not.toBeNull();
      expect(fx.cursor()).toBe("s-rep");
      expect(task().resumeIncarnations?.fixture).toBe(2);
      // a resumed turn (its dispatch set the key, the raw cursor and the incarnation) keeps the key and never stamps
      database().prepare("UPDATE memory_session_lineage SET door_epoch=NULL WHERE native_session='s-rep#2'").run();
      (fx.scope.turnOutputRoots as Map<string, unknown>).set(fx.bot.threadId, { instanceId: "fixture", roots: { roots: new Set(), over: false }, session: "s-rep#2", cursor: "s-rep", incarnation: 2 });
      fx.start("s-rep");
      expect(stamp("s-rep#2")).toBeNull();
      expect(task().resumeIncarnations?.fixture).toBe(2);
      expect(Number(database().prepare("SELECT count(*) AS c FROM memory_session_incarnation WHERE native_id='s-rep'").get()!.c)).toBe(2);
    } finally { closeTurnLineage(fx.turn); }
  });
  it("a committed session lineage row saves the cursor", () => {
    const fx = sessionFixture();
    try {
      fx.start("s-ok");
      expect(fx.row("s-ok")).toBeTruthy();
      expect(fx.cursor()).toBe("s-ok");
    } finally { closeTurnLineage(fx.turn); }
  });
  it("a statement failure in the session lineage write leaves no cursor", () => {
    const fx = sessionFixture();
    database().exec("CREATE TEMP TRIGGER fail_session_lineage BEFORE INSERT ON memory_session_lineage BEGIN SELECT RAISE(ABORT, 'session lineage refused'); END");
    try {
      fx.start("s-statement");
      expect(fx.row("s-statement")).toBeFalsy();
      expect(fx.cursor()).toBeUndefined();
    } finally { database().exec("DROP TRIGGER IF EXISTS fail_session_lineage"); closeTurnLineage(fx.turn); }
  });
  it("a COMMIT failure of the session lineage write leaves no cursor", () => {
    const fx = sessionFixture();
    const db = database();
    const exec = db.exec.bind(db);
    const spy = vi.spyOn(db, "exec").mockImplementation((sql: string) => { if (sql === "COMMIT") throw new Error("disk I/O error"); return exec(sql); });
    try {
      fx.start("s-commit");
      spy.mockRestore();
      expect(fx.row("s-commit")).toBeFalsy();
      expect(fx.cursor()).toBeUndefined();
    } finally { spy.mockRestore(); closeTurnLineage(fx.turn); }
  });
});

describe("replyForStagedImages (a widget row never takes the turn's images)", () => {
  const row = (id: string, turnId: string, widget?: boolean) => ({ id, role: "bot", kind: "text", text: "x", turnId, ...(widget ? { widget: {} } : {}) }) as unknown as Message;
  it("picks the turn's last text row, skipping a trailing widget", () => {
    const text = row("a", "t1");
    expect(replyForStagedImages([text, row("w", "t1", true)], "t1")).toBe(text);
    expect(replyForStagedImages([row("w", "t1", true)], "t1")).toBeUndefined();
    expect(replyForStagedImages([row("a", "t0"), row("w", "t1", true)], "t1")).toBeUndefined();
  });
});

it.each(["direct", "room"])("OpenCode quiet notice persists in a %s thread without engine output", (kind) => {
  const { fold, store, bot, scope } = foldFixture();
  const threadId = kind === "room" ? store.createGroup("Quiet room", [bot.id]).threadId : bot.threadId;
  if (kind === "room") (scope.groupSpeakers as Map<string, unknown>).set(threadId, { botId: bot.id, name: bot.name });
  fold({ threadId, turnId: "quiet-turn", eventId: "quiet", type: "turn.diagnostic", category: "rate_limit", quietMs: 60000 });
  const row = store.activePath(threadId).find(row => row.tool?.name === "OpenCode reported a rate limit. No reply for 60 seconds.");
  expect(row).toBeDefined();
  expect(row?.murageLine).toBe(true);
  expect(row?.tool?.ok).toBe(true);
  expect(isEngineOutput(row!)).toBe(false);
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();

import { appendFixtureMessage } from './testing/approval-card.ts';
import { BotOutsideWrites } from "./bot-outside-writes.ts";
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";
import { productionAdmittedInstance } from "./testing/admission-fence.ts";
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
import { ERROR_REASON_WITHHELD } from "./owner-display.ts";
import { ENGINE_ERROR_KIND_PREFIX } from "../shared/provider-error.ts";
import { EXPECTED_KIND_LINES } from "./testing/engine-kind-lines.ts";
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
import { resolveDisplaySubmission } from "./harness/audience-collector.ts";
import { questionsForCard } from "../shared/questions.ts";
import { createTurnTextPolicy } from "./redact-turn.ts";
import { EngineSignInOwed } from "./engine-signin-owed.ts";
import { scanTurnText } from "./redact.ts";
import type { Scanner } from "./redact-stream-release.ts";
import { ownerDisplayFailedCheck, ownerOnlyDisplay, REPLY_WITHHELD } from "./owner-display.ts";
import { readThreadSummary } from "./thread-summary.ts";
import { isWorkspaceOwner, OWNER as OWNER_PRINCIPAL, threadHumanPrincipal } from "./human-principals.ts";
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
const importsFor = async (fold: string): Promise<Record<string, unknown>> => {
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
};
const productionImports: Record<string, unknown> = await importsFor(FOLD_SOURCE);
/** The production card-action builder (index.ts decisionEngineApprovalAction, installed at index.ts installEngineApprovalBuilder)
 * and the names it imports: the QC rows install it in place of the fixture's stand-in, so the card they read is production's. */
const BUILDER_SOURCE = INDEX_AST.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "decisionEngineApprovalAction")!.getText(INDEX_AST);
const builderImports: Record<string, unknown> = await importsFor(BUILDER_SOURCE);

/** Execute the production event fold with isolated storage and inert outside
 * services. This is a behavior test, not a census of source substrings. */
const decisionReleases: Array<() => void> = [];
afterEach(() => { for (const release of decisionReleases.splice(0).reverse()) release(); });

function foldFixture(policy?: ConstructorParameters<typeof EventBus>[1]) {
  const store = new Store(() => ({ instanceId: "fixture", model: "one" }));
  const bot = store.createBot({}, { seedMessages: false });
  const instance = { instanceId: "fixture", driverKind: "fixture", adapter: { capabilities: {} }, models: { default: "one", options: [{ id: "one", contextWindow: 1000 }, { id: "reported", contextWindow: 5000 }] } } as any;
  const stamp = engineStamp(instance, "one");
  const stamps = new Map([[bot.threadId, stamp]]);
  const noop = () => undefined;
  const bus = new EventBus(undefined, policy);
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
    turnUsageRoutines: new TurnUsageRoutines(() => undefined), projectRoutineRunOfRoomTurn: () => null,
    legacyToolNamesByThread: new Map(),
    releaseLocalVmThread: noop, retiredProviderTurns: new Set(), removeGroupGoalCoordinatorTurn: noop,
    turnUsage: new Map(), lateMemoryRedispatches: new Map(), lateRebuildWatches: new Map(), turnRefusalNotes: new Map(),
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
    // the engines that last said they need signing in (index.ts module declaration, engine-signin-owed.ts): the real one, none marked
    engineSignInOwed: new EngineSignInOwed(),
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
  // O1 m2 S1a D1.6: the dispatch reads its engine through the real admission fence, compiled over this case's registry
  const registry = { get: () => ({ adapter: { capabilities: {} } }) };
  const scope = { RecallReadiness, LineageAllowance, store, homeExecutionGate: undefined, memberTurnProvenance, turnIsBackground, isLiveRoutineRunStatus, backupRestartAdmission: { held: () => false }, routineRunLevel: () => null, roomRounds: new Map(), cfg: {}, decisionServiceContext: { exit: (work: () => unknown) => work() },
    registry, admittedInstance: productionAdmittedInstance(registry), routeHasTools: () => false,
    threadHumanPrincipal: () => ({ kind: "owner" }), routines: fixtureRoutines(),
    botPermissionMode: () => "ask", resolveTurnFor: (_task: unknown, profile: { modelSelection: unknown }) => ({ selection: profile.modelSelection }), routinePeerSource: () => undefined, turnSessionAudience: () => "audience", latestRoomUserMessage: () => undefined, noteHeldQueue: () => {}, heldScanYield, runnableContinuation, isRestoreHeld, releaseHeldContinuation, currentRestoreGeneration: () => null,
    // CANCEL-TREE-104 R1: the setup reads its own room row before the claim; no room request is bound to this turn here
    roomTurnRequestKey: (thread: string, botId: string) => `${thread}:${botId}`, roomTurnRequests: new Map(), pendingRoomTurnRequests: new Map(),
    roomSetupRowEnded: () => { throw new Error("no room row is bound to this turn"); }, settleRoomTurnRequest: () => { throw new Error("no room row is bound to this turn"); } };
  const run = runInNewContext(stripTypeScriptTypes(source.slice(memberStart, memberEnd) + source.slice(start, end) + "\n}") + "\nrunGroupMemberTurnDispatch;", scope);
  // noMentionChain (mobile lane) precedes memoryRedispatch, heldContinuation and continuationCardId
  // the compiled dispatch resolves its engine (index.ts admittedInstance) and admits nothing new: a throw is the wrong outcome, not a pass
  const dispatched = await run(group.id, group.threadId, bot.id, 0, new Set(), "Continue", undefined, undefined, undefined, undefined, undefined, undefined, false, false, undefined, original.id)
    .catch((error: unknown) => String((error as { message?: unknown }).message));
  expect(dispatched, "room continuation dispatch returns false through the production admission fence").toBe(false);
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
  // MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5 f013bcef74: 600 execution anchors keep their exact positions.
  // The words: a long clean turn stays shown (owner rule, MAIN 21:22Z GO of fix/1020-redact-acp-fable 832aa2ad61;
  // the full field table lets go of its oldest settled field instead of masking the turn), so they are no longer «redacted».
  expect(rows.map(row => row.id)).toEqual([lastRead, expect.any(String), hosted]);
  expect(rows.map(row => row.kind === "text" ? `text:${row.text}` : `row:${row.tool?.name}`)).toEqual(["row:read", "text:Let me search.", "row:web_search"]);
  const path = store.activePath(bot.threadId), tail = path.slice(-3);
  // MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5 over f013bcef74: all 600 rows and hosted insertion order remain exact by durable id.
  expect(path.slice(0, 600).map(row => row.id)).toEqual(earlier.map(row => row.id));
  expect(path).toHaveLength(602);
  expect(tail.map(row => row.id)).toEqual([earlier.at(-1)!.id, path.find(row => row.kind === "text")!.id, hosted]);
  expect(tail.map(row => row.kind === "text" ? `text:${row.text}` : `row:${row.tool?.name}`)).toEqual(["row:read", "text:Let me search.", "row:web_search"]);
  expect(JSON.stringify(path)).not.toContain("«redacted»");
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

// ── 1.0.22 fuigo-emptyresp-label: an engine error row whose reason cannot be shown reads Murage's words for its kind, through the production fold ──
describe("the production fold words a masked engine error by its kind (fuigo-emptyresp-label-1022)", () => {
  const SECRET_TEXT = "api_key=" + "FIXTURESECRET123456";
  function errorRow(fields: Record<string, unknown>) {
    const fixture = foldFixture();
    Object.assign(fixture.scope, { redactSecretsInText: (text: string) => text, parseRuntimeErrorDiagnostic: () => undefined, ERROR_MESSAGE_MAX: 200, RETRY_MAX_ATTEMPTS: 3 });
    fixture.fold({ threadId: fixture.bot.threadId, turnId: "turn-1", providerInstanceId: "fixture", provider: "fixture", eventId: "kind-err", type: "runtime.error", message: SECRET_TEXT, details: `ACP request: ${SECRET_TEXT}`, ...fields });
    return fixture.store.activePath(fixture.bot.threadId).filter(row => row.role === "bot").map(row => row.tool).find(tool => tool?.ok === false);
  }
  it.each(Object.keys(EXPECTED_KIND_LINES))("kind %s: the stored error row says Murage's line for it and keeps the kind, never the withheld sentence", kind => {
    const tool = errorRow({ errorKind: kind });
    expect(tool?.name).toBe(`error: ${EXPECTED_KIND_LINES[kind]}`);
    expect(tool?.name).not.toContain(ERROR_REASON_WITHHELD);
    expect(tool?.errorKind).toBe(kind);
  });
  it.each(Object.keys(EXPECTED_KIND_LINES))("kind %s: the stored technical details still name the kind when the engine's text is withheld", kind => {
    const tool = errorRow({ errorKind: kind });
    expect(tool?.errorDetails).toBe(`${EXPECTED_KIND_LINES[kind]}\n${ENGINE_ERROR_KIND_PREFIX}${kind}`);
  });
  // The routine path: the fold itself hands RoutineManager.handleRuntimeEvent the presented event (index.ts routinePresentation call),
  // so a fold that stops passing the kind there leaves a routine run's card reading the withheld sentence.
  function routineSeen(fields: Record<string, unknown>) {
    const fixture = foldFixture();
    const seen: Array<Record<string, unknown>> = [];
    Object.assign(fixture.scope, { redactSecretsInText: (text: string) => text, parseRuntimeErrorDiagnostic: () => undefined, ERROR_MESSAGE_MAX: 200, RETRY_MAX_ATTEMPTS: 3,
      routines: { handleRuntimeEvent: (_event: unknown, presented: Record<string, unknown>) => { seen.push(presented); return null; }, usageRunForThread: () => null, routineRunForThread: () => null, newestLiveRunInThread: () => undefined, listRuns: () => [], getEventBudget: () => ({ closed: false }) } });
    fixture.fold({ threadId: fixture.bot.threadId, turnId: "turn-1", providerInstanceId: "fixture", provider: "fixture", eventId: "kind-routine", type: "runtime.error", message: SECRET_TEXT, details: `ACP request: ${SECRET_TEXT}`, ...fields });
    return seen.filter(event => event.type === "runtime.error");
  }
  it.each(Object.keys(EXPECTED_KIND_LINES))("kind %s: the routine run is handed Murage's line for it, never the withheld sentence", kind => {
    const seen = routineSeen({ errorKind: kind });
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe(EXPECTED_KIND_LINES[kind]);
  });
  it("a routine run on an error with no kind is handed the withheld sentence", () => {
    expect(routineSeen({}).map(event => event.message)).toEqual([ERROR_REASON_WITHHELD]);
  });
  it("empty_response reads the exact owner-facing sentence", () => {
    expect(errorRow({ errorKind: "empty_response" })?.name).toBe("error: The model thought it through but sent no reply. Try again or switch model.");
  });
  it("no kind, or a kind the driver does not know, keeps the withheld sentence", () => {
    expect(errorRow({})?.name).toBe(`error: ${ERROR_REASON_WITHHELD}`);
    expect(errorRow({ errorKind: "not_a_kind" })?.name).toBe(`error: ${ERROR_REASON_WITHHELD}`);
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

// cause22 GROUP E (b), MAIN-RULING 2026-11-22T18:02:24Z (1) + FABLE design H1: the production fold (index.ts prepareTerminalEvent and
// foldRuntimeEvent, compiled from index.ts above) reads bus.audienceWithheldFor at three sites. Each row runs a turn whose own scan
// could not check one unit (the real collector and turn policy on the real bus; only the scanner is given a fault for the sentinel
// word, as rows B4-B6 of harness/redact-audience-1021.test.ts), then reads what the fold stored or broadcast.
const WITHHELD_SENTINEL = "unscannable-fixture-sentinel";
const PLAIN_REPLY = "The plain reply of the same turn.";
const withheldPolicy = () => {
  const scan: Scanner = (text, o) => text.includes(WITHHELD_SENTINEL) ? { text, detected: false, exhausted: true, workUnits: 0, candidates: [] } : scanTurnText(text, o);
  return createTurnTextPolicy({ scan, separateItemRegions: true }) as unknown as ConstructorParameters<typeof EventBus>[1];
};
function withheldTurn() {
  const fixture = foldFixture(withheldPolicy());
  const frames: any[] = [];
  fixture.scope.broadcast = (frame: unknown) => { frames.push(frame); };
  const base = { threadId: fixture.bot.threadId, turnId: "withheld-turn", providerInstanceId: "fixture", eventId: "withheld", createdAt: "2026-01-01T00:00:00.000Z" };
  // one tool field the turn's scan cannot check: that field is withheld alone and the turn is marked as holding unscanned text
  const unscannable = () => fixture.fold({ ...base, type: "item.completed", itemType: "tool", itemId: "tool-1", ok: true, detail: `detail with the ${WITHHELD_SENTINEL} word`, result: { title: "Listing 1" } });
  const texts = () => fixture.store.messagesFor(fixture.bot.threadId).filter(row => row.role === "bot" && row.kind === "text").map(row => row.text);
  // A plain reply of the same turn. MAIN-RULING 17:47:36Z (b): the unscannable unit is withheld alone, the turn is never masked, so
  // this reply is stored and broadcast as written. On the pre-fix sha the whole turn was masked and it was the bare marker.
  fixture.scope.ownerOnlyDisplayThread = () => false;
  const plainReply = () => fixture.fold({ ...base, eventId: "plain-reply", type: "item.completed", itemType: "assistant_text", itemId: "plain-reply", text: PLAIN_REPLY });
  return { ...fixture, frames, base, unscannable, texts, plainReply };
}

it("FOLD-1 a turn that withheld unscanned text stores its coordinator reply as the held-back sentence, never the raw words (prepareTerminalEvent)", () => {
  const { fold, scope, base, unscannable, texts, store, bot, plainReply } = withheldTurn();
  const canary = "fixture-canary-coordinator-Rk27Mx9Qa";
  unscannable(); plainReply();
  scope.groupGoalCoordinatorTurnForEvent = () => ({ turnId: "withheld-turn", assistantItems: ["private-coordinator-envelope"] });
  scope.parseGroupGoalDecision = () => ({ visibleText: `Public words with ${canary}.` });
  fold({ ...base, type: "turn.completed", ok: true });
  // MAIN-RULING 2026-11-23T00:58:16Z redact-marker: the withheld coordinator reply was stored as the bare marker; it is the held-back sentence
  expect(texts()).toEqual([PLAIN_REPLY, REPLY_WITHHELD]); // the turn is shown (its plain reply as written) and the coordinator reply alone is held back
  expect(JSON.stringify(store.messagesFor(bot.threadId))).not.toContain(canary);
});

it("FOLD-2 a turn that withheld unscanned text broadcasts its coordinator reply as the held-back sentence, never the raw words (foldRuntimeEvent raw readers)", () => {
  const { fold, scope, base, unscannable, frames, plainReply, texts } = withheldTurn();
  const canary = "fixture-canary-broadcast-Rk27Mx9Qa";
  unscannable(); plainReply();
  scope.groupGoalCoordinatorTurnForEvent = () => ({ turnId: "withheld-turn", assistantItems: ["private-coordinator-envelope"] });
  scope.parseGroupGoalDecision = () => ({ visibleText: `Public words with ${canary}.` });
  fold({ ...base, type: "turn.completed", ok: true });
  const goal = frames.filter(frame => String(frame?.event?.eventId ?? "").endsWith("-goal-text"));
  // MAIN-RULING 2026-11-23T00:58:16Z redact-marker: the live bubble of the withheld coordinator reply read «redacted»; it is the held-back sentence
  expect({ goal: goal.map(frame => frame.event.text), plain: texts()[0] }).toEqual({ goal: [REPLY_WITHHELD], plain: PLAIN_REPLY }); // the turn is shown; the broadcast coordinator reply alone is held back
  expect(JSON.stringify(frames)).not.toContain(canary);
});

it("FOLD-3 the owner's thread never stores the raw words of a reply whose chain was withheld unscanned (foldRuntimeEvent owner fallback)", () => {
  const { fold, scope, base, texts } = withheldTurn();
  scope.ownerOnlyDisplayThread = () => true; // the owner's own direct thread
  const canary = "fixture-canary-owner-Rk27Mx9Qa";
  const head = "The first line of the reply is plain.\n";
  // the raw text scans clean with the real scanner (ownerTextIsClean), so only the turn's withheld fact keeps it from the owner's row
  const text = `${head}this line holds the ${WITHHELD_SENTINEL} word\nthe words after it were never checked: ${canary}\n`;
  fold({ ...base, type: "item.completed", itemType: "assistant_text", itemId: "reply", text });
  const stored = texts();
  expect(stored).toHaveLength(1);
  expect(stored[0]!.includes(canary) || stored[0]!.includes(WITHHELD_SENTINEL), `stored ${stored[0]!.length} of ${text.length}`).toBe(false);
  expect(stored[0]).toBe(REPLY_WITHHELD);
});

// MAIN-RULING 2026-11-22T21:44:35Z redact-parse-error (b): every reader the withheld fact feeds has a fold row of its own.
// FOLD-4 tool result (audienceMasked -> completedToolRow), FOLD-5 runtime.error provider words (audienceMasked),
// FOLD-6 routine presentation and FOLD-7 the error row's owner view (audienceUnproven), FOLD-8 the retry line of the server log. FOLD-6 and FOLD-7 put the unscannable
// unit in the error message itself, so on the pre-fix sha the owner's view showed the raw words.
const errorScope = (scope: Record<string, unknown>) => {
  Object.assign(scope, { redactSecretsInText: (text: string) => text, ERROR_MESSAGE_MAX: 200, RETRY_MAX_ATTEMPTS: 3 });
  scope.parseRuntimeErrorDiagnostic ??= () => undefined;
  scope.stampService ??= (error: object) => error;
  scope.clampProviderSaid ??= (error: object) => error;
};
const activityRows = (store: Store, threadId: string) => store.messagesFor(threadId).filter(row => row.role === "bot" && row.kind === "activity");

it("FOLD-4 a tool result of a turn that withheld unscanned text is not read for its receipts (foldRuntimeEvent tool result)", () => {
  const { fold, base, store, bot, plainReply, texts } = withheldTurn();
  const result = { results: [{ call_id: "call-1", response: { successful: true } }] };
  fold({ ...base, eventId: "tool-start", type: "item.started", itemType: "tool", itemId: "tool-1", origin: "engine", title: "COMPOSIO_MULTI_EXECUTE_TOOL", input: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", call_id: "call-1" }] } });
  const started = activityRows(store, bot.threadId).at(-1)!.tool!;
  fold({ ...base, eventId: "tool-end", type: "item.completed", itemType: "tool", itemId: "tool-1", ok: true, detail: `detail with the ${WITHHELD_SENTINEL} word`, result });
  const done = activityRows(store, bot.threadId).at(-1)!.tool!;
  plainReply();
  // the fixture: read whole, this result is a completed send; unread, the step is opaque
  expect([completedToolAction(started, true, result).outcome, completedToolAction(started, true, undefined).outcome]).toEqual(["completed", "opaque"]);
  expect({ outcome: done.action?.outcome, classes: done.action?.classes, reply: texts() }).toEqual({ outcome: "opaque", classes: [], reply: [PLAIN_REPLY] }); // the turn is shown; the result alone is not read
});

it("FOLD-5 an error of a turn that withheld unscanned text stores nothing of what the provider said and no diagnostic (foldRuntimeEvent runtime.error)", () => {
  const { fold, scope, base, unscannable, store, bot, plainReply, texts } = withheldTurn();
  errorScope(scope); scope.ownerOnlyDisplayThread = () => false; // a shared audience: only the raw readers are in play
  // The diagnostic beside it: what the fold hands the store is read at store.appendMessage (the store keeps a diagnostic only in
  // its strict shape, and this fixture issues event ids of its own: the error is the third event folded here).
  const written: Message[] = []; const append = store.appendMessage.bind(store);
  store.appendMessage = ((threadId: string, message: Message, ...rest: unknown[]) => { written.push(message); return (append as (...all: unknown[]) => unknown)(threadId, message, ...rest); }) as typeof store.appendMessage;
  scope.parseRuntimeErrorDiagnostic = () => ({ version: 1, diagnosticId: "error-1#3", turnId: "withheld-turn", httpStatus: 402 });
  unscannable(); plainReply();
  fold({ ...base, eventId: "error-1", type: "runtime.error", provider: "fixture", message: "The provider refused the request.", providerError: { kind: "http", httpStatus: 402, providerSaid: "The plan has no credit left." }, diagnostic: { version: 1 } });
  const handed = written.find(message => message.tool?.name.startsWith("error:"));
  const row = activityRows(store, bot.threadId).find(row => row.tool?.name.startsWith("error:"))!;
  expect({ row: !!row && !!handed, providerError: (row?.tool as { providerError?: unknown } | undefined)?.providerError, diagnostic: (handed?.tool as { diagnostic?: unknown } | undefined)?.diagnostic, reply: texts() }).toEqual({ row: true, providerError: undefined, diagnostic: undefined, reply: [PLAIN_REPLY] }); // the turn is shown; the provider's words alone are not stored
});

it("FOLD-8 the retry line in the server log never carries the reason of a turn that withheld unscanned text (foldRuntimeEvent turn.retrying)", () => {
  const { fold, scope, base, unscannable, plainReply, texts } = withheldTurn();
  errorScope(scope);
  const logged: string[] = [];
  scope.console = { ...console, info: (...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); } };
  const canary = "fixture-canary-retry-Rk27Mx9Qa";
  unscannable(); plainReply();
  fold({ ...base, eventId: "retry-1", type: "turn.retrying", attempt: 1, delayMs: 1000, reason: `server said ${canary}` });
  const line = logged.filter(text => text.startsWith("turn.retrying"));
  expect({ lines: line.length, reason: line.some(text => text.includes(canary)), reply: texts() }).toEqual({ lines: 1, reason: false, reply: [PLAIN_REPLY] }); // the turn is shown; the log line alone has the marker for its reason
});

it("FOLD-6 a routine run never gets the raw words of an error whose message was withheld unscanned (foldRuntimeEvent routine presentation)", () => {
  const { fold, scope, base } = withheldTurn();
  errorScope(scope);
  scope.ownerOnlyDisplayThread = () => true;
  const presented: { message?: string }[] = [];
  scope.routines = { ...fixtureRoutines(), handleRuntimeEvent: (_event: unknown, shown: { message?: string }) => { presented.push(shown); return null; } };
  const canary = "fixture-canary-routine-Rk27Mx9Qa";
  fold({ ...base, eventId: "error-1", type: "runtime.error", provider: "fixture", message: `the ${WITHHELD_SENTINEL} word and words never checked: ${canary}` });
  expect({ calls: presented.length, raw: presented.some(shown => String(shown.message).includes(canary) || String(shown.message).includes(WITHHELD_SENTINEL)) }).toEqual({ calls: 1, raw: false });
});

it("FOLD-7 the owner's error row never stores the raw words of an error whose message was withheld unscanned (foldRuntimeEvent error view)", () => {
  const { fold, scope, base, store, bot } = withheldTurn();
  errorScope(scope);
  scope.ownerOnlyDisplayThread = () => true;
  const canary = "fixture-canary-errorview-Rk27Mx9Qa";
  fold({ ...base, eventId: "error-1", type: "runtime.error", provider: "fixture", message: `the ${WITHHELD_SENTINEL} word and words never checked: ${canary}`, details: `details with the ${WITHHELD_SENTINEL} word: ${canary}` });
  const row = activityRows(store, bot.threadId).find(row => row.tool?.name.startsWith("error:"))!;
  expect({ row: !!row, raw: JSON.stringify(row?.tool ?? {}).includes(canary) || JSON.stringify(row?.tool ?? {}).includes(WITHHELD_SENTINEL) }).toEqual({ row: true, raw: false });
});

// MAIN-RULING 2026-11-22T21:44:35Z redact-parse-error (b) + ASTRA 635304ab43: the question CARD production paths (index.ts
// foldRuntimeEvent `request.opened` -> handleDecisionRequest -> decision card, and `question.async` -> openAnswerAsSendCard)
// go through the counted fold. Each row enters through the production fold with the production card-action builder installed,
// reads the card the store holds (what the owner is shown and what the answer route resolves against, index.ts
// resolveDisplaySubmission(questionsForCard(stored.card))), and answers it the way the route does.
function questionCardFixture() {
  const fixture = foldFixture();
  const { scope, bot } = fixture;
  const builder = runInNewContext(stripTypeScriptTypes(BUILDER_SOURCE) + "\ndecisionEngineApprovalAction;", Object.assign(scope, { ...builderImports, ...scope, exactAllowKeyFor: () => undefined, botForDirectThread: () => bot, approveAllTurnOrigin: () => "owner" }));
  decisionReleases.push(decision.installEngineApprovalBuilder(builder));
  const base = { threadId: bot.threadId, turnId: "turn", providerInstanceId: "fixture", eventId: "event" };
  fixture.approvalAttention.admit(bot.threadId, "turn");
  return { ...fixture, base };
}
const cardQuestion = (i: number, options: number) => ({ id: `q${i + 1}`, question: `fixture question ${i + 1} qcWord${i + 1}Zt`, header: `H${i + 1}`,
  options: Array.from({ length: options }, (_, j) => ({ label: `q${i + 1} option ${j + 1} qcOpt${i + 1}x${j + 1}Zt` })), multiSelect: false, allowOther: false });
/** The answer the owner's card sends for every question the card shows (first option of each), resolved as the answer route resolves it. */
const answerShownCard = (id: string, card: Parameters<typeof questionsForCard>[0]) => {
  const questions = questionsForCard(card);
  return resolveDisplaySubmission({ id, requestType: "question", questions, live: true },
    { requestHandle: `q.${id}`, action: "answer", answers: questions.map((_, i) => ({ questionHandle: `q.${i}`, optionHandles: [`o.${i}.0`] })) });
};
it("QC-1 an engine question with more questions and options than the card contract is stored as the counted fold, and the stored card can be answered (foldRuntimeEvent request.opened)", async () => {
  const { store, fold, base, bot } = questionCardFixture();
  const questions = [cardQuestion(0, 12), cardQuestion(1, 2), cardQuestion(2, 2), cardQuestion(3, 2), cardQuestion(4, 2), cardQuestion(5, 2)];
  fold({ ...base, type: "request.opened", requestType: "question", requestId: "many", tool: "AskUserQuestion", summary: "Six questions", questions });
  await vi.waitFor(() => expect(store.activePath(bot.threadId).at(-1)).toMatchObject({ kind: "options" }));
  const row = store.activePath(bot.threadId).at(-1)!;
  const card = row.card as { questions?: { question: string; options: { label: string }[] }[] };
  const stored = JSON.stringify(row);
  expect({ questions: card.questions?.length, options: card.questions?.map(q => q.options.length),
    firstText: card.questions?.[0]?.question, lastText: card.questions?.at(-1)?.question,
    foldedQuestion: stored.includes("qcWord5Zt") || stored.includes("qcWord6Zt"), foldedOption: stored.includes("qcOpt1x11Zt") || stored.includes("qcOpt1x12Zt"),
    answer: answerShownCard(row.id, row.card as never).ok })
    .toEqual({ questions: 4, options: [10, 2, 2, 2],
      firstText: "fixture question 1 qcWord1Zt\n«2 more not shown»", lastText: "fixture question 4 qcWord4Zt\n«2 more not shown»",
      foldedQuestion: false, foldedOption: false, answer: true });
});
it("QC-2 an engine question with more one-tap choices than the card contract stores the first ten and one counted marker line (foldRuntimeEvent request.opened)", async () => {
  const { store, fold, base, bot } = questionCardFixture();
  const choices = Array.from({ length: 13 }, (_, i) => `choice ${i + 1} qcChoice${i + 1}Zt`);
  fold({ ...base, type: "request.opened", requestType: "question", requestId: "choices", tool: "AskUserQuestion", summary: "Which one?", choices });
  await vi.waitFor(() => expect(store.activePath(bot.threadId).at(-1)).toMatchObject({ kind: "options" }));
  const row = store.activePath(bot.threadId).at(-1)!;
  const card = row.card as { options?: string[]; subtitle?: string };
  const stored = JSON.stringify(row);
  expect({ options: card.options, subtitle: card.subtitle, folded: ["qcChoice11Zt", "qcChoice12Zt", "qcChoice13Zt"].some(word => stored.includes(word)), answer: answerShownCard(row.id, row.card as never).ok })
    .toEqual({ options: choices.slice(0, 10), subtitle: "Which one?\n«3 more not shown»", folded: false, answer: true });
});
it("QC-3 a question the engine asked while it kept working opens its card from the counted fold, and that card can be answered (foldRuntimeEvent question.async)", () => {
  const { fold, base, bot, scope } = questionCardFixture();
  // The fold's own gate: a live internal turn of this bot owns the thread. The card opener (index.ts openAnswerAsSendCard) is
  // recorded: it stores its `questions` argument as the card's questions unchanged, so what the fold hands it is the card.
  (scope.internalTurnOwners as Map<string, unknown>).set(bot.threadId, { botId: bot.id, generation: "generation" });
  const opened: { questions: { question: string; options: { label: string }[] }[] }[] = [];
  scope.openAnswerAsSendCard = async (_threadId: string, _botId: string, questions: never) => { opened.push({ questions }); return {}; };
  fold({ ...base, type: "question.async", questions: [cardQuestion(0, 12), cardQuestion(1, 2), cardQuestion(2, 2), cardQuestion(3, 2), cardQuestion(4, 2), cardQuestion(5, 2)] });
  const handed = JSON.stringify(opened);
  expect({ cards: opened.length, questions: opened[0]?.questions.length, options: opened[0]?.questions.map(q => q.options.length),
    firstText: opened[0]?.questions[0]?.question, lastText: opened[0]?.questions.at(-1)?.question,
    folded: ["qcWord5Zt", "qcWord6Zt", "qcOpt1x11Zt", "qcOpt1x12Zt"].some(word => handed.includes(word)),
    answer: answerShownCard("card", { requestId: "ask", subtitle: "", options: [], questions: opened[0]?.questions as never }).ok })
    .toEqual({ cards: 1, questions: 4, options: [10, 2, 2, 2],
      firstText: "fixture question 1 qcWord1Zt\n«2 more not shown»", lastText: "fixture question 4 qcWord4Zt\n«2 more not shown»", folded: false, answer: true });
});
it("QC-5 at No limits the owner's question card (decided as a question, no card-action builder) is the counted fold too (foldRuntimeEvent request.opened)", async () => {
  const { store, fold, base, bot } = questionCardFixture();
  // The same provenance the fixture installs, at the owner's No limits level: the decision is `question` and the card action is
  // the one decision/implementation.ts builds alone.
  decision.installProvenanceReader({
    turnGenerationFor: threadId => threadId === bot.threadId ? "turn" : undefined,
    provenance: () => ({ generation: "turn", threadId: bot.threadId, botId: bot.id, principal: "owner", roomOwnerOnly: true, at: 1, initiator: { k: "owner-typed" } }),
    live: threadId => threadId === bot.threadId ? { botId: bot.id, turnId: "turn", providerInstanceId: "fixture", principal: "owner", owner: true, level: "unlimited" } : undefined,
  });
  const choices = Array.from({ length: 13 }, (_, i) => `choice ${i + 1} qcChoice${i + 1}Zt`);
  const questions = [cardQuestion(0, 12), cardQuestion(1, 2), cardQuestion(2, 2), cardQuestion(3, 2), cardQuestion(4, 2), cardQuestion(5, 2)];
  fold({ ...base, type: "request.opened", requestType: "question", requestId: "nolimits", tool: "AskUserQuestion", summary: "Which one?", choices, questions });
  await vi.waitFor(() => expect(store.activePath(bot.threadId).at(-1)).toMatchObject({ kind: "options" }));
  const row = store.activePath(bot.threadId).at(-1)!;
  const card = row.card as { options?: string[]; questions?: { question: string; options: unknown[] }[] };
  const stored = JSON.stringify(row);
  expect({ why: decision.openApprovals(bot.threadId).map(open => open.why), options: card.options, questions: card.questions?.length, perQuestion: card.questions?.map(q => q.options.length),
    lastText: card.questions?.at(-1)?.question, folded: ["qcChoice11Zt", "qcChoice13Zt", "qcWord5Zt", "qcWord6Zt", "qcOpt1x11Zt"].some(word => stored.includes(word)), answer: answerShownCard(row.id, row.card as never).ok })
    .toEqual({ why: ["question"], options: choices.slice(0, 10), questions: 4, perQuestion: [10, 2, 2, 2],
      lastText: "fixture question 4 qcWord4Zt\n«2 more not shown»", folded: false, answer: true });
});
it("QC-4 a question inside the card contract is stored exactly as the engine asked it (control: the fold changes nothing it does not have to)", async () => {
  const { store, fold, base, bot } = questionCardFixture();
  const questions = [cardQuestion(0, 10), cardQuestion(1, 2), cardQuestion(2, 2), cardQuestion(3, 2)];
  fold({ ...base, type: "request.opened", requestType: "question", requestId: "inside", tool: "AskUserQuestion", summary: "Four questions", questions });
  await vi.waitFor(() => expect(store.activePath(bot.threadId).at(-1)).toMatchObject({ kind: "options" }));
  const row = store.activePath(bot.threadId).at(-1)!;
  expect({ questions: (row.card as { questions?: unknown }).questions, marker: JSON.stringify(row).includes("more not shown"), answer: answerShownCard(row.id, row.card as never).ok })
    .toEqual({ questions, marker: false, answer: true });
});

// MAIN-RULING 2026-11-23T00:58:16Z redact-marker (Sean's Mac, 1.0.21): a reply whose projection is only the marker was stored as the bare
// marker whenever the owner-only check was false, and the bubble and the sidebar read «redacted». It is the held-back sentence for EVERY
// reader, and the server log names the owner check that failed. The owner-only decision is the production ownerOnlyDisplayThread and
// ownerDisplayFailedThread compiled from index.ts over this row's host facts (ownerDisplayFacts is the only fixture: the three ways Sean's
// check came out false). The preview is the real thread summary the store's write keeps (thread-summary.ts syncThreadSummary).
const OWNER_FACTS = { directBotThread: true, room: false, ownerPrincipal: true, notOwnerTurn: false, pairedChannel: false };
const MARKER_ROWS: Array<[string, () => typeof OWNER_FACTS, string]> = [
  ["a non-owner-marked turn", () => ({ ...OWNER_FACTS, notOwnerTurn: true }), "notOwnerTurn"],
  ["a live paired channel run", () => ({ ...OWNER_FACTS, pairedChannel: true }), "pairedChannel"],
  ["an owner lookup that throws", () => { throw new Error("fixture lookup fault"); }, "lookup"],
];
for (const [label, facts, check] of MARKER_ROWS) {
  it(`FOLD-9 a marker-only reply on ${label} is the held-back sentence in the transcript row and the preview, and the log names ${check}`, () => {
    const { fold, scope, base, texts, store, bot } = withheldTurn();
    for (const name of ["ownerOnlyDisplayThread", "ownerDisplayFailedThread"]) {
      // the pre-fix sha has no ownerDisplayFailedThread: its ownerOnlyDisplayThread runs alone, as it did there
      const declaration = INDEX_AST.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
      if (declaration) scope[name] = runInNewContext(stripTypeScriptTypes(declaration.getText(INDEX_AST)) + `\n${name};`, scope);
    }
    Object.assign(scope, { ownerDisplayFailedCheck, ownerOnlyDisplay, ownerDisplayFacts: facts });
    const logged: string[] = [];
    scope.console = { ...console, warn: (...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); } };
    // the whole reply is one unit the turn's scan cannot check: its projection is only the marker
    fold({ ...base, eventId: "marker-reply", type: "item.completed", itemType: "assistant_text", itemId: "marker-reply", text: `the ${WITHHELD_SENTINEL} word` });
    expect(JSON.stringify(store.messagesFor(bot.threadId))).not.toContain(WITHHELD_SENTINEL);
    // the transcript row the write stored (index.ts ownerReplyText)
    expect(texts()).toEqual([REPLY_WITHHELD]);
    // the summary row the same write stored (thread-summary.ts syncThreadSummary), read raw, and the preview the chats route reads
    const stored = database().prepare("SELECT last_role, snippet FROM thread_summary WHERE thread_id=?").get(bot.threadId) as { last_role: string; snippet: string } | undefined;
    expect(stored).toEqual({ last_role: "bot", snippet: REPLY_WITHHELD });
    expect(readThreadSummary(database(), bot.threadId)?.snippet).toBe(REPLY_WITHHELD);
    expect(logged.filter(line => line.startsWith("[redact] reply on thread"))).toEqual([`[redact] reply on thread ${bot.threadId} held back for a shared audience: owner check ${check} failed`]);
  });
}

// ASTRA 8e5df5fecc High1: the log row with nothing of the owner check fixtured. ownerDisplayFacts and pairedChannelRun are compiled from
// index.ts too and read the host's own records (the store, threadHumanPrincipal, internalTurnOwners as an internal turn sets it,
// the routine run origin); only the routine store's run is fixture. The log is asserted FIRST: the pre-fix sha writes no such line.
const CHANNEL_OWNER = { personId: "workspace-owner", bindingId: "fixture-channel-binding", revision: 2 };
const HOST_FACT_ROWS: Array<[string, (threadId: string, scope: Record<string, unknown>) => void, string]> = [
  ["a non-owner-marked internal turn", (threadId, scope) => { (scope.internalTurnOwners as Map<string, unknown>).set(threadId, { botId: "fixture", generation: 1, depth: 1, notOwnerAudience: true }); }, "notOwnerTurn"],
  ["a live paired channel run", (_threadId, scope) => { scope.routines = { ...fixtureRoutines(), handleRuntimeEvent: () => null, activeRunOrigin: () => ({ triggerSource: "channel", humanPrincipal: CHANNEL_OWNER }) }; }, "pairedChannel"],
  ["a routine store that throws on the owner lookup", (_threadId, scope) => { scope.routines = { ...fixtureRoutines(), handleRuntimeEvent: () => null, activeRunOrigin: () => { throw new Error("fixture routine store fault"); } }; }, "lookup"],
];
for (const [label, arrange, check] of HOST_FACT_ROWS) {
  it(`FOLD-10 the server log names ${check} for a marker-only reply on ${label}, from the host's own facts`, () => {
    const { fold, scope, base, texts, bot } = withheldTurn();
    Object.assign(scope, { ownerDisplayFailedCheck, ownerOnlyDisplay, isWorkspaceOwner, threadHumanPrincipal, OWNER_PRINCIPAL, ownerSurfacesByThread: new Map() });
    for (const name of ["pairedChannelRun", "ownerDisplayFacts", "ownerOnlyDisplayThread", "ownerDisplayFailedThread"]) {
      const declaration = INDEX_AST.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
      if (declaration) scope[name] = runInNewContext(stripTypeScriptTypes(declaration.getText(INDEX_AST)) + `\n${name};`, scope);
    }
    arrange(bot.threadId, scope);
    const logged: string[] = [];
    scope.console = { ...console, warn: (...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); } };
    fold({ ...base, eventId: "marker-reply", type: "item.completed", itemType: "assistant_text", itemId: "marker-reply", text: `the ${WITHHELD_SENTINEL} word` });
    expect(logged.filter(line => line.startsWith("[redact] reply on thread"))).toEqual([`[redact] reply on thread ${bot.threadId} held back for a shared audience: owner check ${check} failed`]);
    expect(texts()).toEqual([REPLY_WITHHELD]);
  });
}

// ASTRA 8e5df5fecc High2: the coordinator's UNMASKED branch. A visible text that quotes a marker (a member's reply as the room stored
// it) is masked whole by sanitizeDisplayTextUnit, so the stored row (prepareTerminalEvent) and the live frame (foldRuntimeEvent) were
// the bare marker. MAIN-RULING 2026-11-23T00:58:16Z redact-marker: it is the held-back sentence for every reader.
const QUOTING_COORDINATOR = "The member said «redacted 12 chars» about it.";
const coordinatorTurn = () => {
  const turn = withheldTurn();
  turn.plainReply();
  turn.scope.groupGoalCoordinatorTurnForEvent = () => ({ turnId: "withheld-turn", assistantItems: ["private-coordinator-envelope"] });
  turn.scope.parseGroupGoalDecision = () => ({ visibleText: QUOTING_COORDINATOR });
  turn.fold({ ...turn.base, type: "turn.completed", ok: true });
  return turn;
};
it("FOLD-11 an unmasked coordinator reply that quotes a marker is stored as the held-back sentence, never the bare marker (prepareTerminalEvent)", () => {
  const { texts } = coordinatorTurn();
  expect(texts()).toEqual([PLAIN_REPLY, REPLY_WITHHELD]);
});
it("FOLD-12 an unmasked coordinator reply that quotes a marker is broadcast as the held-back sentence, never the bare marker (foldRuntimeEvent)", () => {
  const { frames } = coordinatorTurn();
  const goal = frames.filter(frame => String(frame?.event?.eventId ?? "").endsWith("-goal-text"));
  expect(goal.map(frame => frame.event.text)).toEqual([REPLY_WITHHELD]);
});
// controls for FOLD-10 and FOLD-11/12 (green on the base too: they pin what the fix must not change)
it("FOLD-11 control: an unmasked coordinator reply with no marker in it is stored and broadcast as written", () => {
  const turn = withheldTurn();
  turn.plainReply();
  turn.scope.groupGoalCoordinatorTurnForEvent = () => ({ turnId: "withheld-turn", assistantItems: ["private-coordinator-envelope"] });
  turn.scope.parseGroupGoalDecision = () => ({ visibleText: "The coordinator's plain words." });
  turn.fold({ ...turn.base, type: "turn.completed", ok: true });
  const goal = turn.frames.filter(frame => String(frame?.event?.eventId ?? "").endsWith("-goal-text"));
  expect({ stored: turn.texts(), goal: goal.map(frame => frame.event.text) }).toEqual({ stored: [PLAIN_REPLY, "The coordinator's plain words."], goal: ["The coordinator's plain words."] });
});
it("FOLD-10 control: the owner alone in his own bot's thread (every host fact passes) gets no [redact] log line", () => {
  const { fold, scope, base } = withheldTurn();
  Object.assign(scope, { ownerDisplayFailedCheck, ownerOnlyDisplay, isWorkspaceOwner, threadHumanPrincipal, OWNER_PRINCIPAL, ownerSurfacesByThread: new Map() });
  for (const name of ["pairedChannelRun", "ownerDisplayFacts", "ownerOnlyDisplayThread", "ownerDisplayFailedThread"]) {
    const declaration = INDEX_AST.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    if (declaration) scope[name] = runInNewContext(stripTypeScriptTypes(declaration.getText(INDEX_AST)) + `\n${name};`, scope);
  }
  const logged: string[] = [];
  scope.console = { ...console, warn: (...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); } };
  fold({ ...base, eventId: "marker-reply", type: "item.completed", itemType: "assistant_text", itemId: "marker-reply", text: `the ${WITHHELD_SENTINEL} word` });
  expect({ owner: (scope.ownerOnlyDisplayThread as (id: string) => boolean)(base.threadId), lines: logged.filter(line => line.startsWith("[redact]")) }).toEqual({ owner: true, lines: [] });
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();

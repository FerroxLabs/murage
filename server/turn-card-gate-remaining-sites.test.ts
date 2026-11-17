import { describe, expect, it, vi, afterEach } from "vitest";
import ts from "typescript";
import { stopCardFixture as rig } from "./testing/turn-card-fixture.ts";
afterEach(() => vi.restoreAllMocks());

// Execute production branches with their original conditions and catches. Stop is held at the real browser-release await;
// the late event/refusal is delivered while that await is unresolved, rather than calling the gate as the test subject.
function productionPart(ast: ts.SourceFile, owner: string, predicate: (node: ts.Node) => boolean): string {
  let root: ts.Node | undefined;
  const findOwner = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(ast) === owner) root = node;
    else ts.forEachChild(node, findOwner);
  };
  findOwner(ast);
  if (!root) throw new Error(`Missing production owner: ${owner}`);
  let found: ts.Node | undefined;
  const find = (node: ts.Node): void => {
    if (predicate(node)) { found = node; return; }
    if (!found) ts.forEachChild(node, find);
  };
  find(root);
  if (!found) throw new Error(`Missing production branch in ${owner}`);
  return found.getText(ast);
}
const variableNamed = (ast: ts.SourceFile, name: string) => (node: ts.Node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(d => d.name.getText(ast) === name);
const ifStarting = (ast: ts.SourceFile, condition: string) => (node: ts.Node) => ts.isIfStatement(node) && node.expression.getText(ast) === condition;

async function duringStop(work: (r: ReturnType<typeof rig>) => void | Promise<void>, stopped = true) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const r = rig();
  if (!stopped) { await work(r); return r; }
  r.built.noteOwnerStop!("T");
  const stopping = r.built.interruptDirectThread!("B", "T", "G");
  await r.entered;
  try { await work(r); }
  finally { r.release(); await stopping; }
  return r;
}

function notice(r: ReturnType<typeof rig>, site: string) {
  const event = { type: "item.completed", itemType: "assistant_image", threadId: "T", turnId: "P", data: "invalid", text: "A removed line" };
  const common = { event, executionEvent: event, eventLease: { lease: r.lease }, lease: r.lease,
    bot: { id: "B" }, speaker: undefined, result: { removedSpeaker: "Guest", removedText: "Guest: a removed line" },
    guarded: { speaker: { id: "B", name: "Ada", color: "blue" } }, speechTurn: undefined,
    turnEngineByThread: new Map(), replySpeakerTurns: { removalRow() {} },
    decodeGeneratedImage: () => { throw new Error("invalid image"); } };
  if (site === "image") {
    const branch = productionPart(r.ast, "foldRuntimeEvent", node => ts.isIfStatement(node) && node.expression.getText(r.ast) === 'event.itemType === "assistant_image"');
    r.production(`(() => { ${branch} })()`, common);
  } else if (site === "removed") {
    const branch = productionPart(r.ast, "foldRuntimeEvent", ifStarting(r.ast, "result.removedSpeaker"));
    r.production(`(() => { let cutSpeaker; ${branch} })()`, common);
  } else {
    const fn = productionPart(r.ast, "prepareTerminalEvent", node => ts.isFunctionDeclaration(node));
    r.production(`${fn}; prepareTerminalEvent(event)`, { ...common,
      event: { type: "turn.completed", threadId: "T", turnId: "P" }, shouldIgnoreProviderEvent: () => false,
      terminalDispatchFor: () => r.lease, internalCapabilities: { activeGeneration: () => "G" },
      groupGoalCoordinatorTurnForEvent: () => undefined, groupGoalCompletionTurnId: (id: string) => id,
      terminalDirectContext: () => ({}), turnOutcome: () => "completed", callRunByTurn: new Map(),
      store: { botByThread: () => ({ id: "B" }), turnRows: () => [], markTerminalAssistantMessage() {} },
      botForDirectThread: () => ({ id: "B" }), runtimeMessageWriter: () => ({ push: (m: unknown) => r.appended.push(m), nextOrdinal: 0 }),
      terminalPreparations: new WeakMap(), adoptStagedImages() {}, replyForStagedImages() {}, generatedImagesByTurn: new Map(), generatedImageTurnKey: () => "key",
      memoryEchoReplies: new Map(), memoryEchoDecision: () => ({ marker: { text: "echo detail" }, echoOnly: true }),
      MEMORY_ECHO_NOTICE: "The engine repeated a memory note.", turnHelpersForThread() {}, isWorkspaceOwner: () => true,
      threadHumanPrincipal: () => ({}), liveSubtasks: new Map(), freshReplayConfirmations: new WeakMap(),
    });
  }
}

describe("STOP-CARD W6: late fold notices", () => {
  it.each(["image", "echo", "removed"])("%s after Stop writes no notice", async site => {
    const r = await duringStop(r => notice(r, site));
    expect({ cards: r.appended, pushed: r.pushed }).toEqual({ cards: [], pushed: [] });
  });
  it.each(["image", "echo", "removed"])("%s without Stop keeps its notice", async site => {
    const r = await duringStop(r => notice(r, site), false);
    expect(r.appended.length + r.pushed.length).toBe(1);
  });
  it("F: repeated tool events during Stop produce no loop notice", async () => {
    const r = await duringStop(r => {
      let callback: ts.ArrowFunction | undefined;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.getText(r.ast) === "bus.subscribeExecution") {
          const candidate = node.arguments[0];
          if (candidate && ts.isArrowFunction(candidate) && candidate.getText(r.ast).includes("repeats.record")) callback = candidate;
        }
        ts.forEachChild(node, visit);
      };
      visit(r.ast);
      if (!callback) throw new Error("Missing production repeat subscriber");
      r.production(`(${callback.getText(r.ast)})(event)`, {
        event: { type: "item.started", itemType: "tool", threadId: "T", turnId: "P", title: "Read file" },
        shouldIgnoreProviderEvent: () => false, loopNudge: { observe() {} }, repeats: { record: () => ({ threshold: 3 }) }, toolTitleKey: () => "read", askCallLabel: () => "Read file",
        loopNoticeName: () => "The same tool call repeated.",
      });
    });
    expect(r.appended).toEqual([]);
  });
});

function limitPath(r: ReturnType<typeof rig>, site: string, identity: Record<string, unknown> = {}) {
  const turn = { threadId: "T", botId: "B", generation: "G", providerTurnId: "P", engineName: "Engine", selection: { instanceId: "I", model: "one" }, sendIds: [], ...identity };
  const limitCardScope = r.ast.statements.some(node => ts.isFunctionDeclaration(node) && node.name?.text === "limitCardScope")
    ? productionPart(r.ast, "limitCardScope", node => ts.isFunctionDeclaration(node)) : "";
  r.production(limitCardScope);
  const globals = { turn, threadId: "T", line: "The engine reached its limit.",
    store: { appendMessage: (_t: string, m: unknown) => r.appended.push(m), scanNewest() {}, bot: () => ({ limitBackup: { selection: { instanceId: "I", model: "two" } } }) },
    gatewayBusyStreaks: { refused: () => ({ count: 1, repeated: false }) }, setup: { firstJobPending: () => false },
    gatewayBusyLogLine: () => "limit reached", gatewayBusyFacts: () => ({ reason: "busy" }), gatewayBusyLine: () => "The engine is busy.",
    isGatewayBusyRow: () => false, backupVerdict: () => ({ ok: false, reason: "hidden" }), backupRefusalOf: () => "The backup engine is unavailable.",
  };
  if (site === "busy" || site === "plain") {
    const fn = site === "busy" ? "markGatewayBusy" : "putLimitLine";
    const code = productionPart(r.ast, fn, node => ts.isFunctionDeclaration(node));
    r.production(`${limitCardScope}\n${code}; ${site === "busy" ? 'markGatewayBusy(turn, "busy", 1)' : 'putLimitLine(threadId, turn, line)'}`, globals);
  } else if (site === "start") {
    const code = productionPart(r.ast, "failOverThread", node => ts.isFunctionDeclaration(node));
    r.production(`${code}; failOverThread(turn, turn.selection, null, 1)`, { ...globals, homeExecutionOff: () => false });
  } else if (site === "recover") {
    const code = productionPart(r.ast, "failoverRefusalSteps", node => ts.isFunctionDeclaration(node));
    r.production(`${code}; failoverRefusalSteps(row).line("hidden")`, { ...globals, row: { ...turn, from: turn.selection, to: turn.selection }, resendRecorded() {} });
  } else {
    const code = productionPart(r.ast, "onDirectLimitTurnCompleted", node => ts.isFunctionDeclaration(node));
    r.production(`${code}; onDirectLimitTurnCompleted(event)`, { ...globals,
      event: { type: "turn.completed", threadId: "T", turnId: "P" }, limitTurns: { settle: () => turn },
      turnSucceeded: () => false, gatewayBusyOfTurn: () => undefined, limitRefusalOfTurn: () => ({ resetsAt: null, until: 1 }),
      limitOutcome: () => ({ kind: "line" }), putLimitLine() {}, plainLimitLine: () => "limit", limitFailovers: { bySendId() {} },
    });
  }
}

describe("STOP-CARD W8: late limit and backup verdicts", () => {
  it.each(["busy", "plain", "start", "recover", "completed"])("%s after Stop writes no card", async site => {
    const r = await duringStop(r => limitPath(r, site));
    expect(r.appended).toEqual([]);
  });
  it.each(["busy", "plain", "start", "recover", "completed"])("%s without Stop keeps the exact card", async site => {
    const r = await duringStop(r => limitPath(r, site), false);
    expect(r.appended).toMatchObject([{ tool: { name: site === "busy" ? "error: The engine is busy." : site === "plain" ? "The engine reached its limit." : "The backup engine is unavailable.", ok: false } }]);
  });
});

function submissionPath(r: ReturnType<typeof rig>, site: string) {
  const common = { threadId: "T", bot: { id: "B" }, run: { generation: "G" }, dispatchClaimId: "G", accepted: { turnId: "P" },
    providerTurnId: "P", engine: "Engine", opts: undefined, memoryLastResort: false, memoryRefusalCauses: { kind: () => "checking", delete() {} },
    userMessage: { id: "U" }, turnRefusalNotes: new Map(), refusedBeforeHandback: new Map(), TURN_REFUSAL_NOTES_MAX: 100,
    submissionBoundary: { hasReleasedSubmission: true, refusedWith: undefined }, refusalKind: () => "not-started",
    submissionRefusalKind: () => "not-started", fenceNote: undefined, engineNameOf: () => "Engine", instance: {},
    backupRefusalMessage: () => undefined, turnRefusedLine: () => "The message was not sent.", lateMemoryRefusalLine: () => "The message was not sent.",
    turnFailureBuzzes: () => false, once: (fn: () => void) => fn, settleDirectAttempts() {}, turnExhausted() {}, routineToken: undefined,
  };
  const declaration = productionPart(r.ast, "startTurnAdmitting", variableNamed(r.ast, site === "note" ? "noteRefusalsOf" : site === "late" ? "card" : "settleWithCard"));
  r.production(`(() => { let refusalNoted = false; ${declaration}; ${site === "note" ? 'noteRefusalsOf("P"); turnRefusalNotes.get("P").note("not-started")' : site === "late" ? "card()" : "settleWithCard()"}; })()`, common);
}

describe("STOP-CARD W9: submission refusals during the Stop wait", () => {
  it.each(["note", "late", "settle"])("%s after Stop writes no card", async site => {
    const r = await duringStop(r => submissionPath(r, site));
    expect(r.appended).toEqual([]);
  });
  it.each(["note", "late", "settle"])("%s without Stop preserves the error fields", async site => {
    const r = await duringStop(r => submissionPath(r, site), false);
    expect(r.appended).toMatchObject([{ tool: { name: "error: The message was not sent.", ok: false, errorDetails: expect.stringContaining("submission_refused") } }]);
  });
});

function roomFailure(r: ReturnType<typeof rig>, site: string) {
  const owner = "runGroupMemberTurnDispatch";
  const optionalMemberCard = (() => {
    try { return productionPart(r.ast, owner, variableNamed(r.ast, "memberCard")); }
    catch { return ""; }
  })();
  const failureLine = productionPart(r.ast, owner, variableNamed(r.ast, "murageFailureLine"));
  let branch: string;
  if (site === "apps") branch = productionPart(r.ast, owner, node => ts.isTryStatement(node)
    && node.tryBlock.getText(r.ast).includes("await composio.turnConnectedAppsReady") && !node.tryBlock.getText(r.ast).includes("roomReader ="));
  else branch = productionPart(r.ast, owner, ifStarting(r.ast, site === "workspace" ? "workspace" : site === "stall" ? "setupStalled" : "roomResendOffer"));
  const errors: string[] = [], released: string[] = [];
  const pending = r.production(`(async () => {
    let failureLine = false; const internalGeneration = "G"; ${optionalMemberCard} ${failureLine}
    ${branch}
  })()`, {
    bot: { id: "B", name: "Ada", color: "blue" }, threadId: "T", orchestration: undefined,
    roomOwnerAudience: true, roomConnectedApps: true, instance: { adapter: { capabilities: { composioMcp: true } } }, cfg: {},
    composio: { connectedAppsExpected: () => true, turnConnectedAppsReady: async () => { throw new Error("engine closed"); } },
    workspace: true, cwd: "fixture", projectTurnLeases: { acquire: () => { throw new Error("restoring"); } }, botFolderOrThrow: (v: unknown) => v,
    setupStalled: true, roomResendOffer: false, pinFailure: undefined, message: "The member engine closed.", guardError: undefined,
    releaseUnstartedRoomTurn: async () => { released.push("released"); }, onDispatchError: (message: string) => errors.push(message),
  });
  return Promise.resolve(pending).then(() => ({ errors, released }));
}

describe("STOP-CARD W12: room member failures", () => {
  it.each(["apps", "workspace", "stall", "dispatch"])("%s after Stop writes no member card", async site => {
    const r = await duringStop(async r => {
      const result = await roomFailure(r, site);
      if (site === "workspace" || site === "stall") expect(result.released).toEqual(["released"]);
      if (site === "apps" || site === "workspace") expect(result.errors).toHaveLength(1);
    });
    expect(r.appended).toEqual([]);
  });
  it.each(["apps", "workspace", "stall", "dispatch"])("%s with no Stop retains the member failure", async site => {
    const r = await duringStop(r => roomFailure(r, site).then(() => {}), false);
    expect(r.appended.length).toBe(site === "apps" || site === "workspace" ? 2 : 1);
  });
  it.each(["B", "other"])("real room dispatch held in prepareThread: Stop B holds only B, member=%s", async member => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig();
    const fn = productionPart(r.ast, "runGroupMemberTurnDispatch", node => ts.isFunctionDeclaration(node));
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const bot = { id: member, name: "Ada", modelSelection: { instanceId: "missing" } };
    const dispatchErrors: string[] = [];
    const pending = r.production(`${fn}; runGroupMemberTurnDispatch("room", "T", "${member}", 0, new Set(), undefined, message => dispatchErrors.push(message))`, {
      RecallReadiness: class {}, store: { activeBot: () => true, prepareThread: async () => { enter(); await held; },
        group: () => ({ id: "room", dm: true, threadId: "T" }), bot: () => bot,
        appendMessage: (_t: string, message: unknown) => { r.appended.push(message); return { id: "row" }; } },
      homeExecutionOff: () => false, homeExecutionGate: undefined, backupRestartAdmission: { held: () => false }, LineageAllowance: { room: () => ({ close() {} }) },
      roomTurnRequestKey: () => "key", roomTurnRequests: new Map(), pendingRoomTurnRequests: new Map(), roomSetupRowEnded: () => false,
      memberTurnAutomation: () => undefined, routineRunLevel: () => undefined, resolveTurnFor: () => ({ selection: bot.modelSelection }),
      roomRounds: new Map(), randomUUID: () => "member-generation", registry: { get: () => undefined }, cfg: {},
      allInstanceConfigs: () => ({}), cloudHome: false, directRuns: { get: () => undefined }, internalTurnOwners: new Map(), dispatchErrors,
    });
    await Promise.race([entered, pending.then(() => { throw new Error("Room dispatch returned before setup wait"); })]);
    r.built.noteOwnerStop!("T", "B");
    release(); await pending;
    expect(r.appended.length).toBe(member === "B" ? 0 : 2);
    expect(dispatchErrors).toEqual(["Ada's model is unavailable"]);
  });
});


describe("STOP-CARD limit scope controls", () => {
  it("a late plain limit of A stays held after B is admitted", async () => {
    const r = await duringStop(() => {});
    r.admitNext("G2", "P2");
    limitPath(r, "plain");
    expect(r.appended).toEqual([]);
  });
  it.each(["busy", "plain", "start", "recover", "completed"])("%s: stopping member B does not hold another member", site => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig();
    r.built.noteOwnerStop!("T", "B");
    limitPath(r, site, { botId: "other", generation: "other-generation", providerTurnId: "other-turn" });
    expect(r.appended).toHaveLength(1);
  });
});


describe("STOP-CARD room stall completion", () => {
  it("a room stall callback during Stop holds the card and still settles", async () => {
    const effects: string[] = [];
    const r = await duringStop(r => {
      const registration = productionPart(r.ast, "runGroupMemberTurnDispatch", node => ts.isCallExpression(node)
        && node.expression.getText(r.ast) === "roomStallCompletions.register" && node.getText(r.ast).includes("roomTurnStallMessage"));
      r.production(`(() => { ${registration}; })()`, {
        threadId: "T", bot: { id: "B", name: "Ada" }, internalGeneration: "G",
        roomStallCompletions: { register: (_t: string, callback: () => void) => callback() },
        abandonProviderTurn: () => effects.push("abandon"), releaseBrowserCapabilityForThread: async () => {},
        roomTurnStallMessage: () => "The member stopped responding.", currentSilenceMinutes: () => 1,
        recordMemorySettlement: () => effects.push("settle"), beginRoomStop: async () => { effects.push("stop"); }, finish: (outcome: string) => effects.push(outcome),
        store: { activeLeaf: () => "leaf", appendMessage: (_t: string, m: unknown) => r.appended.push(m) },
      });
    });
    expect({ cards: r.appended, effects }).toEqual({ cards: [], effects: ["abandon", "settle", "stop", "stalled"] });
  });
});

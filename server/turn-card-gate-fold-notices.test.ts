// W6: shipped image, memory-echo, speaker-removal and repeat-notice paths, injected during Stop's browser-release await.
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { source } from "./decision-wiring/fixture.ts";
import { stopCardRig } from "./decision-wiring/turn-card-fixture.ts";
import { memoryEchoDecision, adoptStagedImages, replyForStagedImages } from "./fold-steps.ts";
import { RepeatDetector, toolTitleKey, askCallKey, askCallLabel } from "./repeat-detector.ts";
import { loopNoticeName } from "../shared/loop-notice.ts";

const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function top(name: string): ts.Node {
  const n = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name || ts.isVariableStatement(n) && n.declarationList.declarations[0]?.name.getText(ast) === name);
  if (!n) throw new Error(`Missing production writer ${name}`);
  return n;
}
function branch(expression: string): string {
  let found: ts.IfStatement | undefined;
  function visit(n: ts.Node) {
    if (ts.isIfStatement(n) && n.expression.getText(ast) === expression) found ??= n;
    ts.forEachChild(n, visit);
  }
  visit(top("foldRuntimeEvent"));
  if (!found) throw new Error(`Missing production branch ${expression}`);
  return `if (${found.expression.getText(ast)}) ${found.thenStatement.getText(ast)}`;
}
function repeatSubscriber(): string {
  const statement = ast.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
    && n.expression.expression.getText(ast) === "bus.subscribeExecution" && n.getText(ast).includes("repeats.record")) as ts.ExpressionStatement | undefined;
  if (!statement || !ts.isCallExpression(statement.expression)) throw new Error("Missing repeat subscriber");
  return statement.expression.arguments[0]!.getText(ast);
}
afterEach(() => vi.restoreAllMocks());
function rig() {
  const cards: { tool: { name: string; ok: boolean } }[] = [];
  const write = (m: { tool: { name: string; ok: boolean } }) => { cards.push(m); return { ...m, id: "row" }; };
  const r = stopCardRig(`
    ${top("prepareTerminalEvent").getText(ast)}
    const repeatEvent = ${repeatSubscriber()};
    function lateImage(event) {
      const executionEvent = event, eventLease = admittedLeaseForEvent(event), bot = undefined, speaker = undefined;
      ${branch('event.itemType === "assistant_image"')}
    }
    function lateRemoval(event) {
      const executionEvent = event, eventLease = admittedLeaseForEvent(event), guarded = { names: ["Ada"], speaker: { id: "B", name: "Ada" } }, speechTurn = undefined;
      let cutSpeaker;
      ${branch('guarded && event.type === "item.completed" && event.itemType === "assistant_text"')}
    }
    globalThis.extra = { lateImage, lateRemoval, prepareTerminalEvent, repeatEvent };`, {
    pushMessage: write,
    store: { appendMessage: (_t: string, m: Parameters<typeof write>[0]) => write(m), setTaskActivity() {}, bot: () => ({ id: "B" }),
      botByThread: () => ({ id: "B" }), groupByThread: () => undefined, turnRows: () => [], markTerminalAssistantMessage: () => undefined },
    decodeGeneratedImage: () => { throw new Error("invalid image"); },
    turnEngineByThread: new Map(), replySpeakerTurns: { item: () => ({ text: "", removedSpeaker: "Ada", removedText: "late line" }), removalRow() {}, ended() {} },
    shouldIgnoreProviderEvent: () => false, internalCapabilities: { activeGeneration: () => "G" },
    groupGoalCoordinatorTurnForEvent: () => undefined, groupGoalCompletionTurnId: (id: string) => id,
    terminalDirectContext: () => ({}), turnOutcome: () => "completed",
    turnHelpersForThread: () => [], isWorkspaceOwner: () => true, threadHumanPrincipal: () => ({}), liveSubtasks: new Map(),
    runtimeMessageWriter: () => ({ push: write, nextOrdinal: 0 }), terminalPreparations: new Map(),
    adoptStagedImages, replyForStagedImages, generatedImagesByTurn: new Map(), generatedImageTurnKey: () => "key",
    memoryEchoDecision, memoryEchoReplies: new Map([["T", { turnId: "P", text: "memory echo" }]]),
    MEMORY_ECHO_NOTICE: "Memory references were repeated without an answer.",
    repeats: new RepeatDetector({ thresholds: [5, 10, 20], maxKeysPerThread: 256 }),
    loopNudge: { observe() {} }, toolTitleKey, askCallKey, askCallLabel, loopNoticeName,
  });
  return { ...r, cards };
}
const cases = [
  { name: "D image attachment", line: "generated image could not be attached: invalid image", fire: (r: ReturnType<typeof rig>) => r.built.lateImage({ type: "item.completed", itemType: "assistant_image", data: "invalid", threadId: "T", turnId: "P" }) },
  { name: "E memory echo", line: "Memory references were repeated without an answer.", fire: (r: ReturnType<typeof rig>) => r.built.prepareTerminalEvent({ type: "turn.completed", ok: true, threadId: "T", turnId: "P", providerInstanceId: "I" }) },
  { name: "E removed speaker", line: "Removed a line written as Ada.", fire: (r: ReturnType<typeof rig>) => r.built.lateRemoval({ type: "item.completed", itemType: "assistant_text", text: "late text", threadId: "T", turnId: "P" }) },
  { name: "F repeat", line: "loop-notice:repeat:5:echo hi", fire: (r: ReturnType<typeof rig>) => { for (let n = 0; n < 5; n++) r.built.repeatEvent({ type: "item.started", itemType: "tool", title: "echo hi", threadId: "T", turnId: "P" }); } },
];
describe("STOP-CARD W6: late fold notices during the browser-release wait", () => {
  it.each(cases)("$name: no notice after Stop; the no-Stop control keeps the exact card", async ({ fire, line }) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const control = rig(); fire(control);
    expect(control.cards.map(m => m.tool.name)).toEqual([line]);
    const r = rig(); r.built.noteOwnerStop("T");
    const stopping = r.built.interruptDirectThread("B", "T", "G");
    await r.entered;
    fire(r);
    expect(r.cards).toEqual([]);
    expect(r.order).toEqual(["bus.cancelTurn", "browser.release"]);
    r.release(); await stopping;
  });
});

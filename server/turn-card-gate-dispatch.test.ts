// W9/W10: production submission callbacks and the dispatch catch's reporting tail, with the async boundaries held explicitly.
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { source } from "./decision-wiring/fixture.ts";
import { stopCardRig } from "./decision-wiring/turn-card-fixture.ts";
import { guardTurnDispatch } from "./turn-dispatch-guard.ts";
import { ownerEngineText } from "./turn-end.ts";
import { once } from "./fold-steps.ts";

const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const start = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "startTurnAdmitting")!;
function find(predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  function visit(n: ts.Node) { if (!found && predicate(n)) found = n; if (!found) ts.forEachChild(n, visit); }
  visit(start);
  if (!found) throw new Error("Missing production dispatch path");
  return found;
}
function declaration(name: string): string {
  return find(n => ts.isVariableStatement(n) && n.declarationList.declarations[0]?.name.getText(ast) === name).getText(ast);
}
function top(name: string): string {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw new Error(`Missing production function ${name}`);
  return node.getText(ast);
}
function dispatchReportingTail(): string {
  const ownerCheck = find(n => ts.isIfStatement(n) && n.expression.getText(ast) === "!admitted.rejectionOwner.current()") as ts.IfStatement;
  if (!ts.isBlock(ownerCheck.parent)) throw new Error("Dispatch reporting has no production block");
  const statements = [...ownerCheck.parent.statements];
  return statements.slice(statements.indexOf(ownerCheck)).map(n => n.getText(ast)).join("\n");
}
function acceptedRefusalCallback(): string {
  const call = find(n => ts.isCallExpression(n) && n.expression.getText(ast) === "submissionBoundary.acceptedBy") as ts.CallExpression;
  return call.arguments[0]!.getText(ast);
}
afterEach(() => vi.restoreAllMocks());
function rig() {
  const cards: { tool: { name: string; errorDetails?: string } }[] = [], errors: string[] = [], drains: string[] = [];
  let reject!: (error: unknown) => void;
  const promise = new Promise<{ turnId: string }>((_resolve, fail) => { reject = fail; });
  const pending = { promise, reject };
  const state = { reported: false, dispatchErrorCalled: false, rejectionOwner: { current: () => true } };
  const r = stopCardRig(`
    ${top("preparationFailureText")}
    ${top("turnFailureDiagnostic")}
    const threadId = "T", dispatchClaimId = "G", bot = { id: "B", name: "Ada", modelSelection: { instanceId: "I" } };
    const run = { threadId, botId: "B", generation: "G" }, accepted = { turnId: "P" }, instance = { driverKind: "acp" };
    const userMessage = { id: "U" }, opts = { onDispatchError: dispatchError }, routineToken = undefined;
    const directOwnerAudience = true, acceptedTurnId = "P", resendOfRow = {}, memoryLastResort = false;
    let refusalNoted = false;
    const refusalKind = () => "not-started";
    ${declaration("noteRefusalsOf")}
    const refused = ${acceptedRefusalCallback()};
    async function rejectDispatch() {
      try { await guardTurnDispatch(pendingDispatch, () => false, async () => {}); }
      catch (failure) {
        let rebuildFailed = false;
        ${dispatchReportingTail()}
      }
    }
    globalThis.extra = {
      rejectDispatch,
      earlyRefusal: () => { refusedBeforeHandback.add("P"); noteRefusalsOf("P"); },
      lateRefusal: (released) => {
        submissionBoundary.hasReleasedSubmission = released;
        refused(new Error("MEMORY_CONTEXT_REVOKED"), { priorSubmissionReleased: released });
        lateMemoryRedispatches.get("P").take("card");
      }
    };`, {
    guardTurnDispatch, ownerEngineText, once, pendingDispatch: pending.promise,
    admitted: state, dispatchError: (message: string) => errors.push(message),
    store: { appendMessage: (_t: string, m: { tool: { name: string } }) => cards.push(m), setTaskActivity() {}, bot: () => ({ id: "B" }) },
    submissionBoundary: { canRetry: false, hasReleasedSubmission: false, hasConfirmedSubmission: true },
    isMemoryContextRevoked: (failure: unknown) => failure instanceof Error && failure.message === "MEMORY_CONTEXT_REVOKED", pinnedMemoryFailure: () => undefined,
    RecallDispatchPending: class extends Error {}, RecallPreparationPending: class extends Error {}, SignInRequiredError: class extends Error {},
    localSetupFailureOf: () => undefined, localSetupEngineOf: () => undefined, turnFailureBuzzes: () => false,
    memoryRefusalCauses: { kind: () => "without-memory", delete() {} }, refusedBeforeHandback: new Set(), turnRefusalNotes: new Map(), TURN_REFUSAL_NOTES_MAX: 1000,
    backupRefusalMessage: () => undefined, turnRefusedLine: () => "The message was not sent.", lateMemoryRefusalLine: () => "The message was not sent.",
    engineNameOf: () => "The engine", // the late ticket goes through the shared rig's registerLateTicket into its lateMemoryRedispatches
    recordMemoryRefusal() {}, turnRefused() {}, nextMemoryRebuild: () => undefined, turnExhausted() {}, MEMORY_REDISPATCH_ATTEMPTS: 3,
    drainQueuedSends: () => drains.push("queued"), drainConnectorResumes: () => drains.push("connector"), drainSecretResumes: () => drains.push("secret"), drainTeamIncidents: () => drains.push("incident"),
    browserSetup: undefined, browserExtension: undefined,
  });
  return { ...r, cards, errors, drains, pending, state };
}
describe("STOP-CARD W9: submission refusal callbacks while Stop waits for browser release", () => {
  it.each(["early", "released", "revoked"])("%s refusal: no card after Stop, same card and metadata without Stop", async kind => {
    vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
    const fire = (r: ReturnType<typeof rig>) => kind === "early" ? r.built.earlyRefusal() : r.built.lateRefusal(kind === "released");
    const control = rig(); fire(control);
    expect(control.cards.map(m => m.tool)).toEqual([{ name: "error: The message was not sent.", ok: false, errorDetails: kind === "revoked" ? "MEMORY_CONTEXT_REVOKED (submission_refused)" : "submission_refused" }]);
    const r = rig(); r.built.noteOwnerStop("T");
    const stopping = r.built.interruptDirectThread("B", "T", "G");
    await r.entered; fire(r);
    expect(r.cards).toEqual([]);
    r.release(); await stopping;
  });
});
describe("STOP-CARD W10: dispatch rejects after Stop during the handshake", () => {
  it("holds the dispatch promise, Stops, then rejects: no card, callback and drains still once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
    const r = rig();
    const dispatching = r.built.rejectDispatch();
    r.built.noteOwnerStop("T");
    const stopping = r.built.interruptDirectThread("B", "T", "G");
    await r.entered;
    r.pending.reject(new Error("The engine could not prepare this reply."));
    await dispatching;
    expect({ cards: r.cards, errors: r.errors, reported: r.state.reported, drains: r.drains })
      .toEqual({ cards: [], errors: ["The engine could not prepare this reply."], reported: true, drains: ["queued", "connector", "secret", "incident"] });
    r.release(); await stopping;
  });
  it("without Stop the same dispatch failure writes the exact diagnostic card and calls back once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = rig(); const dispatching = r.built.rejectDispatch();
    r.pending.reject(new Error("The engine could not prepare this reply.")); await dispatching;
    expect({ tools: r.cards.map(m => m.tool), errors: r.errors }).toEqual({ tools: [{ name: "error: The engine could not prepare this reply.", ok: false, errorDetails: "The engine could not prepare this reply." }], errors: ["The engine could not prepare this reply."] });
  });
});

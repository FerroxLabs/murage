// W12: the real S6 room Stop route, then the room dispatch's workspace and provider-failure branches.
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { source } from "./decision-wiring/fixture.ts";
import { stopCardRig } from "./decision-wiring/turn-card-fixture.ts";
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  function visit(n: ts.Node) { if (!found && predicate(n)) found = n; if (!found) ts.forEachChild(n, visit); }
  visit(root);
  if (!found) throw new Error("Missing production room path");
  return found;
}
const member = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "runGroupMemberTurnDispatch")!;
function declaration(name: string) {
  return find(member, n => ts.isVariableStatement(n) && n.declarationList.declarations[0]?.name.getText(ast) === name).getText(ast);
}
function roomStop(): string {
  return find(ast, n => ts.isIfStatement(n) && n.expression.getText(ast) === "busyGroup" && n.getText(ast).includes("cancelGroupTurnOperations(busyGroup.group.id")).getText(ast);
}
function workspaceBranch(): string {
  return find(member, n => ts.isIfStatement(n) && n.expression.getText(ast) === "workspace" && n.getText(ast).includes("projectTurnLeases.acquire")).getText(ast);
}
function memberErrorTail(): string {
  const pinFailure = find(member, n => ts.isVariableStatement(n) && n.declarationList.declarations[0]?.name.getText(ast) === "pinFailure"
    && n.getText(ast).includes("roomOwnerAudience"));
  if (!ts.isBlock(pinFailure.parent)) throw new Error("Missing production member catch block");
  const statements = [...pinFailure.parent.statements];
  return statements.slice(statements.indexOf(pinFailure as ts.Statement)).map(n => n.getText(ast)).join("\n");
}
afterEach(() => vi.restoreAllMocks());
function rig(memberId = "B") {
  const cards: { tool: { name: string } }[] = [], errors: string[] = [], releases: string[] = [], outcomes: string[] = [];
  const r = stopCardRig(`
    const threadId = "T", botId = memberId, bot = { id: memberId, name: "Ada", modelSelection: { instanceId: "I" } };
    const instance = registry.get("I"), internalGeneration = "G", orchestration = undefined;
    let failureLine = false, turnFailure;
    ${declaration("murageFailureLine")}
    async function stopRoom() {
      const bot = { id: "B" };
      const busyGroup = { threadId, group: { id: "room", name: "Room" } }, expectedThreadId = undefined, req = {}, res = {};
      ${roomStop()}
    }
    async function workspaceFailure() {
      const workspace = true, roomLayers = []; let cwd = "folder";
      ${workspaceBranch()}
    }
    function providerFailure() {
      const err = new Error("The member engine closed."), roomOwnerAudience = true, roomResendRow = () => {}, replyText = "";
      ${memberErrorTail()}
      murageFailureLine(turnFailure, Boolean(replyText.trim()));
    }
    globalThis.extra = { stopRoom, workspaceFailure, providerFailure };`, {
    memberId,
    store: { appendMessage: (_t: string, m: { tool: { name: string } }) => cards.push(m), setTaskActivity() {}, bot: () => ({ id: "B" }) },
    grantOfRequest: new WeakMap(), cancelGroupTurnOperations() {}, markSendsStopped() {}, json: () => ({ ok: true }),
    releaseUnstartedRoomTurn: async () => { releases.push("room"); },
    projectTurnLeases: { acquire: () => { throw new Error("restore in progress"); } }, botFolderOrThrow: (value: unknown) => value,
    onDispatchError: (message: string) => errors.push(message),
    submissionBoundary: { canRetry: false, hasReleasedSubmission: false, hasConfirmedSubmission: true },
    pinnedMemoryFailure: () => undefined, isMemoryContextRevoked: () => false,
    RecallDispatchPending: class extends Error {}, RecallPreparationPending: class extends Error {}, MemoryPinProjectionPending: class extends Error {}, MemoryPinSetTooLarge: class extends Error {}, SignInRequiredError: class extends Error {},
    watchdog: { settle: () => outcomes.push("settle") }, finish: (outcome: string) => outcomes.push(outcome),
  }, { running: false });
  r.leases.clear();
  return { ...r, cards, errors, releases, outcomes };
}
describe("STOP-CARD W12: S6 room Stop while browser release is held", () => {
  it("the Stop for member B keeps member Y's own provider failure visible", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = rig("Y"); const stopping = r.built.stopRoom();
    await r.entered; r.built.providerFailure();
    expect(r.cards.map(m => m.tool.name)).toEqual(["error: The member engine closed.", "Ada could not answer: The member engine closed."]);
    r.release(); await stopping;
  });
  it.each(["workspace", "provider"])("%s member failure is held, the room still releases/reports, and the no-Stop control retains the exact text", async kind => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fire = (r: ReturnType<typeof rig>) => kind === "workspace" ? r.built.workspaceFailure() : r.built.providerFailure();
    const control = rig(); await fire(control);
    const message = kind === "workspace" ? "This project's files are being restored. Wait for the restore to finish before running this task." : "The member engine closed.";
    expect(control.cards.map(m => m.tool.name)).toEqual([`error: ${message}`, `Ada could not answer: ${message}`]);
    const r = rig(); const stopping = r.built.stopRoom();
    await r.entered;
    await fire(r);
    expect(r.cards).toEqual([]);
    expect(r.errors).toEqual([message]);
    if (kind === "workspace") expect(r.releases).toEqual(["room"]);
    else expect(r.outcomes).toEqual(["settle", "dispatch_failed"]);
    r.release(); await stopping;
  });
});

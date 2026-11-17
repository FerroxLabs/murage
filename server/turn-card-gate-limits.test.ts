// W8: production limit and failover cards during the real Stop/browser-release wait.
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { source } from "./decision-wiring/fixture.ts";
import { stopCardRig } from "./decision-wiring/turn-card-fixture.ts";
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function declaration(name: string): string {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node && name === "limitCardScope") return ""; // The ungated parent has no scope helper.
  if (!node) throw new Error(`Missing production function: ${name}`);
  return node.getText(ast);
}
afterEach(() => vi.restoreAllMocks());

function limitRig() {
  const cards: { tool: { name: string; ok: boolean } }[] = [];
  const r = stopCardRig(`${["limitCardScope", "markGatewayBusy", "putLimitLine", "failOverThread", "onDirectLimitTurnCompleted"].map(declaration).join("\n")}
    globalThis.extra = { markGatewayBusy, putLimitLine, failOverThread, onDirectLimitTurnCompleted };`, {
    store: { appendMessage: (_t: string, m: { tool: { name: string; ok: boolean } }) => cards.push(m), scanNewest() {}, setTaskActivity() {}, bot: () => ({ id: "B", limitBackup: { selection: { instanceId: "I2" } } }) },
    gatewayBusyStreaks: { refused: () => ({ count: 1, repeated: false }) },
    setup: { firstJobPending: () => false }, gatewayBusyLogLine: () => "gateway busy", gatewayBusyFacts: () => ({ reason: "busy" }),
    gatewayBusyLine: () => "The engine is busy.",
    limitTurns: { settle: () => ({ botId: "B", threadId: "T", generation: "G", providerTurnId: "P", selection: { instanceId: "I" }, sendIds: [], engineName: "The engine" }) },
    turnSucceeded: () => false, gatewayBusyOfTurn: () => undefined, limitRefusalOfTurn: () => ({ until: 1, resetsAt: null }),
    limitOutcome: () => ({ kind: "line" }), plainLimitLine: () => "The engine reached its limit.",
    backupVerdict: () => ({ ok: false, reason: "unavailable" }), backupRefusalOf: () => "The backup is unavailable.",
  });
  const turn = { botId: "B", threadId: "T", generation: "G", providerTurnId: "P", engineName: "The engine", selection: { instanceId: "I" }, sourceMessageId: "U" };
  return { ...r, cards, turn };
}
describe("STOP-CARD W8: limit and backup verdicts arrive while Stop waits on browser release", () => {
  it.each(["busy", "limit", "backup", "completed-backup"])("%s: no card after Stop; the same failure without Stop retains its line", async kind => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const invoke = (r: ReturnType<typeof limitRig>) => {
      if (kind === "busy") return r.built.markGatewayBusy(r.turn, "busy", 1);
      if (kind === "limit") return r.built.putLimitLine("T", r.turn, "The engine reached its limit.");
      if (kind === "completed-backup") return r.built.onDirectLimitTurnCompleted({ type: "turn.completed", threadId: "T", turnId: "P" });
      return r.built.failOverThread(r.turn, { instanceId: "I2" }, null, 1);
    };
    const control = limitRig();
    invoke(control);
    expect(control.cards.map(m => m.tool.name)).toEqual(kind === "completed-backup" ? ["The backup is unavailable.", "The engine reached its limit."] : [kind === "busy" ? "error: The engine is busy." : kind === "limit" ? "The engine reached its limit." : "The backup is unavailable."]);
    const r = limitRig();
    r.built.noteOwnerStop("T");
    const stopping = r.built.interruptDirectThread("B", "T", "G");
    await r.entered;
    const outcome = invoke(r);
    expect(r.cards).toEqual([]);
    if (kind === "backup") expect(outcome).toEqual({ refused: "unavailable" });
    r.release(); await stopping;
  });
});

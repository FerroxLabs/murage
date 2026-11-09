import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { CallSpeechCoordinator, type CallSpeechReady } from "./call-coordinator.ts";
import { ReplyState, speechTransaction } from "./reply-state.ts";
import { initializeReplySchema } from "./reply-schema.ts";
const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
function extract(name: string, deps: Record<string, unknown>) {
  const start = source.indexOf(`async function ${name}(`), end = source.indexOf("\n/**", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), js + `return ${name};`)(...Object.values(deps));
}
it("S-remote real owner Stop wiring revokes completed playback subscriptions before any awaited engine cleanup", async () => {
  const db = new DatabaseSync(":memory:"); initializeReplySchema(db);
  try {
    let broken = false;
    const state = new ReplyState({ db: () => db, transaction: work => { if (broken) throw Error("fixture write failure"); return speechTransaction(db)(work); } }); state.boot();
    const send = vi.fn(() => true), terminate = vi.fn();
    const session = state.session({ id: "connection", principal: "owner", send, terminate }, "thread");
    const input = { sessionId: session.sessionId, principal: "owner", connectionId: "connection", threadId: "thread", messageId: "message", commandSequence: 1, action: "speak" as const };
    const account = state.account("fixture", "v1");
    const attempt = state.reserve(input, () => ({ target: { threadId: "thread", messageId: "message", botId: "bot", eligible: true }, account })); state.finish(attempt, "complete");
    const player = { stop: vi.fn() };
    let ready!: CallSpeechReady;
    const callSpeech = new CallSpeechCoordinator(() => true);
    callSpeech.attach({ callId: "call", principal: "owner", threadId: "thread", targetId: "bot" }, {}, event => {
      if (event.type === "call.speech.ready") ready = event;
      else player.stop();
      return true;
    });
    callSpeech.begin("thread", "bot", "generation");
    callSpeech.item("thread", "bot", "generation", "item", "Safe reply.");
    callSpeech.settle("thread", "bot", "generation", "message", true);
    const interrupt = vi.fn();
    const cancel = vi.fn();
    const stop = extract("stopDirectThreadForOwner", {
      replyState: state, callSpeech, interruptDirectThread: interrupt, dropAskerWakes: () => {}, recordStopForThread: () => {}, database: () => db,
      markSendsStopped: () => {}, botCalls: { cancel }, stopHeldVenuePosts: () => [], settleVenuePostCard: () => {},
      routines: { activeBotRunForThread: () => undefined },
    });
    broken = true;
    await expect(stop({ id: "bot" }, "thread")).rejects.toMatchObject({ status: 503, code: "durable_stop_failed" });
    expect(send).toHaveBeenCalledWith({ kind: "speech.sessionClosed", sessionId: session.sessionId, bootId: state.bootId, reason: "durable_stop_failed" });
    expect(interrupt).toHaveBeenCalledWith("bot", "thread");
    expect(cancel).toHaveBeenCalledWith({ bot: "bot" }, "stop");
    expect(player.stop).toHaveBeenCalled();
    expect(() => callSpeech.claim("call", "owner", "thread", ready.replyId)).toThrow();
    expect(() => state.authorize(input)).toThrow();
  } finally { db.close(); }
});
it("S-late real generation-specific interrupt checks replacement before durable invalidation and invalidates before its first await", async () => {
  const db = new DatabaseSync(":memory:"); initializeReplySchema(db);
  try {
    const state = new ReplyState({ db: () => db, transaction: speechTransaction(db) }); state.boot(); state.begin("thread", "bot", "current", "prompt"); state.bind("current", "provider");
    let generation = "current";
    const release = vi.fn(async () => { expect(state.generation("thread", "provider")?.state).toBe("invalid"); generation = "new"; });
    const stop = extract("interruptDirectThread", {
      replyState: state, callSpeech: { invalidate: vi.fn() }, directRuns: { get: () => ({ generation }) }, internalTurnOwners: new Map(),
      botForDirectThread: () => ({ modelSelection: { instanceId: "fixture" } }), cancelDirectTurnDispatch: () => ({ phase: "dispatching" }),
      stopEmailForTurn: vi.fn(), emailRuntime: {}, emailGeneration: () => 0, releaseBrowserCapabilityForThread: release,
    });
    await stop("bot", "thread", "old"); expect(state.revision("thread")).toBe(0); expect(release).not.toHaveBeenCalled();
    await stop("bot", "thread", "current"); expect(release).toHaveBeenCalledOnce(); expect(state.revision("thread")).toBe(1);
  } finally { db.close(); }
});

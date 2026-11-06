// UX-L4B-FULL 1.0.19 slice 1 (designs/UX-L4B-FULL-1018.md section 9): the help panel's question is an isolated run. The flag lives on
// the owner_sends row, the drained batch and the run record, and every place words could join a running turn reads it. Tests 12-15 of
// 9.5 (11 and 16 run through the real server in ux-l4b-isolation-api.test.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IndependentThreadRuns, isolationRefuses } from "./independent-thread-runs.ts";
import { SendStore, type AcceptResult, type SendRow } from "./send-store.ts";
import { drainBatch } from "./steer-queue.ts";
import { createTurnAttribution } from "./turn-attribution.ts";

const SERVER = import.meta.dirname;
const source = (file: string) => readFileSync(join(SERVER, file), "utf8");
const newRow = (r: AcceptResult): SendRow => { expect(r.kind).toBe("new"); return (r as { row: SendRow }).row; };
const owner = (text: string, over: Record<string, unknown> = {}) => ({
  kind: "bot" as const, ownerId: "b1", threadId: "t1", fingerprint: text, text, status: "queued" as const, origin: "desktop", ...over,
});
let db: DatabaseSync;
beforeEach(() => { db = new DatabaseSync(":memory:"); });

describe("isolated rows (9.1, test 14)", () => {
  it("an isolated row is always queue-only, persists, and reads back after a restart", () => {
    const s = new SendStore(() => db);
    expect(() => s.accept(owner("help", { isolated: true }))).toThrow(/queue-only/);
    const row = newRow(s.accept(owner("help", { isolated: true, queueOnly: true })));
    expect(row).toMatchObject({ isolated: true, queueOnly: true, via: null, origin: "desktop" });
    const plain = newRow(s.accept(owner("plain")));
    expect(plain.isolated).toBe(false);
    // restart: a fresh store on the same database
    const again = new SendStore(() => db);
    expect(again.queuedRows("t1", "bot").map((r) => [r.text, r.isolated])).toEqual([["help", true], ["plain", false]]);
    expect(drainBatch(again.queuedRows("t1", "bot")).map((r) => r.text)).toEqual(["help"]);
  });

  it("an older table gains the column and its rows read as not isolated", () => {
    const old = new DatabaseSync(":memory:");
    old.exec("CREATE TABLE owner_sends (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, send_id TEXT, queue_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, text TEXT, prompt TEXT, reply_to_id TEXT, origin TEXT, mode TEXT, responder_id TEXT, existing_message_id TEXT, message_id TEXT, status TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    old.exec("INSERT INTO owner_sends (kind, owner_id, thread_id, queue_id, fingerprint, text, status, created_at, updated_at) VALUES ('bot','b1','t1','q1','f','hi','queued',1,1)");
    expect(new SendStore(() => old).queuedRows("t1", "bot")[0]).toMatchObject({ isolated: false, queueOnly: false });
  });

  it("Send again on an isolated row keeps it isolated and queue-only, even from a press without noSteer (G-L2)", () => {
    const s = new SendStore(() => db);
    const first = newRow(s.accept(owner("help", { sendId: "S", isolated: true, queueOnly: true })));
    s.refuse(first.seq);
    const resent = newRow(s.accept({ kind: "bot", ownerId: "b1", threadId: "t1", sendId: "S", fingerprint: "help", text: "help", origin: "desktop", resend: true, actionId: "a1" }));
    expect(resent).toMatchObject({ isolated: true, queueOnly: true, origin: "desktop" });
    expect(resent.queueId).not.toBe(first.queueId);
  });
});

describe("the queue (9.1): an isolated row is a batch alone, both directions", () => {
  it("first: alone; later: it ends the run of owner rows before it", () => {
    const s = new SendStore(() => db);
    s.accept(owner("o1"));
    s.accept(owner("o2"));
    s.accept(owner("help", { isolated: true, queueOnly: true }));
    s.accept(owner("o3"));
    const rows = s.queuedRows("t1", "bot");
    expect(drainBatch(rows).map((r) => r.text)).toEqual(["o1", "o2"]);
    expect(drainBatch(rows.slice(2)).map((r) => r.text)).toEqual(["help"]);
    expect(drainBatch(rows.slice(3)).map((r) => r.text)).toEqual(["o3"]);
  });

  it("the drain hands the batch's isolation to startTurn, and startTurn to admit", () => {
    expect(source("steer-queue.ts")).toContain("...(first.isolated ? { isolated: true } : {})");
    const index = source("index.ts");
    expect(index).toContain("...(batch.isolated ? { isolated: true } : {}),");
    expect(index).toContain("...(opts?.isolated===true?{isolated:true}:{})});");
  });
});

describe("the run record (9.1, test 14)", () => {
  it("admit sets the flag; a rebuild takeover keeps the held run's flag whatever the caller passes", () => {
    const runs = new IndependentThreadRuns<object>();
    const help = runs.admit("b1", "t1", {}, [], { isolated: true });
    expect(runs.get("t1")?.isolated).toBe(true);
    expect(runs.dispatch(help)).toBe(true);
    expect(runs.accepted(help, "turn-help")).toBe(true);
    expect(runs.get("t1")).toMatchObject({ isolated: true, providerTurnId: "turn-help" });
    expect(runs.holdForRebuild(help)).toBe(true);
    const rebuilt = runs.admit("b1", "t1", {}, [], { takeOver: help.generation });
    expect(rebuilt.isolated).toBe(true);
    // and an ordinary run taken over is never made isolated
    const other = runs.admit("b1", "t2", {}, []);
    expect(runs.holdForRebuild(other)).toBe(true);
    expect(runs.admit("b1", "t2", {}, [], { takeOver: other.generation, isolated: true }).isolated).toBeUndefined();
  });
});

describe("question-card answers (9.2, test 15)", () => {
  it("only the answer to the isolated run's own card passes; another turn's answer and plain words do not", () => {
    const help = { isolated: true as const, providerTurnId: "turn-help" };
    expect(isolationRefuses(help, "turn-help")).toBe(false);
    expect(isolationRefuses(help, "turn-other")).toBe(true);
    expect(isolationRefuses(help, undefined)).toBe(true);
    // before the provider names its turn nothing can be its own answer
    expect(isolationRefuses({ isolated: true }, "turn-help")).toBe(true);
    // an ordinary run, or no run: isolation refuses nothing
    expect(isolationRefuses({ providerTurnId: "turn-help" }, undefined)).toBe(false);
    expect(isolationRefuses(undefined, undefined)).toBe(false);
  });

  it("the own-card answer alone passes the waiting line (A-M3); nothing else bypasses it", () => {
    const index = source("index.ts");
    expect(index).toContain("const isolatedRunRefuses = (): boolean => isolationRefuses(directRuns.get(threadId), answer?.turnId);");
    expect(index).toContain("if ((sendStore.blockedByEarlier(threadId, row.seq) && !isolatedOwnAnswer()) || queuedStartPending(threadId)) {");
    expect(index.split("blockedByEarlier(").length - 1).toBe(1);
  });
});

describe("nothing joins an isolated run (9.2, tests 12 and 13)", () => {
  const admission = () => {
    const index = source("index.ts");
    const start = index.indexOf("function admitDirectSend(");
    return index.slice(start, index.indexOf("\nfunction drainQueuedSends()", start));
  };

  it("admission queues before any steer decision, and the fence predicate reads isolation first (test 12)", () => {
    const body = admission();
    const busy = body.indexOf("if (currentAtStart.busy) {");
    const queuedIsolated = body.indexOf("if (isolatedRunRefuses()) {", busy);
    expect(busy).toBeGreaterThan(0);
    expect(queuedIsolated).toBeGreaterThan(busy);
    expect(queuedIsolated).toBeLessThan(body.indexOf("const steerable =", busy));
    expect(queuedIsolated).toBeLessThan(body.indexOf("sendStore.markDispatched(row.seq)", busy));
    const holds = body.slice(body.indexOf("const steerSessionHolds = (): boolean => {"));
    expect(holds.split("\n").slice(1, 4).join("\n")).toContain("if (isolatedRunRefuses()) return false;");
    // the same predicate is the write fence's recheck
    expect(body).toMatch(/holds: steerSessionHolds,/);
    // after a refusal, a live run record (any phase) means wait, never start into thread_busy
    expect(body).toContain("if (!current.busy && !activeGroupTurnForBot(current.id) && !directRuns.get(threadId)) {");
  });

  it("the fence predicate refuses a steer once an isolated run took the thread before the write (test 12)", () => {
    const runs = new IndependentThreadRuns<object>();
    const ordinary = runs.admit("b1", "t1", {}, []);
    const holds = () => !isolationRefuses(runs.get("t1"), undefined);
    expect(holds()).toBe(true); // admitted into the ordinary run
    expect(runs.release(ordinary)).toBe(true);
    expect(runs.get("t1")).toBeUndefined();
    runs.admit("b1", "t1", {}, [], { isolated: true });
    expect(holds()).toBe(false); // the write is refused: the row is queued (dispatched cleared) and runs after the help turn
  });

  it("every production caller of steerWithQuoteLineage and steerBusyDesk reads the flag (test 13)", () => {
    const callers = (name: string) => ["index.ts", "steer-lineage.ts", "loop-nudge.ts", "project-card-executor.ts"]
      .flatMap((file) => source(file).split("\n").flatMap((line, at) => (line.includes(`${name}(`) && !/^\s*(export )?(async )?function /.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*") ? [`${file}:${at + 1}`] : [])));
    // one steer of owner words: the admission, whose holds read isolation (above)
    const lineage = callers("steerWithQuoteLineage");
    expect(lineage).toHaveLength(1);
    expect(lineage[0]).toMatch(/^index\.ts:/);
    // steerBusyDesk: the lineage steer (holds at its fence) and the loop nudge (its own isolation check and fence); nothing else
    const desk = callers("steerBusyDesk").map((at) => at.split(":")[0]).sort();
    expect(desk).toEqual(["loop-nudge.ts", "steer-lineage.ts"]);
    expect(source("steer-lineage.ts")).toContain("if (!opts.holds()) throw new Error(\"MEMORY_CONTEXT_REVOKED\");");
    const nudge = source("loop-nudge.ts");
    expect(nudge).toContain("|| deps.isolated(threadId)) return undefined;");
    expect(nudge).toContain("const fence = () => { if (deps.isolated(threadId)) throw new Error(\"STEER_ISOLATED_RUN\"); };");
    expect(source("index.ts")).toContain("isolated: (threadId) => directRuns.get(threadId)?.isolated === true,");
    // and no other server module (outside tests) calls either
    const others = (readdirSync(SERVER, { recursive: true }) as string[]).filter((file) => !file.includes("node_modules") && file.endsWith(".ts") && !file.includes(".test.") && !["index.ts", "steer-lineage.ts", "loop-nudge.ts", "project-card-executor.ts"].includes(file))
      .filter((file) => /\b(steerWithQuoteLineage|steerBusyDesk)\(/.test(source(file)));
    expect(others).toEqual([]);
  });
});

describe("the route (3.8 inventory row)", () => {
  it("noSteer is read only as `=== true`, never for a via line, and never asks for a typed stop", () => {
    const index = source("index.ts");
    // a Send again on a stored isolated row stays isolated without noSteer, so its "stop" is never a typed Stop (review r2 H1)
    expect(index).toContain("const isolated = !viaStanding && (body.noSteer === true || viaRow?.isolated === true);");
    expect(index).toContain("isolated ? { isolated: true, ownerActs: mayApprove(req, url) } : { typedStop: true, ownerActs: mayApprove(req, url) }");
    expect(index.split("body.noSteer").length - 1).toBe(1);
  });
});

describe("the turn-targeted Stop (slice 2 relies on it)", () => {
  // interruptDirectThread run on its own with fakes: the Stop names a provider turn, and it ends that turn only.
  const index = source("index.ts");
  const begin = index.indexOf("async function interruptDirectThread("), end = index.indexOf("\n/**", begin);
  const code = ts.transpileModule(index.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const harness = (run: { generation: string; providerTurnId?: string; phase: string }, onBrowser: () => void = () => {}) => {
    const interruptTurn = vi.fn(async () => ({ closeConfirmed: true }));
    const deps = { directRuns: { get: () => run, current: () => false, release: vi.fn() }, internalTurnOwners: new Map(), botForDirectThread: () => ({ modelSelection: { instanceId: "fake" } }),
      cancelDirectTurnDispatch: () => ({ phase: "dispatching" }), releaseBrowserCapabilityForThread: async () => { onBrowser(); },
      registry: { get: () => ({ adapter: { interruptTurn } }) }, closeOpenApprovals: vi.fn(), stopCloseConfirmed: () => true, store: { setTaskActivity: vi.fn() },
      stopEmailForTurn: vi.fn(async () => undefined), emailRuntime: {}, emailGeneration: () => 0 };
    const interrupt = new Function(...Object.keys(deps), code + "return interruptDirectThread;")(...Object.values(deps));
    return { interrupt, interruptTurn };
  };
  it("stops the named turn and says so; another turn, or a rebuild that began during the Stop, is left alone and reads stopped:false", async () => {
    const own = harness({ generation: "g1", providerTurnId: "turn-1", phase: "running" });
    await expect(own.interrupt("b", "t", "g1", undefined, "turn-1")).resolves.toBe(true);
    expect(own.interruptTurn).toHaveBeenCalledTimes(1);
    const other = harness({ generation: "g1", providerTurnId: "turn-2", phase: "running" });
    await expect(other.interrupt("b", "t", "g1", undefined, "turn-1")).resolves.toBe(false);
    expect(other.interruptTurn).not.toHaveBeenCalled();
    const run = { generation: "g1", providerTurnId: "turn-1", phase: "running" };
    const rebuilt = harness(run, () => { run.phase = "rebuilding"; run.providerTurnId = "turn-1"; });
    await expect(rebuilt.interrupt("b", "t", "g1", undefined, "turn-1")).resolves.toBe(false);
    expect(rebuilt.interruptTurn).not.toHaveBeenCalled();
    expect(index).toContain("stopped = await interruptDirectThread(bot.id, threadId, run.generation, undefined, body.turnId);");
    expect(index).toContain("return json(res, 200, { ok: true, stopped });");
  });
});

describe("turn state is keyed on the send, never on a turn id (MurageMain ruling, H3)", () => {
  // askTurnState run on its own with fakes; turn attribution is the real module, stamping the fake transcript.
  const index = source("index.ts");
  const begin = index.indexOf("function askTurnState("), end = index.indexOf("\nfunction queuedCancelState", begin);
  const code = ts.transpileModule(index.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const harness = () => {
    const line: { id: string; dispatchedIn?: string } = { id: "m1" };
    const rowsByTurn = new Map<string, { at: number }[]>();
    const sendRow: Record<string, unknown> = { kind: "bot", ownerId: "b1", status: "queued", dispatched: false };
    let run: { botId: string; generation: string; phase: string; providerTurnId?: string } | undefined;
    const turnAttribution = createTurnAttribution({ stamp: (_t, _m, turnId) => { line.dispatchedIn = turnId; } });
    const deps = {
      sendStore: { bySendId: (_t: string, sendId: string) => (sendId === "s1" ? sendRow : undefined) },
      store: { messageById: (_t: string, id: string) => (id === line.id ? line : undefined), turnRowsBounded: (_t: string, turnId: string) => rowsByTurn.get(turnId) ?? [] },
      directRuns: { get: () => run },
      turnAttribution,
    };
    const ask = new Function(...Object.keys(deps), code + "return askTurnState;")(...Object.values(deps)) as (b: string, t: string, s: string, hint?: string) => { state: string; endedAt?: number };
    return { line, rowsByTurn, sendRow, turnAttribution, ask, setRun: (next: typeof run) => { run = next; } };
  };
  it("a rebuild mid-answer gives the send a new turn: never \"ended\" until the replacement turn ends, whatever turnId is asked", () => {
    const h = harness();
    const state = (hint?: string) => h.ask("b1", "t1", "s1", hint).state;
    expect(state()).toBe("queued");
    // first attempt: admitted, fenced, accepted as turn-1, answer rows appear
    Object.assign(h.sendRow, { status: "started", dispatched: true, messageId: "m1" });
    h.setRun({ botId: "b1", generation: "g1", phase: "running" });
    h.turnAttribution.begin("g1", "t1", ["m1"]);
    h.turnAttribution.fencePassed("g1"); h.turnAttribution.accepted("g1", "turn-1");
    h.setRun({ botId: "b1", generation: "g1", phase: "running", providerTurnId: "turn-1" });
    h.rowsByTurn.set("turn-1", [{ at: 10 }]);
    expect(h.line.dispatchedIn).toBe("turn-1");
    expect(state("turn-1")).toBe("running");
    // turn-1 refused late and completes; its run is held for the rebuild: the old turn has rows, but the answer is still coming
    h.turnAttribution.completed("turn-1");
    // (holdForRebuild drops the provider turn)
    h.setRun({ botId: "b1", generation: "g1", phase: "rebuilding" });
    expect(state("turn-1")).not.toBe("ended");
    expect(state()).not.toBe("ended");
    // the rebuild takes the run over, not yet accepted: the line still names turn-1, the new attempt carries it
    h.setRun({ botId: "b1", generation: "g2", phase: "dispatching" });
    h.turnAttribution.begin("g2", "t1", ["m1"]);
    expect(state("turn-1")).toBe("running");
    // the engine hands turn-2 back before the fence (ACP, Codex): the run is bound to turn-2, the line still names turn-1 (H3)
    h.turnAttribution.accepted("g2", "turn-2");
    h.setRun({ botId: "b1", generation: "g2", phase: "running", providerTurnId: "turn-2" });
    expect(h.line.dispatchedIn).toBe("turn-1");
    expect(state("turn-1")).toBe("running");
    expect(state()).toBe("running");
    h.turnAttribution.fencePassed("g2");
    expect(h.line.dispatchedIn).toBe("turn-2");
    expect(state("turn-1")).toBe("running");
    // a run released with no rows of the replacement yet is not "ended" either
    h.turnAttribution.completed("turn-2");
    h.setRun(undefined);
    expect(state("turn-1")).toBe("unknown");
    // the replacement turn ended: now, and only now, "ended" with its newest row
    h.rowsByTurn.set("turn-2", [{ at: 20 }, { at: 30 }]);
    expect(h.ask("b1", "t1", "s1", "turn-1")).toEqual({ state: "ended", endedAt: 30 });
  });
  it("a later send's run does not hold an ended send; an unknown send or another bot's row is \"unknown\" even with a turnId", () => {
    const h = harness();
    Object.assign(h.sendRow, { status: "delivered", dispatched: true, messageId: "m1" });
    h.line.dispatchedIn = "turn-1"; h.rowsByTurn.set("turn-1", [{ at: 5 }]);
    h.turnAttribution.begin("g9", "t1", ["m9"]); h.turnAttribution.accepted("g9", "turn-9");
    h.setRun({ botId: "b1", generation: "g9", phase: "running", providerTurnId: "turn-9" });
    expect(h.ask("b1", "t1", "s1")).toEqual({ state: "ended", endedAt: 5 });
    expect(h.ask("b1", "t1", "nope", "turn-1").state).toBe("unknown");
    expect(h.ask("b2", "t1", "s1", "turn-1").state).toBe("unknown");
  });
});

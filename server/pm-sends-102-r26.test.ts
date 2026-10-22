// Round 26 (the fix round after DESIGN-r26): every guarantee that was a negative filter over data other code can also produce is now a positive capability only one
// module can produce, and the test of each forges the capability and shows the RUNTIME refuses it (the static analysis in handoff-dispatch.structure.test.ts is a lint).
//  1  provider provenance: only an engine's own reply (server/provider-reply.ts, minted once in the server's fold) proves a hand-off ran
//  2  a hand-off's request is found by its id, its row is never deleted while its request is live, and a plain starter never starts a partnered request
//  3  shared fairness is chosen by indexed seeks (never a sort of the queue), at most 100 decisions per pass, and no team starves
//  4  the start is a runtime capability: one minter, live tickets, prompts written only in the transaction that starts their row
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { closeDatabase, database } from "./database.ts";
import { DELEGATION_NOT_STARTABLE, _resetPending, handoffRow, queueDelegation, settleHandoffPair } from "./delegations.ts";
import { claimMinter, isDispatchToken, isLiveTicket } from "./handoff-capability.ts";
import { assertHandoffStartable, configureHandoffDispatch, dispatchHandoff, type HandoffTurnOptions } from "./handoff-dispatch.ts";
import { handoffOutputExists, OLD_OWNER_HANDOFF_GROUP, _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { noteHandoffEvidence } from "./handoff-evidence.ts";
import { recordOwnerDeletion } from "./owner-deletions.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { isProviderReply, providerReplyOf, type ProviderReply } from "./provider-reply.ts";
import { handoffRequest, markRequestDispatched, roomRequest } from "./room-requests.ts";
import { SHARED_DRAIN_DECISIONS, SHARED_FAIR_SQL, _lastDrainDecisions, drainSharedWork, enqueueSharedWork, nextSharedRequest, sharedRequestIsNext } from "./shared-work.ts";
import { fakeHost, rememberRun, runOf, writePrompt } from "./testing/handoff-turn.ts";
import { ownerWorld, sharedWorld, type OwnerWorld } from "./testing/handoff-worlds.ts";
import { engineReply, murageLineReply } from "./testing/provider-reply.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const serverDir = fileURLToPath(new URL(".", import.meta.url));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("timed out"); await tick(); }
}
const count = (sql: string, ...args: string[]) => Number((database().prepare(sql).get(...args) as { n: number }).n);
const rowOf = (id: string) => database().prepare("SELECT phase, origin, started_at, submitted_at, accepted_turn_id, start_attempts, target_thread_id, evidence_at FROM pending_delegations WHERE id=?").get(id) as Record<string, unknown> | undefined;

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); });
afterEach(() => { _resetOwnerMigration(); _resetPending(); closeDatabase(); });

function attach(w: OwnerWorld, steps: (turn: HandoffTurnOptions, text: string) => void | Promise<void>): void {
  configureHandoffDispatch({
    ...fakeHost(w.bus, () => {}, { stamp: false }),
    startTurn: async (_botId: string, text: string, turn: HandoffTurnOptions) => { rememberRun(turn.delegationRun); writePrompt(w.bus, turn.delegationRun, turn.threadId, text); await steps(turn, text); },
    noticeHeld: (notice) => { w.held.push({ id: notice.id, text: notice.text }); },
  }, { bus: w.bus, approvalBus: w.approvalBus });
}
const queued = (w: OwnerWorld, message = "do it once") => queueDelegation(w.bus, w.from, { toBotId: w.target.id, message, depth: 0 }, 2).id!;
const base = (threadId: string, turnId: string | undefined, provider: RuntimeEvent["provider"] = "claudeAgent") => ({ eventId: `e-${Math.random()}`, provider, threadId, createdAt: new Date().toISOString(), ...(turnId ? { turnId } : {}) });

function sources(dir: string = serverDir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

// ── 1 ─────────────────────────────────────────────────────────────────────────────────
describe("1. only an engine's own reply proves a hand-off ran", () => {
  const T = "thread-1", TURN = "turn-1";
  it("the minter marks the engine's reply text and tool start, and nothing else", () => {
    const text = { ...base(T, TURN), type: "item.completed", itemType: "assistant_text", origin: "engine", text: "hi" } as RuntimeEvent;
    const tool = { ...base(T, TURN), type: "item.started", itemType: "tool", origin: "engine", title: "Bash" } as RuntimeEvent;
    expect(isProviderReply(providerReplyOf(text))).toBe(true);
    expect(isProviderReply(providerReplyOf(tool))).toBe(true);
    const none: RuntimeEvent[] = [
      { ...base(T, TURN), type: "runtime.error", message: "spawn failed" },                                           // the Claude spawn-failure shape: a turn id, Murage's own line
      { ...base(T, TURN), type: "turn.retrying", attempt: 1, delayMs: 10, reason: "x" } as RuntimeEvent,
      { ...base(T, TURN), type: "item.completed", itemType: "assistant_text", origin: "murage", text: "cap note" },     // every Murage-origin emit
      { ...base(T, TURN), type: "item.started", itemType: "tool", origin: "murage", title: "Waking up" },
      { ...base(T, undefined), type: "item.completed", itemType: "assistant_text", origin: "engine", text: "no turn" },   // no turn
      { ...base(T, TURN), type: "item.started", itemType: "reasoning" },
      { ...base(T, TURN), type: "item.completed", itemType: "tool", ok: true },
      { ...base(T, TURN), type: "content.delta", streamKind: "assistant_text", delta: "x" },
    ];
    for (const event of none) expect(providerReplyOf(event), JSON.stringify(event)).toBeUndefined();
  });
  it("a marker is not a property any code can fake: a lookalike, a spread copy and a cast are not providers' replies", () => {
    const genuine = engineReply(T, TURN);
    expect(isProviderReply(genuine)).toBe(true);
    expect(isProviderReply({ ...genuine })).toBe(false);
    expect(isProviderReply({ threadId: T, turnId: TURN, eventId: "x" })).toBe(false);
    expect(isProviderReply(Object.create(Object.getPrototypeOf(genuine), Object.getOwnPropertyDescriptors(genuine)))).toBe(false);
    expect(isProviderReply(undefined)).toBe(false);
  });
  it("the Claude spawn-failure shape: a hand-off submitted, Murage's own error line carries the turn id, the callback fires: HELD, evidence NULL", async () => {
    const w = ownerWorld("owner");
    attach(w, (turn) => {
      turn.delegationRun.submitted();
      // what the fold does for runtime.error: a bot activity stamped with the event's turn id, written with the marker providerReplyOf gives it (none)
      const reply = providerReplyOf({ ...base(turn.threadId, "turn-spawn"), type: "runtime.error", message: "spawn failed" });
      w.store.appendMessage(turn.threadId, { role: "bot", kind: "activity", tool: { name: "error: spawn failed", ok: false }, turnId: "turn-spawn" }, undefined, undefined, reply);
      turn.onDispatchError("spawn failed");
    });
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(rowOf(id)).toMatchObject({ phase: "started", started_at: null, evidence_at: null });
    expect(handoffOutputExists(database(), id)).toBe(false);
    expect(w.held.map((notice) => notice.id)).toEqual([id]);
  });
  it("every Murage-origin line, a retry, a stop line and a row carrying provenance:'provider' but no marker are not evidence; a real reply WITHOUT the marker is held too", async () => {
    const w = ownerWorld("owner");
    attach(w, (turn) => {
      turn.delegationRun.submitted();
      const cap = murageLineReply(turn.threadId, "turn-1");
      w.store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: "a cap note", turnId: "turn-1" }, undefined, undefined, cap);
      w.store.appendMessage(turn.threadId, { role: "bot", kind: "activity", tool: { name: "retrying" }, turnId: "turn-1" });
      w.store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: "stopped", turnId: "turn-1", provenance: "provider" });   // (audit only: nothing reads it as proof)
      turn.onDispatchError("lost");
    });
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(rowOf(id)).toMatchObject({ phase: "started", started_at: null, evidence_at: null });
  });
  it("a genuine reply (text or a tool the engine started) that answers the prompt is evidence, for every driver's event shape", async () => {
    for (const provider of ["claudeAgent", "codex", "fuigo", "pi", "antigravity", "boxagent", "openai"] as const) {
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration();
      const w = ownerWorld("owner");
      attach(w, (turn) => {
        turn.delegationRun.submitted();
        const reply = providerReplyOf({ ...base(turn.threadId, "turn-p", provider as RuntimeEvent["provider"]), type: "item.started", itemType: "tool", origin: "engine", title: "Read" });
        w.store.appendMessage(turn.threadId, { role: "bot", kind: "activity", tool: { name: "Read" }, turnId: "turn-p" }, undefined, undefined, reply);
        turn.onDispatchError("lost");
      });
      const id = queued(w);
      await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
      expect(rowOf(id), provider).toBeUndefined();                                       // interrupted: it ran
    }
  });
  it("a marker for another thread or turn, and a reply that does not descend from the prompt, are not evidence", async () => {
    const w = ownerWorld("owner");
    attach(w, (turn) => {
      turn.delegationRun.submitted();
      w.store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: "other thread", turnId: "turn-a" }, undefined, undefined, engineReply("another-thread", "turn-a"));
      w.store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: "other turn", turnId: "turn-a" }, undefined, undefined, engineReply(turn.threadId, "turn-b"));
      w.store.appendMessage(turn.threadId, { role: "user", kind: "text", text: "and something else" });
      w.store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: "an answer to that", turnId: "turn-c" }, undefined, undefined, engineReply(turn.threadId, "turn-c"));
    });
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(rowOf(id)?.evidence_at).toBeNull();
  });
  it("a forged marker (a cast) throws and the write rolls back", async () => {
    const w = ownerWorld("owner");
    let thrown: unknown;
    attach(w, (turn) => {
      turn.delegationRun.submitted();
      try { w.store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: "forged", turnId: "t-1" }, "forged-1", undefined, { threadId: turn.threadId, turnId: "t-1", eventId: "e" } as unknown as ProviderReply); } catch (error) { thrown = error; }
    });
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(String(thrown)).toMatch(/PROVIDER_REPLY_FORGED/);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE id='forged-1'")).toBe(0);
    expect(rowOf(id)?.evidence_at).toBeNull();
    // and the evidence function itself refuses a lookalike
    expect(() => noteHandoffEvidence(database(), "t", { id: "m", role: "bot", turnId: "x", parentId: "dlg-1" }, { threadId: "t", turnId: "x", eventId: "e" } as unknown as ProviderReply)).toThrow(/PROVIDER_REPLY_FORGED/);
  });
  it("the minter is called in exactly one place in the server (the fold), the marker types are named only where they are handed on, and only the fold passes it to a write", () => {
    const callers: string[] = [];
    const namers: string[] = [];
    for (const file of sources()) {
      const rel = file.slice(serverDir.length).replace(/\\/g, "/"); // "/" on every platform, as the filters are written
      const text = readFileSync(file, "utf8");
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (/\bprovidera?ReplyOf\s*\(/.test(code.replace(/export function providerReplyOf/, ""))) callers.push(rel);
      if (/\b(ProviderReply|isProviderReply)\b/.test(code)) namers.push(rel);
    }
    expect(callers.filter((rel) => !rel.startsWith("testing/")).sort()).toEqual(["index.ts"]);
    expect(namers.filter((rel) => !rel.startsWith("testing/")).sort()).toEqual(["handoff-evidence.ts", "index.ts", "message-db.ts", "provider-reply.ts", "store.ts"]);
    const index = readFileSync(join(serverDir, "index.ts"), "utf8");
    expect(index.match(/providerReplyOf\(event\)/g)).toHaveLength(1);
    // the two rows that carry it: the engine's reply text and a tool the engine started
    expect(index).toContain("pushMessage({ role: \"bot\", kind: \"text\", text: shown, turnId: event.turnId }, before, reply);");
    expect(index.match(/\}, undefined, reply\);/g)).toHaveLength(1);
  });
  it("every emit of an engine reply or tool start in a driver chooses its origin, and the choice is the table's", () => {
    const expected: Record<string, { engine: number; murage: number }> = {
      "drivers/claude.ts": { engine: 3, murage: 4 }, "drivers/codex.ts": { engine: 3, murage: 4 }, "drivers/acp/core.ts": { engine: 2, murage: 6 } /* + the Ask stop notice (d612d17e0), Murage's own */,
      "drivers/pi.ts": { engine: 2, murage: 0 }, "drivers/antigravity.ts": { engine: 2, murage: 1 } /* the Ask stop notice (d612d17e0) */, "drivers/boxagent.ts": { engine: 2, murage: 1 }, "drivers/openai-chat.ts": { engine: 2, murage: 0 },
    };
    for (const [file, want] of Object.entries(expected)) {
      const text = readFileSync(join(serverDir, file), "utf8");
      const engine = (text.match(/origin: "engine"/g) ?? []).length, murage = (text.match(/origin: "murage"/g) ?? []).length;
      expect({ file, engine, murage }).toEqual({ file, ...want });
    }
  });
});

// ── 2 ─────────────────────────────────────────────────────────────────────────────────
describe("2. a hand-off's request is found by its id, and the pair is never split", () => {
  function plainShared(w: ReturnType<typeof sharedWorld>, id: string, key: string) {
    const inserted = enqueueSharedWork(w.store, { fromBotId: w.sales.id, sourceThreadId: w.sales.threadId, toBotId: w.iris.id, message: "plain", admissionKey: key, ownerAudience: true, now: 1, id });
    if (!inserted.ok) throw new Error(inserted.code);
    database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, target_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, w.sales.threadId, w.iris.id, w.sales.id, "fresh", null, JSON.stringify({ message: "plain", depth: 0, attempts: 0 }), "shared", `dlg-${id}`, inserted.request.targetThreadId);
    return inserted.request;
  }
  it("handoffRequest finds the request by id whatever its key is spelled like, and never an earlier build's stand-in record", () => {
    const w = sharedWorld();
    plainShared(w, "by-id", "a-plain-key");
    expect(handoffRequest(database(), "by-id")?.admissionKey).toBe("a-plain-key");
    expect(handoffRequest(database(), "nothing")).toBeNull();
    database().prepare("UPDATE room_requests SET group_id=? WHERE id='by-id'").run(OLD_OWNER_HANDOFF_GROUP);
    expect(handoffRequest(database(), "by-id")).toBeNull();
  });
  it("no production code finds a request by slicing or rebuilding the key of a hand-off (the key is spelled once, where the request is created)", () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const rel = file.slice(serverDir.length).replace(/\\/g, "/"); // "/" on every platform, as the filters are written
      if (rel.startsWith("testing/")) continue;
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, index) => {
        if (/\.slice\("ask:delegation:"\.length\)/.test(line) && !(rel === "index.ts" && /\.\.\.\(admissionKey\.startsWith/.test(line))) offenders.push(`${rel}:${index + 1}`);
        if (/roomRequestByKey\([^)]*`ask:delegation:\$\{/.test(line)) offenders.push(`${rel}:${index + 1} (by key)`);
        if (/export const HANDOFF_KEY/.test(line)) offenders.push(`${rel}:${index + 1} (HANDOFF_KEY)`);
      });
    }
    expect(offenders).toEqual([]);
  });
  it("deleting a hand-off's row directly while its request is live raises the trigger's error; after the request ends (or through settleHandoffPair) it goes", () => {
    const w = sharedWorld();
    plainShared(w, "pair-1", "k-1");
    expect(() => database().prepare("DELETE FROM pending_delegations WHERE id='pair-1'").run()).toThrow(/HANDOFF_PAIR_LIVE/);
    expect(rowOf("pair-1")).toBeDefined();
    for (const state of ["running", "waiting_owner", "waiting_bot"]) {
      database().prepare("UPDATE room_requests SET state=? WHERE id='pair-1'").run(state);
      expect(() => database().prepare("DELETE FROM pending_delegations WHERE id='pair-1'").run(), state).toThrow(/HANDOFF_PAIR_LIVE/);
    }
    database().prepare("UPDATE room_requests SET state='queued' WHERE id='pair-1'").run();
    settleHandoffPair("pair-1", { state: "cancelled", note: "test" });                      // ends the request and removes the row in one transaction
    expect(rowOf("pair-1")).toBeUndefined();
    expect(roomRequest(database(), "pair-1")).toMatchObject({ state: "cancelled", outcomeNote: "test" });
    plainShared(w, "pair-2", "k-2");
    database().prepare("UPDATE room_requests SET state='failed' WHERE id='pair-2'").run();
    database().prepare("DELETE FROM pending_delegations WHERE id='pair-2'").run();            // the request ended: nothing is lost
    expect(rowOf("pair-2")).toBeUndefined();
  });
  it("the trigger is part of the 1.0.2 manifest the downgrade drops, and so is the fairness index", () => {
    const w = sharedWorld(); void w;
    expect(count("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND name='pending_delegation_live_pair'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='index' AND name='room_requests_runnable_team'")).toBe(1);
  });
  it("markRequestDispatched refuses a request that has a hand-off row unless the dispatch's token is held (and only the dispatcher's minter makes one)", () => {
    const w = sharedWorld();
    plainShared(w, "tok-1", "k-tok");
    expect(markRequestDispatched(database(), "tok-1", { now: 5 })).toBe(false);
    expect(roomRequest(database(), "tok-1")!.state).toBe("queued");
    expect(markRequestDispatched(database(), "tok-1", { now: 5 }, { kind: "handoff-dispatch" })).toBe(false);          // a lookalike token is no token
    expect(isDispatchToken({ kind: "handoff-dispatch" })).toBe(false);
    // a request with no hand-off row is dispatched as ever
    const inserted = enqueueSharedWork(w.store, { fromBotId: w.sales.id, sourceThreadId: w.sales.threadId, toBotId: w.iris.id, message: "alone", admissionKey: "alone", ownerAudience: true, now: 1, id: "alone" });
    if (!inserted.ok) throw new Error(inserted.code);
    expect(markRequestDispatched(database(), "alone", { now: 5 })).toBe(true);
  });
  it("the plain starter never starts a partnered request: the shared drain hands it to the dispatch (one ticketed start), and a direct plain start is refused at run time", async () => {
    const w = sharedWorld();
    plainShared(w, "plain-9", "k-9");
    drainSharedWork(w.iris.id);
    await until(() => w.turns.length >= 1);
    expect(w.started).toEqual([]);
    expect(w.turns.map((turn) => turn.id)).toEqual(["plain-9"]);
    // the guard the server's plain starter and startTurn run first
    plainShared(w, "plain-10", "k-10");
    expect(() => assertHandoffStartable({ sharedWorkRun: { request: { id: "plain-10" } } })).toThrow(expect.objectContaining({ code: DELEGATION_NOT_STARTABLE }));
    // a wake (its own id, no hand-off row) is not refused
    expect(() => assertHandoffStartable({ sharedWorkRun: { request: { id: "wake-of-plain-10" } } })).not.toThrow();
    const source = readFileSync(join(serverDir, "index.ts"), "utf8");
    expect(source).toMatch(/start: \(request, claim\) => \{\n    \/\/[^\n]*\n    try \{ assertHandoffStartable\(\{ sharedWorkRun: \{ request \} \}\)/);
    expect(source).toMatch(/backupRestartAdmission\.assertOpen\(\);\n  assertHandoffStartable\(opts\);/);
  });
  it("the owner's deletion of the source conversation ends a live request in whatever state it is in, in the same commit that removes the row", () => {
    const w = sharedWorld();
    plainShared(w, "gone-1", "k-g1");
    database().prepare("UPDATE room_requests SET state='running' WHERE id='gone-1'").run();
    recordOwnerDeletion(database(), w.sales.threadId);
    expect(rowOf("gone-1")).toBeUndefined();
    expect(roomRequest(database(), "gone-1")).toMatchObject({ state: "cancelled", outcomeNote: "source-deleted" });
  });
  it("the queue's own removals (a discard of an unfinished turn's hand-offs) end the request with the row", () => {
    const w = sharedWorld();
    plainShared(w, "gone-2", "k-g2");
    settleHandoffPair("gone-2", { state: "cancelled", note: "the delegating turn did not finish" });
    expect(rowOf("gone-2")).toBeUndefined();
    expect(roomRequest(database(), "gone-2")!.state).toBe("cancelled");
  });
});

// ── 3 ─────────────────────────────────────────────────────────────────────────────────
describe("3. shared fairness is chosen by indexed seeks, bounded per pass, and no team starves", () => {
  const COLUMNS = "id,root_id,parent_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,payload_text,refusal,created_at,deadline_at,finished_at,root_thread_id,return_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key,execution_audience";
  function fill(db: DatabaseSync, rows: number, teams: number, bot = "b0"): void {
    const insert = db.prepare(`INSERT INTO room_requests(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'desktop','fp',0,0,?,?)`);
    db.exec("BEGIN");
    try {
      // shared work: each row has its provenance (r29: a team's FIFO is its shared rows, room_requests.shared_work, set from the provenance)
      const provenance = db.prepare("INSERT OR IGNORE INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')");
      for (let i = 0; i < rows; i++) provenance.run(`r-${i}`);
      for (let i = 0; i < rows; i++) insert.run(`r-${i}`, `r-${i}`, null, "g", "ask", "bot", bot, `tt${i}`, "queued", null, null, 1_000 + i, null, null, "t", null, `key-${i}`, JSON.stringify({ kind: "team", team: `T${String(i % teams).padStart(2, "0")}` }));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const planOf = (db: DatabaseSync, sql: string, args: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
  function rowsVisited(db: DatabaseSync, sql: string, args: unknown[]): number {
    let visited = 0;
    db.function("visit", (_rowid: unknown) => { visited++; return 1; });
    db.prepare(sql.replace(/\bWHERE /, "WHERE visit(rowid) AND ")).all(...(args as never[]));
    return visited;
  }
  it("100,000 queued requests over 50 teams: the team scan and the head seek use room_requests_runnable_team, and a decision reads a number of rows that follows the teams, not the queue", () => {
    const db = database(); initializeProjectTables(db);
    fill(db, 100_000, 50);
    expect(planOf(db, SHARED_FAIR_SQL.teams, ["b0", "b0"])).toMatch(/room_requests_runnable_team/);
    expect(planOf(db, SHARED_FAIR_SQL.head, ["b0", "T07", 0, ""])).toMatch(/USING (COVERING )?INDEX room_requests_shared_team/);   // r29: the team's shared rows
    expect(planOf(db, SHARED_FAIR_SQL.head, ["b0", "T07", 0, ""])).not.toMatch(/SCAN room_requests(?! USING)/);
    const teams = (db.prepare(SHARED_FAIR_SQL.teams).all("b0", "b0") as Array<{ team: string }>).map((row) => row.team);
    expect(teams).toHaveLength(50);
    expect(rowsVisited(db, SHARED_FAIR_SQL.head, ["b0", "T07", 0, ""])).toBe(1);
    const started = Date.now();
    const first = nextSharedRequest("b0");
    const elapsed = Date.now() - started;
    expect(first?.id).toBe("r-0");
    expect(elapsed).toBeLessThan(250);                                                       // (the old whole-queue sort took ~550 ms at this size)
    // the cost of the decision is the same at 1,000 rows: 50 teams, one head each
    const small = rowsVisited(db, SHARED_FAIR_SQL.teams, ["b0", "b0"]);
    expect(small).toBeLessThan(200);
  }, 300_000);
  it("no production code sorts the whole queue any more: sharedDispatchOrder (kept for the diagnostics and the older tests) is called by no module", () => {
    const callers: string[] = [];
    for (const file of sources()) {
      const rel = file.slice(serverDir.length).replace(/\\/g, "/"); // "/" on every platform, as the filters are written
      if (rel.startsWith("testing/") || rel === "shared-work.ts") continue;
      if (/\bsharedDispatchOrder\s*\(/.test(readFileSync(file, "utf8"))) callers.push(rel);
    }
    expect(callers).toEqual([]);
    const own = readFileSync(join(serverDir, "shared-work.ts"), "utf8");
    expect(own.match(/sharedDispatchOrder\s*\(/g)).toHaveLength(1);                         // its definition only: the drain and the owner's check use nextSharedRequest
  });
  it("an owner's drain page of 100 asks 'is it next?' without reading the queue", () => {
    const db = database(); initializeProjectTables(db);
    fill(db, 20_000, 10);
    const started = Date.now();
    for (let i = 0; i < 100; i++) sharedRequestIsNext(roomRequest(db, `r-${i * 7}`)!);
    expect(Date.now() - started).toBeLessThan(1500);
  }, 120_000);
  it("an older team's request goes before a newer team's, whichever arrived first in the table", () => {
    const w = sharedWorld();
    const older = w.handoff("old-b", w.support), newer = w.handoff("new-a", w.sales);
    database().prepare("UPDATE room_requests SET created_at=? WHERE id=?").run(1, older.id);
    database().prepare("UPDATE room_requests SET created_at=? WHERE id=?").run(5, newer.id);
    expect(nextSharedRequest(w.iris.id)?.id).toBe("old-b");
    expect(sharedRequestIsNext(roomRequest(database(), "new-a")!)).toBe(false);
    expect(sharedRequestIsNext(roomRequest(database(), "old-b")!)).toBe(true);
  });
  it("under constant arrivals every team gets a start within the number of ready teams: the team that last started goes to the back", () => {
    const w = sharedWorld();
    // team B (support) has ONE old request; team A (sales) keeps getting new ones, each older than B's by id order but newer by age
    const b = w.handoff("b-only", w.support);
    database().prepare("UPDATE room_requests SET created_at=100 WHERE id=?").run(b.id);
    const order: string[] = [];
    let at = 10;
    for (let round = 0; round < 40; round++) {
      const a = w.handoff(`a-${round}`, w.sales);
      database().prepare("UPDATE room_requests SET created_at=? WHERE id=?").run(at++, a.id);
      const next = nextSharedRequest(w.iris.id)!;
      order.push(next.id);
      database().prepare("UPDATE room_requests SET state='running', dispatched_at=? WHERE id=?").run(1000 + round, next.id);   // started
      database().prepare("UPDATE room_requests SET state='done', finished_at=? WHERE id=?").run(1000 + round, next.id);
      if (next.id === "b-only") break;
    }
    expect(order.indexOf("b-only")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("b-only")).toBeLessThanOrEqual(2);                                    // within the ready teams (2): never starved by A's stream
  });
  it("a pass makes at most 100 decisions, and the next pass resumes (setImmediate) when progress was made", async () => {
    const w = sharedWorld();
    const db = database();
    // 250 teams with a queued head each (r28: the drain decides teams, one head per team per pass; not shared work, so each waits after one look)
    fill(db, 250, 250, w.iris.id);
    drainSharedWork(w.iris.id);
    expect(_lastDrainDecisions()).toBe(SHARED_DRAIN_DECISIONS);
    await tick();
    expect(_lastDrainDecisions()).toBeLessThanOrEqual(SHARED_DRAIN_DECISIONS);
  });
});

// ── 4 ─────────────────────────────────────────────────────────────────────────────────
describe("4. the start is a runtime capability, so the static analysis only has to be a lint", () => {
  it("the minter was claimed by the dispatcher when it loaded: a second claim throws", () => {
    expect(() => claimMinter()).toThrow(/HANDOFF_MINTER_CLAIMED/);
  });
  it("a hand-off prompt written in a transaction that did not start its row rolls back, whoever wrote the callback; a row already started refuses a second prompt", async () => {
    const w = ownerWorld("owner");
    const id = queued(w);
    const thread = w.target.threadId;
    const prompts = () => count("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND id LIKE 'dlg-%'", thread);
    expect(() => w.store.appendMessage(thread, { role: "user", kind: "text", text: "forged" }, `dlg-${id}`, () => {})).toThrow(expect.objectContaining({ code: "HANDOFF_PROMPT_REFUSED" }));
    expect(() => w.store.appendMessage(thread, { role: "user", kind: "text", text: "forged" }, `dlg-${id}`)).toThrow(expect.objectContaining({ code: "HANDOFF_PROMPT_REFUSED" }));
    expect(prompts()).toBe(0);
    // the real start writes the prompt and moves the row in one commit
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(prompts()).toBe(1);
    expect(rowOf(id)).toMatchObject({ phase: "started" });
    // started already: a second prompt id is refused even with a callback that "starts" nothing
    expect(() => w.store.appendMessage(thread, { role: "user", kind: "text", text: "again" }, `dlg-${id}x`, () => {})).toThrow(expect.objectContaining({ code: "HANDOFF_PROMPT_REFUSED" }));
  });
  it("a ticket is live only while the dispatcher says so: a lookalike, a copy and a cleared ticket are all refused by the start's own check", async () => {
    const w = ownerWorld("owner");
    attach(w, () => {});
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    const real = runOf(id);
    const threadId = handoffRow(id)!.target_thread_id!;
    expect(isLiveTicket(real)).toBe(true);
    expect(() => assertHandoffStartable({ delegationRun: real, threadId, userMessage: { id: real.turnKey } })).not.toThrow();       // the same turn run again with its own prompt
    const lookalike = { id: real.id, turnKey: real.turnKey, start: real.start.bind(real), within: real.within.bind(real), submitted: () => {}, accepted: () => {} };
    expect(() => assertHandoffStartable({ delegationRun: lookalike })).toThrow(expect.objectContaining({ code: DELEGATION_NOT_STARTABLE }));
    expect(() => assertHandoffStartable({ delegationRun: Object.assign(Object.create(Object.getPrototypeOf(real)), real) })).toThrow(expect.objectContaining({ code: DELEGATION_NOT_STARTABLE }));
  });
  it("an already-started ticket may only run again with its own stored prompt as the turn's message, by value: no userMessage, undefined, another message or any spread order is refused", async () => {
    const w = ownerWorld("owner");
    attach(w, () => {});
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    const run = runOf(id);
    const threadId = handoffRow(id)!.target_thread_id!;
    expect(handoffRow(id)?.phase).toBe("started");
    expect(() => assertHandoffStartable({ delegationRun: run, threadId })).toThrow(expect.objectContaining({ code: DELEGATION_NOT_STARTABLE }));
    expect(() => assertHandoffStartable({ delegationRun: run, threadId, userMessage: undefined })).toThrow(expect.objectContaining({ code: DELEGATION_NOT_STARTABLE }));
    expect(() => assertHandoffStartable({ userMessage: undefined, threadId, delegationRun: run })).toThrow(expect.objectContaining({ code: DELEGATION_NOT_STARTABLE }));
    expect(() => assertHandoffStartable({ ...{ userMessage: { id: run.turnKey } }, ...{ delegationRun: run, threadId, userMessage: { id: "some-other-message" } } })).toThrow(expect.objectContaining({ code: DELEGATION_NOT_STARTABLE }));
    expect(() => assertHandoffStartable({ ...{ delegationRun: run }, threadId, userMessage: { id: run.turnKey } })).not.toThrow();
    expect(() => assertHandoffStartable({ userMessage: { id: run.turnKey }, threadId, delegationRun: run })).not.toThrow();
  });
  it("a plain turn (no run, no shared request) is never refused, and neither is a wake", () => {
    expect(() => assertHandoffStartable(undefined)).not.toThrow();
    expect(() => assertHandoffStartable({})).not.toThrow();
  });
  it("the memory redispatch literals in index.ts carry the turn's own prompt by value (the lint's reading, checked here against the source)", () => {
    const index = readFileSync(join(serverDir, "index.ts"), "utf8");
    expect(index.match(/\{ \.\.\.opts, threadId, userMessage, memoryRedispatch: attempt \}/g)).toHaveLength(2);
  });
});

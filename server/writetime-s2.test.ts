// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S2 of the write-time privacy lane (DESIGN-WRITETIME 2.2): the prompt and tool sinks record what they rest on.
//   hole 1  project read_messages: the lines whose words a page shows join the running turn as point carries (before: no parents);
//   hole 2  bring-in: what it brings joins the running turn, and the copy rests on the turn (before: judged only at read);
//   parts   working context, room transcripts and the skills index are prompt parts with their refs; buildPrompt adds them to the turn;
//   fence   the driver send types run the send fence before every engine write and refuse when a part may no longer be shown;
//   cost    read_messages costs the same statements and rows, and records the same number of refs, at 1,000 and 100,000 lines.
// S1's running turn and S4's predicate are S0 stubs at this point of the lane; memory/testing/fake-lineage.ts models them.
import { mkdirSync } from "node:fs";
import type { StatementSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

vi.mock("./memory/lineage-write.ts", async importOriginal => ({ ...(await importOriginal<object>()), ...(await import("./memory/testing/fake-lineage.ts")).fakeWrite }));
vi.mock("./memory/deny-read.ts", async importOriginal => ({ ...(await importOriginal<object>()), ...(await import("./memory/testing/fake-lineage.ts")).fakeRead }));

import { DATA_DIR } from "./config.ts";
import type { LineageRef } from "./memory/lineage-types.ts";
import type { MemoryRoster } from "./memory/policy.ts";
import type { Message } from "./store.ts";
import type { ProviderAdapter, SendTurnInput } from "./contracts.ts";
type ProviderAdapterLike = Pick<ProviderAdapter, "sendTurn" | "steer">;


// The modules under test are loaded after the mocks, from a fresh module graph: a module some earlier import already evaluated would keep
// the S0 stubs (vitest mocks only what is imported after vi.mock, and resetModules starts the graph again).
async function load() {
  vi.resetModules();
  const fake = await import("./memory/testing/fake-lineage.ts");
  const mods = await Promise.all([import("./database.ts"), import("./internal-capabilities.ts"), import("./message-db.ts"), import("./memory/authority.ts"),
    import("./memory/bring-in.ts"), import("./memory/capture.ts"), import("./memory/capture-scope.ts"), import("./memory/deny-read.ts"), import("./memory/policy.ts"),
    import("./memory/prompt-parts.ts"), import("./memory/repository.ts"), import("./project-memory-tools.ts"), import("./project-tool-routing.ts"),
    import("./project-settings.ts"), import("./room-transcript.ts"), import("./working-context.ts"), import("./drivers/engine-input.ts"), import("./skills.ts"), import("./memory/procedure-review.ts")]);
  return Object.assign({}, fake, ...mods) as typeof fake & typeof import("./database.ts") & typeof import("./internal-capabilities.ts") & typeof import("./message-db.ts")
    & typeof import("./memory/authority.ts") & typeof import("./memory/bring-in.ts") & typeof import("./memory/capture.ts") & typeof import("./memory/capture-scope.ts")
    & typeof import("./memory/deny-read.ts") & typeof import("./memory/policy.ts") & typeof import("./memory/prompt-parts.ts") & typeof import("./memory/repository.ts")
    & typeof import("./project-memory-tools.ts") & typeof import("./project-tool-routing.ts") & typeof import("./project-settings.ts") & typeof import("./room-transcript.ts")
    & typeof import("./working-context.ts") & typeof import("./drivers/engine-input.ts") & typeof import("./skills.ts") & typeof import("./memory/procedure-review.ts");
}
let M: Awaited<ReturnType<typeof load>>;
beforeAll(async () => { M = await load(); }, 120_000);

const NOW = 1_790_000_000_000;
type Roster = MemoryRoster & { bots: Array<MemoryRoster["bots"][number] & { name: string }> };
let roster: Roster;
beforeEach(() => {
  M.closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  M.fakeLineage.reset();
  roster = {
    bots: [
      { id: "dax", name: "Dax", threadId: "dax-direct", section: "Sales", tasks: [{ threadId: "dax-task" }, { threadId: "dax-desk", channelProjectDesk: { groupId: "launch" } }] },
      { id: "finch", name: "Finch", threadId: "finch-direct", section: "Ops" },
    ],
    groups: [{ id: "launch", threadId: "launch-chat", memberIds: ["dax", "finch"], channelProject: { goal: "Launch" }, tasks: [{ threadId: "launch-goal" }] }],
  };
  M.setMemoryCaptureRoster(() => roster);
  M.setMemoryMode("active");
  M.reconcileMemoryRoster(roster);
  M.channelToProjectRows(M.database(), { groupId: "launch", bulletin: "", leadBotId: "finch", now: NOW });
});
afterEach(() => { M.fakeLineage.reset(); heads.clear(); });

let n = 0;
/** The newest line of each thread: a line is said in reply to it (a line with another parent is a branch switch, which revokes the old head). */
const heads = new Map<string, string>();
function say(threadId: string, text: string, extra: Partial<Message> = {}) {
  const parentId = heads.get(threadId);
  const message = { id: `m${++n}`, role: "bot", kind: "text", text, at: NOW + n, from: { botId: "dax", name: "Dax", color: "blue" }, ...(parentId ? { parentId } : {}), ...extra } as Message;
  heads.set(threadId, message.id);
  M.appendMessage(threadId, message);
  return message;
}
const call = (consuming: string) => ({ db: M.database(), groupId: "launch", botId: "dax", role: "member" as const, request: { targetThreadId: consuming, rootThreadId: consuming } as never, memberIds: ["dax", "finch"], ownerAudience: true, now: NOW });
const lineIds = (refs: readonly LineageRef[]) => refs.filter(ref => ref.kind === "line").map(ref => (ref as { messageId: string }).messageId);

describe("hole 1: project read_messages records the lines it shows on the running turn", () => {
  it("a page of another thread adds a point carry for each line whose words it shows, and none for a withheld line", () => {
    M.registerProjectMemoryTools({ roster: () => roster, note: () => {} });
    const shown = say("launch-chat", "The price is 12.");
    const hidden = say("launch-chat", "WITHHELD_CANARY", { withheldFromBots: "forgotten" } as Partial<Message>);
    const owner = say("launch-chat", "Ship it Friday.", { role: "user", from: undefined });
    const turn = M.fakeLineage.open("dax-desk");
    const result = M.projectToolHandlers.get("read-messages")!(call("dax-desk"), {});
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toContain("WITHHELD_CANARY");
    expect(lineIds(turn.parents).sort()).toEqual([shown.id, owner.id].sort());     // owner lines too: any role joins the turn
    expect(lineIds(turn.parents)).not.toContain(hidden.id);
    expect(turn.parents.every(ref => ref.kind !== "line" || ref.threadId === "launch-chat")).toBe(true);
  });

  it("outside any turn (the owner's UI) nothing is recorded", () => {
    M.registerProjectMemoryTools({ roster: () => roster, note: () => {} });
    say("launch-chat", "hello");
    expect(M.projectToolHandlers.get("read-messages")!(call("dax-desk"), {}).status).toBe(200);
    expect(M.fakeLineage.added).toEqual([]);
  });

  it("a refused read records nothing and stands on nothing", () => {
    const turn = M.fakeLineage.open("dax-desk");
    const read = M.readProjectPage(M.database(), roster, "launch", { threadId: "finch-direct" }, { botId: "dax", threadId: "dax-desk" });
    expect(read.result.status).toBe(403);
    expect(M.readMessagesToolText("dax-desk", read).lineageOf).toEqual([{ kind: "none", reason: "murage" }]);
    expect(lineIds(turn.parents)).toEqual([]);
  });
});

function access(botId: string, thread: string) {
  const registry = new M.InternalCapabilities(); registry.begin(botId, thread, "g");
  const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false });
  return M.memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
function ownerFact(thread: string, text: string, key: string) {
  M.captureSource(M.database(), { id: `message:${thread}:${key}`, threadId: thread, messageId: key, kind: "text", speaker: "owner", outcome: "recorded", text });
  const id = M.saveMemoryCandidate(text, [{ sourceId: `message:${thread}:${key}`, revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], key, access("dax", thread));
  M.database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(id);
  return id;
}

describe("hole 2: bring-in adds what it brings to the running turn, and the copy rests on the turn", () => {
  it("a message: the original line and its source join the turn; the new record gets the turn's prefix carry", () => {
    const message = say("dax-direct", "Owner said: the launch party is on Friday at 6.", { role: "user", from: undefined });
    M.captureSource(M.database(), { id: `message:dax-direct:${message.id}`, threadId: "dax-direct", messageId: message.id, kind: "text", speaker: "owner", outcome: "recorded", text: message.text! });
    const turn = M.fakeLineage.open("dax-desk");
    const result = M.bringInToProject(M.database(), { groupId: "launch", roomThreadId: "launch-chat", botId: "dax", roster, now: NOW, sourceMessageId: message.id, turn });
    expect(result.ok).toBe(true);
    expect(turn.parents).toContainEqual({ kind: "line", threadId: "dax-direct", messageId: message.id });
    expect(turn.parents).toContainEqual({ kind: "memory", ref: { kind: "source", id: `message:dax-direct:${message.id}` } });
    const record = M.fakeLineage.records.get(`record:${(result as { recordId: string }).recordId}:1`);
    expect(record).toMatchObject({ thread: "dax-desk", lsn: turn.turnLsn });
    expect(record!.parents).toContainEqual({ kind: "line", threadId: "dax-direct", messageId: message.id });
  });

  it("a note: the record, each source it rests on and each line those sources captured join the turn", () => {
    const original = ownerFact("dax-direct", "Pricing rule: never below 12 a month.", "k1");
    const turn = M.fakeLineage.open("dax-desk");
    expect(M.bringInToProject(M.database(), { groupId: "launch", roomThreadId: "launch-chat", botId: "dax", roster, now: NOW, recordId: original, turn }).ok).toBe(true);
    expect(turn.parents).toContainEqual({ kind: "memory", ref: { kind: "record", id: original, version: 1 } });
    expect(turn.parents).toContainEqual({ kind: "memory", ref: { kind: "source", id: "message:dax-direct:k1" } });
    expect(turn.parents).toContainEqual({ kind: "line", threadId: "dax-direct", messageId: "k1" });
  });

  it("a refused bring-in records nothing", () => {
    const turn = M.fakeLineage.open("dax-desk");
    expect(M.bringInToProject(M.database(), { groupId: "launch", roomThreadId: "launch-chat", botId: "dax", roster, now: NOW, sourceMessageId: "nope", turn }).ok).toBe(false);
    expect(turn.parents).toEqual([]);
    expect(M.fakeLineage.records.size).toBe(0);
  });
});

describe("prompt-borne text is made of parts that name what they rest on", () => {
  it("working context: each quoted reply is a point carry, and the named cards and files ride along", () => {
    const part = M.workingContextPart("block", [{ threadId: "t1", messageId: "a" }, { threadId: "t1", messageId: "b" }, { threadId: "t2", messageId: "c" }],
      [{ kind: "memory", ref: { kind: "card", id: "c1" } }]);
    expect(part.lineageOf).toEqual([
      { kind: "line", threadId: "t1", messageId: "a" }, { kind: "line", threadId: "t1", messageId: "b" }, { kind: "line", threadId: "t2", messageId: "c" },
      { kind: "memory", ref: { kind: "card", id: "c1" } },
    ]);
    expect(M.workingContextPart("", []).lineageOf).toEqual([{ kind: "none", reason: "static" }]);
  });

  it("room transcript: the turn's own thread is positional; another thread carries each shown line, never a withheld one", () => {
    const messages = [{ id: "a" }, { id: "b" }, { id: "c" }] as Message[];
    expect(M.roomTranscriptPart("t", "room", "room", { messages, withheld: new Set(["b"]) }).lineageOf).toEqual([{ kind: "prefix", threadId: "room" }]);
    expect(lineIds(M.roomTranscriptPart("t", "room", "desk", { messages, withheld: new Set(["b"]) }).lineageOf)).toEqual(["a", "c"]);
  });

  it("skills index: each learned skill it lists rests on that skill; imported skills are the owner's material", () => {
    expect(M.skillsIndexRefs("dax", [{ name: "file-expense", source: "learn:conversation" }, { name: "imported", source: "https://example.com/skill" }]))
      .toEqual([{ kind: "memory", ref: { kind: "skill", id: "dax:file-expense" } }]);
    expect(M.skillsIndexRefs("dax", [{ name: "imported", source: "folder:/x" }])).toEqual([{ kind: "none", reason: "static" }]);
  });

  it("a procedure review's text rests on every piece of evidence its snapshot showed", () => {
    expect(M.procedureEvidenceRefs({ evidence: [
      { kind: "source", id: "message:t:m1", revision: 2, scopeId: "s1", text: "", speaker: "", outcome: "" },
      { kind: "record", id: "r1", revision: 3, scopeId: "s2", text: "", speaker: "", outcome: "" },
    ] })).toEqual([
      { kind: "memory", ref: { kind: "source", id: "message:t:m1", version: 2, scopeId: "s1" } },
      { kind: "memory", ref: { kind: "record", id: "r1", version: 3, scopeId: "s2" } },
    ]);
  });

  it("buildPrompt adds every part's refs to the running turn and keeps the turn's deny generation", () => {
    const turn = M.fakeLineage.open("dax-desk");
    const built = M.buildPrompt(turn, [M.promptPart("one", [{ kind: "line", threadId: "x", messageId: "1" }]), M.promptPart("two", [{ kind: "none", reason: "static" }])]);
    expect(built.text).toBe("one\n\ntwo");
    expect(built.denyGeneration).toBe(turn.denyGeneration);
    expect(turn.parents).toEqual([{ kind: "line", threadId: "x", messageId: "1" }, { kind: "none", reason: "static" }]);
  });
});

describe("the driver send types run the send fence before every engine write", () => {
  function adapter(): ProviderAdapterLike & { writes: string[] } {
    const writes: string[] = [];
    return {
      writes,
      sendTurn: async (input: SendTurnInput) => { input.beforeSubmit?.(); writes.push(input.text); return { turnId: "t" } as never; },
      steer: async (_thread: string, text: string, beforeWrite?: () => void) => { beforeWrite?.(); writes.push(text); return true; },
    };
  }
  const reader = { audience: { owner: true, scopeIds: [] } };

  it("unchanged deny generation: the prompt is written, the caller's own fence after ours", async () => {
    const generation = M.denyGeneration(M.database());
    expect(generation).toBeGreaterThanOrEqual(0);
    const turn = { ...M.fakeLineage.open("dax-direct"), denyGeneration: generation };
    const built = M.buildPrompt(turn, [M.promptPart("hello", [{ kind: "none", reason: "owner-turn" }])]);
    const engine = adapter(), order: string[] = [];
    await M.sendBuiltTurn(engine, { threadId: "dax-direct", prompt: built, beforeSubmit: () => order.push("caller") }, { db: M.database(), reader });
    expect(engine.writes).toEqual(["hello"]);
    expect(order).toEqual(["caller"]);
    expect(await M.steerBuilt(engine, "dax-direct", built, { db: M.database(), reader })).toBe(true);
    expect(engine.writes).toEqual(["hello", "hello"]);
  });

  it("a revoke since the prompt was built: the parts are looked up again, and anything not shown refuses the write", async () => {
    const generation = M.denyGeneration(M.database());
    const built = M.buildPrompt({ ...M.fakeLineage.open("dax-direct"), denyGeneration: generation }, [M.promptPart("quote", [{ kind: "line", threadId: "x", messageId: "1" }])]);
    M.database().prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
    const engine = adapter();
    await expect(M.sendBuiltTurn(engine, { threadId: "dax-direct", prompt: built }, { db: M.database(), reader })).rejects.toBeInstanceOf(M.EngineInputRevoked);
    await expect(M.steerBuilt(engine, "dax-direct", built, { db: M.database(), reader })).rejects.toMatchObject({ code: "MEMORY_CONTEXT_REVOKED" });
    expect(engine.writes).toEqual([]);
  });

  it("a prompt built outside any turn has no generation to trust: it is looked up, never taken as unchanged", async () => {
    const built = M.buildPrompt(undefined, [M.promptPart("x", [])]);
    expect(built.denyGeneration).toBe(-1);
    await expect(M.sendBuiltTurn(adapter(), { threadId: "dax-direct", prompt: built }, { db: M.database(), reader })).rejects.toBeInstanceOf(M.EngineInputRevoked);
  });
});

describe("cost: read_messages is flat in history", () => {
  function fill(count: number) {
    const db = M.database();
    const insert = db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)");
    db.exec("BEGIN");
    for (let index = 0; index < count; index++) {
      const id = `h${count}-${index}`;
      insert.run("launch-chat", id, NOW + index, "bot", "text", `line ${index}`, JSON.stringify({ id, role: "bot", kind: "text", text: `line ${index}`, at: NOW + index, from: { botId: "dax", name: "Dax" } }));
    }
    db.exec("COMMIT");
  }
  function measured(run: () => void): { statements: number; rows: number } {
    const db = M.database(), real = db.prepare.bind(db);
    let statements = 0, rows = 0;
    const counted = (statement: StatementSync) => new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "all") return (...args: never[]) => { statements++; const out = (value as (...a: never[]) => unknown[]).apply(target, args); rows += out.length; return out; };
      if (key === "get") return (...args: never[]) => { statements++; const out = (value as (...a: never[]) => unknown).apply(target, args); if (out !== undefined) rows++; return out; };
      if (key === "run") return (...args: never[]) => { statements++; return (value as (...a: never[]) => unknown).apply(target, args); };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    (db as unknown as { prepare: unknown }).prepare = (text: string) => counted(real(text));
    try { run(); } finally { (db as unknown as { prepare: unknown }).prepare = real; }
    return { statements, rows };
  }
  function turnOver(size: number) {
    fill(size);
    M.registerProjectMemoryTools({ roster: () => roster, note: () => {} });
    const turn = M.fakeLineage.open("dax-desk");
    const cost = measured(() => { expect(M.projectToolHandlers.get("read-messages")!(call("dax-desk"), { limit: 20 }).status).toBe(200); });
    return { ...cost, refs: turn.parents.length };
  }

  it("the same statements, rows and recorded refs at 1,000 and 100,000 lines", () => {
    const small = turnOver(1_000);
    M.closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    M.setMemoryMode("active"); M.reconcileMemoryRoster(roster);
    M.channelToProjectRows(M.database(), { groupId: "launch", bulletin: "", leadBotId: "finch", now: NOW });
    M.fakeLineage.reset();
    const large = turnOver(100_000);
    expect(small.refs).toBe(20);
    // rows and recorded refs are flat in history exactly; statements may differ by the one seek of the S6 retire gate (read-time-retired.ts), which a
    // file answers once and then remembers, so the first call on a connection can run one more than a later one
    expect(large.rows).toBe(small.rows);
    expect(large.refs).toBe(small.refs);
    expect(Math.abs(large.statements - small.statements)).toBeLessThanOrEqual(1);
  }, 300_000);

  it("the page is a keyset seek on the thread, never a scan of its history", () => {
    fill(1_000);
    const plan = (M.database().prepare(`EXPLAIN QUERY PLAN SELECT rowid, id, at, role, kind, text, json FROM messages WHERE thread_id=? AND rowid<?
      AND (kind='text' OR (kind='activity' AND json_extract(json,'$.actorKind')='murage')) ORDER BY rowid DESC LIMIT ?`).all("launch-chat", Number.MAX_SAFE_INTEGER, 21) as Array<{ detail: string }>).map(row => row.detail).join(" | ");
    expect(plan).toMatch(/USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY|SEARCH messages/);
    expect(plan).not.toMatch(/^SCAN messages$/);
  });
});

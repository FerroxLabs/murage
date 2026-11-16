import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { openerAt } from "../shared/bot-openers.ts";
import { sourced } from "./testing/bot-row.ts";
import {
  buildTurnContext,
  engineIsFresh,
  isMessageOnlyDispatch,
  isLegacyMessageOnlySession,
  markMessageOnlyDispatch,
  replaysTranscriptNatively,
  TRANSCRIPT_REPLAY_DRIVER_KINDS,
} from "./turn-context.ts";

const transcript = sourced([
  { role: "user" as const, text: "my dog is named Biscuit" },
  { role: "assistant" as const, text: "Noted — Biscuit." },
]);

describe("buildTurnContext", () => {
  it("words a session Murage restarted on the same engine as a restart, not a switch", () => {
    const restarted = buildTurnContext({ text: "next", transcript, rewound: false, fresh: true, sessionRestarted: true, externallyUpdated: false, replaysNatively: false });
    expect(restarted.resume).toBe(false);
    expect(restarted.turnText.startsWith("[Murage started a fresh engine session for this conversation; here is the conversation so far.]")).toBe(true);
    expect(restarted.turnText).not.toContain("switched over");
    expect(restarted.turnText.split("\n")[0]).not.toContain("\u2014");
    expect(restarted.turnText).toContain("User: my dog is named Biscuit");
    // a real engine switch keeps its own wording
    expect(buildTurnContext({ text: "next", transcript, rewound: false, fresh: true, externallyUpdated: false, replaysNatively: false }).turnText).toContain("switched over to you");
    // a rewind wins over a restart
    expect(buildTurnContext({ text: "next", transcript, rewound: true, fresh: true, sessionRestarted: true, externallyUpdated: false, replaysNatively: false }).turnText).toContain("rewound");
  });

  it("passes text through untouched on a plain resumed turn", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: false, externallyUpdated: false, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: true });
  });

  it("replays inline on rewind, exactly like the existing behaviour", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: true, fresh: false, externallyUpdated: false, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("rewound this conversation");
    expect(out.turnText).toContain("User: my dog is named Biscuit");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("replays inline for a fresh engine with prior history — the model-switch fix", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: true, externallyUpdated: false, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("joining this conversation");
    expect(out.turnText).not.toContain("rewound"); // distinct marker, distinct preamble
    expect(out.turnText).toContain("Assistant: Noted — Biscuit.");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("sends native replay metadata without duplicating transcript rows", () => {
    for (const flags of [
      { rewound: true, fresh: false, externallyUpdated: false },
      { rewound: false, fresh: true, externallyUpdated: false },
      { rewound: false, fresh: false, externallyUpdated: true },
    ]) {
      const out = buildTurnContext({ text: "hi", transcript, ...flags, replaysNatively: true });
      expect(out.turnText).toContain("do not restate");
      expect(out.turnText.endsWith("hi")).toBe(true);
      expect(out.turnText).not.toContain("Biscuit");
      expect(out.resume).toBe(false);
    }
  });

  it("does not wrap a fresh engine on an empty thread — nothing to replay", () => {
    const out = buildTurnContext({ text: "hi", transcript: [], rewound: false, fresh: true, externallyUpdated: false, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: false });
  });

  it("replays an out-of-band teammate result before the next user turn", () => {
    const updated = [
      ...transcript,
      ...sourced([{ role: "assistant" as const, text: "@Worker replied to the delegated task:\n\nfinished the report" }]),
    ];
    const out = buildTurnContext({
      text: "what did they find?",
      transcript: updated,
      rewound: false,
      fresh: false,
      externallyUpdated: true,
      replaysNatively: false,
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("received an update outside your provider session");
    expect(out.turnText).toContain("@Worker replied to the delegated task");
    expect(out.turnText.endsWith("what did they find?")).toBe(true);
  });
});

describe("engineIsFresh", () => {
  const withUser = transcript;
  // the real seeded opener, not a copy of one: pinning the sentence is how
  // this fixture went stale the last time the greeting changed
  const greetingOnly = sourced([{ role: "assistant" as const, text: openerAt(0, "Wren") }]);

  it("is false when the same instance ran the last turn and has a cursor", () => {
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: "claude", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(false);
  });

  it("is true when the same instance ran last but there is no cursor to resume", () => {
    expect(engineIsFresh({ instanceId: "pi", lastInstanceId: "pi", resumeCursors: {}, transcript: withUser })).toBe(true);
  });

  it("is true when another instance ran the last turn — even if this one has an older cursor", () => {
    // the user's bug: claude had a session from days ago, antigravity took the
    // latest turn, switching back to claude must NOT resume the stale session
    expect(
      engineIsFresh({ instanceId: "claude", lastInstanceId: "antigravity", resumeCursors: { claude: "old", antigravity: "s2" }, transcript: withUser }),
    ).toBe(true);
  });

  it("is true for an instance that has never run this thread", () => {
    expect(engineIsFresh({ instanceId: "codex", lastInstanceId: "claude", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
  });

  it("is false on a brand-new bot: the seeded greeting alone is nothing to join", () => {
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: {}, transcript: greetingOnly })).toBe(false);
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: {}, transcript: [] })).toBe(false);
  });

  it("legacy task without lastInstanceId: trusts a lone cursor for this instance, replays otherwise", () => {
    // one cursor, ours — pre-upgrade single-engine thread, keep resuming
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(false);
    // one cursor, someone else's — we never ran here
    expect(engineIsFresh({ instanceId: "codex", lastInstanceId: undefined, resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
    // two cursors — can't tell who ran last; replaying is the safe side
    expect(
      engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: { claude: "s1", antigravity: "s2" }, transcript: withUser }),
    ).toBe(true);
  });
});

// Memory refresh must preserve authorized replay without inventing an owner edit.
it("replays refreshed memory without claiming a user rewind", () => {
  const result = buildTurnContext({ text: "continue", transcript: sourced([{role: "user" as const, text: "prior request"}]), rewound: false, fresh: false, externallyUpdated: false, replaysNatively: false, memoryRefreshed: true });
  expect(result.resume).toBe(false);
  expect(result.turnText).toContain("authorized memory context was refreshed");
  expect(result.turnText).toContain("User: prior request");
  expect(result.turnText).not.toContain("The user rewound");
});

// W13: replaysNatively was hardcoded to "grok". It is not a property of xAI —
// it is a property of createOpenAIChatRuntime, which turns `turn.transcript`
// into chat `messages` on every turn. openai-compat and minimax were built on
// that same runtime and were never added, so on any context reset they got the
// branch twice: once as `messages` and once again embedded in the final user
// message. This reads the drivers rather than trusting a literal list.
describe("TRANSCRIPT_REPLAY_DRIVER_KINDS", () => {
  // Comments are stripped before matching, and only whole-line comments are
  // dropped so a URL's "//" survives. A previous source scan on this branch
  // matched prose and ended up enforcing the very claim it should have caught.
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

  it("names exactly the drivers built on createOpenAIChatRuntime", () => {
    const dir = fileURLToPath(new URL("./drivers/", import.meta.url));
    const found = new Set<string>();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.includes(".test.") || name === "openai-chat.ts") continue;
      const code = stripComments(readFileSync(join(dir, name), "utf8"));
      if (!code.includes("createOpenAIChatRuntime(")) continue;
      const kind = /const\s+DRIVER_KIND\s*=\s*"([^"]+)"/.exec(code)?.[1];
      expect(kind, `${name} calls createOpenAIChatRuntime but declares no DRIVER_KIND`).toBeTruthy();
      found.add(kind!);
    }
    expect(found.size).toBeGreaterThan(1);
    expect([...found].sort()).toEqual([...TRANSCRIPT_REPLAY_DRIVER_KINDS].sort());
  });

  it("stops a transcript-replay driver being sent the branch twice", () => {
    for (const kind of TRANSCRIPT_REPLAY_DRIVER_KINDS) {
      expect(replaysTranscriptNatively(kind)).toBe(true);
      const out = buildTurnContext({
        text: "hi", transcript, rewound: false, fresh: true,
        externallyUpdated: false, replaysNatively: replaysTranscriptNatively(kind),
      });
      expect(out.turnText, `${kind} embedded the branch in turnText as well`).not.toContain("Biscuit");
      expect(out.turnText).toContain("do not restate");
    }
    expect(replaysTranscriptNatively("claudeAgent")).toBe(false);
    expect(replaysTranscriptNatively("museCode")).toBe(true);
  });
});

// A memory rebuild resets the engine session before its prompt is built: the prompt must carry the authorized replay on the routes that
// read only turnText (Claude, Codex, ACP), and a dispatch that went out message-only must never leave a session later turns resume.
describe("memory rebuild context", () => {
  it("a refreshed rebuild replays the earlier conversation on the Claude, Codex and ACP routes", () => {
    for (const kind of ["claudeAgent", "codex", "customAcp"]) {
      expect(replaysTranscriptNatively(kind), kind).toBe(false);
      const out = buildTurnContext({ text: "latest", transcript, rewound: false, fresh: false, externallyUpdated: false, memoryRefreshed: true, replaysNatively: replaysTranscriptNatively(kind) });
      expect(out.resume, kind).toBe(false);
      expect(out.turnText, kind).toContain("User: my dog is named Biscuit");
      expect(out.turnText.endsWith("latest"), kind).toBe(true);
      // the warm decision alone is the defect: it resumes a session the rebuild already ended and sends the latest message alone
      expect(buildTurnContext({ text: "latest", transcript, rewound: false, fresh: false, externallyUpdated: false, memoryRefreshed: false, replaysNatively: false }).turnText).toBe("latest");
    }
  });

  it("marks only the message-only dispatch, by its running turn", () => {
    const messageOnly = {}, ordinary = {};
    markMessageOnlyDispatch(messageOnly);
    markMessageOnlyDispatch(undefined);
    expect(isMessageOnlyDispatch(messageOnly)).toBe(true);
    expect(isMessageOnlyDispatch(ordinary)).toBe(false);
    expect(isMessageOnlyDispatch(undefined)).toBe(false);
  });
});


describe("legacy message-only session recognition", () => {
  it.each([
    { name: "tier-two human input", expected: true },
    { name: "tier-two automated input", expected: true, line: "Murage left stored context out of this turn." },
    { name: "healthy tier-one rebuild", expected: false, line: "Murage left remembered details out of this reply." },
    { name: "note from another turn", expected: false, noteTurn: "other-turn" },
    { name: "later recovery note on a healthy session", expected: false, inputId: "later-input" },
    { name: "unmarked activity", expected: false, murageLine: false },
    { name: "missing starting output", expected: false, missingOutput: true },
    { name: "deleted latest input does not fall back to an older note", expected: false, deletedInput: true },
    { name: "deleted first lineage row does not walk to a later match", expected: false, deletedFirst: true },
    { name: "missing session lineage", expected: false, missingSession: true },
  ])("recognizes only a proven starting turn: $name", ({ expected, line, noteTurn, inputId, murageLine, missingOutput, missingSession, deletedInput, deletedFirst }) => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE memory_session_lineage(thread_id TEXT,driver_instance TEXT,native_session TEXT,first_lsn INTEGER,PRIMARY KEY(thread_id,driver_instance,native_session));
        CREATE TABLE memory_thread_no(thread_id TEXT PRIMARY KEY,no INTEGER);
        CREATE TABLE memory_line_lineage(thread_no INTEGER,lsn INTEGER,message_id TEXT,turn_lsn INTEGER,PRIMARY KEY(thread_no,lsn));
        CREATE INDEX memory_line_lineage_turn ON memory_line_lineage(thread_no,turn_lsn,lsn);
        CREATE TABLE messages(thread_id TEXT,id TEXT,role TEXT,json TEXT,PRIMARY KEY(thread_id,id));
        INSERT INTO memory_thread_no VALUES('chat',1);
        INSERT INTO memory_line_lineage VALUES(1,10,'input',NULL);`);
      if (!missingSession) db.exec("INSERT INTO memory_session_lineage VALUES('chat','engine','session',10)");
      db.prepare("INSERT INTO messages VALUES('chat','input','user','{}')").run();
      const id = `memory-note-${createHash("sha256").update("chat\0" + (inputId ?? "input")).digest("hex")}`;
      db.prepare("INSERT INTO messages VALUES('chat',?,'bot',?)").run(id, JSON.stringify({ role: "bot", kind: "activity", murageLine: murageLine ?? true, memoryNote: "without-memory", turnId: noteTurn ?? "first-turn", tool: { name: line ?? "Murage prepared this reply from your message, with remembered context left out." } }));
      if (!missingOutput) {
        db.exec("INSERT INTO memory_line_lineage VALUES(1,12,'reply',10)");
        db.prepare("INSERT INTO messages VALUES('chat','reply','bot',?)").run(JSON.stringify({ turnId: "first-turn" }));
      }
      if (deletedInput) db.exec("UPDATE memory_line_lineage SET lsn=9 WHERE message_id='input'; INSERT INTO memory_line_lineage VALUES(1,10,'deleted-input',NULL)");
      if (deletedFirst) db.exec("INSERT INTO memory_line_lineage VALUES(1,11,'deleted-output',10)");
      const reads: string[] = [], prepare = db.prepare.bind(db);
      db.prepare = (sql: string) => { if (sql.startsWith("SELECT")) reads.push(sql); return prepare(sql); };
      expect(isLegacyMessageOnlySession(db, "chat", "engine", "session")).toBe(expected);
      for (const sql of reads) {
        const plan = prepare("EXPLAIN QUERY PLAN " + sql).all(...Array((sql.match(/\?/g) ?? []).length).fill(1));
        expect(plan.map(row => row.detail).join("\n")).not.toMatch(/\bSCAN\b/);
      }
      expect(isLegacyMessageOnlySession(db, "chat", "other-engine", "session")).toBe(false);
      expect(isLegacyMessageOnlySession(db, "chat", "engine", "another-incarnation")).toBe(false);
    } finally { db.close(); }
  });
});

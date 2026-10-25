// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The reader door (LINEAGE-DESIGN-S6 section D): classification (rule 1), the viewer axis (15), the lineage judge (15a), ownFlag (15b),
// the carried content reader (15c), and the structural tests 18c and 18e.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { appendMessage, closeMessageDb, ClassificationViolation, insertMessage, isEngineOutput, readMessage, searchMessages, updateMessage } from "./message-db.ts";
import type { Message } from "./store.ts";
import { botMessages, botRowOf, botRows, botWindow, CHAIN_REFS, type BotRow, doorEgress, doorReader, fixedCopy, rowsShown, storedRowsShown, type Viewer } from "./bot-read.ts";
import { releaseStoredResult, type LineVerdictState } from "./result-egress.ts";
import { copyOriginUnavailable, copyOriginVerdict } from "./memory/replay-lineage.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { drainRevokeMarker } from "./memory/memory-revocation.ts";
import { storedAnswerText, type StoredAnswerDeps } from "./handoff-replay.ts";
import { BOT_VISIBLE_STATUS, botName, cardTitle, outboundWords, status, statusRecordOf, storedStatusShapeOk, type StatusKey } from "./murage-status.ts";
import { RowSink, writeActivityRow, writeBotRow } from "./bot-egress.ts";
import { mirrorActivity, mirrorMurageLine, mirrorReply, type CommsBus } from "./comms-visibility.ts";
import type { BotRecord, GroupRecord } from "./store.ts";
import { promptQuoteTargets } from "./prompt-quotes.ts";
import { isMurageVoice } from "./murage-voice.ts";
import { murageLine } from "./murage-line.ts";
import { contentReader, denyLookup } from "./memory/deny-read.ts";
import { copyChainCheck } from "./partition-sources.ts";
import { WritetimeFixture } from "./memory/testing/writetime-fixture.ts";
import { released } from "./testing/released.ts";
import { appendHandoffReply } from "./handoff-reply.ts";
import { criteriaClaimCorrection } from "./reply-speaker-guard.ts";
import { commitRevoke } from "./memory/revoke-commit.ts";
import { ROOM_REPLY_CHECKING, ROOM_REPLY_WITHHELD } from "./room-context.ts";
import type { TranscriptEntry } from "./turn-context.ts";
import type { ExternalUpdateMessage } from "./external-context-delivery.ts";
import { humanRow } from "./testing/bot-row.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { settleTestHandles } from "./test-handle-registry.ts";

const SERVER = import.meta.dirname;
function sources(dir = SERVER): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "node_modules" || name === "testing") continue;
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}
/** Code lines only: comment lines and trailing comments do not count. */
const codeLines = (text: string): Array<{ line: number; code: string }> => text.split("\n").map((code, i) => ({ line: i + 1, code: code.replace(/\s\/\/.*$/, "") }))
  .filter(({ code }) => !/^\s*(\/\/|\*|\/\*)/.test(code));

const owner = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text: `owner words ${id}`, at: Date.now(), ...extra });
const BOT: Viewer = { kind: "bot", botId: "bot-a" };
const HUMAN: Viewer = { kind: "human" };

// the WAL checkpointer's own connection leaves the file after closeDatabase returns (wal-maintenance.ts); Windows will not remove a file still open
async function reset(): Promise<void> { closeMessageDb(); closeDatabase(); await settleTestHandles(DATA_DIR); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); }
const TEMPLATE = `${DATA_DIR}.bot-read.db`;
beforeAll(async () => {
  await reset();
  new WritetimeFixture(database()).cert(true);
  appendMessage("warm-up", owner("w1"));
  database().exec("UPDATE memory_scopes SET audience='[]' WHERE json_type(audience)<>'array'");
  rmSync(TEMPLATE, { force: true });
  database().prepare("VACUUM INTO ?").run(TEMPLATE);
  await reset();
});
afterAll(async () => { await reset(); rmSync(TEMPLATE, { force: true }); });
beforeEach(async () => { await reset(); copyFileSync(TEMPLATE, join(DATA_DIR, "messages.db")); });

/** Every Murage-voice shape rule 1 names. */
const CLASSIFIED: Record<string, Message> = {
  murageLine: murageLine({ id: "m-line", role: "bot", kind: "text", text: "the engine said: secret", at: 1, turnId: "t1" }) as Message,
  actorKind: { id: "m-actor", role: "bot", kind: "text", text: "Murage words with secret", at: 1, actorKind: "murage" } as Message,
  offer: { id: "m-offer", role: "bot", kind: "text", text: "status secret", at: 1, murage: { kind: "status" } } as Message,
  routineRun: { id: "m-run", role: "bot", kind: "routine.run", text: "Completed secret", at: 1, routineRun: { runId: "r", routineId: "r", routineName: "secret", status: "completed" } } as Message,
  goalRun: { id: "m-goal", role: "bot", kind: "goal.run", text: "goal secret", at: 1 } as Message,
  ownerVoice: { id: "m-user", role: "user", kind: "text", text: "secret as Murage", at: 1, actorKind: "murage" } as Message,
};

describe("rule 1: one classification", () => {
  it("every shape rule 1 names is Murage-voice, and isEngineOutput agrees", () => {
    for (const [name, row] of Object.entries(CLASSIFIED)) {
      expect(isMurageVoice(row), name).toBe(true);
      expect(isEngineOutput(row), name).toBe(false);
      expect(isMurageVoice(JSON.parse(JSON.stringify(row))), `${name} from stored JSON`).toBe(true);
    }
    const reply: Message = { id: "r", role: "bot", kind: "text", text: "a reply", at: 1, turnId: "t" };
    expect(isMurageVoice(reply)).toBe(false);
    expect(isEngineOutput(reply)).toBe(true);
    for (const junk of [null, undefined, 3, "x", [], { murage: null }, { murageLine: "true" }, { kind: 7 }]) expect(isMurageVoice(junk)).toBe(false);
  });
  it("isEngineOutput calls the one definition", () => {
    const source = readFileSync(join(SERVER, "message-db.ts"), "utf8");
    expect(source).toMatch(/return !isMurageVoice\(message\);/);
    expect(source).not.toMatch(/MURAGE_KINDS/);
  });
});

describe("18c: the door returns nothing or a projection for every classified shape", () => {
  it("a bot viewer never reads a classified row's stored words; the human viewer reads it as stored", () => {
    const thread = "door-classified";
    const rows = Object.values(CLASSIFIED).map((row, i) => ({ ...row, id: `${row.id}-${i}`, at: Date.now() + i }));
    for (const row of rows) appendMessage(thread, row);
    const read = botRows(database(), BOT, thread, rows);
    for (const shown of read) {
      const stored = rows.find(row => row.id === shown.id)!;
      expect(shown.text).not.toContain("secret");
      expect(shown.text).not.toBe(stored.text);
    }
    expect(botRows(database(), HUMAN, thread, rows).map(row => row.text)).toEqual(rows.map(row => row.text ?? ""));
  });
  it("an unclassified owner row reads as stored for a bot, with its speaker from the record", () => {
    const thread = "door-owner";
    const row = owner("o1");
    appendMessage(thread, row);
    const [shown] = botRows(database(), BOT, thread, [row]);
    expect(shown?.text).toBe(row.text);
  });
});

describe("15b and 17: the door reads lineage verdicts, never the owner's note", () => {
  it("a stored \"checking\" (left on disk by an earlier process) is no note: a plain row and a copy read their live lineage verdict at the door (R2, rehearsal 4)", () => {
    // "checking" is never stored; one found on disk (1.0.2, a 1.0.3 process restarted before the drain) must not hold the row for good
    const thread = "door-noted";
    const row = { id: "n1", role: "bot", kind: "text", text: "NOTED_WORDS", at: Date.now(), parentId: "n-origin" } as Message;
    appendMessage(thread, owner("n-origin"));
    const copy = { id: "n2", role: "bot", kind: "text", text: "NOTED_COPY", at: Date.now(), parentId: "n1", copyOf: { threadId: thread, messageIds: ["n-origin"] } } as Message;
    appendMessage(thread, row);
    appendMessage(thread, copy);
    // the flag landed later, as a note does (a row appended already flagged is marked at write, which is the owner's own hide)
    database().prepare("UPDATE messages SET json=json_set(json,'$.withheldFromBots','checking') WHERE thread_id=? AND id IN ('n1','n2')").run(thread);
    row.withheldFromBots = "checking"; copy.withheldFromBots = "checking";
    const page = { threadId: thread, lines: [{ messageId: row.id, author: "generated" as const }, { messageId: copy.id, author: "generated" as const }] };
    expect(denyLookup(database(), page, doorReader()).get(row.id)).toEqual({ state: "shown" });
    expect(denyLookup(database(), page, doorReader()).get(copy.id)).toEqual({ state: "shown" });
    expect(botRows(database(), BOT, thread, [row, copy]).map(r => r.id)).toEqual([row.id, copy.id]);
  });
  it("the server never stores \"checking\" as a note: the write side keeps final verdicts only, and \"checking\" is read live (R2)", () => {
    const files = readdirSync(SERVER, { recursive: true }).map(String).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("testing/") && !f.includes("/testing/"));
    const hits = files.flatMap(file => codeLines(readFileSync(join(SERVER, file), "utf8"))
      .filter(({ code }) => /withheldFromBots\s*:\s*["']checking["']|["']checking["'] as const/.test(code)).map(h => `${file}:${h.line}`));
    expect(hits).toEqual([]);
  });
  it("ownFlag false skips the own-flag branch; the default reader keeps it", () => {
    const thread = "door-flag";
    const row = owner("f1", { withheldFromBots: true });
    appendMessage(thread, row);
    const page = { threadId: thread, lines: [{ messageId: row.id, author: "owner" as const }] };
    expect(denyLookup(database(), page, { audience: null }).get(row.id)).toEqual({ state: "withheld", reason: "own-flag" });
    expect(denyLookup(database(), page, doorReader()).get(row.id)?.state).toBe("shown");
    expect(botRows(database(), BOT, thread, [row]).map(r => r.id)).toEqual([row.id]);
  });
  it("rule 17: the door's code never reads the owner's note", () => {
    const hits = codeLines(readFileSync(join(SERVER, "bot-read.ts"), "utf8")).filter(({ code }) => /withheldFromBots/.test(code));
    expect(hits.map(h => `bot-read.ts:${h.line}`)).toEqual([]);
  });
  it("rule 17: a copy whose original carries only the owner's note is shown, by the door and its chain judge alike", () => {
    const thread = "door-note-copy";
    appendMessage(thread, owner("n-src", { withheldFromBots: true }));
    const copy = { id: "n-copy", role: "bot", kind: "text", text: "copied owner words", at: Date.now(), parentId: "n-src", copyOf: { threadId: thread, messageIds: ["n-src"] } } as Message;
    appendMessage(thread, copy);
    expect(botRows(database(), BOT, thread, [copy]).map(r => r.id)).toEqual(["n-copy"]);
    expect(botMessages(database(), BOT, thread, [copy]).map(r => r.id)).toEqual(["n-copy"]);
  });
  it("a copy of a row left flagged \"checking\" on disk reads shown at the door, its chain judge and the gate, never withheld or checking on that flag (Astra re-check item 6, R2)", () => {
    const thread = "door-held-copy";
    const source: Message = { id: "hc-src", role: "bot", kind: "text", text: "HELD_SOURCE_WORDS", at: Date.now(), withheldFromBots: "checking" };
    appendMessage(thread, source);
    const copy = { id: "hc-copy", role: "bot", kind: "text", text: "HELD_SOURCE_WORDS", at: Date.now(), parentId: "hc-src", copyOf: { threadId: thread, messageIds: ["hc-src"] } } as Message;
    appendMessage(thread, copy);
    const owner = { audience: { owner: true, scopeIds: [] }, ownerOwnChat: true };
    const states = new Map<string, LineVerdictState>();
    const rows = botRows(database(), BOT, thread, [copy], { ...owner, states });
    expect(states.get("hc-copy")).toBe("shown");
    expect(rows.map(r => r.text).join("\n")).toContain("HELD_SOURCE_WORDS");
    expect(rows.map(r => r.text).join("\n")).not.toContain(ROOM_REPLY_CHECKING);
    // the gate's door answer and the copy-origin chain probe judge live too: the stale flag is no note
    expect(doorEgress(database)("bot-a", thread, ["hc-copy"], false)).toBe("shown");
    expect(copyOriginUnavailable(thread, "hc-src")).toBe(false);
  });
  it("before any line lineage exists, a copy whose original carries only a stale checking flag reads as no note, never a mark (Astra final item 2, R2)", () => {
    const thread = "door-held-nolineage";
    appendMessage(thread, { id: "nl-src", role: "bot", kind: "text", text: "NL_WORDS", at: Date.now(), withheldFromBots: "checking" } as Message);
    database().exec("DELETE FROM memory_line_lineage"); // a file no lineage row was written on yet: the chain judge skips the verdicts (rule 29)
    expect(copyOriginVerdict(LineageAllowance.tool(), { threadId: thread, messageIds: ["nl-src"] })).toEqual({ withheld: false, unproven: false });
    // a real flag on the original is a mark: withheld and proven
    database().prepare("UPDATE messages SET json=json_set(json,'$.withheldFromBots',json('true')) WHERE thread_id=? AND id='nl-src'").run(thread);
    expect(copyOriginVerdict(LineageAllowance.tool(), { threadId: thread, messageIds: ["nl-src"] })).toEqual({ withheld: true, unproven: false });
  });
  it("a copy of a checking source and a withheld source reads withheld in either order: every source is judged (Astra final item 3)", () => {
    const thread = "door-mixed-copy";
    appendMessage(thread, { id: "mx-held", role: "bot", kind: "text", text: "MX_HELD", at: Date.now(), withheldFromBots: "checking" } as Message);
    appendMessage(thread, { id: "mx-src", role: "bot", kind: "text", text: "MX_GONE", at: Date.now() } as Message);
    commitRevoke(database(), { kind: "line", threadId: thread, messageIds: ["mx-src"], cause: "hide" });
    drainRevokeMarker(database());
    const owner = { audience: { owner: true, scopeIds: [] }, ownerOwnChat: true };
    for (const [id, order] of [["mx-copy-a", ["mx-held", "mx-src"]], ["mx-copy-b", ["mx-src", "mx-held"]]] as const) {
      const copy = { id, role: "bot", kind: "text", text: "MX", at: Date.now(), copyOf: { threadId: thread, messageIds: [...order] } } as Message;
      appendMessage(thread, copy);
      const states = new Map<string, LineVerdictState>();
      const rows = botRows(database(), BOT, thread, [copy], { ...owner, states });
      expect(states.get(id)).toBe("withheld");
      expect(rows.map(r => r.text).join("\n")).not.toContain(ROOM_REPLY_CHECKING);
      expect(doorEgress(database)("bot-a", thread, [id], false)).toBe("withheld");
    }
  });
  it("a copy whose chain is only checking but which carries a real mark of its own reads withheld (Astra final item 3)", () => {
    const thread = "door-marked-copy";
    appendMessage(thread, { id: "mk-src", role: "bot", kind: "text", text: "MK_HELD", at: Date.now(), withheldFromBots: "checking" } as Message);
    const copy = { id: "mk-copy", role: "bot", kind: "text", text: "MK", at: Date.now(), copyOf: { threadId: thread, messageIds: ["mk-src"] } } as Message;
    appendMessage(thread, copy);
    commitRevoke(database(), { kind: "line", threadId: thread, messageIds: ["mk-copy"], cause: "hide" });
    drainRevokeMarker(database());
    const states = new Map<string, LineVerdictState>();
    const rows = botRows(database(), BOT, thread, [copy], { audience: { owner: true, scopeIds: [] }, ownerOwnChat: true, states });
    expect(states.get("mk-copy")).toBe("withheld");
    expect(rows.map(r => r.text).join("\n")).not.toContain(ROOM_REPLY_CHECKING);
    expect(doorEgress(database)("bot-a", thread, ["mk-copy"], false)).toBe("withheld");
  });
  it("a gone row is withheld whatever the judge", () => {
    const page = { threadId: "door-none", lines: [{ messageId: "missing", author: "generated" as const }] };
    expect(denyLookup(database(), page, doorReader()).get("missing")?.state).toBe("withheld");
  });
});

describe("15a: the copy chain judge", () => {
  it("one judge, the lineage judge: a source with only the owner's note passes, a missing source fails", () => {
    const thread = "door-chain";
    appendMessage(thread, owner("src", { withheldFromBots: true }));
    const copy = { threadId: thread, messageIds: ["src"] };
    expect(copyChainCheck(database())(copy)).toBe(true);
    expect(copyChainCheck(database())({ threadId: thread, messageIds: ["absent"] })).toBe(false);
  });
  it("the owner-note judge and the readers that kept it are deleted", async () => {
    const text = readFileSync(join(SERVER, "partition-sources.ts"), "utf8");
    const code = codeLines(text).map(({ code }) => code).join("\n");
    expect(code).not.toMatch(/owner-note|withheldFromBots|CopyChainJudge/);
    const module = await import("./partition-sources.ts");
    for (const name of ["copyChainPresent", "partitionTranscriptMessages", "partitionTranscriptWindow"]) expect(module, name).not.toHaveProperty(name);
  });
});

describe("15c: the judge is carried, never rebuilt", () => {
  it("contentReader keeps the reader's ownFlag", () => {
    expect(contentReader({ audience: { owner: true, scopeIds: [] } })).toEqual({ audience: null, ownFlag: true });
    expect(contentReader(doorReader())).toEqual({ audience: null, ownFlag: false });
  });
});

describe("18e: viewer and judge literals", () => {
  /** The files that may write the human viewer literal: the door's own type and the owner's routes (filled in as they move to the door). */
  // a file mapped to a pattern may hold the literal only on a line matching it: project-memory-tools.ts's owner page route (OWNER_PAGE)
  const HUMAN_ALLOW = new Map<string, RegExp | null>([["bot-read.ts", null], ["project-memory-tools.ts", /const ownerPageViewer = \(\): Viewer => \(\{ kind: "human" \}\);/]]);
  it("a human viewer literal appears only in the allowlist", () => {
    expect(statSync(join(SERVER, "bot-read.ts")).isFile()).toBe(true);
    const found: string[] = [];
    for (const file of sources()) {
      const rel = relative(SERVER, file).replace(/\\/g, "/"); // the allow list is written with "/"
      if (HUMAN_ALLOW.get(rel) === null) continue;
      const only = HUMAN_ALLOW.get(rel);
      for (const { line, code } of codeLines(readFileSync(file, "utf8"))) if (/kind:\s*["']human["']/.test(code) && !only?.test(code)) found.push(`${rel}:${line}`);
    }
    expect(found, "only the owner's HTTP and UI routes pass the human viewer").toEqual([]);
  });
  it("deny-read.ts derives a content reader only through contentReader", () => {
    const text = readFileSync(join(SERVER, "memory", "deny-read.ts"), "utf8");
    const hits = codeLines(text).filter(({ code }) => /audience:\s*null/.test(code));
    const body = /export function contentReader\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(text)?.[1] ?? "";
    expect(body).toMatch(/audience:\s*null/);
    expect(hits.length, hits.map(h => `deny-read.ts:${h.line}`).join(", ")).toBe(1);
  });
});

describe("rule 2: classification is sticky by verdict", () => {
  it("a write that would unclassify a stored Murage-voice row throws before SQL, for every classified shape", () => {
    const thread = "sticky";
    for (const row of Object.values(CLASSIFIED)) {
      appendMessage(thread, row);
      const plain = { id: row.id, role: row.role, kind: "text", text: "now a plain reply", at: row.at } as Message;
      expect(() => updateMessage(thread, plain), row.id).toThrow(ClassificationViolation);
      expect(() => insertMessage(thread, plain), row.id).toThrow(ClassificationViolation);
      expect(readMessage(thread, row.id)?.text, row.id).toBe(row.text);
    }
  });
  it("the held-queue update keeps actorKind and stays classified; an unclassified row may become classified", () => {
    const thread = "sticky-held";
    const held = { id: "held", role: "bot", kind: "activity", at: 1, actorKind: "murage", tool: { name: "2 items wait", ok: true }, murage: { kind: "queue", held: { count: 2 } } } as Message;
    appendMessage(thread, held);
    updateMessage(thread, { ...held, tool: { name: "1 item waits", ok: true }, murage: { kind: "queue", held: { count: 1 } } });
    expect(readMessage(thread, "held")?.tool?.name).toBe("1 item waits");
    appendMessage(thread, owner("plain"));
    updateMessage(thread, { ...owner("plain"), actorKind: "murage" });
    expect(isMurageVoice(readMessage(thread, "plain"))).toBe(true);
  });
});

describe("16: every bot-facing read goes through the door", () => {
  it("a quote target, a search hit and a room window never carry a Murage-voice row to a bot", () => {
    const thread = "door-wired";
    const rows = Object.values(CLASSIFIED).map((row, i) => ({ ...row, id: `${row.id}-w${i}`, at: 100 + i }));
    for (const row of rows) appendMessage(thread, row);
    appendMessage(thread, owner("o-secret", { text: "owner secret line", at: 200 }));
    const quotes = promptQuoteTargets({ messageById: (t, id) => readMessage(t, id) ?? undefined }, database(), "bot-a", thread, true);
    for (const row of rows) expect(quotes.get(row.id), row.id).toBeUndefined();
    expect(quotes.get("o-secret")?.text).toBe("owner secret line");
    const hits = searchMessages("secret", 40, thread).map(hit => hit.messageId);
    expect(hits).toEqual(["o-secret"]);
    expect(searchMessages("secret", 40, thread, { owner: true }).map(hit => hit.messageId).sort()).toEqual([...rows.filter(row => row.kind === "text").map(row => row.id), "o-secret"].sort());
    const window = botWindow(database(), BOT, thread, [...rows, readMessage(thread, "o-secret")!], () => false, 600);
    expect(window.window.map(row => row.id)).toEqual(["o-secret"]);
  });
  it("no bot-facing renderer labels a row Murage or reads the transcript outside the door", () => {
    for (const file of ["index.ts", "project-memory-tools.ts"]) {
      const text = readFileSync(join(SERVER, file), "utf8");
      expect(text, file).not.toMatch(/actorKind === "murage" \? "Murage"/);
    }
    expect(readFileSync(join(SERVER, "project-memory-tools.ts"), "utf8")).not.toMatch(/json_extract\(json,'\$\.actorKind'\)='murage'/);
    const found: string[] = [];
    for (const file of sources()) {
      const rel = relative(SERVER, file).replace(/\\/g, "/"); // "/" on every platform
      if (rel === "bot-read.ts") continue;
      for (const { line, code } of codeLines(readFileSync(file, "utf8"))) if (/partitionTranscript(Messages|Window)\b/.test(code)) found.push(`${rel}:${line}`);
    }
    expect(found, "read a transcript through botRows, botMessages or botWindow").toEqual([]);
  });
});

/** 18a: the files that read stored rows directly, and how many reads each holds. Every bot-facing read is behind the door (bot-read.ts); the
 * rest are the owner's routes, writers, the lineage judge's own facts, storage and migration. A new read, or a new file, fails here: route it
 * through botRows, or review it and raise the count. A count that falls must fall here too, so the list never hides a gap.
 * Reviewed on the combined lineage (int 50856780e), none bot-facing:
 * - memory/past-chats-build.ts 2: storedHead and readerHeadOnBranch read only a thread's head id and two rowids for the owner's past-chats
 *   memory build (no text, no bot reader; rule 22 keeps Murage lines out of its queue).
 * - message-db.ts, int's seq order (ROOM-ORDER-DESIGN r7 R2): readThread's two statements (numbered or legacy order), the six PAGE_SQL page
 *   reads (seq and rowid keys) and the branch walk's next-row read. They are the store's own loaders under Store.messagesFor and the page
 *   reads; every bot-facing caller reads their rows through botRows. */
const RAW_READS: Record<string, number> = {
  "backup-waiting.ts": 1, "bot-egress.expect-errors.ts": 2, "boundary-ports.ts": 9, "branch-fill.ts": 5, "branch-index.ts": 7, "branch-store.ts": 4,
  "browser-extension-approvals.ts": 3, "browser-extension-setup.ts": 1, "card-summary.ts": 3, "conversation-deletion.ts": 3,
  // 1.0.4 QW Q4 (0bc0c7c28): findWidget reads the one row whose id is the widget id, in the calling turn's own thread, and only while it holds
  // that widget (the WidgetStore interface line counts as the second). update_widget answers the bot with ids and a fixed line, never the row.
  "chat-widgets.ts": 2,
  // frozen-replies.ts (the boot recovery's scan and the rows it judges), handoff-reply.ts and held-replies.ts (an earlier build's held row, retired),
  // index.ts (the retired hold's result row), boundary-ports.ts (a shared request's closing row, terminalFor): server-side reads, never handed to a bot
  "frozen-replies.ts": 5,
  "handoff-boundary.ts": 1, "handoff-dispatch.ts": 1, "handoff-evidence.ts": 1, "handoff-reply.ts": 1, "harness/event-log.ts": 5, "held-replies.ts": 1, "host-computer-consent.ts": 1,
  "human-principals.ts": 1, "image-operations.ts": 2, "inbox-fill-worker.ts": 1, "inbox.base-reference.ts": 4, "inbox.legacy-reference.ts": 1,
  // 1.0.4 QW (20acb3e0d): roomAnswerReceipt reads the owner's own landed answer row back for the owner's client (the room answer's receipt)
  "inbox.ts": 6, "index.ts": 75, "installation-activation.ts": 1, "installation-database-snapshot.ts": 6, "installation-restore-preparation.ts": 1,
  // 1.0.4: index.ts adds the limit-failover resend (the owner's own user row, through acceptBotSend), the turn's sendIds, and the two owner-only MCP card routes
  // (dismissMcpCards, mcp-enable-cards); mcp-bot-cards.ts reads only the ids of open cards. None hands a stored row to a bot.
  "mcp-bot-cards.ts": 2, "mcp-signin-card.ts": 1, "memory/branch-change.ts": 3, "murage-anchor.ts": 1, "memory/bring-in.ts": 1, "memory/capture.ts": 3, "memory/deny-read.ts": 1,
  "memory/evolution-forgetting.ts": 1, "memory/learning-wiring.ts": 2, "memory/lineage-backfill.ts": 9, "memory/lineage-warm.ts": 2,
  "memory/memory-moments.ts": 5, "memory/outcomes.ts": 4, "memory/past-chats-build.ts": 2, "memory/pip-reflect.ts": 2, "memory/policy.ts": 1, "memory/replay-lineage.ts": 6,
  "memory/restore.ts": 1, "memory/reveal-capture.ts": 1, "memory/schema.ts": 1, "memory/upgrade-counts.ts": 2, "message-db.ts": 47,
  "message-search-index.ts": 7, "message-tables.ts": 6, "message-walker.ts": 2, "partition-sources.ts": 2, "peer-approval.ts": 1,
  "project-digest.ts": 2, "project-goals.ts": 1, "project-memory-tools.ts": 4, "project-routes.ts": 1, "project-tools.ts": 1, "prompt-quotes.ts": 2,
  "publish/publish-ops.ts": 4, "room-turn-rows.ts": 3, "setup-thread-facts.ts": 1, "steer-queue.ts": 1, "storage-attachments.ts": 1, "store.ts": 6, "transcript-backfill.ts": 11, "transcript-seq.ts": 6,
  "turn-source-holds.ts": 6, "working-context.ts": 5,
};

describe("18a: raw reads of stored rows only in the allowlist", () => {
  it("every FROM messages, messageById, scanSince and rowsSince outside the door is counted in RAW_READS", () => {
    const counts: Record<string, number> = {};
    for (const file of sources()) {
      const rel = relative(SERVER, file).replace(/\\/g, "/"); // '/' on every platform, as RAW_READS is written
      if (rel === "bot-read.ts") continue;
      let n = 0;
      for (const { code } of codeLines(readFileSync(file, "utf8"))) n += (code.match(/FROM messages\b|messageById\(|scanSince\(|rowsSince\(/g) ?? []).length;
      if (n) counts[rel] = n;
    }
    expect(counts).toEqual(RAW_READS);
  });
});

/** A stored Murage status row as the sinks write it (rule 11): stored words that must never reach a bot, and the status beside them. */
const statusRow = (id: string, murage: unknown, at = 1): Message => ({ id, role: "bot", kind: "activity", tool: { name: `stored secret words ${id}`, ok: true }, actorKind: "murage", murage, at } as Message);

describe("rule 14: BOT_VISIBLE_STATUS", () => {
  it("is exactly the ten keys, and a row can keep every one of them", () => {
    expect([...BOT_VISIBLE_STATUS].sort()).toEqual(["call_ended", "card_result_line", "checking", "criteria_claim_corrected", "no_answer_check_timed_out", "no_answer_checking", "request_finished", "result_unavailable", "setup_confirmed", "withheld"]);
    const made: Record<string, ReturnType<typeof status>> = {
      withheld: status("withheld"), checking: status("checking"), no_answer_checking: status("no_answer_checking"), request_finished: status("request_finished"), result_unavailable: status("result_unavailable"),
      card_result_line: status("card_result_line", { desk: botName({ name: "Desk" }), lead: botName({ name: "Lead" }), card: cardTitle({ title: "Card" }) }),
      criteria_claim_corrected: status("criteria_claim_corrected", { met: 2, total: 3 }), call_ended: status("call_ended", { minutes: 4 }), setup_confirmed: status("setup_confirmed"),
      no_answer_check_timed_out: status("no_answer_check_timed_out", { name: botName({ name: "Worker" }) }),
    };
    for (const key of BOT_VISIBLE_STATUS) {
      const kept = statusRecordOf(made[key]!);
      expect(kept?.key, key).toBe(key);
      expect(storedStatusShapeOk(key, kept?.data), key).toBe(true);
    }
  });
  it("a line no row keeps has no record: a quote, a host line, an owner-only line with a quoted ending", () => {
    expect(statusRecordOf(status("delegation_failed_with", { name: botName({ name: "B" }), why: status("request_failed") }))).toBeUndefined();
    expect(statusRecordOf(status("still_working", { name: botName({ name: "B" }) }))).toBeUndefined();
    expect(statusRecordOf(status("delegated_turn_completed"))).toEqual({ key: "delegated_turn_completed" });
  });
});

describe("rule 11: a row written from a status stores its key and data", () => {
  const sinkRows: Array<{ threadId: string; row: Message }> = [];
  const store = { appendMessage(threadId: string, message: Omit<Message, "id" | "at">, id?: string): Message {
    const row = { ...message, id: id ?? `sink-${sinkRows.length}`, at: Date.now() } as Message; sinkRows.push({ threadId, row }); return row;
  }, patchGroup() { /* unread */ } };
  const bus = { store } as unknown as CommsBus;
  const channel = { id: "g1", threadId: "room-1" } as GroupRecord;
  const bot = { id: "bot-b", name: "B", color: "red" } as BotRecord;
  it("the shared sinks keep murage.status beside unchanged words, and keep nothing for a line no row keeps", () => {
    sinkRows.length = 0;
    const rows = new RowSink(store);
    writeActivityRow(rows, "t1", {}, status("request_finished"), true);
    writeBotRow(rows, "t1", {}, status("result_unavailable"));
    mirrorMurageLine(bus, channel, status("withheld"), { kind: "failure" }, {});
    mirrorActivity(bus, bot, channel, status("call_ended", { minutes: 3 }), true);
    writeActivityRow(rows, "t1", {}, status("still_working", { name: botName({ name: "B" }) }));
    const [activity, text, mirrored, chip, unkept] = sinkRows.map(entry => entry.row);
    expect(activity?.murage).toEqual({ kind: "status", status: { key: "request_finished" } });
    expect(activity?.tool?.name).toBe("The request finished.");
    expect(text?.murage?.status).toEqual({ key: "result_unavailable" });
    expect(text?.text).toBe("(that result is no longer available)");
    expect(mirrored?.murage).toEqual({ kind: "failure", status: { key: "withheld" } });
    expect(mirrored?.actorKind).toBe("murage");
    expect(chip?.murage).toEqual({ kind: "status", status: { key: "call_ended", data: { minutes: 3 } } });
    expect(chip?.from?.botId).toBe("bot-b");
    expect(unkept?.murage).toBeUndefined();
  });
  it("the room line takes the status, not its words", () => {
    const source = readFileSync(join(SERVER, "index.ts"), "utf8");
    expect(source).toMatch(/function roomMurageLine\(threadId: string, text: string \| Outbound,/);
    expect(source).toMatch(/=> roomMurageLine\(threadId, text, murage, lineage, stableId\);/);
  });
});

describe("rule 10: fixedCopy is a runtime-validated projection", () => {
  it("a stored status row with a visible key projects fresh words through botRows and botMessages, never its stored text", () => {
    const thread = "fixed-visible";
    const rows = [
      statusRow("v-finished", { kind: "status", status: { key: "request_finished" } }, 10),
      statusRow("v-call", { kind: "status", status: { key: "call_ended", data: { minutes: 7 } } }, 11),
      statusRow("v-criteria", { kind: "status", status: { key: "criteria_claim_corrected", data: { met: 1, total: 4 } } }, 12),
      statusRow("v-withheld", { kind: "failure", status: { key: "withheld" } }, 13),
    ];
    for (const row of rows) appendMessage(thread, row);
    const stored = rows.map(row => readMessage(thread, row.id)!);
    const read = botRows(database(), BOT, thread, stored);
    expect(read.map(row => row.id)).toEqual(rows.map(row => row.id));
    expect(read.map(row => row.text)).toEqual(["The request finished.", "The voice call ended after 7 min.", "On record: 1 of 4 done criteria met.", fixedCopy(rows[3])]);
    for (const row of read) expect(row.text).not.toContain("secret");
    const messages = botMessages(database(), BOT, thread, stored);
    expect(messages.map(row => row.text)).toEqual(read.map(row => row.text));
    for (const row of messages) { expect(row.tool).toBeUndefined(); expect(JSON.stringify(row)).not.toContain("secret"); }
    expect(botRows(database(), HUMAN, thread, stored).map(row => row.id)).toEqual(rows.map(row => row.id));
    expect(botMessages(database(), HUMAN, thread, stored).map(row => row.tool?.name)).toEqual(rows.map(row => row.tool?.name));
  });
  it("an owner-only key, a legacy row, malformed data, a raw string param and a tampered kind project nothing", () => {
    const thread = "fixed-nothing";
    const rows = [
      statusRow("n-owner-only", { kind: "status", status: { key: "delegated_turn_completed" } }),
      statusRow("n-owner-only-code", { kind: "failure", status: { key: "delegated_turn_failed", data: { why: "auth" } } }),
      statusRow("n-legacy", { kind: "status" }),
      statusRow("n-legacy-actor", undefined),
      statusRow("n-raw-string", { kind: "status", status: { key: "criteria_claim_corrected", data: { met: "all of them secret", total: 3 } } }),
      statusRow("n-string-count", { kind: "status", status: { key: "call_ended", data: { minutes: "5" } } }),
      statusRow("n-extra-param", { kind: "status", status: { key: "withheld", data: { text: "secret" } } }),
      statusRow("n-missing-param", { kind: "status", status: { key: "call_ended" } }),
      statusRow("n-array-data", { kind: "status", status: { key: "call_ended", data: [5] } }),
      statusRow("n-status-string", { kind: "status", status: "request_finished" }),
      statusRow("n-key-number", { kind: "status", status: { key: 7 } }),
      statusRow("n-extra-field", { kind: "status", status: { key: "request_finished", text: "secret" } }),
      statusRow("n-kind-tamper", { kind: "secret", status: { key: "request_finished" } }),
      statusRow("n-proto", { kind: "status", status: { key: "__proto__" } }),
      statusRow("n-unknown-card", { kind: "result", status: { key: "card_result_line", data: { desk: "Desk", lead: "Lead", card: "'secret'" } } }),
      statusRow("n-huge-count", { kind: "status", status: { key: "call_ended", data: { minutes: 1e9 } } }),
    ];
    for (const row of rows) {
      expect(fixedCopy(row), row.id).toBeUndefined();
      expect(fixedCopy(JSON.parse(JSON.stringify(row))), `${row.id} stored`).toBeUndefined();
    }
    for (const junk of [null, undefined, "x", 3, [], { murage: null }, { murage: [] }]) expect(fixedCopy(junk)).toBeUndefined();
    for (const row of rows) appendMessage(thread, row);
    const stored = rows.map(row => readMessage(thread, row.id)!);
    expect(botRows(database(), BOT, thread, stored)).toEqual([]);
    expect(botMessages(database(), BOT, thread, stored)).toEqual([]);
    expect(botRows(database(), HUMAN, thread, stored).map(row => row.text)).toEqual(stored.map(row => row.text ?? ""));
  });
  it("only the seven keys render; every other key in the table renders nothing", () => {
    const plain: StatusKey[] = ["request_failed", "turn_stopped_early", "delegated_turn_stalled", "receipt_cancelled", "no_such_bot", "shared_not_approved"];
    for (const key of plain) expect(fixedCopy(statusRow(key, { kind: "status", status: { key } })), key).toBeUndefined();
    expect(fixedCopy(statusRow("setup", { kind: "status", status: { key: "setup_confirmed" } }))).toBe("That setup step is saved.");
    expect(fixedCopy(statusRow("gone", { kind: "status", status: { key: "result_unavailable" } }))).toBe("(that result is no longer available)");
  });
});

describe("rule 5: a copy of a bot's words is a bot row", () => {
  const written: Array<Omit<Message, "id" | "at">> = [];
  const store = { appendMessage(_threadId: string, message: Omit<Message, "id" | "at">, id?: string): Message { written.push(message); return { ...message, id: id ?? `r-${written.length}`, at: 1 } as Message; },
    bot: (_id: string) => undefined };
  const origin = { threadId: "worker-thread", messageIds: ["worker-reply"] };
  const from = { botId: "bot-w", name: "Worker", color: "green" };
  it("a worker result written through writeBotRow is role bot, from the producing bot, with copyOf and no stamp", () => {
    written.length = 0;
    const rows = new RowSink(store);
    writeBotRow(rows, "t1", { from }, released("the worker's answer", origin));
    writeBotRow(rows, "t1", { from }, status("replied_to_task", { name: botName({ name: "Worker" }), reply: released("quoted answer", origin) }));
    for (const row of written) {
      expect(row).toMatchObject({ role: "bot", kind: "text", from, copyOf: origin });
      expect(isMurageVoice(row as Message), "a copy is never a Murage-voice row").toBe(false);
      expect(row.turnId).toBeUndefined();
    }
  });
  it("a copy whose producing bot is not named keeps none of its words: it is Murage's withheld line", () => {
    written.length = 0;
    writeBotRow(new RowSink(store), "t1", {}, released("words of an unnamed bot", origin));
    const [row] = written;
    expect(row?.text).not.toContain("unnamed bot");
    expect(row?.copyOf).toBeUndefined();
    expect(isMurageVoice(row as Message)).toBe(true);
    expect(row?.murage?.status).toEqual({ key: "withheld" });
  });
  it("a recovered hand-off reply with its original is the worker's bot row, even after the worker was removed", () => {
    written.length = 0;
    appendHandoffReply(store as never, { sourceThreadId: "s1", owed: { text: "The number is 42." }, targetBotId: "bot-w", targetName: "Worker", copyOf: origin });
    expect(written[0]).toMatchObject({ role: "bot", kind: "text", copyOf: origin, from: { botId: "bot-w", name: "Worker" } });
    expect(isMurageVoice(written[0] as Message)).toBe(false);
    // an owed line with no original names no bot's words: it stays Murage's line
    appendHandoffReply(store as never, { sourceThreadId: "s1", owed: { text: "(withheld)" }, targetBotId: "bot-w", targetName: "Worker" });
    expect(isMurageVoice(written[1] as Message)).toBe(true);
  });
});

describe("rule 8: the effective copyOf is persisted", () => {
  const rows: Message[] = [];
  const bus = { store: { appendMessage(_threadId: string, message: Omit<Message, "id" | "at">): Message { const row = { ...message, id: `c-${rows.length}`, at: 1 } as Message; rows.push(row); return row; },
    patchGroup() { /* unread */ }, messageById: () => ({ turnId: "prov-original" }) } } as unknown as CommsBus;
  const channel = { id: "g1", threadId: "room-1" } as GroupRecord;
  const target = { id: "bot-t", name: "T", color: "red" } as BotRecord;
  const origin = { threadId: "worker-thread", messageIds: ["worker-reply"] };
  it("mirrorReply stores the copyOf it used, from the reply itself when the caller passes none, as the target's bot row", () => {
    rows.length = 0;
    mirrorReply(bus, target, released("the reply", origin), channel);
    mirrorReply(bus, target, released("the reply", origin), channel, { threadId: "other", messageIds: ["named"] });
    expect(rows[0]).toMatchObject({ role: "bot", kind: "text", copyOf: origin, from: { botId: "bot-t" } });
    expect(rows[1]?.copyOf).toEqual({ threadId: "other", messageIds: ["named"] });
    for (const row of rows) {
      expect(isMurageVoice(row)).toBe(false);
      expect(row.turnId, "a copy rests on its original through copyOf, never on a turn id of its own").toBeUndefined();
    }
  });
  it("the copy round-trips through the message database with its copyOf", () => {
    const store = { appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message { const row = { ...message, id: "rt", at: 1 } as Message; appendMessage(threadId, row); return row; }, patchGroup() { /* unread */ }, messageById: () => undefined };
    mirrorReply({ store } as unknown as CommsBus, target, released("the reply", origin), channel);
    expect(readMessage("room-1", "rt")?.copyOf).toEqual(origin);
  });
});

describe("rule 21: corrections and call notes are statuses", () => {
  it("a criteria claim correction is its counts; anything that is no claim is none", () => {
    expect(criteriaClaimCorrection("All four done criteria are met.", [{ text: "Real offer", met: false }, { text: "FAQ", met: true }])).toEqual({ met: 1, total: 2 });
    expect(criteriaClaimCorrection("The goal is done.", [{ text: "FAQ", met: true }], "awaiting_signoff")).toEqual({ met: 1, total: 1 });
    expect(criteriaClaimCorrection("The criteria are not all met.", [{ text: "FAQ", met: false }])).toBeNull();
  });
  it("the writers write the statuses: the correction, and the call note's status beside the owner's own words", () => {
    const source = readFileSync(join(SERVER, "index.ts"), "utf8");
    expect(source).toMatch(/roomMurageLine\(event\.threadId, status\("criteria_claim_corrected", correction\)/);
    expect(source).toMatch(/writeBotRow\(rows, threadId, \{\}, status\("call_ended", \{ minutes: note\.minutes \}\)\)/);
    expect(source).not.toMatch(/criteriaRecordCorrection\(/);
  });
});

describe("rule 9 and test 32: a copy and a hand-off are validated recursively at read", () => {
  const ROOM = "chain-room", SRC = "chain-src";
  const OWNER_TURN = { audience: { owner: true, scopeIds: [] as string[] } };
  const bot = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: `bot words ${id}`, at: Date.now(), from: { botId: "bot-b", name: "B", color: "blue" }, ...extra });
  const copyOf = (id: string, thread = SRC) => ({ copyOf: { threadId: thread, messageIds: [id] } });
  /** The copy is dropped for a bot in any other turn and reads as its withheld line in the owner's turn, with none of its words. */
  function expectWithheld(copy: Message, label: string): void {
    expect(botRows(database(), BOT, ROOM, [copy]), label).toEqual([]);
    const [line] = botRows(database(), BOT, ROOM, [copy], OWNER_TURN);
    expect(line?.text, label).toContain(ROOM_REPLY_WITHHELD);
    expect(line?.text, label).not.toContain("bot words");
    expect(botMessages(database(), BOT, ROOM, [copy], OWNER_TURN)[0]?.text, label).toBe(line?.text);
  }
  /** Each row is written on the thread's active branch (its parent the leaf before it), never as a regenerate or branch switch of that leaf. */
  const put = (thread: string, row: Message): Message => {
    const leaf = (database().prepare("SELECT active_leaf_id AS id FROM thread_state WHERE thread_id=?").get(thread) as { id: string | null } | undefined)?.id;
    if (leaf) row.parentId = leaf;
    appendMessage(thread, row);
    return row;
  };
  const shown = (copy: Message) => botRows(database(), BOT, ROOM, [copy]).map(row => row.text);

  it("a copy of a valid source, and a copy of a copy, read as stored", () => {
    put(SRC, bot("s1"));
    const first = bot("c1", copyOf("s1")); put(ROOM, first);
    const second = bot("c2", copyOf("c1", ROOM)); put(ROOM, second);
    expect(shown(first)).toEqual([first.text]);
    expect(shown(second)).toEqual([second.text]);
  });
  it("a source with only the owner's note passes; the door never judges by the note", () => {
    put(SRC, bot("noted", { withheldFromBots: true }));
    const copy = bot("c-noted", copyOf("noted")); put(ROOM, copy);
    expect(shown(copy)).toEqual([copy.text]);
  });
  it("a copy of a withheld source (its line revoked)", () => {
    put(SRC, bot("w-src"));
    const copy = bot("c-w", copyOf("w-src")); put(ROOM, copy);
    commitRevoke(database(), { kind: "line", threadId: SRC, messageIds: ["w-src"], cause: "hide" });
    expectWithheld(copy, "withheld");
  });
  it("a copy of a forgotten source", () => {
    put(SRC, owner("f-src"));
    const copy = bot("c-f", copyOf("f-src")); put(ROOM, copy);
    database().prepare("INSERT OR REPLACE INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,(SELECT id FROM memory_scopes LIMIT 1),?,?,1,'h','text','owner','recorded','deleted')").run(`message:${SRC}:f-src`, SRC, "f-src");
    expectWithheld(copy, "forgotten");
  });
  it("a copy of a tombstoned source", () => {
    put(SRC, owner("t-src"));
    const copy = bot("c-t", copyOf("t-src")); put(ROOM, copy);
    database().prepare("INSERT INTO memory_tombstones VALUES('tomb-t','source',?,NULL,NULL,1,'forgotten',1)").run(`message:${SRC}:t-src`);
    expectWithheld(copy, "tombstoned");
  });
  it("a copy of a classified source", () => {
    put(SRC, murageLine({ id: "m-src", role: "bot", kind: "text", text: "bot words the engine said", at: 1, turnId: "t1" }) as Message);
    const copy = bot("c-m", copyOf("m-src")); put(ROOM, copy);
    expectWithheld(copy, "classified");
  });
  it("a copy of a missing source", () => {
    const copy = bot("c-x", copyOf("never-stored")); put(ROOM, copy);
    expectWithheld(copy, "missing");
  });
  it("a copy of a malformed source: a stored row that is not an object, or a malformed link of its own", () => {
    put(SRC, bot("bad-json"));
    database().prepare("UPDATE messages SET json='[]' WHERE thread_id=? AND id=?").run(SRC, "bad-json");
    const first = bot("c-bad", copyOf("bad-json")); put(ROOM, first);
    expectWithheld(first, "not an object");
    put(SRC, bot("bad-link"));
    database().prepare("UPDATE messages SET json=json_set(json,'$.copyOf',json('{\"threadId\":7}')) WHERE thread_id=? AND id=?").run(SRC, "bad-link");
    const second = bot("c-bad2", copyOf("bad-link")); put(ROOM, second);
    expectWithheld(second, "malformed link");
  });
  it("a copy of a cyclic chain", () => {
    put(SRC, bot("cy-a", copyOf("cy-b")));
    put(SRC, bot("cy-b", copyOf("cy-a")));
    const copy = bot("c-cy", copyOf("cy-a")); put(ROOM, copy);
    expectWithheld(copy, "cyclic");
  });
  it("chains naming CHAIN_REFS sources read; one naming more is over the bound", () => {
    // eight copies of eight originals each: a copy of seven of them and one original names 64 sources, a copy of all eight names 72
    for (let i = 0; i < 64; i += 1) put(SRC, bot(`l${i}`));
    for (let m = 0; m < 8; m += 1) put(SRC, bot(`m${m}`, { copyOf: { threadId: SRC, messageIds: Array.from({ length: 8 }, (_, k) => `l${m * 8 + k}`) } }));
    expect(CHAIN_REFS).toBe(64);
    const within = bot("c-in", { copyOf: { threadId: SRC, messageIds: [...Array.from({ length: 7 }, (_, m) => `m${m}`), "l63"] } }); put(ROOM, within);
    const over = bot("c-over", { copyOf: { threadId: SRC, messageIds: Array.from({ length: 8 }, (_, m) => `m${m}`) } }); put(ROOM, over);
    expect(shown(within)).toEqual([within.text]);
    expectWithheld(over, "over-bound");
    // judged together, the sources the first row's chain already judged still count toward the second row's bound
    expect(botRows(database(), BOT, ROOM, [within, over]).map(row => row.id)).toEqual([within.id]);
  });
  it("a hand-off prompt reads through its handoffOf row: shown when that row is, withheld when it is classified or gone", () => {
    put(SRC, bot("sent", { kind: "activity", tool: { name: "Messaged @A" } }));
    const prompt = owner("h-ok", { handoffFrom: SRC, handoffOf: { threadId: SRC, messageId: "sent" } }); put(ROOM, prompt);
    expect(shown(prompt)).toEqual([prompt.text]);
    put(SRC, murageLine({ id: "sent-m", role: "bot", kind: "activity", at: 1, tool: { name: "Messaged @A" } }) as Message);
    const legacy = owner("h-m", { handoffFrom: SRC, handoffOf: { threadId: SRC, messageId: "sent-m" } }); put(ROOM, legacy);
    expect(botRows(database(), BOT, ROOM, [legacy])).toEqual([]);
    const gone = owner("h-x", { handoffFrom: SRC, handoffOf: { threadId: SRC, messageId: "absent" } }); put(ROOM, gone);
    expect(botRows(database(), BOT, ROOM, [gone])).toEqual([]);
  });
  it("the human viewer reads every copy as stored", () => {
    const copy = bot("c-h", copyOf("never-stored")); put(ROOM, copy);
    expect(botRows(database(), HUMAN, ROOM, [copy]).map(row => row.text)).toEqual([copy.text]);
  });
});

describe("16: the result gate and a hand-off replay read every line of their walk through the door", () => {
  const SRC = "egress-src", DEST = "egress-dest";
  const put = (thread: string, row: Message): Message => {
    const leaf = (database().prepare("SELECT active_leaf_id AS id FROM thread_state WHERE thread_id=?").get(thread) as { id: string | null } | undefined)?.id;
    if (leaf) row.parentId = leaf;
    appendMessage(thread, row);
    return row;
  };
  const reply = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: `worker words ${id}`, at: Date.now(), from: { botId: "bot-b", name: "B", color: "blue" }, ...extra });
  /** The gate's own rules all open: only the door can withhold here. */
  const gate = (): StoredAnswerDeps => ({
    message: (threadId, id) => readMessage(threadId, id) ?? undefined,
    authorize: () => ({ ok: true }), copyOriginWithheld: () => false, capturedMessageWithheld: () => false, messageSourceForgotten: () => false,
    messageMadeWithMemory: () => false, partitionAllowed: () => true, ownUnsharedWork: () => true, request: () => null, requestSourceThread: () => undefined,
    doorShown: doorEgress(database),
  });
  const release = (id: string) => releaseStoredResult({ origin: { threadId: SRC, messageIds: [id] } }, "bot-b", DEST, { fromBotId: "bot-a" }, false, undefined, gate());
  const words = (id: string): string | undefined => { const out = release(id); return out.kind === "text" ? outboundWords(out.text) : undefined; };

  it("a worker's reply is released; a Murage-voice row, a copy of one and a revoked line are withheld", () => {
    put(SRC, reply("r-ok"));
    expect(words("r-ok")).toBe("worker words r-ok");
    put(SRC, murageLine(reply("r-m", { text: "worker words the engine said" })) as Message);
    expect(release("r-m").kind).toBe("withheld");
    put(SRC, reply("r-copy", { copyOf: { threadId: SRC, messageIds: ["r-m"] } }));
    expect(release("r-copy").kind).toBe("withheld");
    put(SRC, reply("r-rev"));
    expect(words("r-rev")).toBe("worker words r-rev");
    commitRevoke(database(), { kind: "line", threadId: SRC, messageIds: ["r-rev"], cause: "hide" });
    expect(release("r-rev").kind).toBe("withheld");
  });
  it("a hand-off replayed in an event run hands back the withheld line for a stored answer the door does not show", () => {
    put(SRC, reply("a-ok"));
    put(SRC, { id: "a-m", role: "bot", kind: "text", text: "worker words as Murage", at: Date.now(), actorKind: "murage" } as Message);
    const who = { fromBotId: "bot-a", toBotId: "bot-b", fromThreadId: DEST };
    const answer = (id: string) => storedAnswerText(gate(), { threadId: SRC, messageId: id }, who, false);
    expect(outboundWords(answer("a-ok")!)).toBe("worker words a-ok");
    const withheld = answer("a-m");
    expect(withheld && outboundWords(withheld)).not.toContain("worker words");
  });
  it("the server's gate asks the door, and the gate keeps no reader of its own outside it", () => {
    expect(readFileSync(join(SERVER, "index.ts"), "utf8")).toMatch(/doorShown: doorEgress\(database, ownerOwnConversation\)/);
    const egress = readFileSync(join(SERVER, "result-egress.ts"), "utf8");
    expect(egress).not.toMatch(/export function (turnSourcesHold|textHolders)\b/);
    expect(egress).not.toMatch(/threadMessages\??:/);
  });
});

describe("16: a copy's original in replay is judged by the door (the working-context reply: working-context-door.test.ts)", () => {
  const SRC = "origin-src";
  const put = (row: Message): Message => {
    const leaf = (database().prepare("SELECT active_leaf_id AS id FROM thread_state WHERE thread_id=?").get(SRC) as { id: string | null } | undefined)?.id;
    if (leaf) row.parentId = leaf;
    appendMessage(SRC, row);
    return row;
  };
  const bot = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: `bot words ${id}`, at: Date.now(), from: { botId: "bot-b", name: "B", color: "blue" }, ...extra });
  it("copyOriginUnavailable uses the rule 9 chain judge: classified, revoked, a failing chain and a missing original are unavailable; the note alone is not", () => {
    put(bot("o-ok"));
    expect(copyOriginUnavailable(SRC, "o-ok")).toBe(false);
    put(murageLine(bot("o-m")) as Message);
    expect(copyOriginUnavailable(SRC, "o-m")).toBe(true);
    put(bot("o-rev"));
    commitRevoke(database(), { kind: "line", threadId: SRC, messageIds: ["o-rev"], cause: "hide" });
    // the revoke's window closes once the marker has walked it (an inline walk may run out of its 8 ms on a loaded runner): drained here so the
    // rows judged after it read on their own verdicts
    drainRevokeMarker(database());
    expect(copyOriginUnavailable(SRC, "o-rev")).toBe(true);
    put(bot("o-chain", { copyOf: { threadId: SRC, messageIds: ["o-m"] } }));
    expect(copyOriginUnavailable(SRC, "o-chain")).toBe(true);
    expect(copyOriginUnavailable(SRC, "never-stored")).toBe(true);
    put(bot("o-noted", { withheldFromBots: true }));
    expect(copyOriginUnavailable(SRC, "o-noted")).toBe(false);
  });
});

describe("16 and 19: rows a reader already holds, from many threads, are judged in one door operation", () => {
  const put = (thread: string, row: Message): Message => {
    const leaf = (database().prepare("SELECT active_leaf_id AS id FROM thread_state WHERE thread_id=?").get(thread) as { id: string | null } | undefined)?.id;
    if (leaf) row.parentId = leaf;
    appendMessage(thread, row);
    return row;
  };
  const bot = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: `bot words ${id}`, at: Date.now(), from: { botId: "bot-a", name: "A", color: "blue" }, ...extra });
  it("rowsShown judges held rows without reading them again, reads the per-operation state once, and keeps each row's own verdict", () => {
    const held = Array.from({ length: 8 }, (_, i) => ({ threadId: `held-${i}`, row: put(`held-${i}`, bot(`h${i}`)) }));
    put("held-0", murageLine(bot("h-m")) as Message);
    held.push({ threadId: "held-0", row: bot("h-copy", { copyOf: { threadId: "held-0", messageIds: ["h-m"] } }) });
    put("held-0", held[8]!.row);
    commitRevoke(database(), { kind: "line", threadId: "held-3", messageIds: ["h3"], cause: "hide" });
    // the revoke's window closes once the marker has walked it (an inline walk may run out of its 8 ms on a loaded runner): drained here so the
    // rows written after h3 read on their own verdicts, not as pending
    drainRevokeMarker(database());
    const db = database();
    const real = db.prepare.bind(db);
    const seen: string[] = [];
    (db as any).prepare = (sql: string) => {
      const statement = real(sql);
      return new Proxy(statement, { get(target, key) {
        const value = (target as any)[key];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => { if (key === "get" || key === "all" || key === "run" || key === "iterate") seen.push(sql); return value.apply(target, args); };
      } });
    };
    let verdicts: boolean[];
    try { verdicts = rowsShown(db, BOT, held); } finally { (db as any).prepare = real; }
    expect(verdicts).toEqual([true, true, true, false, true, true, true, true, false]);
    // no held row is read again by key, and the lineage gate is read once for the whole operation
    expect(seen.filter(sql => /SELECT (id, text, )?json FROM messages WHERE thread_id=\? AND id=\?/.test(sql))).toEqual([]);
    expect(seen.filter(sql => /FROM memory_line_lineage LIMIT 1/.test(sql))).toHaveLength(1);
    // storedRowsShown is the same judgment over rows it reads by id
    expect(storedRowsShown(db, BOT, "held-1", ["h1"])).toBe(true);
    expect(storedRowsShown(db, BOT, "held-3", ["h3"])).toBe(false);
    expect(rowsShown(db, HUMAN, held).every(Boolean)).toBe(true);
  });
  it("the working context hands the door the rows it holds, in one call per build", () => {
    const code = codeLines(readFileSync(join(SERVER, "working-context.ts"), "utf8")).map(({ code }) => code).join("\n");
    expect(code).not.toMatch(/storedRowsShown/);
    expect(code.match(/rowsShown\(/g)).toHaveLength(1);
  });
});

describe("18b: only a BotRow reaches a prompt", () => {
  const plain = (id: string): Message => owner(id);
  const chip = (id: string, key = "withheld"): Message => ({ id, role: "bot", kind: "text", text: "stored words", at: 1, murage: { kind: "failure", status: { key } } } as Message);
  it("the door's rows carry their BotRow for the viewer that read them, and nothing else does", () => {
    const row = plain("b1"), hidden = chip("b2", "turn_failed_note"), shown = chip("b3");
    appendMessage("t18b", row);
    const read = botMessages(database(), BOT, "t18b", [row, hidden, shown]);
    expect(read.map(r => r.id)).toEqual(["b1", "b3"]);
    expect(botRowOf(read[0]!, BOT)?.text).toBe(row.text);
    // a projection carries its fixed words, never the stored text
    expect(botRowOf(read[1]!, BOT)?.text).toBe(fixedCopy(shown));
    expect(botRowOf(read[1]!, BOT)?.text).not.toContain("stored words");
    expect(botRowOf(hidden, BOT)).toBeUndefined();
    expect(botRowOf(shown, BOT)).toBeUndefined();
    // another viewer has no BotRow for a row only bot-a's door read
    expect(botRowOf(read[0]!, { kind: "bot", botId: "bot-z" })).toBeUndefined();
    expect(botRowOf(plain("never-read"), BOT)).toBeUndefined();
  });
  it("a later door pass that leaves a row out takes its BotRow away (rule 19: the latest verdict, never a kept one)", () => {
    const row = chip("b4", "turn_failed_note");
    expect(botMessages(database(), BOT, "t18b", [row], { standIns: new Set(["b4"]) })).toEqual([row]);
    expect(botRowOf(row, BOT)).toBeDefined();
    expect(botMessages(database(), BOT, "t18b", [row])).toEqual([]);
    expect(botRowOf(row, BOT)).toBeUndefined();
  });
  it("botWindow's rows carry their BotRow too", () => {
    const rows = [plain("w1"), chip("w2", "turn_failed_note"), owner("w3", { parentId: "w1" })];
    appendMessage("t18b-w", rows[0]!);
    appendMessage("t18b-w", rows[2]!);
    const { window } = botWindow(database(), BOT, "t18b-w", rows, () => false, 100);
    expect(window.map(r => r.id)).toEqual(["w1", "w3"]);
    expect(window.every(r => botRowOf(r, BOT)?.id === r.id)).toBe(true);
    expect(botRowOf(rows[1]!, BOT)).toBeUndefined();
  });
  it("the transcript and the external update accept only a BotRow, and a BotRow is minted only by the door (type level)", () => {
    const source = humanRow(plain("ty1"));
    const entries: TranscriptEntry[] = [{ id: "ty1", role: "user", text: "x", source }];
    // @ts-expect-error a transcript line needs the door's BotRow
    entries.push({ id: "ty2", role: "user", text: "x" });
    const pending: ExternalUpdateMessage[] = [{ id: "e1", text: "" }, { id: "e2", text: "words", source }];
    // @ts-expect-error an external update with words needs the door's BotRow
    pending.push({ id: "e3", text: "words" });
    // @ts-expect-error a BotRow is minted only by the door
    const forged: BotRow = { id: "f", role: "user", speaker: undefined, text: "x", at: 1 };
    expect([entries.length, pending.length, Boolean(forged)]).toEqual([2, 3, true]);
  });
  it("index.ts renders a replay line and a room line only from the door's BotRow", () => {
    const code = codeLines(readFileSync(join(SERVER, "index.ts"), "utf8")).map(({ code }) => code).join("\n");
    expect(code).toMatch(/function replayEntry\(source: BotRow,/);
    expect(code.match(/replayEntry\(/g)?.length, "replayEntry is called only from replayLines").toBe(2);
    expect(code).toMatch(/function replayLines\(/);
    expect(code).toMatch(/function roomLine\(source: BotRow,/);
    expect(code.match(/roomLine\(/g)?.length, "roomLine is called only from renderRoomContext, with the door's BotRow").toBe(2);
    expect(code).toMatch(/const source = botRowOf\(m, viewer\);\n\s*if \(!source\) return \[\];\n\s*const line = roomLine\(source,/);
  });
});

import { expect, it } from "vitest";
import { Store } from "../store.ts";
import { closeDatabase, database } from "../database.ts";
import { highlevelEngineRequest, highlevelEngineAsk } from "./engine-policy.ts";
import type { RuntimeEvent } from "../contracts.ts";

const selection = () => ({ instanceId: "claude", model: "default" });
const shell = (threadId: string): RuntimeEvent => ({ type: "request.opened", requestType: "permission",
  threadId, turnId: "turn", eventId: "ask", createdAt: new Date().toISOString(), provider: "test", requestId: "request",
  tool: "shell", summary: "Run git status", toolEngine: "acp", toolKind: "execute", toolCall: { name: "execute", input: { command: "git status" } },
});

it("unmarked bot and room conversations keep ordinary approvals; real HighLevel marks survive restart", () => {
  const store = new Store(selection);
  const bot = store.createBot();
  const other = store.createBot();
  const group = store.createGroup("Card budget", [bot.id, other.id]);
  for (const threadId of [bot.threadId, other.threadId, group.threadId]) {
    expect(store.threadHighLevelMarked(threadId)).toBe("unmarked");
    expect(highlevelEngineRequest(shell(threadId), store.threadHighLevelMarked(threadId))).toBeUndefined();
  }
  for (const threadId of [bot.threadId, group.threadId]) {
    expect(store.markThreadHighLevel(threadId)).toBe(true);
    expect(store.markThreadHighLevel(threadId)).toBe(true);
    expect(highlevelEngineRequest(shell(threadId), store.threadHighLevelMarked(threadId))).toEqual({ kind: "deny" });
  }
  closeDatabase();
  const restarted = new Store(selection);
  expect(restarted.threadHighLevelMarked(bot.threadId)).toBe("marked");
  expect(restarted.threadHighLevelMarked(group.threadId)).toBe("marked");
  expect(restarted.threadHighLevelMarked(other.threadId)).toBe("unmarked");
  expect(restarted.markThreadHighLevel("unknown-thread")).toBe(false);
});

it("an unreadable mark store withholds, and a failed write never admits a HighLevel mount", () => {
  const store = new Store(selection);
  const bot = store.createBot();
  const db = database();
  db.exec("ALTER TABLE highlevel_thread_marks RENAME TO highlevel_thread_marks_test_held");
  try {
    expect(store.threadHighLevelMarked(bot.threadId)).toBe("unreadable");
    expect(store.markThreadHighLevel(bot.threadId)).toBe(false);
  } finally {
    db.exec("ALTER TABLE highlevel_thread_marks_test_held RENAME TO highlevel_thread_marks");
  }
  expect(store.threadHighLevelMarked(bot.threadId)).toBe("unmarked");
});

it("unreadable marks withhold a proven native engine call", () => {
  const store = new Store(selection);
  const bot = store.createBot();
  expect(store.markThreadHighLevel(bot.threadId)).toBe(true);
  const db = database();
  db.exec("ALTER TABLE highlevel_thread_marks RENAME TO highlevel_thread_marks_test_held");
  try {
    const call = { engine: "acp" as const, mcpMounts: [{ engineName: "highlevel", mountId: "own:highlevel", provenance: "own" as const }], toolIdentity: { namespace: "mcp" as const, name: "highlevel__HIGHLEVEL_CONTACTS" }, toolCall: { name: "mcp__highlevel__HIGHLEVEL_CONTACTS", input: {} } };
    expect(highlevelEngineAsk(call, store.threadHighLevelMarked(bot.threadId))).toEqual({ kind: "deny" });
  } finally { db.exec("ALTER TABLE highlevel_thread_marks_test_held RENAME TO highlevel_thread_marks"); }
});

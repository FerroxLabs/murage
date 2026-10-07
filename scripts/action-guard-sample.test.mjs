import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { sampleReplies } from "./action-guard-sample.mjs";

it("requires an explicit copy and refuses the home data path before opening it", () => {
  expect(() => sampleReplies(undefined, 2)).toThrow("copy path");
  expect(() => sampleReplies(join(homedir(), ".murage", "messages.db"), 2)).toThrow("outside ~/.murage");
});
it("exports exactly N recent bot replies with records and empty owner labels from a copy", () => {
  const folder = join(homedir(), "copy"); mkdirSync(folder);
  const path = join(folder, "messages.db"), db = new DatabaseSync(path);
  db.exec("CREATE TABLE messages(thread_id TEXT, role TEXT, kind TEXT, text TEXT, at INTEGER, json TEXT)");
  const insert = db.prepare("INSERT INTO messages VALUES('t',?,?,?,?,?)");
  for (let i = 0; i < 2; i++) insert.run("bot", "text", `reply ${i}`, i, JSON.stringify({ id: `m${i}`, text: `reply ${i}`, turnId: `turn${i}`, turnTerminal: true }));
  insert.run("bot", "activity", "", 3, JSON.stringify({ id: "tool", turnId: "turn2", tool: { name: "send_message", ok: true } }));
  insert.run("bot", "text", "reply 2", 3, JSON.stringify({ id: "m2", text: "reply 2", turnId: "turn2", turnTerminal: true }));
  insert.run("user", "text", "owner", 4, JSON.stringify({ id: "owner", text: "owner" })); db.close();
  const sample = sampleReplies(path, 2);
  expect(sample.map(row => row.reply.id)).toEqual(["m2", "m1"]);
  expect(sample[0]).toMatchObject({ label: null, split: null, records: [{ id: "tool" }] });
});

it("N8 exports complete authored turns with earlier evidence on the selected fork", async () => {
  const { checkReplyActions } = await import("../server/reply-action-guard.ts");
  const folder = join(homedir(), "fork-copy"); mkdirSync(folder);
  const path = join(folder, "messages.db"), db = new DatabaseSync(path);
  db.exec("CREATE TABLE messages(thread_id TEXT,role TEXT,kind TEXT,text TEXT,at INTEGER,json TEXT); CREATE TABLE thread_state(thread_id TEXT,active_leaf_id TEXT)");
  const rows = [
    { id: "root", role: "user", text: "Begin", parentId: null },
    { id: "earlier-send", kind: "activity", turnId: "earlier", tool: { name: "send_message", ok: true }, parentId: "root" },
    { id: "earlier-reply", text: "Done", turnId: "earlier", turnTerminal: true, parentId: "earlier-send" },
    { id: "fork-pay", kind: "activity", turnId: "turn", tool: { name: "pay_invoice", ok: true }, parentId: "earlier-reply" },
    { id: "abandoned", text: "I paid it.", turnId: "turn", turnTerminal: true, parentId: "fork-pay", at: 99 },
    { id: "first", text: "I sent it.", turnId: "turn", parentId: "earlier-reply" },
    { id: "peer", text: "I paid it.", turnId: "turn", from: { botId: "peer" }, parentId: "first" },
    { id: "last", text: "Anything else?", turnId: "turn", turnTerminal: true, parentId: "peer" },
  ].map((row, at) => ({ role: "bot", kind: "text", at, ...row }));
  const insert = db.prepare("INSERT INTO messages VALUES('t',?,?,?,?,?)");
  for (const row of rows) insert.run(row.role, row.kind, row.text ?? "", row.at, JSON.stringify(row));
  db.prepare("INSERT INTO thread_state VALUES('t','last')").run(); db.close();
  const [sample] = sampleReplies(path, 1);
  expect(sample.reply.id).toBe("last");
  expect(sample.pieces.map(row => row.id)).toEqual(["first", "last"]);
  expect(sample.records.map(row => row.id)).toEqual(["earlier-send"]);
  expect(sample.path.map(row => row.id)).not.toContain("abandoned");
  const verdict = checkReplyActions(sample);
  expect(verdict.state).toBe("earlier");
  expect(verdict.claims).toMatchObject([{ pieceId: "first", rowId: "earlier-send" }]);
  expect(sample.activeLeafId).toBe("last");
});

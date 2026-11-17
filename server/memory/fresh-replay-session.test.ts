// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { FreshReplaySessionConfirmation, withCurrentReplaySessionChange, withOwnReplayEligibilityChange } from "./fresh-replay-session.ts";
import { assertSendReplayProof, captureSendReplayProof, confirmFreshReplaySession, sendReplaySessionCurrent } from "./replay-lineage.ts";
import { sessionKeyOf } from "./session-incarnation.ts";
import { afterUpdate } from "../branch-store.ts";

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  database().exec(`CREATE TABLE IF NOT EXISTS send_replay_exclusions (
    thread_id TEXT NOT NULL,message_id TEXT NOT NULL,attempt_id TEXT,reason TEXT NOT NULL,revision INTEGER NOT NULL,
    PRIMARY KEY(thread_id,message_id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS send_replay_epochs(thread_id TEXT PRIMARY KEY NOT NULL,revision INTEGER NOT NULL);
    INSERT INTO send_replay_epochs VALUES('chat',1);`);
});
afterEach(() => { closeDatabase(); });

const key = () => sessionKeyOf("chat", "engine", "native", 2);
const current = () => sendReplaySessionCurrent("chat", "engine", key().nativeSession);
const make = (assertAccepted = () => {}) => new FreshReplaySessionConfirmation(captureSendReplayProof("chat", []), "engine", assertAccepted);

it.each(["aws", "asw", "was", "wsa", "saw", "swa"])("confirms the incarnation only after acceptance, write and fresh session (%s)", order => {
  const receipt = make();
  const steps: Record<string, () => void> = { a: () => receipt.accepted("turn"), w: () => receipt.engineWritten(), s: () => receipt.sessionStarted("turn", key(), true) };
  expect(current()).toBe(false);
  for (const [index, step] of [...order].entries()) {
    steps[step]!();
    expect(current()).toBe(index === 2);
  }
  // The raw native id names the previous incarnation, which stays unproven.
  expect(sendReplaySessionCurrent("chat", "engine", "native")).toBe(false);
});

it.each(["resumed", "unknown-turn", "other-turn", "other-thread", "other-engine"])("never stamps a %s session", kind => {
  const receipt = make(); receipt.accepted("turn"); receipt.engineWritten();
  const session = sessionKeyOf(kind === "other-thread" ? "other" : "chat", kind === "other-engine" ? "other" : "engine", "native", 2);
  receipt.sessionStarted(kind === "unknown-turn" ? undefined : kind === "other-turn" ? "previous" : "turn", session, kind !== "resumed");
  expect(current()).toBe(false);
});

it("an accepted session with no confirmed write stays unproven", () => {
  const receipt = make(); receipt.sessionStarted("turn", key(), true); receipt.accepted("turn");
  expect(current()).toBe(false);
});

it("refused acceptance cannot confirm even after the provider wrote", () => {
  const receipt = make(() => { throw new Error("submission refused"); });
  receipt.engineWritten(); receipt.sessionStarted("turn", key(), true);
  expect(() => receipt.accepted("turn")).toThrow("submission refused");
  expect(current()).toBe(false);
});

it("a replay change between write and acceptance refuses the old proof", () => {
  const receipt = make(); receipt.engineWritten(); receipt.sessionStarted("turn", key(), true);
  database().exec("UPDATE send_replay_epochs SET revision=2 WHERE thread_id='chat'");
  expect(() => receipt.accepted("turn")).toThrow("SEND_REPLAY_CHANGED");
  expect(current()).toBe(false);
});

it("confirmation remains revocable and disappears on connection restart", () => {
  const receipt = make(); receipt.accepted("turn"); receipt.engineWritten(); receipt.sessionStarted("turn", key(), true);
  expect(current()).toBe(true);
  database().exec("UPDATE send_replay_epochs SET revision=2 WHERE thread_id='chat'");
  expect(current()).toBe(false);
  receipt.engineWritten(); receipt.accepted("turn");
  expect(current()).toBe(false);
  const nextKey = sessionKeyOf("chat", "engine", "native", 3);
  const next = make(); next.accepted("turn-2"); next.engineWritten(); next.sessionStarted("turn-2", nextKey, true);
  expect(current()).toBe(false);
  expect(sendReplaySessionCurrent("chat", "engine", nextKey.nativeSession)).toBe(true);
  closeDatabase(); database();
  expect(sendReplaySessionCurrent("chat", "engine", nextKey.nativeSession)).toBe(false);
});

it("a known session survives only the next owned line's local eligibility changes", () => {
  const receipt = make(); receipt.accepted("first"); receipt.engineWritten(); receipt.sessionStarted("first", key(), true);
  withCurrentReplaySessionChange("chat", "engine", key().nativeSession, ["next"], () => {
    database().exec("INSERT INTO send_replay_exclusions VALUES('chat','next','attempt','not_submitted',1); UPDATE send_replay_epochs SET revision=2 WHERE thread_id='chat'");
  });
  expect(current()).toBe(true);
  const next = new FreshReplaySessionConfirmation(captureSendReplayProof("chat", ["next"]), "engine", () => {},
    { ownMessageIds: ["next"], retainedSession: key().nativeSession });
  next.ownEligibilityChange(() => database().exec("UPDATE send_replay_exclusions SET reason='uncertain' WHERE message_id='next'; UPDATE send_replay_epochs SET revision=3 WHERE thread_id='chat'"));
  next.ownEligibilityChange(() => database().exec("DELETE FROM send_replay_exclusions WHERE message_id='next'; UPDATE send_replay_epochs SET revision=4 WHERE thread_id='chat'"));
  next.engineWritten(); next.accepted("second"); next.sessionStarted("second", key(), false);
  expect(current()).toBe(true);
  database().exec("UPDATE send_replay_epochs SET revision=5 WHERE thread_id='chat'");
  expect(current()).toBe(false);
  // A later local send never rehabilitates the now-stale session.
  withCurrentReplaySessionChange("chat", "engine", key().nativeSession, ["later"], () => {
    database().exec("UPDATE send_replay_epochs SET revision=6 WHERE thread_id='chat'");
  });
  expect(current()).toBe(false);
});

it("local send bookkeeping does not stamp an unknown retained session", () => {
  withCurrentReplaySessionChange("chat", "engine", key().nativeSession, ["next"], () => {
    database().exec("UPDATE send_replay_epochs SET revision=2 WHERE thread_id='chat'");
  });
  expect(current()).toBe(false);
});

it.each(["unowned-removal", "new-exclusion", "foreign-epoch", "ancestry"])("an owned transition rejects %s and rolls its writes back", kind => {
  const db = database();
  db.exec(`INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat','history',1,'user','text','history','{"id":"history"}');
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('source','origin',1,'user','text','source','{}');
    INSERT INTO send_replay_exclusions VALUES('chat','blocked','attempt','uncertain',1);
    INSERT INTO send_replay_epochs VALUES('source',1);`);
  const proof = captureSendReplayProof("chat", ["history", "blocked"], new Map([["history", [{ threadId: "source", messageId: "origin" }]]]));
  const change = () => {
    db.exec("UPDATE send_replay_epochs SET revision=2 WHERE thread_id='chat'");
    if (kind === "unowned-removal") db.exec("DELETE FROM send_replay_exclusions WHERE message_id='blocked'");
    if (kind === "new-exclusion") db.exec("INSERT INTO send_replay_exclusions VALUES('chat','history','attempt','uncertain',1)");
    if (kind === "foreign-epoch") db.exec("UPDATE send_replay_epochs SET revision=2 WHERE thread_id='source'");
    if (kind === "ancestry") db.prepare("UPDATE messages SET json=? WHERE id='history'").run(JSON.stringify({ id: "history", copyOf: { threadId: "other", messageIds: ["origin"] } }));
  };
  expect(() => withOwnReplayEligibilityChange([proof], ["history"], change)).toThrow("SEND_REPLAY_CHANGED");
  expect(db.prepare("SELECT revision FROM send_replay_epochs WHERE thread_id='chat'").get()).toMatchObject({ revision: 1 });
  expect(() => assertSendReplayProof(proof)).not.toThrow();
});

it("a stale proof refuses the local mutation before it runs", () => {
  const proof = captureSendReplayProof("chat", []);
  database().exec("UPDATE send_replay_epochs SET revision=2 WHERE thread_id='chat'");
  let called = false;
  expect(() => withOwnReplayEligibilityChange([proof], [], () => { called = true; })).toThrow("SEND_REPLAY_CHANGED");
  expect(called).toBe(false);
});

it("post-write delivery evidence still commits without rehabilitating a stale proof", () => {
  const proof = captureSendReplayProof("chat", []);
  confirmFreshReplaySession("chat", "engine", key().nativeSession, proof);
  database().exec("UPDATE send_replay_epochs SET revision=2 WHERE thread_id='chat'");
  let recorded = 0;
  withOwnReplayEligibilityChange([proof], [], () => { recorded++; }, false);
  expect(recorded).toBe(1);
  expect(current()).toBe(false);
  expect(() => assertSendReplayProof(proof)).toThrow("SEND_REPLAY_CHANGED");
});

it.each(["dispatchedIn", "turnId", "turnTerminal"])("the owned %s patch preserves exact replay across the real branch writer", field => {
  const db = database();
  db.exec(`INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat','owner-line',1,'user','text','hello','{"id":"owner-line","role":"user","kind":"text","text":"hello","at":1}')`);
  const proof = captureSendReplayProof("chat", ["owner-line"]);
  confirmFreshReplaySession("chat", "engine", key().nativeSession, proof);
  const next = new FreshReplaySessionConfirmation(proof, "engine", () => {}, { ownMessageIds: ["owner-line"] });
  const row = { id: "owner-line", role: "user" as const, kind: "text" as const, text: "hello", at: 1, [field]: field === "turnTerminal" ? true : "turn" };
  next.ownEligibilityChange(() => {
    db.prepare("UPDATE messages SET json=? WHERE id='owner-line'").run(JSON.stringify(row));
    const mrow = Number(db.prepare("SELECT rowid FROM messages WHERE id='owner-line'").get()!.rowid);
    afterUpdate(db, "chat", row, mrow, false, false, "text");
  }, false);
  expect(db.prepare("SELECT revision FROM send_replay_epochs WHERE thread_id='chat'").get()).toMatchObject({ revision: 2 });
  expect(current()).toBe(true);
  expect(() => assertSendReplayProof(proof)).not.toThrow();
});

it.each(["source-a", "source-b"])("a continued session retains old and newly disclosed copy originals (%s)", changed => {
  const db = database();
  for (const thread of ["source-a", "source-b"]) {
    db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,'origin',1,'user','text','source','{}')").run(thread);
  }
  const roots = (threadId: string) => new Map([["copy", [{ threadId, messageId: "origin" }]]]);
  confirmFreshReplaySession("chat", "engine", key().nativeSession, captureSendReplayProof("chat", ["copy"], roots("source-a")));
  const next = new FreshReplaySessionConfirmation(captureSendReplayProof("chat", ["copy"], roots("source-b")), "engine", () => {}, { retainedSession: key().nativeSession });
  next.accepted("turn"); next.engineWritten(); next.sessionStarted("turn", key(), false);
  expect(current()).toBe(true);
  db.prepare("INSERT INTO send_replay_exclusions VALUES(?,'origin','attempt','uncertain',1)").run(changed);
  db.prepare("INSERT INTO send_replay_epochs VALUES(?,1)").run(changed);
  expect(current()).toBe(false);
});

it("too many copied candidates retire continuation instead of dropping an old source", () => {
  const initialIds = Array.from({ length: 1280 }, (_, index) => `history-${index}`);
  confirmFreshReplaySession("chat", "engine", key().nativeSession, captureSendReplayProof("chat", initialIds));
  const copies = new Map<string, { threadId: string; messageId: string }[]>(Array.from({ length: 1281 }, (_, index) => [`copy-${index}`, [{ threadId: "source", messageId: `origin-${index}` }]]));
  const next = new FreshReplaySessionConfirmation(captureSendReplayProof("chat", [...copies.keys()], copies), "engine", () => {}, { retainedSession: key().nativeSession });
  next.accepted("turn"); next.engineWritten();
  expect(current()).toBe(false);
});

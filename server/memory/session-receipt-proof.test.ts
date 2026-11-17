// SPDX-License-Identifier: AGPL-3.0-or-later
// Receipt writer and retained-session proof owner: new3-g5b.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { SEND_ATTEMPT_SCHEMA_SQL, SendAttemptStore } from "../send-attempt-state.ts";
import { setReplayShadowForTest } from "./replay-walk.ts";
import { takeReplayShadowDivergencesForTest } from "./replay-shadow.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { captureSendReplayProof, confirmFreshReplaySession, sendReplaySessionCurrent } from "./replay-lineage.ts";

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  database().exec(SEND_ATTEMPT_SCHEMA_SQL);
});
afterEach(() => { setReplayShadowForTest(process.env.MURAGE_REPLAY_SHADOW === "1"); closeDatabase(); });

function row(id: string, thread = "conversation", copyOf?: { threadId: string; messageIds: string[] }) {
  const message = { id, at: 1, role: "user", kind: "text", text: `Fixture ${id}`, ...(copyOf ? { copyOf } : {}) };
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,1,'user','text',?,?)").run(thread, id, message.text, JSON.stringify(message));
}
function fixture(copy = false) {
  row("history", copy ? "source" : "conversation");
  if (copy) row("copy", "conversation", { threadId: "source", messageIds: ["history"] });
  confirmFreshReplaySession("conversation", "engine", "session", captureSendReplayProof("conversation", [copy ? "copy" : "history"]));
  const current = () => sendReplaySessionCurrent("conversation", "engine", "session");
  const store = new SendAttemptStore(database());
  const send = (id: string, thread = "conversation", existing = false) => {
    if (!existing) row(id, thread);
    const attempt = store.create({ ownerId: "owner", botId: "fixture", threadId: thread, sendId: id, fingerprint: "fixture" });
    store.link(attempt.attemptId, id);
    let key = store.bind([attempt.attemptId], { generation: `generation-${id}`, providerInstanceId: "engine" })[0]!;
    return {
      release: () => store.releaseWrite(key, store.byId(attempt.attemptId)!.revision, 1),
      acknowledge: () => {
        key = store.allocateProvider(key, store.byId(attempt.attemptId)!.revision, `provider-${id}`);
        store.acknowledge(key, store.byId(attempt.attemptId)!.revision);
      },
    };
  };
  return { current, store, send };
}

it("keeps a session across a new queued input, holds its release, then retains the acknowledged input", () => {
  const f = fixture(), send = f.send("next");
  expect(f.current()).toBe(true);
  send.release(); expect(f.current()).toBe(false);
  send.acknowledge(); expect(f.current()).toBe(true);
  database().exec("INSERT INTO send_replay_exclusions VALUES('conversation','next',NULL,'uncertain',1); UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id='conversation'");
  expect(f.current()).toBe(false); // the new input is now part of retained context
});

it("does not let one acknowledgement clear another possibly written input", () => {
  const f = fixture(), first = f.send("first"); first.release();
  const second = f.send("second"); second.release(); second.acknowledge();
  expect(f.current()).toBe(false);
  first.acknowledge(); expect(f.current()).toBe(true);
});

it("cannot heal an unwitnessed epoch with a later legitimate receipt", () => {
  const f = fixture();
  database().exec("INSERT INTO send_replay_epochs VALUES('conversation',1)");
  const next = f.send("next"); next.release(); next.acknowledge();
  expect(f.current()).toBe(false);
});

it.each([false, true])("never advances across an exclusion of retained history (copy=%s)", copy => {
  const f = fixture(copy), source = f.send("history", copy ? "source" : "conversation", true);
  expect(f.current()).toBe(false);
  source.release(); source.acknowledge();
  expect(f.current()).toBe(false);
});

it("does not absorb a changed copy ancestor before a receipt write", () => {
  setReplayShadowForTest(true);
  const f = fixture(true);
  database().prepare("UPDATE messages SET json=? WHERE thread_id='conversation' AND id='copy'").run(JSON.stringify({ copyOf: { threadId: "source", messageIds: ["missing"] } }));
  // First prove the deliberately missing epoch bump is fatal and observable.
  expect(() => f.send("broken-writer")).toThrow("REPLAY_SHADOW_DIVERGED");
  expect(takeReplayShadowDivergencesForTest()).toBe(1);
  // Complete the writer's epoch contract, then retain every original stale
  // receipt / release / acknowledgement refusal assertion below.
  database().exec("INSERT INTO send_replay_epochs VALUES('conversation',1) ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1");
  const next = f.send("next"); next.release(); next.acknowledge();
  expect(f.current()).toBe(false);
});

it("restores the pending state and proof when an enclosing receipt transaction rolls back", () => {
  const f = fixture();
  expect(() => f.store.transaction(() => {
    const next = f.send("next"); next.release(); expect(f.current()).toBe(false);
    throw new Error("fixture rollback");
  })).toThrow("fixture rollback");
  expect(f.current()).toBe(true);
});

it("keeps an uncertain input unusable after reopening the database", () => {
  const f = fixture(), next = f.send("next"); next.release();
  expect(f.current()).toBe(false);
  closeDatabase(); database();
  expect(f.current()).toBe(false);
});

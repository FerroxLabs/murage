// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Regression owner: long-thread-producer. Replay primitive owner: new3-g5.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { FreshReplaySessionConfirmation } from "./fresh-replay-session.ts";
import { assertSendReplayProof, captureSendReplayProof, confirmFreshReplaySession,
  currentSendReplaySessionProof, sendReplaySessionCurrent } from "./replay-lineage.ts";

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  database().exec(`CREATE TABLE IF NOT EXISTS send_replay_exclusions (
    thread_id TEXT NOT NULL,message_id TEXT NOT NULL,attempt_id TEXT,reason TEXT NOT NULL,revision INTEGER NOT NULL,
    PRIMARY KEY(thread_id,message_id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS send_replay_epochs(thread_id TEXT PRIMARY KEY NOT NULL,revision INTEGER NOT NULL);
    INSERT INTO send_replay_epochs VALUES('chat',1);
    INSERT INTO send_replay_exclusions VALUES('chat','history',NULL,'not_submitted',1);
    INSERT INTO send_replay_exclusions VALUES('chat','newly-excluded',NULL,'uncertain',1);`);
});
afterEach(() => closeDatabase());

it("keeps a continuation alive with its parent's excluded candidate while refusing new exclusions and excluded own input", () => {
  const retained = captureSendReplayProof("chat", ["history", "delivered"]);
  expect(retained.excludedIds.has("history")).toBe(true);
  confirmFreshReplaySession("chat", "engine", "native", retained);
  const continuation = (ids: string[], ownMessageIds: string[]) => {
    const turn = new FreshReplaySessionConfirmation(captureSendReplayProof("chat", ids), "engine", () => {},
      { ownMessageIds, retainedSession: "native" });
    turn.engineWritten();
    return () => turn.accepted("next-turn");
  };

  expect(continuation(["history", "newly-excluded", "next"], ["next"])).toThrow("SEND_REPLAY_CHANGED");
  expect(continuation(["history", "next"], ["history"])).toThrow("SEND_REPLAY_CHANGED");
  expect(continuation(["history", "next"], ["next"])).not.toThrow();

  expect(sendReplaySessionCurrent("chat", "engine", "native")).toBe(true);
  const extended = currentSendReplaySessionProof("chat", "engine", "native")!;
  expect(extended.messageIds).toEqual(["history", "delivered", "next"]);
  expect([...extended.excludedIds]).toEqual(["history"]);
  expect(() => assertSendReplayProof(extended)).not.toThrow();
});

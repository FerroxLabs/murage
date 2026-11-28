import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { mailboxSealed, initializeMailboxCustody } from "./custody.ts";
import { encodeSseFrames, SseReplay } from "../sse-buffer.ts";
import { mailboxFrameThread, sealedFrameSubject } from "./projection.ts";

const sentinel = "fixture-protected-mail";
const subject = { scope: "thread", threadId: "fixture-thread" } as const;
const message = { id: "fixture-row", role: "bot", kind: "text", at: 2, text: sentinel };
const frames = [
  { kind: "message", threadId: subject.threadId, message },
  { kind: "bot", threadId: subject.threadId, threadDelta: { threadId: subject.threadId, messages: [message] } },
  { kind: "bot", threadId: subject.threadId, bot: { id: "fixture-bot", threadId: subject.threadId, messages: [message], openCards: [message] } },
] as const;
const data = (frame: string) => JSON.parse(frame.split("\n")[1].slice("data: ".length));

it("S2 preserves the primary, task-delta and cards-beside frame shapes while projecting each payload", () => {
  const { primary, taskDelta: delta, cardsBeside: beside } = encodeSseFrames("fixture", 2, true, ...frames);
  expect(delta).toBeDefined();
  expect(beside).toBeDefined();
  for (const frame of [primary, delta, beside]) {
    expect(frame).toMatch(/^id: fixture:2\n/);
    expect(frame).not.toContain(sentinel);
  }
  const held = { id: "fixture-row", sealed: true, text: "Email conversation" };
  expect(data(primary)).toMatchObject({ kind: "message", message: held });
  expect(data(delta!)).toMatchObject({ kind: "bot", threadDelta: { threadId: subject.threadId, messages: [held] } });
  expect(data(beside!)).toMatchObject({ kind: "bot", bot: { id: "fixture-bot", messages: [held], openCards: [] } });
});

it("S2c projects a serialized pre-seal entry by the current seal at the real replay selection boundary", () => {
  using db = new DatabaseSync(":memory:");
  initializeMailboxCustody(db);
  const replay = new SseReplay(undefined, frameSubject => frameSubject.scope === "thread" && mailboxSealed(db, frameSubject.threadId));
  const { primary: frame } = encodeSseFrames("fixture", 2, false, frames[0]);
  replay.append({ seq: 2, kind: "message", subject }, frame);
  expect(replay.prepare(1, 2, () => true).frames).toEqual([frame]);

  db.prepare("INSERT INTO mailbox_sealed_threads(thread_id, generation, state) VALUES (?, 1, 'pending')").run(subject.threadId);

  const prepared = replay.prepare(1, 2, () => true);
  expect(prepared.resumed).toBe(true);
  expect(prepared.frames).toHaveLength(1);
  expect(prepared.frames[0]).not.toContain(sentinel);
  expect(data(prepared.frames[0])).toMatchObject({ kind: "message", seq: 2, message: { sealed: true, text: "Email conversation" } });
});

it("S2c projects a stale bot transcript page after its owner has been removed", () => {
  const roster = { bot: () => null, group: () => undefined, isMailboxSealed: () => false };
  const replay = new SseReplay(undefined, frameSubject => sealedFrameSubject(roster, frameSubject));
  const { primary: frame } = encodeSseFrames("fixture", 2, false, frames[2]);
  replay.append({ seq: 2, kind: "bot", subject: { scope: "bot", botId: "fixture-bot" } }, frame);
  expect(frame).toContain(sentinel);
  const prepared = replay.prepare(1, 2, () => true);
  expect(prepared.resumed).toBe(true);
  expect(prepared.frames).toHaveLength(1);
  expect(prepared.frames[0]).not.toContain(sentinel);
});

it("S2c replay uses the stored page thread when its bot has switched tasks", () => {
  using db = new DatabaseSync(":memory:");
  initializeMailboxCustody(db);
  const replay = new SseReplay(undefined, candidate => candidate.scope === "thread" && mailboxSealed(db, candidate.threadId));
  const payload = frames[2];
  const { primary: frame } = encodeSseFrames("fixture", 2, false, payload);
  replay.append({ seq: 2, kind: "bot", subject: { scope: "bot", botId: "fixture-bot" }, threadId: mailboxFrameThread(payload) }, frame);
  expect(replay.prepare(1, 2, () => true).frames).toEqual([frame]);
  db.prepare("INSERT INTO mailbox_sealed_threads(thread_id,generation,state) VALUES (?,1,'deleted')").run(subject.threadId);
  const prepared = replay.prepare(1, 2, () => true);
  expect(prepared.resumed).toBe(true);
  expect(prepared.frames).toHaveLength(1);
  expect(prepared.frames[0]).not.toContain(sentinel);
});

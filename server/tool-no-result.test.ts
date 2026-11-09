// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 U6 E15 (design U6-DESIGN-1103 section 5, items 6 and 7): when a turn settles, the tool rows of exactly that turn
// still open are marked `unrecorded` ("No result") instead of spinning forever. Ownership is by turnId through the turn
// index: another turn's live row, an engine notice and a settled row are left as they are. A late real completion
// (index.ts item.completed, completedToolRow) rebuilds the tool, so the real outcome clears the mark.
import { beforeAll, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { prepareThread } from "./branch-store.ts";
import { Store, type Message } from "./store.ts";
import { completedToolRow } from "./completed-tool-row.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
let store: Store;
let threadId: string;
let other: string;

const row = (thread: string, turnId: string, tool: NonNullable<Message["tool"]>) =>
  store.appendMessage(thread, { role: "bot", kind: "activity", turnId, tool }).id;

beforeAll(async () => {
  removeTempDirSync(DATA_DIR);
  store = new Store(selection);
  threadId = store.createBot({ name: "Ada" }).threadId;
  other = store.createBot({ name: "Bea" }).threadId;
  for (const id of [threadId, other]) {
    store.messagesFor(id);
    await prepareThread(id);
  }
}, 120_000);

describe("U6 E15 pass 1: turn end marks only its own open tool rows No result", () => {
  it("marks turn A's open rows, never turn B's live row, a notice, a settled row or another thread's row; idempotent", () => {
    store.appendMessage(threadId, { role: "user", kind: "text", text: "go", turnId: "turn-a" });
    const openA = row(threadId, "turn-a", { name: "Bash", summary: "npm test", spoken: "Running the tests" });
    const doneA = row(threadId, "turn-a", { name: "Read", ok: true });
    const failA = row(threadId, "turn-a", { name: "Write", ok: false });
    const noticeA = row(threadId, "turn-a", { name: "engine note", notice: true });
    // turn B is still running in the same thread (delayed terminal event of A while B works: design item 7)
    const liveB = row(threadId, "turn-b", { name: "Grep" });
    const otherThread = row(other, "turn-a", { name: "Bash" });

    expect(store.markTurnToolsUnrecorded(threadId, "turn-a")).toBe(1);
    const tool = (id: string, thread = threadId) => store.messageById(thread, id)?.tool;
    expect(tool(openA)).toMatchObject({ name: "Bash", summary: "npm test", spoken: "Running the tests", unrecorded: true });
    expect(tool(openA)?.ok).toBeUndefined();
    expect(tool(doneA)?.unrecorded).toBeUndefined();
    expect(tool(failA)?.unrecorded).toBeUndefined();
    expect(tool(noticeA)?.unrecorded).toBeUndefined();
    expect(tool(liveB)?.unrecorded).toBeUndefined();
    expect(tool(otherThread, other)?.unrecorded).toBeUndefined();
    // a redelivered terminal event marks nothing twice
    expect(store.markTurnToolsUnrecorded(threadId, "turn-a")).toBe(0);
    // B settles later: only now is its open row marked
    expect(store.markTurnToolsUnrecorded(threadId, "turn-b")).toBe(1);
    expect(tool(liveB)?.unrecorded).toBe(true);
  });

  it("a late real completion clears the mark and keeps the narration (the real outcome wins)", () => {
    const id = row(threadId, "turn-c", { name: "Bash", summary: "make", spoken: "Building" });
    store.markTurnToolsUnrecorded(threadId, "turn-c");
    const marked = store.messageById(threadId, id)!.tool!;
    expect(marked.unrecorded).toBe(true);
    store.patchMessage(threadId, id, { tool: completedToolRow(marked, true, undefined, undefined) });
    const done = store.messageById(threadId, id)!.tool!;
    expect(done.unrecorded).toBeUndefined();
    expect(done).toMatchObject({ name: "Bash", ok: true, summary: "make", spoken: "Building" });
    const failed = completedToolRow({ ...marked, notice: true }, false, undefined, "exit 1");
    expect(failed).toMatchObject({ ok: false, errorDetails: "exit 1", notice: true });
    expect(failed.unrecorded).toBeUndefined();
  });
});

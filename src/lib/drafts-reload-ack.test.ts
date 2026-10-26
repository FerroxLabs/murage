// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U36: after a reload, a send the server already holds clears its own words and
// attachments from the still-open composer, and keeps anything added since.
// With one record per draft (U36-DRAFT-SEND-STATE-106) the held draft is read-only
// across the reload, and an attachment added meanwhile waits in `later` until the
// acknowledgement settles the send.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

function sharedStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}
type SharedStorage = ReturnType<typeof sharedStorage>;

function sharedLocks() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    request<T>(_name: string, callback: () => T | Promise<T>): Promise<T> {
      const run = chain.then(() => callback());
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

/** A page load: a fresh module over the same Storage and the same Web Locks. */
async function load(storage: SharedStorage, locks: ReturnType<typeof sharedLocks>) {
  vi.resetModules();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("navigator", { locks });
  return import("./drafts");
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const sentFile = { kind: "file" as const, id: "a-sent", name: "plan.pdf", path: "/u/plan.pdf", size: 10 };
const addedFile = { kind: "file" as const, id: "a-added", name: "notes.txt", path: "/u/notes.txt", size: 4 };
const record = (storage: SharedStorage, id: string) => JSON.parse(storage.getItem(`murage-draft:${id}`) ?? "null");

/** Types "text" with the sent file, presses Send, then reloads the page before any answer. */
async function sendThenReload(id: string, text: string) {
  const storage = sharedStorage(), locks = sharedLocks();
  const before = await load(storage, locks);
  before.setComposerDraftText(id, text);
  before.setComposerDraftAttachments(id, [sentFile] as never);
  await flush();
  const view = before.readComposerDraft(id);
  const begun = await before.beginDraftSend(id, { text: view.text, att: view.att, mode: view.mode }, (sendId, content) => ({
    sendId, kind: "bot" as const, botId: "b1", threadId: "t1", text: content.text, at: Date.now(), attempts: 0,
  }));
  if (!begun.ok) throw new Error(`press refused: ${begun.reason}`);
  const after = await load(storage, locks);
  return { storage, after, sendId: begun.sendId };
}

it("keeps an attachment added to the open composer while the reloaded send was retried", async () => {
  const id = "bot:b1:t1";
  const { storage, after, sendId } = await sendThenReload(id, "hello");
  expect(await after.appendComposerDraftAttachments(id, [addedFile] as never)).toBe(true);
  expect(await after.settleDraftSend(undefined, sendId, undefined, "acked")).toBe(true);
  expect(record(storage, id)).toMatchObject({ text: "", att: [addedFile] });
  expect(record(storage, id).later).toBeUndefined();
});

it("clears the sent attachments when nothing was added", async () => {
  const id = "bot:b1:t2";
  const { storage, after, sendId } = await sendThenReload(id, "hi");
  expect(await after.settleDraftSend(undefined, sendId, undefined, "acked")).toBe(true);
  expect(record(storage, id)).toMatchObject({ text: "", att: [] });
});

it("leaves the words alone until the send settles: the reloaded draft is held, not edited", async () => {
  const id = "bot:b1:t3";
  const { storage, after } = await sendThenReload(id, "hi");
  after.readComposerDraft(id);
  expect(after.isDraftHeld(id)).toBe(true);
  expect(after.setComposerDraftText(id, "hi, and more")).toBe(false);
  await flush();
  expect(record(storage, id)).toMatchObject({ text: "hi", att: [sentFile] });
});

it("the store's acknowledgement settles the draft record and never empties every attachment", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "state", "store.tsx"), "utf8");
  expect(source).toContain('settleDraftSend(undefined, frame.message.sendId, undefined, "acked")');
  expect(source).not.toContain("acknowledgeDraft: (entry) => {");
});

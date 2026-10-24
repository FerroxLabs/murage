// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U36: after a reload, a send the server already holds clears its own words and
// attachments from the still-open composer, and keeps anything added since.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const storage = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
const load = async () => { vi.resetModules(); return import("./drafts"); };

const sentFile = { kind: "file" as const, id: "a-sent", name: "plan.pdf", path: "/u/plan.pdf", size: 10 };
const addedFile = { kind: "file" as const, id: "a-added", name: "notes.txt", path: "/u/notes.txt", size: 4 };

it("keeps an attachment added to the open composer while the reloaded send was retried", async () => {
  vi.stubGlobal("localStorage", storage());
  const drafts = await load();
  const id = "bot:b1:t1";
  drafts.setDraft(localStorage, id, "hello");
  expect(drafts.setDraftAttachments(localStorage, id, [sentFile, addedFile] as never)).toBe(true);
  expect(drafts.clearReloadedSendDraft({ draftId: id, text: "hello", attachments: [sentFile] as never })).toBe(true);
  expect(drafts.getDraft(localStorage, id)).toBe("");
  expect(drafts.getDraftAttachments(localStorage, id).map((a) => a.id)).toEqual(["a-added"]);
});

it("clears the sent attachments when nothing was added", async () => {
  vi.stubGlobal("localStorage", storage());
  const drafts = await load();
  const id = "bot:b1:t2";
  drafts.setDraft(localStorage, id, "hi");
  drafts.setDraftAttachments(localStorage, id, [sentFile] as never);
  expect(drafts.clearReloadedSendDraft({ draftId: id, text: "hi", attachments: [sentFile] as never })).toBe(true);
  expect(drafts.getDraftAttachments(localStorage, id)).toEqual([]);
});

it("leaves an edited draft alone", async () => {
  vi.stubGlobal("localStorage", storage());
  const drafts = await load();
  const id = "bot:b1:t3";
  drafts.setDraft(localStorage, id, "hi, and more");
  drafts.setDraftAttachments(localStorage, id, [sentFile] as never);
  expect(drafts.clearReloadedSendDraft({ draftId: id, text: "hi", attachments: [sentFile] as never })).toBe(false);
  expect(drafts.getDraft(localStorage, id)).toBe("hi, and more");
  expect(drafts.getDraftAttachments(localStorage, id).map((a) => a.id)).toEqual(["a-sent"]);
});

it("the store's reload acknowledgement no longer empties every attachment", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "state", "store.tsx"), "utf8");
  const ack = source.slice(source.indexOf("acknowledgeDraft: (entry) => {"), source.indexOf("post: (entry, signal) =>"));
  expect(ack).toContain("clearReloadedSendDraft(draft)");
  expect(ack).not.toContain("attachments: []");
});

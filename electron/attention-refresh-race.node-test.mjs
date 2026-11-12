// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { createAttentionWindowHost } from "./attention-window-host.mjs";
import { createAttentionActions } from "./attention-actions.mjs";
import { createItemsReader } from "../src/attention-ui/items-reader.mjs";

// The real host feeds the real reader: a pushed refresh that lands while an
// items() read is outstanding must never blank the card or lose a Reply draft.
const info = { kind: "flyout", windowId: 7 };
const record = { home: "local", epoch: "e", threadId: "t", messageId: "m", requestId: "r", digest: "a".repeat(64), outsideOk: { flyout: true },
  display: { botName: "Chief", title: "Read", willRun: "cat notes.txt" } };
function rig() {
  const posts = []; let gate = null;
  const transport = { current: () => "identity", readCard: async () => ({ ...record, open: true }), post: async body => { posts.push(body); return { ok: true }; } };
  const actions = createAttentionActions({ lock: { locked: () => false } });
  const host = createAttentionWindowHost({ actions, transportFor: () => transport, surfaceFor: () => "flyout", openTarget() {}, sendToChief: () => ({ ok: true }),
    sendToPinned: () => ({ ok: true }), pauseAutomations: () => ({ ok: true }),
    readItems: async () => { const hold = gate; gate = null; if (hold) await hold.promise; return { previews: true, items: [record], running: [], receipts: [], chief: { name: "Chief" } }; } });
  const publications = [];
  const reader = createItemsReader({ read: () => host.items(info), valid: data => Array.isArray(data.items), publish: state => { publications.push(state); } });
  const hold = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); gate = { promise }; return resolve; };
  return { host, reader, publications, posts, hold };
}
const drafts = state => state.drafts ?? {};

test("X1 a retaining push during a pending read keeps the card, its draft and a working action token", async () => {
  const { host, reader, publications, posts, hold } = rig();
  const first = await reader.refresh(); const cardId = first.items[0].cardId; publications.length = 0;
  reader.setDraft?.(cardId, { text: "keep this reply", replying: true });
  const release = hold(); const reading = reader.refresh(); await new Promise(resolve => setImmediate(resolve));
  host.invalidateWindow(info.windowId, { retainCards: true }); void reader.refresh();
  release(); const final = await reading;
  assert.ok(publications.every(state => state.data !== null), `a publication blanked the data: ${JSON.stringify(publications.map(s => [s.data === null, s.failed]))}`);
  assert.equal(final.items[0].cardId, cardId);
  // The overtaken read must not commit (its tokens would belong to data read before the push): only the newest read is ever published.
  assert.equal(new Set(publications.map(state => state.data)).size, 2, "a read that began before the push must not be published");
  if (typeof reader.setDraft === "function") assert.equal(drafts(publications.at(-1))[cardId]?.text, "keep this reply");
  assert.deepEqual(await host.act(info, final.items[0].actionToken, "allow"), { ok: true });
  assert.equal((await host.act(info, final.items[0].actionToken, "allow")).ok, false); assert.equal(posts.length, 1);
});
test("X2 a privacy invalidation during a pending read blanks the data, empties drafts and mints a new card id", async () => {
  const { host, reader, publications, hold } = rig();
  const first = await reader.refresh(); const cardId = first.items[0].cardId; publications.length = 0;
  reader.setDraft?.(cardId, { text: "private words", replying: true });
  const release = hold(); const reading = reader.refresh(); await new Promise(resolve => setImmediate(resolve));
  host.invalidateWindow(info.windowId); void reader.refresh();
  release(); const final = await reading;
  const blank = publications.find(state => state.data === null);
  assert.ok(blank, "privacy withdrawal must blank the data"); assert.deepEqual(drafts(blank), {});
  assert.notEqual(final.items[0].cardId, cardId);
  assert.equal(JSON.stringify(publications.slice(publications.indexOf(blank))).includes("private words"), false);
});

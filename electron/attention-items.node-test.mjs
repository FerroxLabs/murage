// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { itemsFromAttention } from "./attention-items.mjs";

const card = { threadId: "t", messageId: "m", requestId: "r", digest: "a".repeat(64), outsideOk: { flyout: true }, display: { botName: "A", title: "Read", willRun: "cat x" } };
test("joins attention authority to tray extras, includes Open-only questions and only three receipts", () => {
  const result = itemsFromAttention({ home: "local", previews: true, attention: { epoch: "e", open: [card], heldDuringQuiet: [{ threadId: "hidden" }] },
    tray: { items: [{ ...card, digest: "stale" }, { threadId: "q", messageId: "q", summary: "Question" }], working: [{ botName: "A", doing: "Reading" }], bots: [{ id: "a", name: "A", chief: false }, { id: "c", name: "Chief", chief: true }] },
    receipts: [1, 2, 3, 4].map(n => ({ text: String(n) })) });
  assert.equal(result.items.length, 2); assert.equal(result.items[0].digest, card.digest);
  assert.equal(result.items[1].outsideOk.flyout, undefined);
  assert.equal(result.items[0].home, "local"); assert.equal(result.items[0].epoch, "e");
  assert.deepEqual(result.running, [{ botName: "A", doing: "Reading" }]);
  assert.deepEqual(result.receipts.map(row => row.text), ["2", "3", "4"]);
  assert.deepEqual(result.chief, { name: "Chief" }); assert.doesNotMatch(JSON.stringify(result), /hidden|stale/);
});
test("unknown previews redact all text and never retain stale tray action authority", () => {
  for (const previews of [false, undefined]) {
    const result = itemsFromAttention({ previews, attention: { open: [card] }, tray: { working: [{ doing: "private" }], bots: [{ chief: true, name: "private" }] }, receipts: [{ text: "private" }] });
    assert.equal(result.items[0].display, null); assert.deepEqual(result.items[0].outsideOk, {});
    assert.doesNotMatch(JSON.stringify(result), /private|cat x|digest/);
  }
  const stale = itemsFromAttention({ previews: true, attention: { open: [] }, tray: { items: [card] } });
  assert.deepEqual(stale.items[0].outsideOk, {}); assert.equal(stale.items[0].digest, undefined);
  assert.deepEqual(itemsFromAttention(null).items, []);
});

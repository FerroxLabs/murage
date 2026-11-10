// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// NOTIFY-EVERYWHERE-1019 S3R rev 3.0 R11 step 6: the new delivery shapes are bounded in BOTH preloads (and again in main), and the
// channel classes are right: attention:* local-only, the cloud-attention:* set cloud-safe.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { CLOUD_SAFE_CHANNELS, LOCAL_ONLY_CHANNELS, CLASS_CLOUD_SAFE, CLASS_LOCAL_ONLY, channelClass } from "./ipc-channel-classes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(path.join(here, name), "utf8");
const BLOCK = /const ATTENTION_SESSION = [\s\S]*?const attentionFreed = \(value\) => \{[\s\S]*?\n\};\n/;
const SESSION = "s".repeat(25);

function helpers(name) {
  const block = BLOCK.exec(read(name))?.[0];
  assert.ok(block, `${name} carries the attention shape helpers`);
  return { block, fns: vm.runInNewContext(`${block}; ({ attentionMessage, attentionHello, attentionPresent, attentionGone, attentionFreed });`, {}) };
}

test("both preloads carry the identical shape helpers", () => {
  assert.equal(helpers("preload.cjs").block, helpers("preload-cloud.cjs").block);
});

for (const name of ["preload.cjs", "preload-cloud.cjs"]) {
  const { fns } = helpers(name);
  const plain = (value) => (value === null ? null : JSON.parse(JSON.stringify(value)));

  test(`${name}: main to window pushes are session-addressed and bounded`, () => {
    const m = (v) => plain(fns.attentionMessage(v));
    assert.deepEqual(m({ type: "show", session: SESSION, ref: "r1", gen: 3, previews: true, extra: "x" }), { type: "show", session: SESSION, ref: "r1", gen: 3, previews: true });
    assert.deepEqual(m({ type: "close", session: SESSION, ref: "r1", gen: 0 }), { type: "close", session: SESSION, ref: "r1", gen: 0 });
    assert.deepEqual(m({ type: "previews", session: SESSION, previews: false }), { type: "previews", session: SESSION, previews: false });
    assert.equal(m({ type: "show", ref: "r1", gen: 1, previews: true }), null, "no session");
    assert.equal(m({ type: "show", session: "SHORT", ref: "r1", gen: 1, previews: true }), null, "a malformed session");
    assert.equal(m({ type: "show", session: SESSION, ref: "r".repeat(65), gen: 1, previews: true }), null, "a long ref");
    assert.equal(m({ type: "show", session: SESSION, ref: "r1", gen: -1, previews: true }), null, "a negative gen");
    assert.equal(m({ type: "show", session: SESSION, ref: "r1", gen: 1.5, previews: true }), null, "a fractional gen");
    assert.equal(m({ type: "show", session: SESSION, ref: "r1", gen: 1 }), null, "show without previews");
    assert.equal(m({ type: "unknown", session: SESSION }), null);
    assert.equal(m(null), null);
  });

  test(`${name}: present is bounded: title 256, body 1024, icon a png data URI of at most 64 KB`, () => {
    const base = { session: SESSION, ref: "r1", gen: 2, title: "t", body: "b", botId: "bot", threadId: "th", privatePreview: false, silent: true };
    const p = (extra) => plain(fns.attentionPresent({ ...base, ...extra }));
    assert.deepEqual(p({}), base);
    assert.ok(p({ title: "t".repeat(256) }));
    assert.equal(p({ title: "t".repeat(257) }), null);
    assert.ok(p({ body: "b".repeat(1024) }));
    assert.equal(p({ body: "b".repeat(1025) }), null);
    const icon = "data:image/png;base64,AAAA";
    assert.equal(p({ icon }).icon, icon);
    assert.equal(p({ icon: "data:image/jpeg;base64,AAAA" }), null, "png only");
    assert.equal(p({ icon: "https://evil.example/x.png" }), null, "no remote icon");
    assert.equal(p({ icon: `data:image/png;base64,${"A".repeat(65536)}` }), null, "over 64 KB");
    assert.equal(p({ session: "no" }), null);
    assert.equal(p({ gen: "1" }), null);
    assert.equal(p({ silent: "yes" }), null);
    assert.equal(p({ title: 5 }), null);
    assert.equal(plain(fns.attentionPresent({ ...base, unexpected: 1 })).unexpected, undefined, "unknown fields are dropped");
  });

  test(`${name}: hello, gone and freed carry only their own bounded fields`, () => {
    assert.deepEqual(plain(fns.attentionHello({ session: SESSION, junk: 1 })), { session: SESSION });
    assert.equal(fns.attentionHello({ session: 5 }), null);
    assert.deepEqual(plain(fns.attentionGone({ session: SESSION, ref: "r", gen: 1, junk: 1 })), { session: SESSION, ref: "r", gen: 1 });
    assert.equal(fns.attentionGone({ session: SESSION, ref: "", gen: 1 }), null);
    const refs = Array.from({ length: 288 }, (_, i) => `r${i}`);
    assert.deepEqual(plain(fns.attentionFreed({ session: SESSION, refs })).refs.length, 288);
    assert.equal(fns.attentionFreed({ session: SESSION, refs: [...refs, "r288"] }), null, "more than LEDGER_MAX refs");
    assert.equal(fns.attentionFreed({ session: SESSION, refs: ["ok", 7] }), null);
    assert.equal(fns.attentionFreed({ session: SESSION, refs: "r" }), null);
  });
}

test("the bridges call literal channels: attention:* for the local window, cloud-attention:* for a Cloud window, freed one-way", () => {
  for (const [name, prefix] of [["preload.cjs", "attention"], ["preload-cloud.cjs", "cloud-attention"]]) {
    const source = read(name);
    const invoked = [...source.matchAll(/ipcRenderer\.invoke\("([a-z-]*attention:[a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(invoked, ["hello", "offer", "visible", "present", "gone"].map((x) => `${prefix}:${x}`), name);
    const sent = [...source.matchAll(/ipcRenderer\.send\("([a-z-]*attention:[a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(sent, [`${prefix}:freed`], name);
  }
});

test("channel classes: attention:* is local-only; the cloud-attention:* set is cloud-safe", () => {
  for (const x of ["hello", "offer", "visible", "present", "gone", "freed"]) {
    assert.equal(channelClass(`attention:${x}`), CLASS_LOCAL_ONLY, `attention:${x}`);
    assert.ok(LOCAL_ONLY_CHANNELS.includes(`attention:${x}`));
    assert.equal(channelClass(`cloud-attention:${x}`), CLASS_CLOUD_SAFE, `cloud-attention:${x}`);
    assert.ok(CLOUD_SAFE_CHANNELS.includes(`cloud-attention:${x}`));
  }
});

test("a hostile Cloud page cannot reach a local attention channel through the Cloud preload", () => {
  const source = read("preload-cloud.cjs");
  for (const channel of [...source.matchAll(/ipcRenderer\.(?:invoke|send)\("([^"]+)"/g)].map((m) => m[1])) {
    assert.notEqual(channelClass(channel), CLASS_LOCAL_ONLY, `${channel} is not a local-only channel`);
  }
  assert.ok(!/ipcRenderer\.(?:invoke|send)\("attention:/.test(source));
});

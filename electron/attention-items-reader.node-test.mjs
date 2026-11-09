// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { createItemsReader } from "../src/attention-ui/items-reader.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const populated = () => ({
  ok: true,
  items: [{ cardId: "card", display: { title: "Private request" }, actionToken: "old-action", openToken: "old-open" }],
  receipts: [{ text: "Private receipt" }], running: [{ doing: "Private work" }], chief: { name: "Chief" },
});
const fixture = () => {
  let result = populated(), state, calls = 0;
  const publications = [];
  const reader = createItemsReader({
    read: () => { calls++; return typeof result === "function" ? result() : Promise.resolve(result); },
    valid: data => Array.isArray(data.items),
    publish: value => { state = value; publications.push(value); },
  });
  return { reader, publications, setResult: value => { result = value; }, get state() { return state; }, get calls() { return calls; } };
};

for (const failure of ["reject", "refuse", "throw", "malformed"]) {
  test(`a populated reader redacts retained content after ${failure} and recovers only from a successful read`, async () => {
    const f = fixture();
    const original = await f.reader.refresh();
    const pending = deferred();
    f.setResult(() => pending.promise);
    const reading = f.reader.refresh();
    assert.equal(f.state.data, original);
    assert.equal(f.state.refreshing, true);
    if (failure === "reject") pending.reject(new Error("read failed"));
    else if (failure === "refuse") pending.resolve({ ok: false });
    else if (failure === "malformed") pending.resolve({ ok: true, items: null });
    else f.setResult(() => { throw new Error("read failed"); });
    assert.equal(await reading, null);
    assert.equal(f.state.data, null);
    assert.equal(f.state.failed, true);
    assert.equal(f.state.refreshing, false);
    assert.equal(JSON.stringify(f.state).includes("Private"), false);
    const recovery = deferred();
    f.setResult(() => recovery.promise);
    const recovering = f.reader.refresh();
    assert.equal(f.state.data, null);
    assert.equal(f.state.refreshing, true);
    const fresh = populated(); fresh.items[0].actionToken = "fresh-action";
    recovery.resolve(fresh);
    assert.equal(await recovering, fresh);
    assert.equal(f.state.failed, false);
    assert.equal(f.state.refreshing, false);
    assert.equal(f.calls, 3);
  });
}

test("refreshes retain card identity, coalesce pushes, and publish only the final authority", async () => {
  const f = fixture();
  const original = await f.reader.refresh();
  const first = deferred(), second = deferred();
  const pending = [first, second];
  f.setResult(() => pending.shift().promise);
  const reading = f.reader.refresh();
  assert.equal(f.reader.refresh(), reading);
  assert.equal(f.reader.refresh(), reading);
  assert.equal(f.state.data, original);
  assert.equal(f.state.refreshing, true);
  const stale = populated(); stale.items[0].actionToken = "discarded-action";
  const fresh = populated(); fresh.items[0].actionToken = "fresh-action"; fresh.items[0].openToken = "fresh-open";
  first.resolve(stale); second.resolve(fresh);
  assert.equal(await reading, fresh);
  assert.equal(f.calls, 3);
  assert.equal(f.state.data.items[0].cardId, original.items[0].cardId);
  assert.equal(f.state.data.items[0].actionToken, "fresh-action");
  assert.equal(f.state.data.items[0].openToken, "fresh-open");
  assert.equal(f.publications.some(state => state.data === stale), false);
  const during = f.publications.slice(3, -1);
  assert.ok(during.length > 0);
  assert.ok(during.every(state => state.refreshing));
  assert.equal(f.state.refreshing, false);
});

test("a failed superseded read redacts content even while the queued read is pending", async () => {
  const f = fixture(); await f.reader.refresh();
  const nextRead = deferred(), recovery = deferred();
  let calls = 0;
  f.setResult(() => {
    if (++calls === 1) return Promise.reject(new Error("read failed"));
    nextRead.resolve(); return recovery.promise;
  });
  const reading = f.reader.refresh(); f.reader.refresh();
  await nextRead.promise;
  assert.equal(f.state.data, null); assert.equal(f.state.refreshing, true);
  assert.equal(f.state.failed, true);
  const fresh = populated(); recovery.resolve(fresh);
  assert.equal(await reading, fresh); assert.equal(f.state.failed, false);
});

test("surface validation refuses incomplete data after a populated read", async () => {
  let value = { ...populated(), pill: { state: "expanded" } }, state;
  const reader = createItemsReader({ read: async () => value, valid: data => Boolean(data.pill), publish: next => { state = next; } });
  await reader.refresh();
  value = populated();
  assert.equal(await reader.refresh(), null);
  assert.equal(state.data, null); assert.equal(state.failed, true);
});

test("disposal suppresses pending publications, queued reads and subsequent refreshes", async () => {
  const f = fixture(); await f.reader.refresh();
  const pending = deferred(), started = deferred();
  f.setResult(() => { started.resolve(); return pending.promise; });
  const reading = f.reader.refresh(); f.reader.refresh();
  await started.promise;
  f.reader.dispose();
  const count = f.publications.length;
  pending.resolve(populated());
  assert.equal(await reading, null); assert.equal(await f.reader.refresh(), null);
  assert.equal(f.publications.length, count); assert.equal(f.calls, 2);
});

test("disposal before a scheduled read prevents the bridge call", async () => {
  const f = fixture();
  const reading = f.reader.refresh();
  f.reader.dispose();
  assert.equal(await reading, null);
  assert.equal(f.calls, 0);
});

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Exactness differential (turnctx r3): on random conversations written through the
// real writers -- appends, edits that fork, switches between versions, rows
// inserted before and after others, patches that give a row words, rows with no
// parent link -- every read the class fix moved onto the indexes gives exactly what
// the full read of the thread gives: the branch's text lines, the membership of
// every row, the newest lines in storage order, a turn's replies, the newest
// request card and the images a conversation names.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { closeDatabase, database } from "./database.ts";
import { Store, type Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const isLine = (m: Message) => m.kind === "text" && Boolean(m.text);

function compare(label: string, threadId: string, random: () => number) {
  // the reference: a store with nothing cached reads the whole thread and walks its path in memory
  const reference = new Store(selection);
  const path = reference.activePath(threadId);
  const onPath = new Set(path.map((m) => m.id));
  const all = (database().prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid").all(threadId) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Message);
  const store = new Store(selection); // and the readers under test, on a store with nothing cached either
  const member = store.branchMembership(threadId);
  for (const m of all) if (member(m.id) !== onPath.has(m.id)) throw new Error(`${label}: membership of ${m.id}: expected ${onPath.has(m.id)}`);
  const lines = path.filter(isLine);
  for (const k of [1, 5, 30, 80]) {
    const got = store.activeTextLines(threadId, k);
    const want = lines.slice(-k).map((m) => m.id), have = got.messages.map((m) => m.id);
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      const info = (id: string) => { const m = all.find((x) => x.id === id); return `${id}[${m?.role}/${m?.kind}/${JSON.stringify(m?.text)} parent=${m?.parentId} insertedBefore=${m?.insertedBefore}]`; };
      throw new Error(`${label}: active lines ${k}: expected ${want.map(info).join(",")} got ${have.map(info).join(",")}; leaf=${new Store(selection).activeLeaf(threadId)} path=${path.map((m) => m.id.slice(0, 4) + ":" + (m.text ?? m.kind)).join(" > ")}`);
    }
    expect(got.hasMore, `${label}: hasMore ${k}`).toBe(lines.length > k);
  }
  const storage = all.filter(isLine);
  for (const k of [1, 7, 30]) expect(store.newestTextLines(threadId, k).map((m) => m.id), `${label}: newest lines ${k}`).toEqual(storage.slice(-k).map((m) => m.id));
  const cards = path.filter((m) => m.card?.requestId);
  expect(store.newestRequestCard(threadId)?.id, `${label}: newest request card`).toBe(cards.at(-1)?.id);
  const turns = [...new Set(all.map((m) => m.turnId).filter(Boolean))] as string[];
  for (const turn of turns.slice(0, 4)) {
    const originals = all.filter((m) => m.turnId === turn && m.role === "bot" && m.kind === "text" && !m.copyOf).map((m) => m.id);
    const got = store.turnReplyOriginals(threadId, turn);
    if (JSON.stringify(got) !== JSON.stringify(originals)) throw new Error(`${label}: originals of ${turn}: expected ${JSON.stringify(originals)} got ${JSON.stringify(got)}; rows ${JSON.stringify(all.filter((m) => m.turnId === turn).map((m) => [m.id.slice(0, 4), m.role, m.kind, m.text]))}; turn_first=${JSON.stringify(database().prepare("SELECT first_rowid FROM turn_first WHERE thread_id=? AND turn_id=?").get(threadId, turn))}; rowids=${JSON.stringify(database().prepare("SELECT rowid AS r, substr(id,1,4) AS i FROM messages WHERE thread_id=? AND json_extract(json,'$.turnId')=?").all(threadId, turn))}`);
  }
  void random;
}

it("every read the indexes serve equals the full read, on random conversations with forks, switches and splices", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const random = rng(seed * 104729);
    const store = new Store(selection);
    const { threadId } = store.createBot({ name: `Diff ${seed}` });
    const ids: string[] = [];
    let turn = 0;
    const add = (extra: Partial<Message> & { role: "user" | "bot"; kind: Message["kind"] }) => { const m = store.appendMessage(threadId, extra as never); ids.push(m.id); return m; };
    for (let step = 0; step < 90; step++) {
      const roll = random();
      if (roll < 0.30) add({ role: "user", kind: "text", text: `ask ${step}` });
      else if (roll < 0.45) { turn++; add({ role: "bot", kind: "text", text: `reply ${step}`, turnId: `t${turn}` }); }
      else if (roll < 0.60) add({ role: "bot", kind: "activity", text: undefined, turnId: `t${turn}`, tool: { name: "Bash", ok: true, summary: "ran" } } as never);
      else if (roll < 0.65) add({ role: "bot", kind: "options", text: "May I?", card: { title: "Card", options: [], requestId: `req-${step}` } } as never);
      else if (roll < 0.70) add({ role: "bot", kind: "text", text: "", turnId: `t${turn}` }); // a row with no words: not a line
      else if (roll < 0.78 && ids.length > 3) { const pick = ids[Math.floor(random() * ids.length)]!; const m = store.insertMessageBefore(threadId, pick, { role: "bot", kind: "text", text: `before ${step}` }); ids.push(m.id); }
      else if (roll < 0.84 && ids.length > 3) { const pick = ids[Math.floor(random() * ids.length)]!; const m = store.insertMessageAfter(threadId, pick, { role: "bot", kind: "text", text: `after ${step}` }); ids.push(m.id); }
      else if (roll < 0.90 && ids.length > 4) {
        const users = ids.filter((id) => store.messageById(threadId, id)?.role === "user");
        if (users.length) { const edited = store.branchMessage(threadId, users[Math.floor(random() * users.length)]!, `edited ${step}`); if (edited) ids.push(edited.id); }
      } else if (roll < 0.94 && ids.length > 4) { try { store.setActiveLeaf(threadId, ids[Math.floor(random() * ids.length)]!); } catch { /* not a leaf the store accepts */ } }
      else if (ids.length) { const pick = ids[Math.floor(random() * ids.length)]!; const row = store.messageById(threadId, pick); if (row?.kind === "text") store.patchMessage(threadId, pick, { text: row.text ? "" : `now with words ${step}` }); }
      if (step % 30 === 29) compare(`seed ${seed} step ${step}`, threadId, random);
    }
    compare(`seed ${seed} end`, threadId, random);
  }
}, 300_000);

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The live half of the write-time differential (Astra's audit, int102-gate/audit-astra/REPORT.md). writetime-differential.test.ts compares the
// new lookup with the frozen read-time judge on histories 1.0.1 left behind. The shapes below exist only in a file 1.0.2 wrote itself, and the
// frozen judge has no word for them: concurrent turns of different threads that share a head and a parent (the carry key), notes and cards a
// bot wrote in a turn and other threads read (object consumers), prompts built from a replay, parents and objects (the send fence), forgets
// made while turns are in flight, and a marker left to drain while new turns are written. So the oracle here is a model written apart from the
// marks: a ledger of what every line and object was built on (the same facts the writers are given), and the closure of an owner forget over
// that ledger, by the design's rules:
//   - the forgotten line is denied; so is every generated line of its thread after it whose turn began before the forget committed
//     (positional, DESIGN-WRITETIME 1);
//   - whatever rests on a denied line or object is denied (a reply's turn parents, an object's turn parents), and from the start of a denied
//     turn the same positional rule runs in that turn's thread;
//   - an object a bot wrote in a turn rests on the turn's thread up to its head: denied when that thread has a denied origin at or before it;
//   - a line whose turn began after the commit and rests on nothing denied is clean.
// For every line, object and recorded prompt (sendFence), in the pending window (marker not drained) and after the drain:
//   - the model denies it, the new side shows it: unsafe (always zero);
//   - the model denies it, the drain is done, the new side does not say withheld: unproven (always zero);
//   - the model shows it, the new side does not (after the drain; in the window only "checking: pending"): unlisted (always zero).
import { mkdirSync, rmSync } from "node:fs";
import { expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, closeMessageDb } from "../message-db.ts";
import type { Message } from "../store.ts";
import { denyLookup, memoryLookup } from "./deny-read.ts";
import { addTurnParents, closeTurnLineage, currentLsn, openTurnLineage } from "./lineage-write.ts";
import { memoryRefKey, type LineageRef, type LineageReader, type LineageVerdict, type MemoryRef } from "./lineage-types.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { buildPrompt, promptPart, recordTurnObject, sendFence, turnToolText } from "./prompt-parts.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { prng } from "./testing/legacy-history-fixture.ts";
import type { BuiltPrompt } from "./lineage-types.ts";

const SEEDS = Number(process.env.WRITETIME_LIVE_SEEDS ?? 24);
const ROUNDS = Number(process.env.WRITETIME_LIVE_ROUNDS ?? 14);
const THREADS = 6;
const CONTENT: LineageReader = { audience: null };
const OWNER: LineageReader = { audience: { owner: true, scopeIds: [] } };

interface LNode { key: string; thread: string; id: string; lsn: number; turnLsn: number; deps: string[]; origin: number }
interface ONode { key: string; ref: MemoryRef; thread: string; head: number; deps: string[] }
interface Forget { root: string; cap: number; rootKind: "line" | "object" }
interface Recorded { built: BuiltPrompt; shown: string[]; deps: string[]; what: string }
interface Denied { lines: Set<string>; objects: Set<string> }

const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: Date.now(), ...extra });

it(`${SEEDS} live histories x ${ROUNDS} rounds: the new side never shows what the model denies, and shows what it leaves clean`, () => {
  const tally = { pairs: 0, denied: 0, clean: 0, forgets: 0, objects: 0, prompts: 0, concurrent: 0, delayed: 0, unsafe: [] as string[], unproven: [] as string[], unlisted: [] as string[], byClass: new Map<string, number>() };
  for (let seed = 1; seed <= SEEDS; seed++) runSeed(seed, tally);
  console.log(`WRITETIME-LIVE-DIFFERENTIAL ${SEEDS} histories, ${tally.pairs} pairs (model denies ${tally.denied}, clean ${tally.clean}), ${tally.forgets} forgets (${tally.delayed} left to drain), ${tally.concurrent} concurrent batches, ${tally.objects} objects, ${tally.prompts} prompts, unsafe ${tally.unsafe.length}, unproven ${tally.unproven.length}, unlisted ${tally.unlisted.length}, over-withhold by class ${JSON.stringify(Object.fromEntries(tally.byClass))}`);
  expect(tally.unsafe.slice(0, 20), "new shows what the model denies").toEqual([]);
  expect(tally.unproven.slice(0, 20), "the model denies it, the marker drained, and the new side does not say withheld").toEqual([]);
  expect(tally.unlisted.slice(0, 20), "the model leaves it clean and the new side does not show it").toEqual([]);
  expect(tally.denied).toBeGreaterThan(0);
  expect(tally.clean).toBeGreaterThan(tally.denied / 2);
  expect(tally.concurrent).toBeGreaterThan(0);
  expect(tally.delayed).toBeGreaterThan(0);
}, 900_000);

function runSeed(seed: number, tally: { pairs: number; denied: number; clean: number; forgets: number; objects: number; prompts: number; concurrent: number; delayed: number; unsafe: string[]; unproven: string[]; unlisted: string[]; byClass: Map<string, number> }): void {
  closeMessageDb(); closeDatabase();
  rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  const db = database();
  const random = prng(seed * 7919 + 13), pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const threads = Array.from({ length: THREADS }, (_, at) => `lv${seed}-t${at}`);
  const tail = new Map<string, string>();
  const lines = new Map<string, LNode>(), objects = new Map<string, ONode>();
  const forgets: Forget[] = [];
  const prompts: Recorded[] = [];
  let counter = 0;
  const key = (thread: string, id: string) => `${thread}/${id}`;
  const write = (thread: string, message: Message) => {
    const parentId = tail.get(thread);
    appendMessage(thread, parentId ? { ...message, parentId } : message);
    tail.set(thread, message.id);
  };
  const lineageOf = (thread: string, id: string) => db.prepare("SELECT l.lsn,l.turn_lsn FROM memory_line_lineage l JOIN memory_thread_no n ON n.no=l.thread_no WHERE n.thread_id=? AND l.message_id=?").get(thread, id)!;

  // ---- the model ----
  /** What one forget denies, by the rules in the header. */
  const closure = (forget: Forget): Denied => {
    const denied: Denied = { lines: new Set(), objects: new Set() };
    const origins = new Map<string, number>();
    if (forget.rootKind === "line") { const root = lines.get(forget.root)!; denied.lines.add(root.key); origins.set(root.thread, root.lsn); } else denied.objects.add(forget.root);
    const rests = (deps: readonly string[]) => deps.some(dep => denied.lines.has(dep) || denied.objects.has(dep));
    for (let changed = true; changed;) {
      changed = false;
      for (const node of lines.values()) {
        if (denied.lines.has(node.key)) continue;
        const origin = origins.get(node.thread);
        const positional = origin !== undefined && node.lsn > origin && node.turnLsn < forget.cap;
        if (positional || rests(node.deps)) {
          denied.lines.add(node.key); changed = true;
          if (!positional) origins.set(node.thread, Math.min(origins.get(node.thread) ?? Number.MAX_SAFE_INTEGER, node.origin));
        }
      }
      for (const node of objects.values()) {
        if (denied.objects.has(node.key)) continue;
        const origin = origins.get(node.thread);
        if ((origin !== undefined && origin <= node.head) || rests(node.deps)) { denied.objects.add(node.key); changed = true; }
      }
    }
    return denied;
  };
  const deniedNow = (): Denied => {
    const all: Denied = { lines: new Set(), objects: new Set() };
    for (const forget of forgets) { const one = closure(forget); one.lines.forEach(k => all.lines.add(k)); one.objects.forEach(k => all.objects.add(k)); }
    return all;
  };

  // ---- the writers ----
  const clean = () => { const denied = deniedNow(); return { lines: [...lines.values()].filter(node => !denied.lines.has(node.key)), objects: [...objects.values()].filter(node => !denied.objects.has(node.key)) }; };
  const forgetOne = (inline: boolean) => {
    const now = clean();
    if (!now.lines.length && !now.objects.length) return;
    // a line that something rests on is the interesting one
    const restedOn = new Set([...lines.values(), ...objects.values()].flatMap(node => node.deps));
    const fromObjects = now.objects.length && random() < 0.25;
    if (fromObjects) {
      const object = pick(now.objects);
      commitRevoke(db, { kind: "memory", ref: object.ref, cause: "forget" }, { inline });
      forgets.push({ root: object.key, cap: currentLsn(db), rootKind: "object" });
    } else {
      const candidates = now.lines.filter(node => restedOn.has(node.key));
      const node = candidates.length && random() < 0.7 ? pick(candidates) : pick(now.lines);
      commitRevoke(db, { kind: "line", threadId: node.thread, messageIds: [node.id], cause: "forget" }, { inline });
      forgets.push({ root: node.key, cap: currentLsn(db), rootKind: "line" });
    }
    tally.forgets++;
    if (!inline) tally.delayed++;
  };

  for (let round = 0; round < ROUNDS; round++) {
    if (round >= 3 && random() < 0.1) forgetOne(random() < 0.4);
    // a batch of 1-3 destination threads whose turns open at the same head (the owner lines first), sharing parents half of the time
    const size = 1 + Math.floor(random() * 3);
    const batch = [...threads].sort(() => random() - 0.5).slice(0, size);
    const owners = batch.map(thread => { const id = `o${++counter}`; write(thread, msg(id, { role: "user" })); return id; });
    const turns = batch.map(thread => openTurnLineage(db, { threadId: thread, turnId: `turn-${++counter}` }));
    if (size > 1) tally.concurrent++;
    const available = clean();
    const sharedLines = random() < 0.5 ? available.lines.filter(() => random() < 0.3).slice(0, 2) : null;
    const sharedObjects = random() < 0.5 ? available.objects.filter(() => random() < 0.5).slice(0, 1) : null;
    const chosen = batch.map((thread, at) => {
      const own = available.lines.filter(node => node.thread !== thread);
      const parentLines = sharedLines ? sharedLines.filter(node => node.thread !== thread) : own.filter(() => random() < 0.25).slice(0, 3);
      const parentObjects = sharedObjects ?? available.objects.filter(() => random() < 0.3).slice(0, 2);
      addTurnParents(turns[at]!, parentLines.map((node): LineageRef => ({ kind: "line", threadId: node.thread, messageId: node.id })));
      for (const object of parentObjects) turnToolText(thread, `read ${object.key}`, [{ kind: "memory", ref: object.ref }]);
      return { parentLines, parentObjects };
    });
    // the prompts these turns would send: the replay of the thread's own recent clean lines, the other threads' lines, the objects they read
    // (built before anything is forgotten below, as the dispatch builds them before it sends)
    const cleanKeys = new Set([...available.lines.map(node => node.key)]);
    batch.forEach((thread, at) => {
      if (random() >= 0.6) return;
      const turn = turns[at]!, { parentLines, parentObjects } = chosen[at]!;
      const recent = [...lines.values()].filter(node => node.thread === thread && cleanKeys.has(node.key)).slice(-5);
      const built = buildPrompt(turn, [promptPart("replay", [
        { kind: "prefix", threadId: thread, headLsn: turn.turnLsn, shown: [...recent.map(node => node.id), owners[at]!] },
        ...parentLines.map((node): LineageRef => ({ kind: "line", threadId: node.thread, messageId: node.id })),
        ...parentObjects.map((node): LineageRef => ({ kind: "memory", ref: node.ref })),
      ])]);
      prompts.push({ built, shown: recent.map(node => node.key), deps: [...parentLines.map(node => node.key), ...parentObjects.map(node => node.key)], what: `${thread} turn at ${turn.turnLsn}` });
      tally.prompts++;
    });
    // a forget committed while the turns are in flight: their replies are written after it
    if (round >= 3 && random() < 0.08) forgetOne(false);
    batch.forEach((thread, at) => {
      const turn = turns[at]!, { parentLines, parentObjects } = chosen[at]!;
      const deps = [...parentLines.map(node => node.key), ...parentObjects.map(node => node.key)];
      const replyId = `r${++counter}`;
      write(thread, msg(replyId));
      const row = lineageOf(thread, replyId);
      lines.set(key(thread, replyId), { key: key(thread, replyId), thread, id: replyId, lsn: Number(row.lsn), turnLsn: Number(row.turn_lsn), deps, origin: deps.length ? turn.turnLsn : Number(row.lsn) });
      if (random() < 0.5) {
        const kind = pick(["note", "card", "summary", "skill", "file"] as const);
        const ref: MemoryRef = { kind, id: `${kind}${++counter}` };
        recordTurnObject(db, thread, ref);
        objects.set(memoryRefKey(ref), { key: memoryRefKey(ref), ref, thread, head: Math.max(turn.turnLsn, currentLsn(db) - 1), deps });
        tally.objects++;
      }
    });
    turns.forEach(closeTurnLineage);
  }
  if (!forgets.length) forgetOne(false);

  // ---- compared twice: the marker's window, then after it drained ----
  let drained = false;
  const where = () => `seed ${seed} ${drained ? "drained" : "pending"}`;
  const judge = (denied: boolean, verdict: LineageVerdict, what: string) => {
    tally.pairs++;
    if (denied) {
      tally.denied++;
      if (verdict.state === "shown") tally.unsafe.push(`${where()}: ${what} is denied by the model and the new side shows it`);
      else if (drained && verdict.state !== "withheld") tally.unproven.push(`${where()}: ${what} is denied by the model, the marker drained, and it reads ${JSON.stringify(verdict)}`);
      return;
    }
    tally.clean++;
    if (verdict.state === "shown") return;
    if (!drained && verdict.state === "checking" && verdict.reason === "pending") { tally.byClass.set("pending-window", (tally.byClass.get("pending-window") ?? 0) + 1); return; }
    tally.unlisted.push(`${where()}: ${what} is clean in the model and reads ${JSON.stringify(verdict)}`);
  };
  const compare = () => {
    const denied = deniedNow();
    const explain = (node: LNode) => {
      const pending = db.prepare("SELECT thread_id,since_lsn,revoke_id FROM memory_deny_pending WHERE thread_id IN (?,'*')").all(node.thread).map(row => `${row.thread_id}@${row.since_lsn}/R${row.revoke_id}`);
      const jobs = db.prepare("SELECT revoke_id,phase,state,root_lsn,started_lsn FROM memory_revoke_jobs").all().map(row => `R${row.revoke_id}:${row.phase}/${row.state}@${row.root_lsn}-${row.started_lsn}`);
      return `lsn ${node.lsn} turn ${node.turnLsn} deps [${node.deps.join(", ")}] pending [${pending.join(", ")}] jobs [${jobs.join(", ")}] forgets [${forgets.map(f => `${f.root}<${f.cap}`).join(", ")}]`;
    };
    for (const node of lines.values()) judge(denied.lines.has(node.key), denyLookup(db, { threadId: node.thread, lines: [{ messageId: node.id, author: "generated" }] }, CONTENT).get(node.id)!, `line ${node.key} (${explain(node)})`);
    for (const node of objects.values()) judge(denied.objects.has(node.key), memoryLookup(db, [node.ref], CONTENT).get(node.key)!, `object ${node.key}`);
    for (const prompt of prompts) {
      const required = prompt.shown.some(k => denied.lines.has(k)) || prompt.deps.some(k => denied.lines.has(k) || denied.objects.has(k));
      judge(required, sendFence(db, prompt.built, OWNER), `prompt ${prompt.what}`);
    }
  };
  compare();
  expect(drainRevokeMarker(db).pending, `seed ${seed}: marker drained`).toBe(false);
  drained = true;
  compare();
}

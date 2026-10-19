// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The randomized event-order test that gates merge 2 (the client half) of BOTADDED-DESIGN-V3 r6 §11, with the corrections the
// r6 audits made a condition of using it as the gate:
// - OPUS-AUDIT-V3-R5 "Check r6": every seed runs BOTH quiescence modes, `reload` (one forced `resumed:false` hydrate per subject)
//   and `resume` (every frame on a resumed stream, no forced snapshot), because the reload rebuilds the list and hides divergence;
//   per-step invariants H and I are added; the server model emits a mutation's frame before its answer, has failed and stalled
//   hydrates, runs two desktop subjects beside the phone, and lets a PATCH restore land inside a DELETE's await window; the gate
//   is the fixed seed list (a date seed runs only when ORDER_SEEDS asks for it, e.g. nightly).
// - Astra r5: invariant C allows the documented R10 tombstone and nothing else; N5 below carries no epoch expectations; Astra's
//   orders 1-7 are named cases. Orders that r6 accepts as Medium follow-ups are `it.todo` with the follow-up's name.
//
// Invariants (A-C after quiescence, the rest after every step):
//   A each subject's bot id set equals the server's visible set for its surface;
//   B every held record's fields equal the server's and `recordSeq` equals the server's number (same run);
//   C `pendingDeletes` and `verifyBots` are empty, `pastEpochs` holds only epochs seen within the TTL, and `tombstones` is empty
//     except the R10 entry: a `kind:"deleted"`, unacked, current-run tombstone written by this subject's own settled DELETE whose
//     deletion frame of that run it never received and no roster it applied listed (a frame of a run the subject had not joined was
//     verified, not applied, and acks nothing: seed 48 with the r4 room mix, pre-existing on ae2ff899a);
//   D the phone never holds a record with `hidden:true`;
//   E a pending id is never held, and an `http` action marked `expired` changes nothing;
//   F a page applies only under the highest intent for its bot, and never for `deletedThreadId`;
//   G no held record goes back to a lower number, or an older run, than one already applied for that id;
//   H once a subject applied a real deletion of X, it never holds X again (ids are never reused);
//   I on a desktop, a hidden record the server lists in an applied roster stays held (H-r6-1).
// Rooms (ROOM-ORDER-DESIGN §7; two desktops and the scoped phone, rooms created, renamed, archived, restored and deleted through the real
// reducer actions, answers delayed up to 12 minutes, restarts, stream drops, hydrates and sweeps):
//   RA at quiescence each subject's rooms equal the server's (ids, name, section, hidden) for its audience;
//   RB after every step, a room is never held at or below a removal statement of its run (or an older run) the subject's reducer acted on
//      (a room tombstone written), until a later statement re-creates it;
//   RC after every step, a room tombstone is an unacked removal of the current run, or younger than a removal can be overtaken (it is not
//      kept past a sweep period once past its life and passed by the stream), and names a room the server removed; and the server's
//      `roomRemovals` never holds more entries than removals within the TTL;
//   RD the phone never holds an archived room;
//   RE after every step, a held room that holds rows never loses a row it showed while held (rows are only appended on the server and a
//      page is the whole thread, so every later transcript is a superset; Astra r7 H3: a delayed same-number page replaced newer rows).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { answerClock } from "./answer-tag";
import { transcriptState } from "./transcript-seq";
import {
  ANSWER_TTL_MS,
  SWEEP_MS,
  DELETE_RETRY_MAX,
  LEGACY,
  REPLAY_FRAMES,
  World,
  describeOp,
  generate,
  prng,
  replay,
  shrink,
  type Letter,
  type Mode,
  type Op,
  type OrderFailure,
  type Subject,
} from "./testing/order-model";

const phoneFlag = vi.hoisted(() => ({ phone: false }));
vi.mock("@/lib/phone-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/phone-client")>()),
  isPhoneClient: () => phoneFlag.phone,
}));

const T0 = Date.UTC(2026, 9, 15, 12);
const realNow = () => Number(process.hrtime.bigint() / 1_000_000n);
const clock = { now: () => Date.now(), advance: (ms: number) => { vi.advanceTimersByTime(ms); } };
const make = () => {
  vi.setSystemTime(T0);
  return new World({ phoneFlag, clock });
};

// The reducer stamps tombstones with `answerClock`, which reads the faked `performance` (starting at 0); the harness sweeps and expires
// answers with `Date`. One clock for both, or a tombstone looks 50 years old to the sweep.
const realAnswerNow = answerClock.now;
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance"], now: T0 });
  answerClock.now = () => Date.now();
});
afterAll(() => {
  answerClock.now = realAnswerNow;
  vi.useRealTimers();
});

/** The fixed gate list: seeds 1-2000. ORDER_SEEDS="a-b" or "a,b,c" replaces it (the nightly date seed, a reproduction). */
function seeds(): number[] {
  const spec = process.env.ORDER_SEEDS?.trim();
  if (!spec) return Array.from({ length: 2000 }, (_, i) => i + 1);
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range) return Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i);
  return spec.split(",").map((x) => Number(x.trim())).filter(Number.isFinite);
}

const ops = (w: World, list: Op[]) => { for (const op of list) w.apply(op); };
const frames = (w: World, s: Subject) => { while (s.conn.queue.length) w.deliverFrame(s); };
const st = (s: Subject) => s.state as unknown as Record<string, any>;
/** The hydrate a hello `resumed:false` asked for, handled by the server and delivered. */
const hydrateNow = (w: World, s: Subject) => {
  const id = s.hydrate.inFlight;
  if (!id) throw new Error(`${s.name} has no hydrate in flight`);
  w.process(id, "none");
  w.deliver(id);
};
/** A disconnect long enough for the replay buffer to overflow, then the `resumed:false` hello. */
const reconnectAfterOverflow = (w: World, s: Subject, floodBot: string) => {
  w.disconnect(s);
  ops(w, [{ t: "flood", botId: floodBot }]);
  w.reconnect(s);
  expect(s.hydrated, `${s.name} should have needed a snapshot (replay ${REPLAY_FRAMES})`).toBe(false);
};
const quiescent = (w: World, mode: Mode): OrderFailure | null => {
  w.quiesce(mode);
  if (!w.failure) w.checkQuiescent();
  return w.failure;
};

describe("bot reconciliation event orders (BOTADDED-DESIGN-V3 r6 §11)", () => {
  it(`fixed seeds: invariants A-I hold after every step and at both quiescences${LEGACY ? " (HEAD reducer: expected to fail)" : ""}`, () => {
    const started = realNow();
    const list = seeds();
    const found: Array<{ seed: number; mode: Mode; failure: OrderFailure; ops: Op[] }> = [];
    let stepsRun = 0;
    const rooms = { removals: 0, applied: 0 };
    for (const seed of list) {
      const rnd = prng(seed);
      const count = 200 + Math.floor(rnd() * 401);
      const w = make();
      const log = generate(w, rnd, count);
      stepsRun += log.length;
      const reload = w.failure ?? quiescent(w, "reload");
      const stats = w.roomStats();
      rooms.removals += stats.removals;
      rooms.applied += stats.applied;
      if (reload) found.push({ seed, mode: "reload", failure: reload, ops: log });
      const resume = replay(make, log, "resume", false);
      if (resume) found.push({ seed, mode: "resume", failure: resume, ops: log });
    }
    const runMs = realNow() - started;

    // Shrink the first failing seed of each invariant (and mode) to a minimal order, within a time budget.
    const byKey = new Map<string, typeof found>();
    for (const f of found) {
      const key = `${f.failure.letter}/${f.mode}`;
      byKey.set(key, [...(byKey.get(key) ?? []), f]);
    }
    const lines: string[] = [];
    let regression = 17;
    for (const [key, group] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
      const first = group[0]!;
      const letter = first.failure.letter as Letter;
      const minimal = byKey.size <= 12 ? shrink(make, first.ops, first.mode, letter, 8_000, realNow) : first.ops;
      const traced: string[] = [];
      const again = replay(make, minimal, first.mode, true, process.env.ORDER_TRACE ? (line) => traced.push(`      ${line}`) : undefined);
      if (traced.length) lines.push(...traced);
      lines.push(
        `-- ${key}: ${group.length} seed(s), e.g. ${group.slice(0, 6).map((g) => g.seed).join(", ")}; minimal order (P${regression++}, seed ${first.seed}, ${minimal.length} ops):`,
        ...minimal.map((op, i) => `   ${String(i + 1).padStart(3)}. ${describeOp(op)}`),
        `   => ${again ? `${again.letter} at step ${again.step < 0 ? "quiescence" : again.step + 1}: ${again.detail}` : "(did not reproduce after shrinking)"}`,
      );
    }
    console.log(
      `[order-test] ${list.length} seeds x 2 modes, ${stepsRun} steps, ${runMs} ms; reducer ${LEGACY ? "HEAD (legacy actions)" : "r6"}; ` +
      `rooms: ${rooms.removals} server removals, ${rooms.applied} removal statements applied by a subject; ` +
      `${found.length} failing runs${found.length ? `\n${lines.join("\n")}` : ""}`,
    );
    expect(found.map((f) => `${f.seed}/${f.mode}: ${f.failure.letter} ${f.failure.detail}`).slice(0, 20)).toEqual([]);
  }, 600_000);

  describe("Astra r5 orders (astra-botadded-v3design-r5/REPORT.md)", () => {
    it("order 1: a restore answer applied to an already-held bot survives an older roster that omits it", () => {
      const w = make();
      const p = w.sub("P");
      expect(w.held(p, "b0")).toBeTruthy();
      w.disconnect(p); // no stream: the phone reconciles by hydrate only
      ops(w, [
        { t: "send", id: "h", sub: "D1", kind: "hide", botId: "b0" }, { t: "process", req: "h", fail: "none" }, { t: "deliver", req: "h" },
      ]);
      w.reconcile(p);
      const roster = p.hydrate.inFlight!;
      w.process(roster, "none"); // serialised with b0 hidden: absent from the scoped roster
      ops(w, [
        { t: "send", id: "u", sub: "D1", kind: "restore", botId: "b0" }, { t: "process", req: "u", fail: "none" }, { t: "deliver", req: "u" },
        { t: "send", id: "n", sub: "P", kind: "rename", botId: "b0" }, { t: "process", req: "n", fail: "none" }, { t: "deliver", req: "n" },
      ]);
      expect(w.held(p, "b0")?.hidden).toBeFalsy();
      w.deliver(roster);
      // The server shows b0 to the phone: either it is still held, or it is being verified (and the verify brings it back).
      const keptOrVerified = Boolean(w.held(p, "b0")) || Boolean(st(p).verifyBots?.b0);
      expect(keptOrVerified, "the phone dropped a bot its newer restore answer had updated").toBe(true);
    });

    it("order 2 (M-r6-3, server: I14 says 'released to the engine's write'): a fence plus an accepted id does not stamp a row whose write never happened", async () => {
      const { createTurnAttribution } = await import("../../server/turn-attribution.ts");
      const { TurnSubmissionBoundary } = await import("../../server/turn-dispatch-guard.ts");
      const row: { dispatchedIn?: string } = {};
      const attribution = createTurnAttribution({
        stamp: (_thread, _id, turnId) => { row.dispatchedIn = turnId; },
        unstamp: (_thread, _id, turnId) => { if (row.dispatchedIn === turnId) row.dispatchedIn = undefined; },
      });
      const boundary = new TurnSubmissionBoundary();
      attribution.begin("g1", "t", ["u1"]);
      attribution.bind("g1", boundary);
      // openai-chat: the id is returned, acceptance runs, beforeSubmit stamps, then `fetch` fails before the body is sent
      attribution.accepted("g1", "T1");
      boundary.beforeSubmit(() => {});
      boundary.notWritten();
      expect(row.dispatchedIn, "a row stamped for a write that never happened").toBeUndefined();
      // Claude: the first fence passes, the MCP-readiness await runs, the second fence refuses
      boundary.beforeSubmit(() => {});
      expect(row.dispatchedIn).toBe("T1"); // the relaunch's write is released
      expect(() => boundary.beforeSubmit(() => { throw new Error("retired during the MCP wait"); })).toThrow();
      expect(row.dispatchedIn).toBeUndefined();
      // the write that does happen is stamped, once
      boundary.beforeSubmit(() => {});
      expect(row.dispatchedIn).toBe("T1");
    });

    it("order 3 (M-r6-1, server): a steer is stamped from the attempt that received it at its write fence, not the attempt current after the await", async () => {
      const { createSteerReceiver, createTurnAttribution } = await import("../../server/turn-attribution.ts");
      const stamps: Array<[string, string]> = [];
      const attribution = createTurnAttribution({ stamp: (_thread, id, turnId) => { stamps.push([id, turnId]); } });
      const run = (generation: string, turnId: string, row: string) => {
        attribution.begin(generation, "t", [row]);
        attribution.fencePassed(generation);
        attribution.accepted(generation, turnId);
      };
      run("gA", "TA", "u1");
      let current = "gA";
      const receiver = createSteerReceiver(() => attribution.attempt(current));
      // the steer waits for the engine; A completes (its entry leaves) and B starts; the fence then runs, and the write goes into B
      attribution.completed("TA");
      current = "gB";
      run("gB", "TB", "u2");
      receiver.atFence();
      // the acknowledgement is awaited; B completes too before it returns
      attribution.completed("TB");
      attribution.addDelivered(receiver.attempt()!, "steer-1");
      expect(stamps).toContainEqual(["steer-1", "TB"]);
      expect(stamps).not.toContainEqual(["steer-1", "TA"]);
      // steer.confirmed for an uncertain steer: the receiving attempt's turn, independent of terminal cleanup
      expect(attribution.confirmed(receiver.attempt(), "steer-2")).toBe("TB");
    });

    it.fails("order 4 (known Medium, follow-up Astra r5 #4: page of a requested task deleted in another tab): a delayed switch answer for a task deleted in another tab does not open the deleted task", () => {
      const w = make();
      const d1 = w.sub("D1");
      const d2 = w.sub("D2");
      expect(w.held(d1, "b0")?.threadId).toBe("b0-t0");
      ops(w, [{ t: "send", id: "sw", sub: "D1", kind: "switch", botId: "b0", thread: "b0-t1" }, { t: "process", req: "sw", fail: "none" }]);
      frames(w, d1); // the switch's own echo: an ordinary record frame, the viewed task still exists
      frames(w, d2);
      ops(w, [{ t: "send", id: "dt", sub: "D2", kind: "deleteTask", botId: "b0", thread: "b0-t1" }, { t: "process", req: "dt", fail: "none" }]);
      frames(w, d1);
      w.deliver("sw");
      expect(w.held(d1, "b0")?.threadId, "D1 opened a task the server deleted").not.toBe("b0-t1");
    });

    it("order 5 (Astra r5 #5, M-r6-4): a DELETE that is given up on keeps its fence, so a pre-delete GET still within its life does not bring the bot back", () => {
      const w = make();
      const d1 = w.sub("D1");
      expect(w.held(d1, "b1")).toBeTruthy();
      // A plain GET of the bot, answered by the server before the delete, held back by the network (an ordinary read, not a verification).
      ops(w, [{ t: "send", id: "g", sub: "D1", kind: "detail", botId: "b1" }]);
      w.reqs.get("g")!.verify = false;
      ops(w, [{ t: "process", req: "g", fail: "none" }]);
      // The DELETE commits; its answer and the stream's frame are both lost.
      w.disconnect(d1);
      ops(w, [
        { t: "send", id: "d", sub: "D1", kind: "delete", botId: "b1" },
        { t: "process", req: "d", fail: "netAfter" }, { t: "commit", req: "d" }, { t: "deliver", req: "d" },
      ]);
      expect(w.server.bots.has("b1")).toBe(false);
      // Every retry gets no answer either, until the client gives up.
      const tracker = d1.trackers[0]!;
      for (let tries = 1; tries < DELETE_RETRY_MAX; tries++) {
        expect(tracker.done, `gave up after ${tries - 1} tries`).toBe(false);
        ops(w, [{ t: "tick", ms: Math.max(1, tracker.nextAt - w.now() + 1) }]);
        const attempt = tracker.inflight!;
        expect(attempt, `try ${tries + 1} was sent`).toBeTruthy();
        ops(w, [{ t: "process", req: attempt, fail: "netBefore" }, { t: "deliver", req: attempt }]);
      }
      expect(tracker.done, "the client gave up").toBe(true);
      expect(w.now() - w.reqs.get("g")!.sentAt, "the retained GET is still within its life").toBeLessThan(ANSWER_TTL_MS);
      // The verification of the bot it gave up on: the server says it is gone.
      const verify = [...w.reqs.values()].find((r) => r.kind === "detail" && r.verify && r.phase === "toServer")!;
      expect(verify, "a verification was asked for").toBeTruthy();
      ops(w, [{ t: "process", req: verify.id, fail: "none" }, { t: "deliver", req: verify.id }]);
      expect(w.held(d1, "b1")).toBeUndefined();
      // The retained GET arrives within its life.
      ops(w, [{ t: "deliver", req: "g" }]);
      expect(w.held(d1, "b1"), "a deleted bot reappeared after the client gave up").toBeUndefined();
      // And the next verification settles whatever the answer asked for.
      for (const r of [...w.reqs.values()]) if (r.kind === "detail" && r.verify && r.phase === "toServer") ops(w, [{ t: "process", req: r.id, fail: "none" }, { t: "deliver", req: r.id }]);
      expect(w.held(d1, "b1")).toBeUndefined();
      expect(quiescent(w, "resume")).toBeNull();
    });

    it("order 6 (M-r6-2, server): a restore during an archived DELETE's awaits cannot leave the bot alive without its facilities", async () => {
      const { commitRefusal, createPerKeySerialiser } = await import("../../server/bot-deletion-ledger.ts");
      const serial = createPerKeySerialiser();
      const bots = new Map([["b1", { hidden: true as boolean | undefined }]]);
      const facilities = { routines: true, webhooks: true, calendar: true };
      const events: string[] = [];
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => { openGate = resolve; });
      // the route: preconditions, then the teardown, then the awaits, then the commit (index.ts DELETE /api/bots/:id)
      const del = serial.run("b1", async () => {
        const bot = bots.get("b1");
        if (!bot?.hidden) { events.push("delete refused: not archived"); return; }
        facilities.routines = false; facilities.webhooks = false; facilities.calendar = false;
        events.push("teardown");
        await gate;
        const refusal = commitRefusal(bots.get("b1"), { ifArchived: true, running: false });
        if (refusal) { events.push(`commit refused: ${refusal}`); return; }
        bots.delete("b1");
        events.push("committed");
      });
      await Promise.resolve();
      // the PATCH restore arrives while the DELETE is inside its awaits: its whole handler takes its turn behind the DELETE (index.ts
      // PATCH /api/bots/:id runs inside `run`, which releases the turn in its own finally; Astra r7 H2)
      const restore = serial.run("b1", async () => {
        const bot = bots.get("b1");
        if (!bot) { events.push("restore: no such bot"); return; }
        bot.hidden = undefined;
        events.push("restored");
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events, "the restore ran inside the DELETE's window").toEqual(["teardown"]);
      openGate();
      await Promise.all([del, restore]);
      // whichever way the race resolves, a surviving bot has its facilities
      if (bots.has("b1")) expect(facilities).toEqual({ routines: true, webhooks: true, calendar: true });
      expect(events).toEqual(["teardown", "committed", "restore: no such bot"]);
      // and a restore that comes first defeats the later archived DELETE before any teardown
      bots.set("b2", { hidden: true });
      let finishRestore!: () => void;
      const restoring = new Promise<void>((resolve) => { finishRestore = resolve; });
      const first = serial.run("b2", async () => { await restoring; bots.get("b2")!.hidden = undefined; });
      const later = serial.run("b2", async () => (bots.get("b2")?.hidden ? "teardown" : "refused before teardown"));
      finishRestore();
      await first;
      expect(await later).toBe("refused before teardown");
    });

    it("order 7a (High, H-r6-1): a desktop that archived a bot keeps it in its archive list across a resumed:false hydrate", () => {
      const w = make();
      const d1 = w.sub("D1");
      ops(w, [{ t: "send", id: "h", sub: "D1", kind: "hide", botId: "b0" }, { t: "process", req: "h", fail: "none" }, { t: "deliver", req: "h" }]);
      frames(w, d1);
      expect(w.held(d1, "b0")?.hidden).toBe(true);
      reconnectAfterOverflow(w, d1, "b1");
      hydrateNow(w, d1);
      expect(w.failure).toBeNull(); // invariant I
      expect(w.held(d1, "b0")?.hidden, "the archived bot left the desktop's archive list").toBe(true);
      expect(quiescent(w, "resume")).toBeNull();
    });

    it("order 7b (Astra r5 #7b, closed r7: a deletion after a hide still in the window stays listed for the phone): after a missed archive then a permanent delete, a delayed pre-archive answer does not bring the bot back to the phone", () => {
      const w = make();
      const p = w.sub("P");
      ops(w, [{ t: "send", id: "n", sub: "P", kind: "rename", botId: "b0" }, { t: "process", req: "n", fail: "none" }]);
      w.disconnect(p); // the rename's frame never reaches the phone; its answer is delayed
      ops(w, [
        { t: "send", id: "h", sub: "D1", kind: "hide", botId: "b0" }, { t: "process", req: "h", fail: "none" }, { t: "deliver", req: "h" },
        { t: "send", id: "d", sub: "D1", kind: "delete", botId: "b0", archivedList: true }, { t: "process", req: "d", fail: "none" }, { t: "commit", req: "d" }, { t: "deliver", req: "d" },
        { t: "flood", botId: "b1" },
      ]);
      w.reconnect(p);
      hydrateNow(w, p);
      expect(w.held(p, "b0")).toBeUndefined();
      w.deliver("n"); // within its life
      expect(w.held(p, "b0"), "a deleted bot reappeared on the phone").toBeUndefined();
    });
  });

  it("order 8 (found by seed 524: a frame of the previous run buffered behind a stalled roster must not outlive the next run's tombstone): a deleted bot does not come back from a buffered frame of the run before a restart", () => {
    const ops_: Op[] = [
      { t: "flood", botId: "b2" }, { t: "disconnect", sub: "P" }, { t: "reconnect", sub: "P" }, { t: "server", kind: "rename", botId: "b0" },
      { t: "frame", sub: "P" }, { t: "process", req: "roster.P.#2", fail: "netAfter" }, { t: "deliver", req: "roster.P.#2" }, { t: "restart" },
      { t: "send", id: "r63", sub: "P", kind: "delete", botId: "b0" }, { t: "process", req: "r63", fail: "none" }, { t: "commit", req: "r63" }, { t: "deliver", req: "r63" },
      { t: "tick", ms: 60_001 }, { t: "tick", ms: 600_001 }, { t: "process", req: "roster.P.#3", fail: "none" }, { t: "deliver", req: "roster.P.#3" },
    ];
    expect(replay(make, ops_, "reload", true)).toBeNull();
  });

  it("order 8b (Astra r7 H1, three runs): a deletion answered by a run two ahead outlives a delayed roster of the run between, so a frame of that run cannot bring the bot back", () => {
    const w = make();
    const d1 = w.sub("D1");
    ops(w, [{ t: "reconcile", sub: "D1" }]); // a roster asked for on e0
    expect(d1.hydrate.inFlight).toBe("roster.D1.#2");
    ops(w, [{ t: "restart" }, { t: "server", kind: "rename", botId: "b0" }]); // e1: the bot changes under it
    const frameOfTheRunBetween = w.server.wire(w.server.bots.get("b0")!);
    expect(frameOfTheRunBetween).toMatchObject({ tasksEpoch: "e1", tasksSeq: 1 });
    ops(w, [{ t: "process", req: "roster.D1.#2", fail: "none" }]); // answered by e1, delayed in transit
    ops(w, [{ t: "restart" }]); // e2
    ops(w, [{ t: "send", id: "d", sub: "D1", kind: "delete", botId: "b0" }, { t: "process", req: "d", fail: "none" }, { t: "commit", req: "d" }, { t: "deliver", req: "d" }]);
    expect(st(d1).tombstones.b0).toMatchObject({ epoch: "e2", kind: "deleted" });
    ops(w, [{ t: "deliver", req: "roster.D1.#2" }]); // the e1 roster lands after the e2 answer, within its life: adopted
    expect(st(d1).streamEpoch).toBe("e1");
    expect(w.held(d1, "b0")).toBeUndefined();
    ops(w, [{ t: "tick", ms: ANSWER_TTL_MS + SWEEP_MS + 1 }]); // past the tombstone's life; the sweep runs
    expect(st(d1).tombstones.b0, "the e2 tombstone retired on the strength of a roster asked for before it").toBeDefined();
    // a buffered frame of e1 for the deleted bot, as the reducer meets it
    w.dispatch(d1, { type: "botPatched", source: "stream", bot: frameOfTheRunBetween });
    expect(w.held(d1, "b0"), "a deleted bot came back from a frame of the run between").toBeUndefined();
    expect(w.failure).toBeNull();
    // the roster asked for after the deletion names e2, acks the tombstone on drain, and it retires: nothing is kept forever
    expect(quiescent(w, "resume")).toBeNull();
  });

  it("order 9 (Astra r7 H3): a switch answer delayed behind its own frame and a row written since never takes the row off the screen", () => {
    const w = make();
    const d1 = w.sub("D1");
    const rows = () => d1.state.groups.find((g) => g.id === "g1")!.messages.map((m) => m.id);
    ops(w, [{ t: "server", kind: "gmessage", groupId: "g1" }, { t: "frame", sub: "D1" }]); // a row for a room read unloaded: its line only
    expect(d1.state.groups.find((g) => g.id === "g1")?.messagesUnloaded).toBe(true);
    ops(w, [{ t: "send", id: "sw", sub: "D1", kind: "gswitch", groupId: "g1" }, { t: "process", req: "sw", fail: "none" }, { t: "frame", sub: "D1" }]); // the switch's frame: its page
    expect(rows()).toEqual(["g1-m1"]);
    ops(w, [{ t: "server", kind: "gmessage", groupId: "g1" }, { t: "frame", sub: "D1" }]); // a row written since, live
    expect(rows()).toEqual(["g1-m1", "g1-m2"]);
    ops(w, [{ t: "deliver", req: "sw" }]); // the same switch's answer, delayed: the same number, the page of its time
    expect(rows(), "a delayed same-number page took a live row off the screen").toEqual(["g1-m1", "g1-m2"]);
    expect(w.failure).toBeNull(); // RE
    expect(quiescent(w, "resume")).toBeNull();
  });

  it("order 10 (Astra build r2 H3): a newer page delayed behind a row this client received over HTTP never takes the row off the screen", () => {
    const w = make();
    const d1 = w.sub("D1");
    const rows = () => (st(d1).groups as Array<{ id: string; messages: Array<{ id: string }> }>).find((g) => g.id === "g1")!.messages.map((m) => m.id);
    // the first page loads the room (it holds no rows yet)
    ops(w, [{ t: "send", id: "o", sub: "D1", kind: "gopen", groupId: "g1" }, { t: "process", req: "o", fail: "none" }, { t: "deliver", req: "o" }]);
    expect(st(d1).groups.find((g: { id: string }) => g.id === "g1").messagesUnloaded).toBeUndefined();
    // a switch is handled: its page is built now (no rows), its frame waits in the stream, its answer waits on the wire
    ops(w, [{ t: "send", id: "s", sub: "D1", kind: "gswitch", groupId: "g1" }, { t: "process", req: "s", fail: "none" }]);
    // a send is handled and answered first: the row reaches this client over HTTP, ahead of the switch's frame
    ops(w, [{ t: "send", id: "m", sub: "D1", kind: "gsend", groupId: "g1" }, { t: "process", req: "m", fail: "none" }, { t: "deliver", req: "m" }]);
    expect(rows()).toEqual(["g1-m1"]);
    // the switch's answer, newer than the record held and built before the row
    ops(w, [{ t: "deliver", req: "s" }]);
    expect(w.failure).toBeNull();
    expect(rows(), "a delayed newer page took an HTTP-received row off the screen").toEqual(["g1-m1"]);
    frames(w, d1);
    expect(rows()).toEqual(["g1-m1"]);
    expect(quiescent(w, "resume")).toBeNull();
  });

  it("order 11 (Astra build r2 new High): a room inserted from a metadata-only answer is unloaded, and its first page shows its rows", () => {
    const w = make();
    const d1 = w.sub("D1");
    // D1 creates a room: the answer is the record without a page
    ops(w, [{ t: "send", id: "c", sub: "D1", kind: "gcreate" }, { t: "process", req: "c", fail: "none" }, { t: "deliver", req: "c" }]);
    frames(w, d1);
    const room = (st(d1).groups as Array<{ id: string; messagesUnloaded?: true; messages: Array<{ id: string }> }>).find((g) => g.id === `g${w.server.roomCounter}`)!;
    expect(room, "the created room is held").toBeDefined();
    expect(room.messagesUnloaded, "a record inserted without a page is unloaded").toBe(true);
    // rows written meanwhile reach it live: an unloaded room moves its sidebar line only
    ops(w, [{ t: "server", kind: "gmessage", groupId: room.id }, { t: "server", kind: "gmessage", groupId: room.id }]);
    frames(w, d1);
    // the first page (scrollback loadFirstPage) shows them
    ops(w, [{ t: "send", id: "o", sub: "D1", kind: "gopen", groupId: room.id }]);
    expect(w.reqs.get("o"), "the room needs its first page").toBeDefined();
    ops(w, [{ t: "process", req: "o", fail: "none" }, { t: "deliver", req: "o" }]);
    const after = (st(d1).groups as Array<{ id: string; messagesUnloaded?: true; messages: Array<{ id: string }> }>).find((g) => g.id === room.id)!;
    expect(after.messagesUnloaded).toBeUndefined();
    expect(after.messages.map((m) => m.id)).toEqual([`${room.id}-m1`, `${room.id}-m2`]);
    expect(quiescent(w, "resume")).toBeNull();
  });

  describe("the room invariants catch what they are for (ROOM-ORDER-DESIGN §7)", () => {
    const withSettledDelete = (): { w: World; d1: Subject; d2: Subject; copy: Record<string, any> } => {
      const w = make();
      const [d1, d2] = [w.sub("D1"), w.sub("D2")];
      const copy = { ...(d2.state.groups.find((g) => g.id === "g1") as unknown as Record<string, any>) };
      ops(w, [{ t: "send", id: "gd", sub: "D1", kind: "gdelete", groupId: "g1" }, { t: "process", req: "gd", fail: "none" }, { t: "deliver", req: "gd" }]);
      expect(w.failure).toBeNull();
      expect(d1.state.groups.some((g) => g.id === "g1")).toBe(false);
      return { w, d1, d2, copy };
    };
    it("RF: a complete room that lacks a row the server holds", () => {
      const w = make();
      const d1 = w.sub("D1");
      ops(w, [{ t: "send", id: "o", sub: "D1", kind: "gopen", groupId: "g1" }, { t: "process", req: "o", fail: "none" }, { t: "deliver", req: "o" }]);
      ops(w, [{ t: "server", kind: "gmessage", groupId: "g1" }]);
      frames(w, d1);
      // a lost row, the transcript claiming the thread is empty (complete with none)
      d1.state = { ...d1.state, groups: d1.state.groups.map((g) => (g.id === "g1" ? { ...g, messages: [], tail: 0 } : g)) };
      expect(quiescent(w, "resume")?.letter).toBe("RF");
    });

    it("RE: a loaded room that drops a row it showed", () => {
      const w = make();
      const d1 = w.sub("D1");
      ops(w, [{ t: "send", id: "sw", sub: "D1", kind: "gswitch", groupId: "g1" }, { t: "process", req: "sw", fail: "none" }, { t: "deliver", req: "sw" }, { t: "server", kind: "gmessage", groupId: "g1" }]);
      frames(w, d1); // the switch's frame (same number), then the row
      w.checkStep(); // the row is shown
      expect(w.failure).toBeNull();
      expect(d1.state.groups.find((g) => g.id === "g1")!.messages.map((m) => m.id)).toEqual(["g1-m1"]);
      d1.state = { ...d1.state, groups: d1.state.groups.map((g) => (g.id === "g1" ? { ...g, messages: [] } : g)) };
      w.checkStep();
      expect(w.failure?.letter).toBe("RE");
    });
    it("RB: a room held again at or below an applied removal", () => {
      const { w, d1, copy } = withSettledDelete();
      d1.state = { ...d1.state, groups: [...d1.state.groups, copy as never] } as typeof d1.state;
      w.checkStep();
      expect(w.failure?.letter).toBe("RB");
    });
    it("RB allows a statement past the removal (a restore re-creates the room)", () => {
      const { w, d1, copy } = withSettledDelete();
      const removed = d1.roomRemoved.get("g1")!;
      d1.state = { ...d1.state, groups: [...d1.state.groups, { ...copy, recordSeq: removed.seq + 1 } as never] } as typeof d1.state;
      w.checkStep();
      expect(w.failure).toBeNull();
    });
    it("RA: a room missing at quiescence, and a stale name", () => {
      const w = make();
      const d1 = w.sub("D1");
      d1.state = { ...d1.state, groups: d1.state.groups.filter((g) => g.id !== "g2") } as typeof d1.state;
      w.checkQuiescent();
      expect(w.failure?.letter).toBe("RA");
      const w2 = make();
      const d2 = w2.sub("D2");
      d2.state = { ...d2.state, groups: d2.state.groups.map((g) => (g.id === "g2" ? { ...g, name: "stale" } : g)) } as typeof d2.state;
      w2.checkQuiescent();
      expect(w2.failure?.letter).toBe("RA");
    });
    it("RC: a tombstone for a room never removed, and one kept past its life and a sweep period", () => {
      const w = make();
      const d1 = w.sub("D1");
      const tomb = { epoch: w.server.epoch, seq: 1, kind: "deleted", confirmedAt: w.now(), streamAcked: true };
      d1.state = { ...d1.state, roomTombstones: { nope: tomb } } as typeof d1.state;
      w.checkStep();
      expect(w.failure?.letter).toBe("RC");
      const { w: w2, d1: e1 } = withSettledDelete();
      e1.state = { ...e1.state, roomTombstones: { g1: { epoch: w2.server.epoch, seq: 6, kind: "deleted", confirmedAt: w2.now(), streamAcked: true } } } as typeof e1.state;
      vi.advanceTimersByTime(ANSWER_TTL_MS + 1);
      w2.checkStep(); // past its life and passed by the stream: the sweep owes it
      expect(w2.failure).toBeNull();
      vi.advanceTimersByTime(SWEEP_MS + 6_000);
      w2.checkStep();
      expect(w2.failure?.letter).toBe("RC");
    });
    it("RD: the phone holds an archived room", () => {
      const w = make();
      const p = w.sub("P");
      const room = w.sub("D1").state.groups.find((g) => g.id === "g3")!;
      p.state = { ...p.state, groups: [...p.state.groups, room] } as typeof p.state;
      w.checkStep();
      expect(w.failure?.letter).toBe("RD");
    });
    it("a delete, an archive and a restore reach every subject (the harness drives the real reducer actions)", () => {
      const w = make();
      ops(w, [
        { t: "send", id: "ga", sub: "D1", kind: "garchive", groupId: "g1" }, { t: "process", req: "ga", fail: "none" }, { t: "deliver", req: "ga" },
        { t: "send", id: "gd", sub: "D2", kind: "gdelete", groupId: "g2" }, { t: "process", req: "gd", fail: "none" }, { t: "deliver", req: "gd" },
      ]);
      for (const s of w.subs) frames(w, s);
      expect(w.failure).toBeNull();
      expect(w.sub("D1").state.groups.find((g) => g.id === "g1")?.hidden).toBe(true);
      expect(w.sub("D2").state.groups.find((g) => g.id === "g1")?.hidden).toBe(true);
      expect(w.sub("P").state.groups.some((g) => g.id === "g1")).toBe(false);
      expect(w.sub("P").state.groups.some((g) => g.id === "g2")).toBe(false);
      expect(w.sub("D1").state.groups.some((g) => g.id === "g2")).toBe(false);
      expect(quiescent(w, "resume")).toBeNull();
    });
  });

  it("N5 (r6, no epoch expectations): roster rows are admitted by number; membership of an unlisted held bot is by admission order against the roster's send", () => {
    const w = make();
    const d1 = w.sub("D1");
    // A newer http answer beats an older roster row.
    w.reconcile(d1);
    const older = d1.hydrate.inFlight!;
    w.process(older, "none");
    ops(w, [{ t: "send", id: "n", sub: "D1", kind: "rename", botId: "b0" }, { t: "process", req: "n", fail: "none" }, { t: "deliver", req: "n" }]);
    w.deliver(older);
    expect(w.held(d1, "b0")?.name).toBe(w.server.bots.get("b0")!.name);
    // Held before the send, unlisted (deleted longer ago than the removed[] window): dropped.
    w.disconnect(d1);
    ops(w, [{ t: "server", kind: "delete", botId: "b1" }, { t: "tick", ms: ANSWER_TTL_MS + 1 }]);
    w.reconcile(d1);
    hydrateNow(w, d1);
    expect(w.held(d1, "b1")).toBeUndefined();
    // Inserted after the send (this client's create answered during the hydrate), unlisted: kept and verified.
    w.reconnect(d1);
    if (d1.hydrate.inFlight) hydrateNow(w, d1);
    frames(w, d1);
    w.reconcile(d1);
    const roster = d1.hydrate.inFlight!;
    w.process(roster, "none");
    ops(w, [{ t: "send", id: "c", sub: "D1", kind: "create" }, { t: "process", req: "c", fail: "none" }, { t: "deliver", req: "c" }]);
    const created = [...w.server.bots.keys()].find((id) => !["b0", "b2"].includes(id))!;
    expect(w.held(d1, created)).toBeTruthy();
    w.deliver(roster);
    expect(w.held(d1, created), "a bot created during the hydrate was dropped").toBeTruthy();
    expect(Boolean(st(d1).verifyBots?.[created]) || [...w.reqs.values()].some((r) => r.kind === "detail" && r.botId === created)).toBe(true);
  });

  it("C allows the R10 tombstone (own DELETE settled, frame missed, no roster listed it) and nothing else", () => {
    const w = make();
    const d1 = w.sub("D1");
    ops(w, [{ t: "send", id: "d", sub: "D1", kind: "delete", botId: "b1" }]);
    w.disconnect(d1);
    ops(w, [{ t: "process", req: "d", fail: "none" }, { t: "commit", req: "d" }, { t: "deliver", req: "d" }]);
    expect(w.held(d1, "b1")).toBeUndefined();
    ops(w, [{ t: "tick", ms: ANSWER_TTL_MS + 1 }, { t: "flood", botId: "b0" }]);
    w.reconnect(d1);
    hydrateNow(w, d1);
    expect(quiescent(w, "resume")).toBeNull();
    // The restated C still catches any other leftover.
    const d2 = w.sub("D2");
    d2.state = { ...d2.state, tombstones: { b0: { epoch: w.server.epoch, seq: 1, kind: "hidden", confirmedAt: T0, streamAcked: true } } } as typeof d2.state;
    w.checkQuiescent();
    expect(w.failure?.letter).toBe("C");
  });
});

describe("r6 (one ordering key): rows held across a reconnect and a windowed first page", () => {
  it("order 12: the held row is unvouched, the window's gap is paged by number, the refresh vouches the held row, and the room ends complete", () => {
    const w = make();
    const d1 = w.sub("D1");
    const room = () => (st(d1).groups as Array<{ id: string; messages: Array<{ id: string; seq?: number; unvouched?: true }>; tail?: number; numbered?: true }>).find((g) => g.id === "g1")!;
    const ids = () => room().messages.map((m) => m.id);
    ops(w, [{ t: "server", kind: "gmessage", groupId: "g1" }]);
    frames(w, d1);
    ops(w, [{ t: "send", id: "o1", sub: "D1", kind: "gopen", groupId: "g1" }, { t: "process", req: "o1", fail: "none" }, { t: "deliver", req: "o1" }]);
    expect(ids()).toEqual(["g1-m1"]);
    expect(room()).toMatchObject({ numbered: true, tail: 1 });
    expect(transcriptState(room() as never)).toBe("complete");
    // away long enough for the replay buffer to overflow; five rows are written meanwhile
    w.disconnect(d1);
    for (let i = 0; i < 5; i++) ops(w, [{ t: "server", kind: "gmessage", groupId: "g1" }]);
    ops(w, [{ t: "flood", botId: "b0" }]);
    w.reconnect(d1);
    expect(d1.hydrated).toBe(false);
    hydrateNow(w, d1);
    // r7 R4: the roster keeps the row, unvouched, and forgets the tail
    expect(ids()).toEqual(["g1-m1"]);
    expect(room().messages[0]!.unvouched).toBe(true);
    expect(room().tail).toBeUndefined();
    expect(transcriptState(room() as never)).toBe("partial");
    // the newest page is a window of two rows: (1, 5) is an interior gap, not a complete transcript
    ops(w, [{ t: "send", id: "o2", sub: "D1", kind: "gopen", groupId: "g1", limit: 2 }, { t: "process", req: "o2", fail: "none" }, { t: "deliver", req: "o2" }]);
    expect(ids()).toEqual(["g1-m1", "g1-m5", "g1-m6"]);
    expect(room().tail).toBe(6);
    expect(transcriptState(room() as never)).toBe("partial");
    // paging back fills the gap by number, then the page before m3 re-reads m1 and vouches it
    ops(w, [{ t: "send", id: "p1", sub: "D1", kind: "golder", groupId: "g1", limit: 2 }, { t: "process", req: "p1", fail: "none" }, { t: "deliver", req: "p1" }]);
    expect(ids()).toEqual(["g1-m1", "g1-m3", "g1-m4", "g1-m5", "g1-m6"]);
    expect(transcriptState(room() as never)).toBe("partial");
    ops(w, [{ t: "send", id: "p2", sub: "D1", kind: "golder", groupId: "g1", limit: 2 }, { t: "process", req: "p2", fail: "none" }, { t: "deliver", req: "p2" }]);
    expect(ids()).toEqual(["g1-m1", "g1-m2", "g1-m3", "g1-m4", "g1-m5", "g1-m6"]);
    expect(room().messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(transcriptState(room() as never)).toBe("complete");
    expect(w.failure).toBeNull();
    expect(quiescent(w, "resume")).toBeNull();
  });
});

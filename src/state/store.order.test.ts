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
//     deletion frame it never received and no roster it applied listed;
//   D the phone never holds a record with `hidden:true`;
//   E a pending id is never held, and an `http` action marked `expired` changes nothing;
//   F a page applies only under the highest intent for its bot, and never for `deletedThreadId`;
//   G no held record goes back to a lower number, or an older run, than one already applied for that id;
//   H once a subject applied a real deletion of X, it never holds X again (ids are never reused);
//   I on a desktop, a hidden record the server lists in an applied roster stays held (H-r6-1).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ANSWER_TTL_MS,
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

beforeAll(() => { vi.useFakeTimers({ toFake: ["Date", "performance"], now: T0 }); });
afterAll(() => { vi.useRealTimers(); });

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
    for (const seed of list) {
      const rnd = prng(seed);
      const count = 200 + Math.floor(rnd() * 401);
      const w = make();
      const log = generate(w, rnd, count);
      stepsRun += log.length;
      const reload = w.failure ?? quiescent(w, "reload");
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

    it.todo("order 2: fence + accepted id stamps a row whose write never happened (follow-up M-r6-3, server: I14 says 'released to the engine's write'; pre-write failures clear dispatchedIn)");

    it.todo("order 3: a steer stamped from the attempt current after the await (follow-up M-r6-1, server: hold the attempt entry before steerWithQuoteLineage)");

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

    it.todo("order 5: gaveUp lifts the fence while a pre-delete answer is still within its life (follow-up M-r6-4: an unacked deleted tombstone until a verified 200, or a cap past ANSWER_TTL_MS)");

    it.todo("order 6: a commit-time refusal after the DELETE route's teardown leaves the restored bot without its facilities (follow-up M-r6-2, server: lock PATCH hide/restore, abort the browser cleanup on refusal)");

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

    it.fails("order 7b (known Medium, follow-up Astra r5 #7b: hide then delete loses the phone hide fence): after a missed archive then a permanent delete, a delayed pre-archive answer does not bring the bot back to the phone", () => {
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

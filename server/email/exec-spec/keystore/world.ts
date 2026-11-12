// The fault injector and scheduler: world construction, the enabled-move generator, `step` (apply one move, calling the
// reducer where a home reacts) and the canonical state hash. No I/O. Deterministic: same world + move => same result.
import { createHash } from "node:crypto";
import { deadStatus, evidenceAbout, holdEnd, protectedSet } from "./invariants.current.ts";
import { DAY, H, MARGIN, homeIds } from "./domain.ts";
import type { Domain } from "./domain.ts";
import { canAlloc, emptyFlux, fluxAdvance, fluxApply, fluxHonours, fluxOwnerDelete, fluxUsageSync, fluxUse, usagePending } from "./flux.ts";
import type {
  BotId, HomeAction, HomeEvent, HomeId, HomeX, KeyId, Move, NoNow, Operation, ReqX, Reducer, StepAction, WorldX, AuthorityEvent, Evidence, Time,
} from "./types.ts";

// ───────────── construction ─────────────
export const freshMemory = (running: boolean): HomeX["memory"] => ({
  running, evidence: null, D: {}, botKey: {}, candidateToken: {}, rejected: {}, sendsInFlight: {}, lastRefusal: null,
});
export function emptyHome(id: HomeId, running = true): HomeX {
  return {
    id, destroyed: false,
    durable: {
      disk: { gen: 0, bots: {}, owner: null, retired: [], prev: [] }, proof: null, bindings: {}, intents: {}, fenced: false,
      tombstones: [], deadlines: {}, mintLog: [], observedDead: {}, twinKeyLive: {}, takeAuth: {}, lastLocalUse: {},
    },
    memory: freshMemory(running), repairVisible: {},
    supervisor: { alive: true, queue: [], builtAcks: [] }, outbox: [], nextSaveId: 1,
  };
}
export function emptyWorld(d: Domain): WorldX {
  const homes: Record<HomeId, HomeX> = {};
  for (const h of homeIds(d)) homes[h] = emptyHome(h);
  return { now: 0, flux: { ...emptyFlux(0), ...(d.fluxProfile === "flux276" ? { reaperStopped: true } : {}) }, homes, ops: {}, requests: [], unobserved: {}, trace: [], nextReq: 1, budget: { ...d.budgets }, alerts: [] };
}
export const clone = <T>(x: T): T => structuredClone(x);

// ───────────── enabled moves ─────────────
const openCount = (w: WorldX, home: HomeId, bot: BotId, kind: string) =>
  w.requests.filter((r) => { const o = w.ops[r.opId]; return o.home === home && o.bot === bot && o.kind === kind && !(r.appliedAtFlux && r.inbound.length === 0); }).length;

export function clockTargets(w: WorldX): Time[] {
  const t = new Set<Time>([w.now + 1]);
  const add = (x: number | undefined) => { if (x !== undefined && x > w.now && Number.isFinite(x)) t.add(x); };
  for (const k of Object.values(w.flux.keys)) if (k.deadlineAt !== undefined) [k.deadlineAt - 2 * H, k.deadlineAt - MARGIN, k.deadlineAt, k.deadlineAt + 1, ...(w.flux.reaperStopped ? [k.deadlineAt + 30 * 60_000] : [])].forEach(add);
  for (const h of Object.values(w.flux.holds)) [h.until, h.until + 1].forEach(add);
  for (const home of Object.values(w.homes)) for (const i of Object.values(home.durable.intents)) if (i.deadlineAt !== undefined) [i.deadlineAt - MARGIN, i.deadlineAt, i.deadlineAt + 1].forEach(add);
  return [...t].sort((a, b) => a - b);
}

/** r3.2g: holdEnd of the operation a pending outbox call belongs to: the FIRST send (decision) time of that logical operation + 24 h. */
export function callHoldEnd(w: WorldX, hid: HomeId, a: Extract<HomeAction, { a: "call" }>): Time {
  const op = (a.idem ? Object.values(w.ops).find((o) => o.home === hid && o.bot === a.bot && o.idem === a.idem) : undefined) ?? (a.opId ? w.ops[a.opId] : undefined);
  return (op?.firstSentAt ?? a.at ?? w.now) + DAY;
}

/** r3.2h (H2/H3): the ONE drop rule. A call in the outbox expires there ONLY when the product would send nothing: a `rotate` whose successor is
 *  unsaved (the guard at binding-service.ts:519) with now >= intent.at + 24 h (:521), or a `mint` with now >= at + 24 h (the setup re-op, :165).
 *  Never a `delete` (the revoke at :535 has no window) and never a `list`. */
export function expiresInOutbox(w: WorldX, hid: HomeId, a: HomeAction): boolean {
  if (a.a !== "call") return false;
  if (a.kind === "mint") return w.now >= callHoldEnd(w, hid, a);
  if (a.kind !== "rotate") return false;
  const d = w.homes[hid].durable;
  const intent = Object.values(d.intents).find((i) => defined0(a.idem) && i.rotateIdem === a.idem);
  const stored = d.disk.bots[a.bot], old = intent?.oldKeyId ?? a.keyId;
  const successorUnsaved = stored === undefined || stored === old;
  return successorUnsaved && w.now >= callHoldEnd(w, hid, a);
}
const defined0 = <T>(x: T | undefined | null): x is T => x !== undefined && x !== null;

export function enabledMoves(w: WorldX, d: Domain): Move[] {
  const out: Move[] = [];
  const f = d.faults, b = w.budget;
  for (const hid of Object.keys(w.homes)) {
    const h = w.homes[hid];
    if (h.destroyed) continue;
    if (h.memory.running) {
      for (const bot of Object.keys(h.durable.bindings)) {
        out.push({ k: "drive", home: hid, bot });
        if (f.use && b.uses > 0 && (h.memory.botKey[bot] ?? h.durable.disk.bots[bot])) out.push({ k: "use", home: hid, bot });
        if (b.owner > 0) for (const press of ["reconnect", "take", "remove"] as const) out.push({ k: "owner", home: hid, bot, press });
      }
      const head = h.outbox[0];
      if (head && (head.a !== "call" || expiresInOutbox(w, hid, head) || (b.calls > 0 && openCount(w, hid, head.bot, head.kind) < d.maxOutstanding))) out.push({ k: "exec", home: hid }); // r3.2h: the expiry drop is a no-budget step
      if (f.crashChild && b.crashes > 0) out.push({ k: "crash", home: hid, mode: "child" });
      if (f.crashSupervisor && b.crashes > 0) out.push({ k: "crash", home: hid, mode: "supervisor" });
      if (f.crashPower && b.crashes > 0) out.push({ k: "crash", home: hid, mode: "power" });
      if (f.fence && b.fence > 0) out.push({ k: "fence", home: hid, on: !h.durable.fenced });
    } else out.push({ k: "boot", home: hid });
    if (h.supervisor.queue.length) out.push({ k: "supStep", home: hid });
    h.supervisor.builtAcks.forEach((_, idx) => {
      if (h.memory.running) {
        out.push({ k: "ackDeliver", home: hid, idx, dup: false });
        if (f.dup && b.dups > 0) out.push({ k: "ackDeliver", home: hid, idx, dup: true });
      }
      if (f.lose && b.lost > 0) out.push({ k: "ackLose", home: hid, idx });
    });
  }
  for (const r of w.requests) {
    const o = w.ops[r.opId];
    if (!r.appliedAtFlux) {
      out.push({ k: "apply", reqId: r.reqId, outcome: "normal" });
      if (b.fluxFaults > 0) {
        if (f.flux500) (["e500_applied", "e500_applied_nohold", "e500_dropped"] as const).forEach((outcome) => out.push({ k: "apply", reqId: r.reqId, outcome }));
        if (f.flux503 && o.kind === "rotate") out.push({ k: "apply", reqId: r.reqId, outcome: "incomplete503" });
        if (f.flux400 && o.kind !== "delete" && o.kind !== "list") out.push({ k: "apply", reqId: r.reqId, outcome: "bad400" });
      }
      if (f.lose && b.lost > 0) out.push({ k: "dropReq", reqId: r.reqId });
    }
    const home = w.homes[o.home];
    const idxs = f.reorder ? r.inbound.map((_, i) => i) : r.inbound.length ? [0] : [];
    for (const idx of idxs) {
      if (home?.memory.running && !home.destroyed) {
        out.push({ k: "deliver", reqId: r.reqId, idx, dup: false });
        if (f.dup && b.dups > 0) out.push({ k: "deliver", reqId: r.reqId, idx, dup: true });
      }
      if (f.lose && b.lost > 0) out.push({ k: "lose", reqId: r.reqId, idx });
    }
    if (f.timeout && home?.memory.running && !r.timedOut && !r.answered && r.inbound.length === 0) out.push({ k: "timeout", reqId: r.reqId });
  }
  // r3.2g (spec-owner ruling R1): the clock MAY step while a decided `call` sits in an outbox (the product's outbox waits; time passes).
  // Bounded: no step beyond just past the earliest pending call's holdEnd (= its first-send/decision time + 24 h, then +1 ms).
  // A call still pending past that point is never sent (see exec): the product expires it (binding-service.ts:521).
  let clockLimit = Infinity;
  for (const h of Object.values(w.homes)) if (!h.destroyed) for (const x of h.outbox) if (x.a === "call" && (x.kind === "rotate" || x.kind === "mint") && !expiresInOutbox(w, h.id, x) && w.now < callHoldEnd(w, h.id, x)) clockLimit = Math.min(clockLimit, callHoldEnd(w, h.id, x) + 1); // r3.2h: only a call that can still be SENT bounds time
  if (b.clock > 0) {
    const ts = new Set(clockTargets(w).filter((t) => t <= clockLimit));
    if (Number.isFinite(clockLimit) && clockLimit > w.now) ts.add(clockLimit);
    for (const to of [...ts].sort((a, c) => a - c)) out.push({ k: "clock", to });
  }
  if (f.ownerDelete && b.ownerDeletes > 0) for (const k of Object.values(w.flux.keys)) if (fluxHonours(w.flux, k.id)) out.push({ k: "ownerFluxDelete", key: k.id });
  for (const k of Object.values(w.flux.keys)) if (usagePending(w.flux, k.id)) out.push({ k: "usageSync", key: k.id });
  if (f.flagOff && b.flag > 0) out.push({ k: "flag", on: !w.flux.flagOn });
  return out;
}

// ───────────── step ─────────────
export interface StepResult {
  world: WorldX;
  move: Move;
  action: StepAction;
  /** per-home commit views of this step (see `step`) */
  commits: StepAction[];
  /** every reducer call this step caused */
  reductions: { home: HomeId; event: HomeEvent; actions: HomeAction[] }[];
  error?: string; // the reducer threw (e.g. "unimplemented"): not an invariant violation, reported separately
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** F7: one logical operation may be sent at most twice (the first POST and one retry). Harness bookkeeping, not spec state. */
export const F7_ATTEMPTS = 2;
export const sendsOf = (o: Operation, add = 0): number => { const x = o as Operation & { sends?: number }; x.sends = (x.sends ?? 0) + add; return x.sends; };
/** r3.2 take-predicate for the sticky replayForgone, evaluated on a step's PREV world: the home is running + proven + unfenced, no
 *  request of the op is awaiting an answer, the op's F7 attempts are not spent, and the home's queue is empty for that bot (nothing
 *  in its outbox for the bot and the reducer enables no automatic action for it). */
export function takeable(w: WorldX, o: Operation, red?: Reducer): boolean {
  const h = w.homes[o.home];
  if (!h || h.destroyed || !h.memory.running || h.memory.evidence === null || h.durable.fenced) return false;
  if (w.requests.some((r) => r.opId === o.opId && !r.answered && !r.timedOut)) return false;
  if (sendsOf(o) >= F7_ATTEMPTS) return false;
  if (h.outbox.some((a) => a.a === "call" && a.bot === o.bot)) return false;
  if (!red) return true;
  try { return red(clone(h), { now: w.now, t: "drive", bot: o.bot }).actions.length === 0; } catch { return false; }
}

/** r3.2e (I6d) tombstone-ghost recorder: the cause (I11 > I8 > none) that held for tombstoning x at home h, judged on a step's PREV
 *  world. Mirrors the spec's tombCauseOf (not exported); written once per (home, key), in the step that ADDS the tombstone. */
function tombCauseOn(h: HomeX, w: WorldX, x: KeyId): "I8" | "I11" | "none" {
  const d = h.durable;
  const i11 = Object.values(w.ops).some((o) => o.home === h.id && o.kind === "list" && o.delivered.some((r) => r.code === 200 && !!r.list && r.list.some((row) => row.keyId === x && deadStatus(row.status))));
  const strays = new Set(Object.values(d.intents).flatMap((i) => i.strays));
  const i8 = d.disk.retired.includes(x) && !protectedSet(h).has(x) && !strays.has(x) && !d.disk.prev.includes(x);
  return i11 ? "I11" : i8 ? "I8" : "none";
}

export function step(w0: WorldX, m: Move, red: Reducer, d: Domain): StepResult {
  const w = clone(w0);
  const reductions: StepResult["reductions"] = [];
  let action: StepAction = { kind: "env", what: m.k, detail: m };
  const changedHomes: HomeId[] = [];
  let error: string | undefined;

  const reduceAt = (hid: HomeId, ev: HomeEvent) => {
    const hx = w.homes[hid];
    let res;
    try { res = red(clone(hx), ev); } catch (e) { error = (e as Error).message; return; }
    const { actions, state } = res;
    // r3.2h (H4): every rotate/mint call carries the durable intent.at (decision time); a reducer that omits it is a reducer failure
    if (actions.some((a) => a.a === "call" && (a.kind === "rotate" || a.kind === "mint") && a.at === undefined)) { error = "call without intent.at"; return; }
    if (!eq(hx.durable, state.durable) && !changedHomes.includes(hid)) changedHomes.push(hid);
    // (gap 1) the reducer's own alert output is in next.alerts in THIS step (I7c); alerts have no other effect, so they leave the outbox
    for (const a of actions) if (a.a === "alert" && !w.alerts.some((x) => x.home === hid && x.bot === a.bot && x.code === a.code)) w.alerts.push({ home: hid, bot: a.bot, code: a.code });
    w.homes[hid] = { ...state, supervisor: hx.supervisor, nextSaveId: hx.nextSaveId, outbox: [...(((state as HomeX).outbox) ?? hx.outbox), ...actions.filter((a) => a.a !== "alert").map((a) => (a.a === "call" && a.at === undefined ? { ...a, at: w.now } : a))] } as HomeX;
    reductions.push({ home: hid, event: ev, actions });
  };
  const ev = (e: NoNow<HomeEvent>): HomeEvent => ({ ...e, now: w.now }) as HomeEvent;
  const reqOf = (id: number): ReqX => w.requests.find((r) => r.reqId === id)!;
  const opOfReq = (r: ReqX): Operation => w.ops[r.opId];
  const trace = (e: AuthorityEvent) => { w.trace.push(e); };
  /** the home has heard an answer for this bot: the "died unobserved" exemption (I1) ends */
  const observed = (home: HomeId, bot: BotId) => { if (w.pipeDead?.[home]) { delete w.pipeDead[home][bot]; if (!Object.keys(w.pipeDead[home]).length) delete w.pipeDead[home]; } if (w.unobserved[home]) { delete w.unobserved[home][bot]; if (!Object.keys(w.unobserved[home]).length) delete w.unobserved[home]; } };
  const markUnobserved = (before: WorldX["flux"], after: WorldX["flux"]) => {
    for (const hid of Object.keys(w.homes)) {
      const h = w.homes[hid];
      if (h.destroyed) continue;
      for (const [bot, st] of Object.entries(h.durable.bindings)) {
        const key = h.durable.disk.bots[bot];
        if (key && (st.state === "active" || st.state === "restored_unverified") && fluxHonours(before, key) && !fluxHonours(after, key)) (w.unobserved[hid] ??= {})[bot] = key;
      }
      // harness fix (I1 counterexample, rotate-in-flight): a key Flux kills while it sits in the home's SAVE PIPELINE (outbox save, or a
      // queued/written/renamed/synced/reread job) will BECOME durable later; the home has not heard of the death, so it is unobserved too.
      const piped: Array<[BotId, KeyId]> = [];
      for (const j of h.supervisor.queue) for (const [bot, key] of Object.entries(j.image.bots)) piped.push([bot, key]);
      for (const a of h.outbox) if (a.a === "save") for (const [bot, key] of Object.entries(a.bots)) piped.push([bot, key]);
      for (const [bot, key] of piped) if (key && fluxHonours(before, key) && !fluxHonours(after, key) && w.unobserved[hid]?.[bot] === undefined) ((w.pipeDead ??= {})[hid] ??= {})[bot] = key; // promoted to `unobserved` when the key BECOMES durable (the spec exempts a key that is durable-and-dead only in the step it lands)
    }
  };

  // r3.2 (Astra A2): replayForgone is STICKY checker bookkeeping, set at any step whose prev has the op unknown inside its hold
  // (prev.now < holdEnd) where the replay was AVAILABLE and LEFT: home running, proven, unfenced, no request of the op awaiting an
  // answer, F7 attempts left, and NO automatic action enabled for (home, bot).
  for (const o of Object.values(w.ops)) {
    if (o.outcome !== "unknown" || o.replayForgone === true || !(w0.now < holdEnd(o))) continue;
    if (!takeable(w0, o, red)) continue;
    o.replayForgone = true;
  }
  switch (m.k) {
    case "drive": reduceAt(m.home, ev({ t: "drive", bot: m.bot })); action = { kind: "drive", home: m.home, bot: m.bot }; break;
    case "exec": {
      const h = w.homes[m.home];
      const a = h.outbox.shift()!;
      if (a.a === "call" && expiresInOutbox(w, m.home, a)) {
        // r3.2h: the call's rotation/mint expired in the outbox (see expiresInOutbox): the product sends nothing (binding-service.ts:521, :165). The home
        // is told (`expired`) so the intent closes the way the product's clearCursor + rotation_expired closes it (:521). delete and list never get here.
        action = { kind: "env", what: "call-expired-in-outbox", detail: a.kind };
        reduceAt(m.home, ev({ t: "expired", bot: a.bot, kind: a.kind as "rotate" | "mint", idem: a.idem }));
      } else if (a.a === "call") {
        w.budget.calls--;
        const reqId = w.nextReq++;
        const bodyHash = `${a.kind}|${a.bot}|${a.keyId ?? ""}`;
        // one logical operation = one Idempotency-Key (retries included); a list or an idem-less call is its own operation
        // (gap 2) the reducer may name the operation in its action (I6b compares takeAuth.opId with call.opId); else op<reqId>
        let opId = a.idem ? Object.values(w.ops).find((o) => o.home === m.home && o.bot === a.bot && o.idem === a.idem)?.opId : undefined;
        if (!opId && a.opId && w.ops[a.opId] && w.ops[a.opId].home === m.home && w.ops[a.opId].bot === a.bot) opId = a.opId;
        if (!opId) {
          opId = a.opId ?? `op${reqId}`;
          w.ops[opId] = { opId, home: m.home, bot: a.bot, kind: a.kind, keyId: a.keyId, idem: a.idem, bodyHash, firstSentAt: a.at ?? w.now, outcome: "unknown", delivered: [], replayForgone: false, sends: 0 } as Operation;
        }
        sendsOf(w.ops[opId], 1);
        w.requests.push({ reqId, opId, appliedAtFlux: false, inbound: [], dupLeft: 0, answered: false, timedOut: false, dropped: false });
        const call = { home: m.home, bot: a.bot, kind: a.kind, keyId: a.keyId, idem: a.idem, bodyHash, opId, actor: a.actor, ...(a.cause ? { cause: a.cause } : {}) };
        action = { kind: "call", call }; trace({ t: "call", ...call });
      } else if (a.a === "save") {
        const maxGen = Math.max(h.durable.disk.gen, ...h.supervisor.queue.map((j) => j.gen));
        h.supervisor.queue.push({ gen: maxGen + 1, image: { gen: maxGen + 1, bots: a.bots, owner: a.owner, retired: a.retired, prev: a.prev }, phase: "queued" });
        action = { kind: "save", home: m.home, phase: "written" };
      } else {
        if (!w.alerts.some((x) => x.home === m.home && x.bot === a.bot && x.code === a.code)) w.alerts.push({ home: m.home, bot: a.bot, code: a.code });
        action = { kind: "env", what: "alert", detail: a.code };
      }
      break;
    }
    case "apply": {
      const r = reqOf(m.reqId), o = opOfReq(r);
      if (m.outcome !== "normal") w.budget.fluxFaults--;
      const out = fluxApply(w.flux, { home: o.home, bot: o.bot, kind: o.kind, keyId: o.keyId, idem: o.idem, opId: o.opId }, m.outcome, d.keysPerBot);
      void canAlloc;
      markUnobserved(w.flux, out.flux);
      w.flux = out.flux; r.appliedAtFlux = true; r.inbound.push(out.resp);
      break;
    }
    case "dropReq": {
      const r = reqOf(m.reqId), o = opOfReq(r);
      w.budget.lost--; r.appliedAtFlux = true; r.dropped = true;
      // (gap 4) the home hears a timeout for a dropped request (else a busy flag stays stuck and liveness is blocked)
      const hm = w.homes[o.home];
      if (hm?.memory.running && !hm.destroyed && !r.timedOut) { r.timedOut = true; o.delivered.push({ code: "lost" }); reduceAt(o.home, ev({ t: "lost", reqId: r.reqId, opId: o.opId, bot: o.bot, kind: o.kind, keyId: o.keyId, idem: o.idem })); }
      break;
    }
    case "deliver": {
      const r = reqOf(m.reqId), o = opOfReq(r);
      const resp = r.inbound[m.idx];
      if (m.dup) w.budget.dups--; else r.inbound.splice(m.idx, 1);
      r.answered = true;
      o.delivered.push(resp);
      if (resp.code !== "lost" && resp.code !== 500 && resp.code !== 503) o.outcome = "known";
      { const k0 = w.unobserved[o.home]?.[o.bot] ?? w.pipeDead?.[o.home]?.[o.bot]; if (k0 !== undefined && evidenceAbout(w.homes[o.home], w, { kind: "answer", opId: o.opId, resp, duplicate: m.dup } as never, o.bot, k0)) observed(o.home, o.bot); } // r3.2: only evidence about THAT key ends the exemption
      action = { kind: "answer", opId: o.opId, resp, duplicate: m.dup };
      trace({ t: "answer", opId: o.opId, resp });
      reduceAt(o.home, ev({ t: "response", reqId: r.reqId, opId: o.opId, bot: o.bot, kind: o.kind, keyId: o.keyId, idem: o.idem, resp, duplicate: m.dup }));
      break;
    }
    case "lose": { const r = reqOf(m.reqId); w.budget.lost--; r.inbound.splice(m.idx, 1); break; }
    case "timeout": {
      const r = reqOf(m.reqId), o = opOfReq(r);
      r.timedOut = true;
      o.delivered.push({ code: "lost" });
      reduceAt(o.home, ev({ t: "lost", reqId: r.reqId, opId: o.opId, bot: o.bot, kind: o.kind, keyId: o.keyId, idem: o.idem }));
      break;
    }
    case "supStep": {
      const h = w.homes[m.home];
      const j = h.supervisor.queue[0];
      if (j.phase === "queued") { j.phase = "written"; action = { kind: "save", home: m.home, phase: "written" }; }
      else if (j.phase === "written") { j.phase = "renamed"; action = { kind: "save", home: m.home, phase: "renamed" }; }
      else if (j.phase === "renamed") { j.phase = "synced"; h.durable.disk = clone(j.image); action = { kind: "save", home: m.home, phase: "synced" }; }
      else { // synced -> reread -> ack built (the supervisor outlives a child crash)
        h.supervisor.queue.shift();
        h.supervisor.builtAcks.push({ gen: j.gen, bots: clone(j.image.bots), ...(j.image.owner ? { owner: j.image.owner } : {}) });
        action = { kind: "save", home: m.home, phase: "reread" };
      }
      break;
    }
    case "ackDeliver": {
      const h = w.homes[m.home];
      const e = h.supervisor.builtAcks[m.idx];
      if (m.dup) w.budget.dups--; else h.supervisor.builtAcks.splice(m.idx, 1);
      action = { kind: "ack", home: m.home, ev: e };
      reduceAt(m.home, ev({ t: "ack", ev: clone(e) }));
      break;
    }
    case "ackLose": { const h = w.homes[m.home]; w.budget.lost--; h.supervisor.builtAcks.splice(m.idx, 1); action = { kind: "ack", home: m.home, ev: null }; break; }
    case "crash": {
      const h = w.homes[m.home];
      w.budget.crashes--;
      if (m.mode !== "child") { // supervisor dies: queue and built acks are gone; a RENAMED file stays put, a power loss loses it
        const head = h.supervisor.queue[0];
        if (head?.phase === "renamed" && m.mode === "supervisor") h.durable.disk = clone(head.image);
        h.supervisor = { alive: false, queue: [], builtAcks: [] };
      }
      h.memory = freshMemory(false); h.outbox = [];
      for (const r of w.requests) if (w.ops[r.opId].home === m.home) { r.inbound = []; r.timedOut = true; } // connections died with the child
      action = { kind: "crash", home: m.home, mode: m.mode }; trace({ t: "crash", home: m.home, mode: m.mode });
      break;
    }
    case "boot": {
      const h = w.homes[m.home];
      h.memory = freshMemory(true);
      h.supervisor.alive = true;
      const proofValid = !!h.durable.proof && h.durable.proof.gen === h.durable.disk.gen;
      action = { kind: "boot", home: m.home }; trace({ t: "boot", home: m.home });
      reduceAt(m.home, ev({ t: "boot", proof: clone(h.durable.proof), proofValid }));
      break;
    }
    case "clock": {
      w.budget.clock--; w.now = m.to; { const adv = fluxAdvance(w.flux, m.to); markUnobserved(w.flux, adv); w.flux = adv; }
      action = { kind: "clock", to: m.to };
      for (const hid of Object.keys(w.homes)) if (w.homes[hid].memory.running && !w.homes[hid].destroyed) reduceAt(hid, ev({ t: "clock" }));
      // r3 (Q-B amendment): replayLost is checker bookkeeping, written ONCE, at the clock step that first reaches holdEnd with the
      // outcome still unknown: true iff the home was not running / unproven / fenced, or still had an automatic action enabled
      // for (home, bot) (the jump models an outage it could not beat); false iff it was free to replay and had nothing enabled.
      for (const o of Object.values(w.ops)) {
        if (o.outcome !== "unknown" || o.replayLost !== undefined || !(w0.now < holdEnd(o) && holdEnd(o) <= m.to)) continue;
        const h = w.homes[o.home];
        let auto = false;
        if (h && h.memory.running && !h.destroyed) {
          try { auto = red(clone(h), { now: w.now, t: "drive", bot: o.bot }).actions.length > 0; } catch { auto = false; }
        }
        o.replayLost = !h || h.destroyed || !h.memory.running || h.memory.evidence === null || h.durable.fenced || auto || sendsOf(o) >= F7_ATTEMPTS; // r3.2: both F7 attempts spent = never takeable
      }
      break;
    }
    case "fence": w.budget.fence--; w.homes[m.home].durable.fenced = m.on; action = { kind: "fence", home: m.home, on: m.on }; reduceAt(m.home, ev({ t: "fence", on: m.on })); break;
    case "owner": w.budget.owner--; action = { kind: "owner", home: m.home, bot: m.bot, press: m.press }; trace({ t: "owner", home: m.home, bot: m.bot, press: m.press }); reduceAt(m.home, ev({ t: "owner", bot: m.bot, press: m.press })); break;
    case "ownerFluxDelete": {
      w.budget.ownerDeletes--;
      const after = fluxOwnerDelete(w.flux, m.key);
      markUnobserved(w.flux, after); w.flux = after;
      action = { kind: "flux_owner_delete", keyId: m.key }; trace({ t: "flux_owner_delete", keyId: m.key });
      break;
    }
    case "usageSync": w.flux = fluxUsageSync(w.flux, m.key); action = { kind: "usage_sync", keyId: m.key }; break;
    case "flag": w.budget.flag--; w.flux = { ...w.flux, flagOn: m.on }; break;
    case "use": {
      // a bot sends email with the key the home mounted: 200 iff Flux honours it, 401 otherwise (F5)
      const h = w.homes[m.home];
      w.budget.uses--;
      const key = h.memory.botKey[m.bot] ?? h.durable.disk.bots[m.bot];
      const u = fluxUse(w.flux, key);
      w.flux = u.flux;
      action = { kind: "use", home: m.home, bot: m.bot, resp: u.resp };
      // every send is a `use` event (the reducer records lastLocalUse in the same step, I11); a 401 is then also a `rejected` event
      reduceAt(m.home, ev({ t: "use", bot: m.bot, ...(key !== undefined ? { keyId: key } : {}) }));
      if (u.resp === 401) {
        { const k0 = w.unobserved[m.home]?.[m.bot] ?? w.pipeDead?.[m.home]?.[m.bot]; if (k0 !== undefined && evidenceAbout(w.homes[m.home], w, { kind: "use", home: m.home, bot: m.bot, resp: 401 } as never, m.bot, k0)) observed(m.home, m.bot); }
        const st = key ? w.flux.keys[key]?.status : undefined;
        reduceAt(m.home, ev({ t: "rejected", bot: m.bot, code: st === "revoked" || st === undefined ? 404 : 401 }));
      }
      break;
    }
  }
  // A step whose reducer changed a home's durable state ALSO counts, per home, as a `commit` (what = move:event): the invariants that
  // look at commits (I3, I12) see it, and the primary action (answer, use, ack, owner, clock...) stays visible to the rest.
  const commits: StepAction[] = [];
  if (error === undefined && action.kind !== "call" && action.kind !== "crash" && action.kind !== "owner") {
    for (const hid of changedHomes) commits.push({ kind: "commit", home: hid, what: `${m.k}:${reductions.filter((r) => r.home === hid).map((r) => r.event.t).join("+")}` });
  }
  // the owner-visible repair flag is the production pure read of durable data and the clock, evaluated after EVERY step
  if (error === undefined && red.keyRepair) for (const hid of Object.keys(w.homes)) {
    const hm = w.homes[hid];
    if (hm.destroyed) continue;
    for (const bot of Object.keys(hm.durable.bindings)) hm.repairVisible[bot] = red.keyRepair(hm, bot, w.now);
  }
  // harness fix (I1 counterexample #2, stale 201 after owner delete): a key ALREADY dead at Flux when it enters the home's save
  // pipeline (late 201 naming a successor the owner deleted meanwhile) is dead-on-arrival too; the home has no evidence of it.
  if (error === undefined) for (const hid of Object.keys(w.homes)) {
    const hm = w.homes[hid];
    if (hm.destroyed) continue;
    const piped: Array<[BotId, KeyId]> = [];
    for (const j of hm.supervisor.queue) for (const [bot, key] of Object.entries(j.image.bots)) piped.push([bot, key]);
    for (const x of hm.outbox) if (x.a === "save") for (const [bot, key] of Object.entries(x.bots)) piped.push([bot, key]);
    for (const [bot, key] of piped) if (key && !fluxHonours(w.flux, key) && hm.durable.observedDead[bot] !== key && w.unobserved[hid]?.[bot] === undefined && w.pipeDead?.[hid]?.[bot] === undefined && hm.durable.disk.bots[bot] !== key) ((w.pipeDead ??= {})[hid] ??= {})[bot] = key;
  }
  // promote pipeline-dead keys: when the dead key has become the home's durable key it is dead-on-arrival and unobserved; when it has
  // left the pipeline without landing, drop the record
  if (w.pipeDead) {
    for (const hid of Object.keys(w.pipeDead)) for (const [bot, key] of Object.entries(w.pipeDead[hid])) {
      const hm = w.homes[hid];
      const inPipe = !hm.destroyed && (hm.supervisor.queue.some((j) => j.image.bots[bot] === key) || hm.outbox.some((a) => a.a === "save" && a.bots[bot] === key));
      if (!hm.destroyed && hm.durable.disk.bots[bot] === key) { (w.unobserved[hid] ??= {})[bot] = key; delete w.pipeDead[hid][bot]; }
      else if (!inPipe) delete w.pipeDead[hid][bot];
    }
    for (const hid of Object.keys(w.pipeDead)) if (!Object.keys(w.pipeDead[hid]).length) delete w.pipeDead[hid];
    if (!Object.keys(w.pipeDead).length) delete w.pipeDead;
  }
  // r3.2e: record the cause of every tombstone this step ADDED, judged on prev (w0); never rewritten
  if (error === undefined) for (const hid of Object.keys(w.homes)) {
    const hm = w.homes[hid], ph = w0.homes[hid];
    if (hm.destroyed || !ph) continue;
    for (const x of hm.durable.tombstones) {
      if (ph.durable.tombstones.includes(x) || w.tombCause?.[hid]?.[x] !== undefined) continue;
      ((w.tombCause ??= {})[hid] ??= {})[x] = tombCauseOn(ph, w0, x);
    }
  }
  // GC: a request nobody can hear from again leaves the state (keeps the hash finite)
  w.requests = w.requests.filter((r) => !(r.appliedAtFlux && r.inbound.length === 0 && (r.answered || r.timedOut || r.dropped)));
  return { world: w, move: m, action, commits, reductions, error };
}

// ───────────── canonical hash (operational state, NOT the trace, alerts, reqIds or opIds) ─────────────
// Per the spec's hash rule: opIds and reqIds are renamed by first use; time is relative to `now` and clamped.
const TIME_KEYS = new Set(["deadlineAt", "until", "oldKeyExpiresAt", "createdAt", "lastUsedAt", "lastUsedVisibleAt", "firstSentAt", "first", "last", "at"]);
/** records keyed by id whose VALUES are times (hashed relative to now, never absolute) */
const TIME_MAPS = new Set(["deadlines", "lastLocalUse", "reconAt"]);
const REL = 2 * DAY;
const OPID_KEYS = new Set(["opId", "listOpId"]);
function canon(x: unknown, now: number, ren: Map<string, string>, key = ""): unknown {
  if (Array.isArray(x)) return x.map((v) => canon(v, now, ren));
  if (x && typeof x === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(x as object).sort()) {
      const v = (x as Record<string, unknown>)[k];
      o[k] = TIME_MAPS.has(key) && typeof v === "number" ? Math.max(-REL, Math.min(REL, v - now)) : canon(v, now, ren, k);
    }
    return o;
  }
  if (typeof x === "number" && TIME_KEYS.has(key)) return Math.max(-REL, Math.min(REL, x - now));
  if (typeof x === "string" && OPID_KEYS.has(key)) return ren.get(x) ?? x;
  if (x === undefined) return null;
  return x;
}
export function canonicalState(w: WorldX): unknown {
  const { trace: _t, now, nextReq: _n, requests, flux, ops, alerts: _a, ...rest } = w;
  const { now: _fn, ...fluxRest } = flux;
  const none = new Map<string, string>();
  // rename opIds by a stable order of their content (opId excluded), then ids by that order
  const body = (o: (typeof ops)[string]) => JSON.stringify(canon({ ...o, opId: "" }, now, none));
  const order = Object.values(ops).sort((a, b) => (body(a) < body(b) ? -1 : body(a) > body(b) ? 1 : 0));
  const ren = new Map<string, string>(order.map((o, i) => [o.opId, `o${i}`]));
  const opList = order.map((o) => canon({ ...o, opId: ren.get(o.opId) }, now, ren));
  const reqs = requests.map((r) => { const { reqId: _id, ...q } = r; return canon(q, now, ren); }).map((q) => JSON.stringify(q)).sort();
  return canon({ ...rest, flux: fluxRest, reqs, ops: opList }, now, ren);
}
export const hashState = (w: WorldX): string => createHash("sha1").update(JSON.stringify(canonicalState(w))).digest("hex").slice(0, 20);
export type { Evidence };
